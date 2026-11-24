package media

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

// The SFU measures each receiver's download from that receiver's own
// transport-cc feedback about the packets the SFU sends it. A receiver on a
// clean link reads no loss; a participant the SFU sends nothing has no
// measurement.
func TestRouterMeasuresEachReceiversDownlink(t *testing.T) {
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
	// The receiver's default interceptors send transport-cc feedback about
	// what they read.
	targetClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		go func() {
			for {
				if _, _, err := track.ReadRTP(); err != nil {
					return
				}
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
	if _, err := sourceClient.AddTrack(videoTrack); err != nil {
		t.Fatalf("add camera track: %v", err)
	}
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("source", SourceRoleCamera, sourceIngress, track)
	})
	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "source client")
	send := func(index int) {
		packet := &rtp.Packet{Header: rtp.Header{
			Version: 2, Marker: true, SequenceNumber: uint16(index), Timestamp: uint32(index * 1800),
		}, Payload: []byte{0x10, 0x00, 0x9d, 0x01, 0x2a, 0x10, 0x00, 0x10, 0x00}}
		if err := videoTrack.WriteRTP(packet); err != nil {
			t.Fatalf("write: %v", err)
		}
	}
	send(0)
	waitIntegrationSignal(t, targetOffer, "router target offer")
	waitIntegrationPublicationTargets(t, router, 1, 1)
	negotiateIntegrationPeers(t, targetEgress.Connection(), targetClient)
	waitIntegrationPeerConnected(t, targetClient, "target client")

	deadline := time.Now().Add(5 * time.Second)
	loss10, jitterMs := -1, -1
	for index := 1; time.Now().Before(deadline); index++ {
		send(index)
		time.Sleep(20 * time.Millisecond)
		if index > 75 {
			if loss10, jitterMs = router.DownlinkQuality("target"); loss10 >= 0 {
				break
			}
		}
	}
	if loss10 < 0 {
		t.Fatal("no downlink measurement for the receiver after its transport-cc feedback")
	}
	if loss10 != 0 {
		t.Fatalf("a loopback receiver lost %d tenths of a percent", loss10)
	}
	if jitterMs > 20 {
		t.Fatalf("a loopback receiver measured %d ms of jitter", jitterMs)
	}
	if loss10, _ := router.DownlinkQuality("source"); loss10 >= 0 {
		t.Fatalf("the publisher, sent nothing, has a downlink measurement: %d", loss10)
	}
	if loss10, _ := router.DownlinkQuality("nobody"); loss10 >= 0 {
		t.Fatal("an unknown participant has a downlink measurement")
	}
}
