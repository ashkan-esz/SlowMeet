package media

import (
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	pion "github.com/pion/webrtc/v4"
)

// A forwarded packet must name the receiver's own transceiver in its mid
// extension. It used to carry the publisher's mid, and Chrome routes by mid
// before SSRC, so a camera layer was delivered to whichever of the
// receiver's transceivers had the publisher's mid (B17). Here the publisher
// stamps mid "9"; the receiver must read its own transceiver's mid.
func TestRouterGivesEachReceiverItsOwnMid(t *testing.T) {
	router := NewRouter()
	sourceClient := newIntegrationPeer(t)
	sourceIngress := newIntegrationWrapperPeer(t)
	targetEgress := newIntegrationWrapperPeer(t)
	targetClient := newIntegrationPeer(t)
	t.Cleanup(func() {
		router.Unregister("source")
		router.Unregister("target")
		_ = sourceClient.Close()
		_ = targetClient.Close()
		_ = sourceIngress.Close()
		_ = targetEgress.Close()
	})

	type observation struct {
		got, want string
	}
	var mu sync.Mutex
	observed := []observation{}
	targetClient.OnTrack(func(track *pion.TrackRemote, receiver *pion.RTPReceiver) {
		if track.Kind() != pion.RTPCodecTypeVideo {
			return
		}
		var midID uint8
		for _, extension := range receiver.GetParameters().HeaderExtensions {
			if extension.URI == sdp.SDESMidURI {
				midID = uint8(extension.ID)
			}
		}
		want := ""
		for _, transceiver := range targetClient.GetTransceivers() {
			if transceiver.Receiver() == receiver {
				want = transceiver.Mid()
			}
		}
		go func() {
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				got := "<none>"
				if midID != 0 {
					if payload := packet.Header.GetExtension(midID); payload != nil {
						got = string(payload)
					}
				}
				mu.Lock()
				observed = append(observed, observation{got: got, want: want})
				mu.Unlock()
			}
		}()
	})

	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeVideo, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add video receive transceiver: %v", err)
	}
	targetOffer := make(chan struct{}, 4)
	router.SetVideoSubscriptionsWithLayer("target", []string{"source"}, "medium")
	router.Register("source", sourceIngress, nil)
	router.Register("target", targetEgress, func() error {
		select {
		case targetOffer <- struct{}{}:
		default:
		}
		return nil
	})
	videoTrack := newIntegrationTrack(pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000}, "source-video")
	sender, err := sourceClient.AddTrack(videoTrack)
	if err != nil {
		t.Fatalf("add camera track: %v", err)
	}
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("source", SourceRoleCamera, sourceIngress, track)
	})
	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "source client")
	var publisherMidID uint8
	for _, extension := range sender.GetParameters().HeaderExtensions {
		if extension.URI == sdp.SDESMidURI {
			publisherMidID = uint8(extension.ID)
		}
	}
	if publisherMidID == 0 {
		t.Fatal("the publisher's connection did not negotiate the mid extension")
	}

	// VP8 key frames, one packet each, stamped with a mid that is not the
	// receiver's.
	send := func(index int) {
		packet := &rtp.Packet{Header: rtp.Header{
			Version: 2, Marker: true, SequenceNumber: uint16(index), Timestamp: uint32(index * 3000),
		}, Payload: []byte{0x10, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00}}
		if err := packet.Header.SetExtension(publisherMidID, []byte("9")); err != nil {
			t.Fatalf("set publisher mid: %v", err)
		}
		if err := videoTrack.WriteRTP(packet); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	send(0)
	waitIntegrationSignal(t, targetOffer, "router target offer")
	waitIntegrationPublicationTargets(t, router, 1, 1)
	negotiateIntegrationPeers(t, targetEgress.Connection(), targetClient)
	waitIntegrationPeerConnected(t, targetClient, "target client")
	for index := 1; index <= 60; index++ {
		send(index)
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	defer mu.Unlock()
	if len(observed) < 20 {
		t.Fatalf("the receiver read only %d camera packets", len(observed))
	}
	for _, seen := range observed {
		if seen.want == "" {
			t.Fatal("the receiver's camera transceiver has no mid")
		}
		if seen.got != seen.want {
			t.Fatalf("the receiver got mid %q on its camera, want its own transceiver's %q", seen.got, seen.want)
		}
	}
}
