package media

import (
	"context"
	"encoding/binary"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

const (
	nackIntegrationLostSequence = uint16(101)
)

type nackIntegrationProbe struct {
	dropped    chan uint16
	nacked     chan uint16
	resent     chan uint16
	didDrop    atomic.Bool
	ssrc       atomic.Uint32
	nackSSRC   atomic.Uint32
	rtxSSRC    atomic.Uint32
	releaseRTX <-chan struct{}
}

type nackIntegrationFactory struct {
	probe *nackIntegrationProbe
}

func (f *nackIntegrationFactory) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &nackIntegrationInterceptor{probe: f.probe}, nil
}

type nackIntegrationInterceptor struct {
	interceptor.NoOp
	probe *nackIntegrationProbe
}

func (i *nackIntegrationInterceptor) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	i.probe.ssrc.Store(info.SSRC)
	i.probe.rtxSSRC.Store(info.SSRCRetransmission)
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if header != nil && header.SSRC == i.probe.rtxSSRC.Load() && len(payload) >= 2 && binary.BigEndian.Uint16(payload) == nackIntegrationLostSequence {
			signalNackProbeSequence(i.probe.resent, nackIntegrationLostSequence)
			if i.probe.releaseRTX != nil {
				<-i.probe.releaseRTX
			}
		}
		if header != nil && header.SSRC == i.probe.ssrc.Load() && header.SequenceNumber == nackIntegrationLostSequence {
			if i.probe.didDrop.CompareAndSwap(false, true) {
				signalNackProbeSequence(i.probe.dropped, header.SequenceNumber)
				// Report success to the sender while intentionally losing this packet
				// after Pion's NACK responder has cached it for retransmission.
				return len(payload), nil
			}
		}
		return writer.Write(header, payload, attributes)
	})
}

func (i *nackIntegrationInterceptor) BindRTCPReader(reader interceptor.RTCPReader) interceptor.RTCPReader {
	return interceptor.RTCPReaderFunc(func(buffer []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		n, receivedAttributes, err := reader.Read(buffer, attributes)
		if err != nil || n == 0 {
			return n, receivedAttributes, err
		}

		packets, parseErr := receivedAttributes.GetRTCPPackets(buffer[:n])
		if parseErr == nil {
			for _, packet := range packets {
				nack, ok := packet.(*rtcp.TransportLayerNack)
				if !ok {
					continue
				}
				i.probe.nackSSRC.Store(nack.MediaSSRC)
				for _, pair := range nack.Nacks {
					for _, sequence := range pair.PacketList() {
						if sequence == nackIntegrationLostSequence {
							signalNackProbeSequence(i.probe.nacked, sequence)
							return n, receivedAttributes, err
						}
					}
				}
			}
		}
		return n, receivedAttributes, err
	})
}

func signalNackProbeSequence(channel chan<- uint16, sequence uint16) {
	select {
	case channel <- sequence:
	default:
	}
}

func newNackIntegrationPeer(t *testing.T, probe *nackIntegrationProbe) *pion.PeerConnection {
	t.Helper()

	mediaEngine := &pion.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		t.Fatalf("register default codecs: %v", err)
	}

	registry := &interceptor.Registry{}
	// Register the loss injector before Pion's defaults. The default NACK
	// responder therefore caches the original packet before the injector drops
	// its first outbound transmission.
	registry.Add(&nackIntegrationFactory{probe: probe})
	if err := pion.RegisterDefaultInterceptors(mediaEngine, registry); err != nil {
		t.Fatalf("register default interceptors: %v", err)
	}

	api := pion.NewAPI(
		pion.WithMediaEngine(mediaEngine),
		pion.WithInterceptorRegistry(registry),
	)
	peer, err := api.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create loss-injected Pion peer: %v", err)
	}
	return peer
}

func TestRouterRetransmitsIngressVideoPacketLostBeforeMarker(t *testing.T) {
	t.Run("continuous source", func(t *testing.T) { testRouterRetransmitsIngressVideo(t, false) })
	t.Run("idle source", func(t *testing.T) { testRouterRetransmitsIngressVideo(t, true) })
}

