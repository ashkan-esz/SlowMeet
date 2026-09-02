package media

import (
	"context"
	"testing"
	"time"

	internalwebrtc "SlowMeet/internal/webrtc"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

const routerIntegrationTimeout = 10 * time.Second

type receivedRTP struct {
	kind  pion.RTPCodecType
	track *pion.TrackRemote
}

func TestRouterForwardsRTPBetweenRealPeerConnections(t *testing.T) {
	router := NewRouter()

	sourceClient := newIntegrationPeer(t)
	sourceIngress := newIntegrationWrapperPeer(t)
	targetEgress := newIntegrationWrapperPeer(t)
	targetClient := newIntegrationPeer(t)
	secondTargetEgress := newIntegrationWrapperPeer(t)
	secondTargetClient := newIntegrationPeer(t)

	t.Cleanup(func() {
		router.Unregister("source")
		router.Unregister("target")
		router.Unregister("second-target")
		for _, peer := range []*pion.PeerConnection{
			sourceClient, targetClient, secondTargetClient,
		} {
			_ = peer.Close()
		}
		for _, peer := range []*internalwebrtc.Peer{
			sourceIngress, targetEgress, secondTargetEgress,
		} {
			_ = peer.Close()
		}
	})

	targetTracks := make(chan receivedRTP, 2)
	targetClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		targetTracks <- receivedRTP{kind: track.Kind(), track: track}
	})
	secondTargetTracks := make(chan receivedRTP, 2)
	secondTargetClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		secondTargetTracks <- receivedRTP{kind: track.Kind(), track: track}
	})
	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeAudio, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add audio receive transceiver: %v", err)
	}
	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeVideo, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add video receive transceiver: %v", err)
	}

	targetOffer := make(chan struct{}, 1)
	secondTargetOffer := make(chan struct{}, 1)
	router.Register("source", sourceIngress, nil)
	router.Register("target", targetEgress, func() error {
		select {
		case targetOffer <- struct{}{}:
		default:
		}
		return nil
	})
	router.Register("second-target", secondTargetEgress, func() error {
		select {
		case secondTargetOffer <- struct{}{}:
		default:
		}
		return nil
	})

	audioTrack := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType:  pion.MimeTypeOpus,
		ClockRate: 48000,
		Channels:  2,
	}, "source-audio")
	videoTrack := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType:  pion.MimeTypeVP8,
		ClockRate: 90000,
	}, "source-video")
	if _, err := sourceClient.AddTrack(audioTrack); err != nil {
		t.Fatalf("add audio track: %v", err)
	}
	if _, err := sourceClient.AddTrack(videoTrack); err != nil {
		t.Fatalf("add video track: %v", err)
	}

	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("source", sourceIngress, track)
	})

	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "source client")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "source ingress")

	sendIntegrationPacket(t, audioTrack, pion.RTPCodecTypeAudio, 48_000, 0)
	sendIntegrationPacket(t, videoTrack, pion.RTPCodecTypeVideo, 90_000, 0)
	waitIntegrationSignal(t, targetOffer, "router target offer")
	waitIntegrationSignal(t, secondTargetOffer, "router second target offer")
	waitIntegrationPublicationCount(t, router, 2)
	negotiateIntegrationPeers(t, targetEgress.Connection(), targetClient)
	negotiateIntegrationPeers(t, secondTargetEgress.Connection(), secondTargetClient)
	sendIntegrationRTP(t, audioTrack, pion.RTPCodecTypeAudio, 48_000)
	sendIntegrationRTP(t, videoTrack, pion.RTPCodecTypeVideo, 90_000)

	receivedKinds := make(map[pion.RTPCodecType]bool, 2)
	secondReceivedKinds := make(map[pion.RTPCodecType]bool, 2)
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	for len(receivedKinds) < 2 || len(secondReceivedKinds) < 2 {
		select {
		case received := <-targetTracks:
			if received.track == nil {
				t.Fatal("destination reported a nil remote track")
			}
			if received.kind != pion.RTPCodecTypeAudio && received.kind != pion.RTPCodecTypeVideo {
				t.Fatalf("destination received unexpected media kind %s", received.kind)
			}
			receivedKinds[received.kind] = true
			if !readIntegrationRTP(ctx, received.track) {
				t.Fatalf("timed out reading forwarded %s RTP", received.kind)
			}
		case received := <-secondTargetTracks:
			if received.track == nil {
				t.Fatal("second destination reported a nil remote track")
			}
			if received.kind != pion.RTPCodecTypeAudio && received.kind != pion.RTPCodecTypeVideo {
				t.Fatalf("second destination received unexpected media kind %s", received.kind)
			}
			secondReceivedKinds[received.kind] = true
			if !readIntegrationRTP(ctx, received.track) {
				t.Fatalf("timed out reading second forwarded %s RTP", received.kind)
			}
		case <-ctx.Done():
			t.Fatalf("timed out waiting for forwarded media; received %v and %v", receivedKinds, secondReceivedKinds)
		}
	}
}

