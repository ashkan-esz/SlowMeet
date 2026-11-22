package media

import (
	"context"
	"strings"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"

	internalwebrtc "SlowMeet/internal/webrtc"
)

var (
	integrationVP8 = pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000}
	integrationVP9 = pion.RTPCodecCapability{MimeType: pion.MimeTypeVP9, ClockRate: 90000, SDPFmtpLine: "profile-id=0"}
)

// codecSwitchFixture is one publisher and one receiver around a router, with
// the receiver subscribed to the publisher's camera.
type codecSwitchFixture struct {
	router        *Router
	sourceClient  *pion.PeerConnection
	sourceIngress *internalwebrtc.Peer
	targetEgress  *internalwebrtc.Peer
	targetClient  *pion.PeerConnection
	targetTracks  chan *pion.TrackRemote
	targetOffer   chan struct{}
	// nextSequence keeps the publisher's RTP sequence numbers rising across
	// tracks: they share one SSRC, and SRTP drops a sequence number far behind
	// the newest as a replay.
	nextSequence uint16
}

func (fixture *codecSwitchFixture) send(t *testing.T, track *pion.TrackLocalStaticRTP, count uint16) {
	t.Helper()
	sendIntegrationRTPPackets(t, track, pion.RTPCodecTypeVideo, 90_000, fixture.nextSequence, count)
	fixture.nextSequence += count
}

// newCodecSwitchFixture registers both peers. targetCodecs, when not nil, is
// the receiver's supported video codecs as its browser would report them.
func newCodecSwitchFixture(t *testing.T, targetCodecs []string) *codecSwitchFixture {
	t.Helper()
	fixture := &codecSwitchFixture{
		router:        NewRouter(),
		sourceClient:  newIntegrationPeer(t),
		sourceIngress: newIntegrationWrapperPeer(t),
		targetEgress:  newIntegrationWrapperPeer(t),
		targetClient:  newIntegrationPeer(t),
		targetTracks:  make(chan *pion.TrackRemote, 4),
		targetOffer:   make(chan struct{}, 4),
		nextSequence:  1,
	}
	t.Cleanup(func() {
		fixture.router.Unregister("source")
		fixture.router.Unregister("target")
		_ = fixture.sourceClient.Close()
		_ = fixture.targetClient.Close()
		_ = fixture.sourceIngress.Close()
		_ = fixture.targetEgress.Close()
	})
	if _, err := fixture.targetClient.AddTransceiverFromKind(
		pion.RTPCodecTypeVideo, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add camera receive transceiver: %v", err)
	}
	fixture.targetClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		fixture.targetTracks <- track
	})
	fixture.router.SetVideoSubscriptionsWithLayer("target", []string{"source"}, "medium")
	if targetCodecs != nil {
		fixture.router.SetReceiverVideoCodecs("target", targetCodecs)
	}
	fixture.router.Register("source", fixture.sourceIngress, nil)
	fixture.router.Register("target", fixture.targetEgress, func() error {
		select {
		case fixture.targetOffer <- struct{}{}:
		default:
		}
		return nil
	})
	fixture.sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		fixture.router.Publish("source", SourceRoleCamera, fixture.sourceIngress, track)
	})
	return fixture
}

// publish starts the publisher's camera in codec and waits for the router to
// have its publication.
func (fixture *codecSwitchFixture) publish(t *testing.T, codec pion.RTPCodecCapability) (*pion.TrackLocalStaticRTP, *pion.RTPSender) {
	t.Helper()
	track := newIntegrationTrack(codec, "browser-camera")
	sender, err := fixture.sourceClient.AddTrack(track)
	if err != nil {
		t.Fatalf("add source camera: %v", err)
	}
	negotiateIntegrationPeers(t, fixture.sourceClient, fixture.sourceIngress.Connection())
	waitIntegrationPeerConnected(t, fixture.sourceClient, "camera source client")
	fixture.send(t, track, 1)
	waitIntegrationPublicationCount(t, fixture.router, 1)
	return track, sender
}

