package media

import (
	"context"
	"testing"
	"time"

	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

func TestRouterForwardsCompliantAudioCatchUpBurst(t *testing.T) {
	router := NewRouter(Limits{MaxAudioBitrate: 96_000})
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
	if _, err := sourceIngress.Connection().AddTransceiverFromKind(pion.RTPCodecTypeAudio,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	if _, err := targetClient.AddTransceiverFromKind(pion.RTPCodecTypeAudio,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	tracks := make(chan *pion.TrackRemote, 1)
	targetClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) { tracks <- track })
	router.Register("source", sourceIngress, nil)
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("source", SourceRoleAudio, sourceIngress, track)
	})
	source := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType: pion.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	}, "burst-audio")
	if _, err := sourceClient.AddTrack(source); err != nil {
		t.Fatal(err)
	}
	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "audio publisher")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "audio ingress")
	sendIntegrationPacket(t, source, pion.RTPCodecTypeAudio, 48_000, 1)
	waitIntegrationPublicationCount(t, router, 1)
	offer := make(chan struct{}, 1)
	router.Register("target", targetEgress, func() error {
		select {
		case offer <- struct{}{}:
		default:
		}
		return nil
	})
	waitIntegrationSignal(t, offer, "audio receiver offer")
	waitIntegrationPublicationTargets(t, router, 1, 1)
	negotiateIntegrationPeers(t, targetClient, targetEgress.Connection())
	waitIntegrationPeerConnected(t, targetClient, "audio receiver")
	waitIntegrationPeerConnected(t, targetEgress.Connection(), "audio egress")
	router.mu.RLock()
	pub := router.pubs[publicationKey("source", SourceRoleAudio, "")]
	if pub == nil || pub.tracks["target"] == nil || pub.tracks["target"].audio == nil || pub.limiter.burstWindow != audioBurstWindow {
		router.mu.RUnlock()
		t.Fatal("real audio publication did not use catch-up admission and mailbox")
	}
	router.mu.RUnlock()

	start := time.Now()
	for sequence := uint16(100); sequence < 150; sequence++ {
		packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence,
			Timestamp: uint32(sequence) * 960}, Payload: make([]byte, 80)}
		if err := source.WriteRTP(packet); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	track := waitIntegrationTrack(t, ctx, tracks, "catch-up audio")
	if err := track.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	for want := uint16(100); want < 150; want++ {
		packet, _, err := track.ReadRTP()
		if err != nil || packet.SequenceNumber != want {
			t.Fatalf("catch-up packet = %v, error = %v, want sequence %d", packet, err, want)
		}
	}
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("one second of audio was paced instead of drained: %s", elapsed)
	}
	if drops := router.AudioDrops(); drops.Admission != 0 || drops.QueueOverflow != 0 || drops.QueueExpired != 0 || drops.WriteFailures != 0 {
		t.Fatalf("compliant catch-up burst produced SFU drops: %+v", drops)
	}
}
