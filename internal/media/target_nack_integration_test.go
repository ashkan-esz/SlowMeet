package media

import (
	"context"
	"testing"
	"time"

	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

// This exercises real RTCP and RTX while holding one test target's mailbox
// full. The target writer is started only after the lost packet is observed,
// making the mailbox overflow deterministic without changing production code.
func TestRouterRepairsMailboxDropThroughReceiverNACK(t *testing.T) {
	probe := &nackIntegrationProbe{dropped: make(chan uint16, 1), nacked: make(chan uint16, 1), resent: make(chan uint16, 1)}
	probe.didDrop.Store(true) // This test loses the packet at the SFU mailbox.
	router := NewRouter()
	sourceClient := newNackIntegrationPeer(t, probe)
	sourceIngress := newIntegrationWrapperPeer(t)
	slowEgress, healthyEgress := newIntegrationWrapperPeer(t), newIntegrationWrapperPeer(t)
	slowClient, healthyClient := newIntegrationPeer(t), newIntegrationPeer(t)
	t.Cleanup(func() {
		for _, id := range []string{"source", "slow", "healthy"} {
			router.Unregister(id)
		}
		_ = sourceClient.Close()
		_ = slowClient.Close()
		_ = healthyClient.Close()
		_ = sourceIngress.Close()
		_ = slowEgress.Close()
		_ = healthyEgress.Close()
	})
	if _, err := sourceIngress.Connection().AddTransceiverFromKind(pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	for _, client := range []*pion.PeerConnection{slowClient, healthyClient} {
		if _, err := client.AddTransceiverFromKind(pion.RTPCodecTypeVideo,
			pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
	}
	slowTracks, healthyTracks := make(chan *pion.TrackRemote, 1), make(chan *pion.TrackRemote, 1)
	slowClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) { slowTracks <- track })
	healthyClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) { healthyTracks <- track })
	router.Register("source", sourceIngress, nil)
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("source", SourceRoleCamera, sourceIngress, track)
	})
	sourceTrack := newIntegrationTrack(pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90_000}, "source-video")
	sender, err := sourceClient.AddTrack(sourceTrack)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		for {
			if _, _, err := sender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "source")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "source ingress")
	write := func(sequence uint16) error {
		return sourceTrack.WriteRTP(&rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence,
			Timestamp: uint32(sequence) * 3000, Marker: true}, Payload: []byte{0x10, 0x00}})
	}
	if err := write(99); err != nil {
		t.Fatal(err)
	}
	waitIntegrationPublicationCount(t, router, 1)
	for _, receiver := range []struct {
		id     string
		egress *pion.PeerConnection
		client *pion.PeerConnection
		offer  chan struct{}
	}{
		{"slow", slowEgress.Connection(), slowClient, make(chan struct{}, 1)},
		{"healthy", healthyEgress.Connection(), healthyClient, make(chan struct{}, 1)},
	} {
		peer := slowEgress
		if receiver.id == "healthy" {
			peer = healthyEgress
		}
		router.Register(receiver.id, peer, func() error {
			select {
			case receiver.offer <- struct{}{}:
			default:
			}
			return nil
		})
		router.SetVideoSubscriptionsWithLayer(receiver.id, []string{"source"}, "medium")
		waitIntegrationSignal(t, receiver.offer, receiver.id+" offer")
		negotiateIntegrationPeers(t, receiver.client, receiver.egress)
		waitIntegrationPeerConnected(t, receiver.client, receiver.id+" client")
		waitIntegrationPeerConnected(t, receiver.egress, receiver.id+" egress")
	}
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	if err := write(100); err != nil {
		t.Fatal(err)
	}
	slowTrack := waitIntegrationTrack(t, ctx, slowTracks, "slow receiver")
	healthyTrack := waitIntegrationTrack(t, ctx, healthyTracks, "healthy receiver")
	slowPackets := integrationPacketSequences(slowTrack)
	healthyPackets := integrationPacketSequences(healthyTrack)
	awaitNackProbeSequence(t, ctx, slowPackets, 100, "slow initial packet")
	awaitNackProbeSequence(t, ctx, healthyPackets, 100, "healthy initial packet")

	router.mu.Lock()
	var pub *publication
	for _, candidate := range router.pubs {
		if candidate.sourceID == "source" && candidate.role == SourceRoleCamera {
			pub = candidate
			break
		}
	}
	if pub == nil || pub.tracks["slow"] == nil {
		router.mu.Unlock()
		t.Fatal("slow target was not registered")
	}
	old := pub.tracks["slow"]
	old.stop()
	slow := newPublicationTarget(old.track, 1)
	slow.lastSentLayer = old.lastSentLayer
	slow.enqueue(&rtp.Packet{}) // Occupy the mailbox until the loss is recorded.
	pub.tracks["slow"] = slow
	router.mu.Unlock()
	if err := write(nackIntegrationLostSequence); err != nil {
		t.Fatal(err)
	}
	awaitNackProbeSequence(t, ctx, healthyPackets, nackIntegrationLostSequence, "healthy original")
	lost := &rtp.Packet{Header: rtp.Header{Timestamp: uint32(nackIntegrationLostSequence) * 3000, SequenceNumber: nackIntegrationLostSequence}}
	for !slow.hasVideoLoss(lost) {
		select {
		case <-ctx.Done():
			t.Fatal("target mailbox did not record the loss")
		case <-time.After(time.Millisecond):
		}
	}
	<-slow.pending
	go slow.writePackets(pub.stoppedChannel())
	if err := write(102); err != nil {
		t.Fatal(err)
	}
	stopSource, sourceStopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(sourceStopped)
		ticker := time.NewTicker(30 * time.Millisecond)
		defer ticker.Stop()
		for sequence := uint16(103); ; sequence++ {
			select {
			case <-stopSource:
				return
			case <-ticker.C:
				if write(sequence) != nil {
					return
				}
			}
		}
	}()
	defer func() { close(stopSource); <-sourceStopped }()
	awaitNackProbeSequence(t, ctx, probe.nacked, nackIntegrationLostSequence, "publisher received receiver NACK")
	awaitNackProbeSequence(t, ctx, probe.resent, nackIntegrationLostSequence, "publisher RTX")
	for {
		select {
		case sequence := <-slowPackets:
			if sequence == nackIntegrationLostSequence {
				goto repaired
			}
		case <-ctx.Done():
			t.Fatal("slow receiver did not receive the repaired packet")
		}
	}
repaired:
	// Continue through a later ordinary packet and reject a duplicate repair at
	// the healthy receiver during the same interval.
	for {
		select {
		case sequence := <-healthyPackets:
			if sequence == nackIntegrationLostSequence {
				t.Fatal("healthy receiver received the targeted repair")
			}
			if sequence >= 110 {
				return
			}
		case <-ctx.Done():
			t.Fatal("healthy receiver stopped making progress")
		}
	}
}

func integrationPacketSequences(track *pion.TrackRemote) <-chan uint16 {
	sequences := make(chan uint16, 256)
	go func() {
		for {
			packet, _, err := track.ReadRTP()
			if err != nil {
				return
			}
			select {
			case sequences <- packet.SequenceNumber:
			default:
			}
		}
	}()
	return sequences
}