// switchCodec makes the publisher send another codec on the same sender and
// SSRC, which is what a browser does when its send codec changes.
func (fixture *codecSwitchFixture) switchCodec(t *testing.T, sender *pion.RTPSender, codec pion.RTPCodecCapability) *pion.TrackLocalStaticRTP {
	t.Helper()
	before := fixture.router.currentPublication(publicationKey("source", SourceRoleCamera, ""))
	if before == nil {
		t.Fatal("camera publication missing before the codec switch")
	}
	track := newIntegrationTrack(codec, "browser-camera")
	if err := sender.ReplaceTrack(track); err != nil {
		t.Fatalf("switch publisher codec: %v", err)
	}
	fixture.send(t, track, 5)
	waitForPublicationReplacement(t, fixture.router, before)
	select {
	case <-before.forwardDone:
	case <-time.After(routerIntegrationTimeout):
		t.Fatal("the previous codec's forwarding loop did not exit")
	}
	return track
}

// receive completes the receiver's pending negotiation and returns the camera
// track it ends up decoding packets from.
func (fixture *codecSwitchFixture) receive(t *testing.T, source *pion.TrackLocalStaticRTP, wantMime string) {
	t.Helper()
	waitIntegrationSignal(t, fixture.targetOffer, "camera offer")
	negotiateIntegrationPeers(t, fixture.targetEgress.Connection(), fixture.targetClient)
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	fixture.send(t, source, 150)
	for {
		track := waitIntegrationTrack(t, ctx, fixture.targetTracks, wantMime+" camera track")
		if !strings.EqualFold(track.Codec().MimeType, wantMime) {
			// The track of the codec that was just replaced.
			continue
		}
		if !readIntegrationRTP(ctx, track) {
			t.Fatalf("receiver did not get %s packets", wantMime)
		}
		return
	}
}

func (fixture *codecSwitchFixture) publicationCodec(t *testing.T) string {
	t.Helper()
	pub := fixture.router.currentPublication(publicationKey("source", SourceRoleCamera, ""))
	if pub == nil {
		t.Fatal("camera publication missing")
	}
	return pub.codecName
}

// A browser that changes its send codec keeps the transceiver and SSRC, so no
// new track event reaches the router: it has to notice the new payload type
// on the live publication and give receivers a track in the new codec.
func TestRouterFollowsInPlaceCodecChange(t *testing.T) {
	fixture := newCodecSwitchFixture(t, nil)
	vp8, sender := fixture.publish(t, integrationVP8)
	if got := fixture.publicationCodec(t); got != "vp8" {
		t.Fatalf("publication codec = %q, want vp8", got)
	}
	fixture.receive(t, vp8, pion.MimeTypeVP8)

	vp9 := fixture.switchCodec(t, sender, integrationVP9)
	if got := fixture.publicationCodec(t); got != "vp9" {
		t.Fatalf("publication codec after the switch = %q, want vp9", got)
	}
	fixture.receive(t, vp9, pion.MimeTypeVP9)
	waitIntegrationPublicationTargets(t, fixture.router, 1, 1)
}

// A receiver whose browser cannot decode the publisher's codec is left out,
// which keeps its own negotiation working, and is subscribed as soon as the
// publisher switches to a codec it has.
func TestRouterSkipsReceiverUntilItCanDecode(t *testing.T) {
	fixture := newCodecSwitchFixture(t, []string{"vp8", "h264"})
	_, sender := fixture.publish(t, integrationVP9)
	if got := fixture.publicationCodec(t); got != "vp9" {
		t.Fatalf("publication codec = %q, want vp9", got)
	}
	select {
	case <-fixture.targetOffer:
		t.Fatal("a receiver without VP9 was offered the VP9 camera")
	case <-time.After(300 * time.Millisecond):
	}
	waitIntegrationPublicationTargets(t, fixture.router, 1, 0)

	vp8 := fixture.switchCodec(t, sender, integrationVP8)
	fixture.receive(t, vp8, pion.MimeTypeVP8)
	waitIntegrationPublicationTargets(t, fixture.router, 1, 1)
}
