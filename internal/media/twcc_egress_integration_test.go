package media

import (
	"encoding/binary"
	"sort"
	"sync"
	"testing"
	"time"

	internalwebrtc "SlowMeet/internal/webrtc"

	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	pion "github.com/pion/webrtc/v4"
)

// A receiver's transport-wide congestion-control sequence must be the SFU's
// own for that receiver's transport. Forwarded packets used to keep their
// publisher's transport-cc number, so a receiver of two publishers saw two
// unrelated counters interleaved as one transport; once they drifted apart,
// every packet read as a huge jump and the browsers' transport-cc feedback
// grew to thousands of packets a second (all-fast-link-top-quality in a full
// netns run). Here the two publishers stamp numbers 40000 apart; the receiver
// must get one contiguous run that is neither publisher's.
func TestRouterStampsItsOwnTransportSequenceOnForwardedPackets(t *testing.T) {
	router := NewRouter()
	type source struct {
		id      string
		client  *pion.PeerConnection
		ingress *internalwebrtc.Peer
		track   *pion.TrackLocalStaticRTP
		extID   uint8
		base    uint16
	}
	sources := []*source{{id: "alpha", base: 10000}, {id: "beta", base: 50000}}
	targetEgress := newIntegrationWrapperPeer(t)
	targetClient := newIntegrationPeer(t)
	t.Cleanup(func() {
		router.Unregister("target")
		_ = targetClient.Close()
		_ = targetEgress.Close()
		for _, src := range sources {
			router.Unregister(src.id)
			if src.client != nil {
				_ = src.client.Close()
			}
			if src.ingress != nil {
				_ = src.ingress.Close()
			}
		}
	})

	var mu sync.Mutex
	received := []uint16{}
	targetClient.OnTrack(func(track *pion.TrackRemote, receiver *pion.RTPReceiver) {
		var extID uint8
		for _, ext := range receiver.GetParameters().HeaderExtensions {
			if ext.URI == sdp.TransportCCURI {
				extID = uint8(ext.ID)
			}
		}
		go func() {
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				if extID == 0 {
					continue
				}
				if payload := packet.Header.GetExtension(extID); len(payload) >= 2 {
					mu.Lock()
					received = append(received, binary.BigEndian.Uint16(payload))
					mu.Unlock()
				}
			}
		}()
	})

	targetOffer := make(chan struct{}, 8)
	router.Register("target", targetEgress, func() error {
		select {
		case targetOffer <- struct{}{}:
		default:
		}
		return nil
	})
	for _, src := range sources {
		src.client = newIntegrationPeer(t)
		src.ingress = newIntegrationWrapperPeer(t)
		if _, err := src.ingress.Connection().AddTransceiverFromKind(
			pion.RTPCodecTypeAudio, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
		); err != nil {
			t.Fatalf("%s: add audio receive transceiver: %v", src.id, err)
		}
		src.track = newIntegrationTrack(pion.RTPCodecCapability{MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2}, src.id+"-audio")
		sender, err := src.client.AddTrack(src.track)
		if err != nil {
			t.Fatalf("%s: add audio track: %v", src.id, err)
		}
		router.Register(src.id, src.ingress, nil)
		id, ingress := src.id, src.ingress
		ingress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
			router.Publish(id, SourceRoleAudio, ingress, track)
		})
		negotiateIntegrationPeers(t, src.client, src.ingress.Connection())
		waitIntegrationPeerConnected(t, src.client, src.id+" client")
		for _, ext := range sender.GetParameters().HeaderExtensions {
			if ext.URI == sdp.TransportCCURI {
				src.extID = uint8(ext.ID)
			}
		}
		if src.extID == 0 {
			t.Fatalf("%s: transport-cc was not negotiated on the publisher's sender", src.id)
		}
	}

	send := func(src *source, index int) {
		packet := &rtp.Packet{Header: rtp.Header{
			Version: 2, SequenceNumber: uint16(index), Timestamp: uint32(index * 960),
		}, Payload: []byte{0xf8, 0xff, 0xfe}}
		number := make([]byte, 2)
		binary.BigEndian.PutUint16(number, src.base+uint16(index))
		if err := packet.Header.SetExtension(src.extID, number); err != nil {
			t.Fatalf("%s: set transport-cc: %v", src.id, err)
		}
		if err := src.track.WriteRTP(packet); err != nil {
			t.Fatalf("%s: write: %v", src.id, err)
		}
	}
	for _, src := range sources {
		send(src, 0)
	}
	waitIntegrationSignal(t, targetOffer, "router target offer")
	waitIntegrationPublicationTargets(t, router, 2, 2)
	negotiateIntegrationPeers(t, targetEgress.Connection(), targetClient)
	waitIntegrationPeerConnected(t, targetClient, "target client")

	for index := 1; index <= 150; index++ {
		for _, src := range sources {
			send(src, index)
		}
		time.Sleep(10 * time.Millisecond)
	}
	time.Sleep(300 * time.Millisecond)

	mu.Lock()
	numbers := append([]uint16(nil), received...)
	mu.Unlock()
	if len(numbers) < 100 {
		t.Fatalf("the receiver read only %d transport-cc numbers", len(numbers))
	}
	for _, number := range numbers {
		for _, src := range sources {
			if number >= src.base && number <= src.base+200 {
				t.Fatalf("the receiver got publisher %s's transport-cc number %d: the SFU forwarded it instead of stamping its own", src.id, number)
			}
		}
	}
	sort.Slice(numbers, func(i, j int) bool { return numbers[i] < numbers[j] })
	if span := int(numbers[len(numbers)-1]) - int(numbers[0]) + 1; span > len(numbers)+10 {
		t.Fatalf("the receiver's transport-cc numbers span %d for %d packets: not one transport's sequence", span, len(numbers))
	}
}