func newIntegrationPeer(t *testing.T) *pion.PeerConnection {
	t.Helper()
	peer, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create Pion peer: %v", err)
	}
	return peer
}

func newIntegrationWrapperPeer(t *testing.T) *internalwebrtc.Peer {
	t.Helper()
	peer, err := internalwebrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create wrapped Pion peer: %v", err)
	}
	return peer
}

func newIntegrationTrack(codec pion.RTPCodecCapability, id string) *pion.TrackLocalStaticRTP {
	track, err := pion.NewTrackLocalStaticRTP(codec, id, "router-integration")
	if err != nil {
		panic(err)
	}
	return track
}

func negotiateIntegrationPeers(t *testing.T, offerer, answerer *pion.PeerConnection) {
	t.Helper()

	offer, err := offerer.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if err := offerer.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local offer: %v", err)
	}
	<-pion.GatheringCompletePromise(offerer)

	localOffer := offerer.LocalDescription()
	if localOffer == nil {
		t.Fatal("offerer has no local description after gathering")
	}
	if err := answerer.SetRemoteDescription(*localOffer); err != nil {
		t.Fatalf("set remote offer: %v", err)
	}

	answer, err := answerer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create answer: %v", err)
	}
	if err := answerer.SetLocalDescription(answer); err != nil {
		t.Fatalf("set local answer: %v", err)
	}
	<-pion.GatheringCompletePromise(answerer)

	localAnswer := answerer.LocalDescription()
	if localAnswer == nil {
		t.Fatal("answerer has no local description after gathering")
	}
	if err := offerer.SetRemoteDescription(*localAnswer); err != nil {
		t.Fatalf("set remote answer: %v", err)
	}
}

func sendIntegrationRTP(t *testing.T, track *pion.TrackLocalStaticRTP, kind pion.RTPCodecType, clockRate uint32) {
	t.Helper()

	for sequence := uint16(1); sequence < 300; sequence++ {
		sendIntegrationPacket(t, track, kind, clockRate, sequence)
		time.Sleep(10 * time.Millisecond)
	}
}

func sendIntegrationPacket(t *testing.T, track *pion.TrackLocalStaticRTP, kind pion.RTPCodecType, clockRate uint32, sequence uint16) {
	t.Helper()
	packet := &rtp.Packet{
		Header: rtp.Header{
			Version:        2,
			PayloadType:    integrationPayloadType(kind),
			SequenceNumber: sequence,
			Timestamp:      uint32(sequence) * clockRate / 10,
			SSRC:           42 + uint32(kind),
		},
		Payload: []byte{0x01, 0x02, 0x03, 0x04},
	}
	if err := track.WriteRTP(packet); err != nil {
		t.Fatalf("write %s RTP: %v", kind, err)
	}
}

func integrationPayloadType(kind pion.RTPCodecType) uint8 {
	if kind == pion.RTPCodecTypeVideo {
		return 96
	}
	return 111
}

func waitIntegrationPeerConnected(t *testing.T, peer *pion.PeerConnection, name string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	for {
		state := peer.ConnectionState()
		if state == pion.PeerConnectionStateConnected {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s connection state = %s", name, state)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func readIntegrationRTP(ctx context.Context, track *pion.TrackRemote) bool {
	packet := make(chan bool, 1)
	go func() {
		_, _, err := track.ReadRTP()
		packet <- err == nil
	}()
	select {
	case received := <-packet:
		return received
	case <-ctx.Done():
		return false
	}
}

func waitIntegrationSignal(t *testing.T, signal <-chan struct{}, name string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	select {
	case <-signal:
	case <-ctx.Done():
		t.Fatalf("timed out waiting for %s", name)
	}
}

func waitIntegrationPublicationCount(t *testing.T, router *Router, want int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	for {
		router.mu.RLock()
		got := len(router.pubs)
		router.mu.RUnlock()
		if got >= want {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("router publications = %d, want at least %d", got, want)
		case <-time.After(10 * time.Millisecond):
		}
	}
}