func testRouterRetransmitsIngressVideo(t *testing.T, idleSource bool) {
	probe := &nackIntegrationProbe{
		dropped: make(chan uint16, 1),
		nacked:  make(chan uint16, 1),
		resent:  make(chan uint16, 1),
	}
	var releaseRTX chan struct{}
	if idleSource {
		releaseRTX = make(chan struct{})
		probe.releaseRTX = releaseRTX
		defer func() {
			if releaseRTX != nil {
				close(releaseRTX)
			}
		}()
	}
	router := NewRouter()
	sourceClient := newNackIntegrationPeer(t, probe)
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

	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add ingress video transceiver: %v", err)
	}
	if _, err := targetClient.AddTransceiverFromKind(
		pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add receiver video transceiver: %v", err)
	}

	targetTracks := make(chan *pion.TrackRemote, 1)
	targetClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		targetTracks <- track
	})
	router.Register("source", sourceIngress, nil)
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("source", SourceRoleCamera, sourceIngress, track)
	})

	sourceTrack := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType:  pion.MimeTypeVP8,
		ClockRate: 90_000,
	}, "source-video")
	sourceSender, err := sourceClient.AddTrack(sourceTrack)
	if err != nil {
		t.Fatalf("add source camera track: %v", err)
	}
	go func() {
		for {
			if _, _, err := sourceSender.ReadRTCP(); err != nil {
				return
			}
		}
	}()
	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "publisher")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "ingress")

	write := func(sequence uint16, timestamp uint32, marker bool) {
		t.Helper()
		packet := &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				SequenceNumber: sequence,
				Timestamp:      timestamp,
				Marker:         marker,
			},
			Payload: []byte{0x10, 0x00},
		}
		if err := sourceTrack.WriteRTP(packet); err != nil {
			t.Fatalf("write source RTP sequence %d: %v", sequence, err)
		}
	}

	// The first packet opens the publication before a receiver subscribes.
	write(99, 179_000, true)
	waitIntegrationPublicationCount(t, router, 1)

	targetOffer := make(chan struct{}, 1)
	router.Register("target", targetEgress, func() error {
		select {
		case targetOffer <- struct{}{}:
		default:
		}
		return nil
	})
	router.SetVideoSubscriptionsWithLayer("target", []string{"source"}, "medium")
	waitIntegrationSignal(t, targetOffer, "receiver offer")
	negotiateIntegrationPeers(t, targetClient, targetEgress.Connection())
	waitIntegrationPeerConnected(t, targetClient, "receiver")
	waitIntegrationPeerConnected(t, targetEgress.Connection(), "egress")

	// Sequence 101 is lost on the publisher's local send path. Sequence 102
	// closes the frame, which makes successful forwarding of 101 afterward
	// depend on ingress NACK repair and the router's late-packet handling.
	write(100, 180_000, false)
	write(101, 180_000, false)
	write(102, 180_000, true)

	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	targetTrack := waitIntegrationTrack(t, ctx, targetTracks, "receiver video track")
	if err := targetTrack.SetReadDeadline(time.Now().Add(routerIntegrationTimeout)); err != nil {
		t.Fatalf("set receiver RTP deadline: %v", err)
	}

	awaitNackProbeSequence(t, ctx, probe.dropped, nackIntegrationLostSequence, "injected packet loss")
	awaitNackProbeSequence(t, ctx, probe.nacked, nackIntegrationLostSequence, "automatic NACK")
	select {
	case <-probe.resent:
	case <-ctx.Done():
		t.Fatalf("publisher did not retransmit: local ssrc %d, nack ssrc %d", probe.ssrc.Load(), probe.nackSSRC.Load())
	}
	for _, want := range []uint16{100, 102} {
		packet, _, err := targetTrack.ReadRTP()
		if err != nil || packet.SequenceNumber != want {
			t.Fatalf("received RTP packet = %v, error = %v; want sequence %d", packet, err, want)
		}
	}
	if idleSource {
		// The final original packet has reached the receiver. Let the ingress
		// reader park before releasing RTX, with no further primary packets.
		// Cross more than one idle poll interval while the track is quiet.
		time.Sleep(2*videoRTXReadPollInterval + 50*time.Millisecond)
		waitIntegrationPublicationCount(t, router, 1)
		close(releaseRTX)
		releaseRTX = nil
		if err := targetTrack.SetReadDeadline(time.Now().Add(time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	// A continuing camera provides primary packets; the idle case deliberately
	// sends none after releasing the retransmission.
	stopSource := make(chan struct{})
	sourceStopped := make(chan struct{})
	sourceErrors := make(chan error, 1)
	go func() {
		defer close(sourceStopped)
		if idleSource {
			return
		}
		ticker := time.NewTicker(30 * time.Millisecond)
		defer ticker.Stop()
		sequence := uint16(103)
		timestamp := uint32(183_000)
		for {
			select {
			case <-stopSource:
				return
			case <-ticker.C:
				packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: sequence, Timestamp: timestamp, Marker: true}, Payload: []byte{0x10, 0x00}}
				if err := sourceTrack.WriteRTP(packet); err != nil {
					sourceErrors <- err
					return
				}
				sequence++
				timestamp += 3_000
			}
		}
	}()
	defer func() { close(stopSource); <-sourceStopped }()

	for {
		packet, _, err := targetTrack.ReadRTP()
		if err != nil {
			select {
			case sourceErr := <-sourceErrors:
				t.Fatalf("source stopped before repair: %v", sourceErr)
			default:
				t.Fatalf("receiver did not get repair: %v", err)
			}
		}
		if packet.SequenceNumber == nackIntegrationLostSequence {
			break
		}
	}
}

func awaitNackProbeSequence(t *testing.T, ctx context.Context, sequences <-chan uint16, want uint16, what string) {
	t.Helper()
	select {
	case got := <-sequences:
		if got != want {
			t.Fatalf("%s sequence = %d, want %d", what, got, want)
		}
	case <-ctx.Done():
		t.Fatalf("timed out waiting for %s sequence %d", what, want)
	}
}
