package media

import (
	"context"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"
)

// A reconnect-grace resume reclaims the participant ID with a brand-new peer
// while deliberately skipping the superseded client's teardown: the old
// receiver targets stay registered under the ID. Register must purge those
// superseded targets before queueing subscriptions, or long-lived
// publications — audio above all, which never swaps — suppress every
// re-subscription and the rebuilt peer receives zero audio while ICE stays
// connected (observed as the CI weaknet audio failures).
func TestRouterRegisterReplacesSupersededReceiverTargets(t *testing.T) {
	router := NewRouter()
	sourceClient := newIntegrationPeer(t)
	sourceIngress := newIntegrationWrapperPeer(t)
	firstEgress := newIntegrationWrapperPeer(t)
	firstClient := newIntegrationPeer(t)
	secondEgress := newIntegrationWrapperPeer(t)
	secondClient := newIntegrationPeer(t)

	t.Cleanup(func() {
		router.Unregister("source")
		router.Unregister("receiver")
		_ = sourceClient.Close()
		_ = firstClient.Close()
		_ = sourceIngress.Close()
		_ = firstEgress.Close()
		_ = secondClient.Close()
		_ = secondEgress.Close()
	})

	if _, err := sourceIngress.Connection().AddTransceiverFromKind(pion.RTPCodecTypeAudio,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	for _, receiver := range []*pion.PeerConnection{firstClient, secondClient} {
		if _, err := receiver.AddTransceiverFromKind(pion.RTPCodecTypeAudio,
			pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatal(err)
		}
	}
	firstTracks := make(chan *pion.TrackRemote, 1)
	firstClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) { firstTracks <- track })
	secondTracks := make(chan *pion.TrackRemote, 1)
	secondClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) { secondTracks <- track })

	router.Register("source", sourceIngress, nil)
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("source", SourceRoleAudio, sourceIngress, track)
	})
	source := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType: pion.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
	}, "resume-audio")
	if _, err := sourceClient.AddTrack(source); err != nil {
		t.Fatal(err)
	}
	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "audio publisher")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "audio ingress")
	sendIntegrationPacket(t, source, pion.RTPCodecTypeAudio, 48_000, 1)
	waitIntegrationPublicationCount(t, router, 1)

	// First receiver generation: normal join and live audio.
	firstOffer := make(chan struct{}, 1)
	router.Register("receiver", firstEgress, func() error {
		select {
		case firstOffer <- struct{}{}:
		default:
		}
		return nil
	})
	waitIntegrationSignal(t, firstOffer, "first receiver offer")
	waitIntegrationPublicationTargets(t, router, 1, 1)
	negotiateIntegrationPeers(t, firstClient, firstEgress.Connection())
	waitIntegrationPeerConnected(t, firstClient, "first receiver")
	waitIntegrationPeerConnected(t, firstEgress.Connection(), "first egress")
	router.mu.RLock()
	firstTarget := router.pubs[publicationKey("source", SourceRoleAudio, "")].tracks["receiver"]
	router.mu.RUnlock()
	if firstTarget == nil {
		t.Fatal("first receiver did not get an audio target")
	}

	// Reconnect-grace resume: the participant ID is reclaimed by a new peer
	// while the superseded client's teardown is deliberately skipped, so the
	// stale first-generation target is still registered under "receiver".
	secondOffer := make(chan struct{}, 1)
	router.Register("receiver", secondEgress, func() error {
		select {
		case secondOffer <- struct{}{}:
		default:
		}
		return nil
	})
	waitIntegrationSignal(t, secondOffer, "resumed receiver offer")
	negotiateIntegrationPeers(t, secondClient, secondEgress.Connection())
	waitIntegrationPeerConnected(t, secondClient, "resumed receiver")
	waitIntegrationPeerConnected(t, secondEgress.Connection(), "resumed egress")

	router.mu.RLock()
	pub := router.pubs[publicationKey("source", SourceRoleAudio, "")]
	target := pub.tracks["receiver"]
	targetCount := len(pub.tracks)
	router.mu.RUnlock()
	if targetCount != 1 {
		t.Fatalf("receiver targets after resume = %d, want the superseded target replaced", targetCount)
	}
	if target == nil || target == firstTarget || target.audio == nil {
		t.Fatal("resumed receiver did not get a fresh audio target")
	}

	// The rebuilt peer must receive live audio from the long-lived
	// publication. Pion fires the offerer's OnTrack on first packet arrival,
	// so start forwarding before waiting for the resumed receiver's track.
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	sendIntegrationPacket(t, source, pion.RTPCodecTypeAudio, 48_000, 2)
	track := waitIntegrationTrack(t, ctx, secondTracks, "resumed receiver audio track")
	if err := track.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatal(err)
	}
	packet, _, err := track.ReadRTP()
	if err != nil || packet.SequenceNumber != 2 {
		t.Fatalf("resumed receiver packet = %v, error = %v; want sequence 2 from the long-lived audio publication", packet, err)
	}
}
