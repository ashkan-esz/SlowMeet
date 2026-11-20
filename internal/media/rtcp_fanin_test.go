package media

import (
	"errors"
	"io"
	"maps"
	"slices"
	"sync"
	"testing"
	"time"

	internalwebrtc "SlowMeet/internal/webrtc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

const (
	// rtcpFanInQuietWindow is how long the publisher is watched for feedback
	// beyond what the subscribers sent.
	rtcpFanInQuietWindow = 300 * time.Millisecond
	// rtcpFanInSenderSSRCBase and rtcpFanInNackBase give every subscriber its
	// own RTCP sender SSRC and its own lost sequence number. The sequence
	// numbers are far above anything the publisher sends, so no NACK
	// responder on the path has a packet to retransmit for them.
	rtcpFanInSenderSSRCBase = uint32(0x5100)
	rtcpFanInNackBase       = uint16(40_000)
)

// rtcpFanInFeedback collects the keyframe and retransmission requests that
// reach a publisher's camera sender.
type rtcpFanInFeedback struct {
	plis  chan *rtcp.PictureLossIndication
	nacks chan *rtcp.TransportLayerNack
}

func rtcpFanInReadFeedback(sender *pion.RTPSender) *rtcpFanInFeedback {
	feedback := &rtcpFanInFeedback{
		plis:  make(chan *rtcp.PictureLossIndication, 64),
		nacks: make(chan *rtcp.TransportLayerNack, 64),
	}
	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				switch request := packet.(type) {
				case *rtcp.PictureLossIndication:
					select {
					case feedback.plis <- request:
					default:
					}
				case *rtcp.TransportLayerNack:
					select {
					case feedback.nacks <- request:
					default:
					}
				}
			}
		}
	}()
	return feedback
}

// rtcpFanInPumpCamera publishes single-packet frames with contiguous sequence
// numbers until the returned stop function is called, so no receiver on the
// path ever has a gap of its own to NACK.
func rtcpFanInPumpCamera(t *testing.T, track *pion.TrackLocalStaticRTP) (stop func()) {
	t.Helper()
	stopping, stopped := make(chan struct{}), make(chan struct{})
	go func() {
		defer close(stopped)
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for sequence := uint16(1); ; sequence++ {
			select {
			case <-stopping:
				return
			case <-ticker.C:
			}
			err := track.WriteRTP(&rtp.Packet{
				Header: rtp.Header{
					Version: 2, Marker: true, PayloadType: 96,
					SequenceNumber: sequence, Timestamp: uint32(sequence) * 3000,
				},
				Payload: []byte{0x10, 0x00},
			})
			if err != nil && !errors.Is(err, io.ErrClosedPipe) {
				t.Errorf("write publisher camera RTP: %v", err)
				return
			}
		}
	}()
	var once sync.Once
	return func() {
		once.Do(func() {
			close(stopping)
			<-stopped
		})
	}
}

type rtcpFanInSubscriber struct {
	id     string
	client *pion.PeerConnection
	egress *internalwebrtc.Peer
	tracks chan *pion.TrackRemote
	camera *pion.TrackRemote
}

// TestSubscriberKeyFrameRequestsFanInToPublisher sends real RTCP from one,
// two and three subscribers of the same camera through the SFU on loopback
// and counts what the publisher's sender reads.
func TestSubscriberKeyFrameRequestsFanInToPublisher(t *testing.T) {
	for _, test := range []struct {
		name        string
		subscribers int
	}{
		{name: "one subscriber", subscribers: 1},
		{name: "two subscribers", subscribers: 2},
		{name: "three subscribers", subscribers: 3},
	} {
		t.Run(test.name, func(t *testing.T) {
			testSubscriberKeyFrameRequestsFanIn(t, test.subscribers)
		})
	}
}

func testSubscriberKeyFrameRequestsFanIn(t *testing.T, subscriberCount int) {
	router := NewRouter()
	sourceClient := newIntegrationPeer(t)
	sourceIngress := newIntegrationWrapperPeer(t)
	subscribers := make([]*rtcpFanInSubscriber, subscriberCount)
	for index := range subscribers {
		subscribers[index] = &rtcpFanInSubscriber{
			id:     "subscriber-" + string(rune('1'+index)),
			client: newIntegrationPeer(t),
			egress: newIntegrationWrapperPeer(t),
			tracks: make(chan *pion.TrackRemote, 1),
		}
	}
	stopCamera := func() {}
	t.Cleanup(func() {
		stopCamera()
		router.Unregister("publisher")
		_ = sourceClient.Close()
		_ = sourceIngress.Close()
		for _, subscriber := range subscribers {
			router.Unregister(subscriber.id)
			_ = subscriber.client.Close()
			_ = subscriber.egress.Close()
		}
	})

	if _, err := sourceIngress.Connection().AddTransceiverFromKind(pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatalf("add camera receive transceiver: %v", err)
	}
	router.Register("publisher", sourceIngress, nil)
	// The camera is published without a simulcast layer, so the router itself
	// never requests a keyframe here: every PLI the publisher reads below was
	// written by a subscriber.
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		router.Publish("publisher", SourceRoleCamera, sourceIngress, track)
	})
	camera := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType: pion.MimeTypeVP8, ClockRate: 90_000,
	}, "publisher-camera")
	sender, err := sourceClient.AddTrack(camera)
	if err != nil {
		t.Fatalf("add publisher camera: %v", err)
	}
	feedback := rtcpFanInReadFeedback(sender)
	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "publisher client")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "publisher ingress")
	stopCamera = rtcpFanInPumpCamera(t, camera)
	waitIntegrationPublicationCount(t, router, 1)

	for _, subscriber := range subscribers {
		if _, err := subscriber.client.AddTransceiverFromKind(pion.RTPCodecTypeVideo,
			pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
			t.Fatalf("add %s camera receive transceiver: %v", subscriber.id, err)
		}
		subscriber.client.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
			subscriber.tracks <- track
		})
		offer := make(chan struct{}, 1)
		router.Register(subscriber.id, subscriber.egress, func() error {
			select {
			case offer <- struct{}{}:
			default:
			}
			return nil
		})
		router.SetVideoSubscriptionsWithLayer(subscriber.id, []string{"publisher"}, "medium")
		waitIntegrationSignal(t, offer, subscriber.id+" camera offer")
		negotiateIntegrationPeers(t, subscriber.client, subscriber.egress.Connection())
		waitIntegrationPeerConnected(t, subscriber.client, subscriber.id+" client")
		waitIntegrationPeerConnected(t, subscriber.egress.Connection(), subscriber.id+" egress")
	}
	for _, subscriber := range subscribers {
		select {
		case subscriber.camera = <-subscriber.tracks:
		case <-time.After(routerIntegrationTimeout):
			t.Fatalf("%s did not receive the publisher's camera", subscriber.id)
		}
	}
	publisherSSRC := uint32(sender.GetParameters().Encodings[0].SSRC)
	if publisherSSRC == 0 {
		t.Fatal("publisher camera sender has no SSRC")
	}

	// Every subscriber loses its picture in the same instant, as happens when
	// they all sit behind bad links, and asks for a keyframe once.
	wantSenders := make([]uint32, 0, subscriberCount)
	for index, subscriber := range subscribers {
		senderSSRC := rtcpFanInSenderSSRCBase + uint32(index)
		wantSenders = append(wantSenders, senderSSRC)
		if err := subscriber.client.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{
			SenderSSRC: senderSSRC, MediaSSRC: uint32(subscriber.camera.SSRC()),
		}}); err != nil {
			t.Fatalf("write %s PLI: %v", subscriber.id, err)
		}
	}

	// KNOWN ISSUE (B2): relayRTCP forwards every subscriber's keyframe request
	// to the publisher as it arrives, with no throttle and no coalescing
	// across the subscribers of one publication, so N simultaneous PLIs cost
	// the publisher's encoder N keyframe requests. Desired: requests for the
	// same publication that arrive together are merged into a single PLI.
	// When that is fixed the multi-subscriber rows fail the wait below ("read
	// 1 PLIs from N subscribers, want N"): set wantPublisherPLIs to 1 for every
	// row, and make the sender SSRC comparison accept the one merged request.
	// (Setting it to 1 today makes those rows fail the "more than" check.) The
	// relay metric counts what subscribers sent and stays at subscriberCount.
	wantPublisherPLIs := subscriberCount

	var gotSenders []uint32
	for len(gotSenders) < wantPublisherPLIs {
		select {
		case pli := <-feedback.plis:
			if pli.MediaSSRC != publisherSSRC {
				t.Fatalf("publisher read a PLI for media SSRC %d, want its own camera SSRC %d",
					pli.MediaSSRC, publisherSSRC)
			}
			gotSenders = append(gotSenders, pli.SenderSSRC)
		case <-time.After(routerIntegrationTimeout):
			t.Fatalf("publisher read %d PLIs from %d subscribers, want %d",
				len(gotSenders), subscriberCount, wantPublisherPLIs)
		}
	}
	select {
	case pli := <-feedback.plis:
		t.Fatalf("publisher read more than %d PLIs for %d subscriber requests: extra %+v",
			wantPublisherPLIs, subscriberCount, pli)
	case <-time.After(rtcpFanInQuietWindow):
	}
	slices.Sort(gotSenders)
	if !slices.Equal(gotSenders, wantSenders) {
		t.Fatalf("PLI sender SSRCs at the publisher = %v, want one from each subscriber %v", gotSenders, wantSenders)
	}
	if got := router.RTCPRelay().PLI; got != uint64(subscriberCount) {
		t.Fatalf("relay counted %d subscriber PLIs, want %d", got, subscriberCount)
	}

	// Retransmission requests are per packet, so unlike keyframe requests
	// every distinct one must reach the publisher, retargeted at its track.
	wantLost := make([]uint16, 0, subscriberCount)
	for index, subscriber := range subscribers {
		lost := rtcpFanInNackBase + uint16(index)
		wantLost = append(wantLost, lost)
		if err := subscriber.client.WriteRTCP([]rtcp.Packet{&rtcp.TransportLayerNack{
			SenderSSRC: rtcpFanInSenderSSRCBase + uint32(index),
			MediaSSRC:  uint32(subscriber.camera.SSRC()),
			Nacks:      []rtcp.NackPair{{PacketID: lost}},
		}}); err != nil {
			t.Fatalf("write %s NACK: %v", subscriber.id, err)
		}
	}
	var gotLost []uint16
	for len(gotLost) < subscriberCount {
		select {
		case nack := <-feedback.nacks:
			for _, pair := range nack.Nacks {
				for _, sequence := range pair.PacketList() {
					if !slices.Contains(wantLost, sequence) {
						// Not one of the test's requests: a NACK some receiver
						// on the path generated for a packet of its own.
						continue
					}
					if nack.MediaSSRC != publisherSSRC {
						t.Fatalf("publisher read a NACK for media SSRC %d, want its own camera SSRC %d",
							nack.MediaSSRC, publisherSSRC)
					}
					if want := rtcpFanInSenderSSRCBase + uint32(sequence-rtcpFanInNackBase); nack.SenderSSRC != want {
						t.Fatalf("NACK for sequence %d came from sender SSRC %d, want %d", sequence, nack.SenderSSRC, want)
					}
					gotLost = append(gotLost, sequence)
				}
			}
		case <-time.After(routerIntegrationTimeout):
			t.Fatalf("publisher read NACKs for %v, want one for each of %v", gotLost, wantLost)
		}
	}
	slices.Sort(gotLost)
	if !slices.Equal(gotLost, wantLost) {
		t.Fatalf("NACKed sequences at the publisher = %v, want each of %v exactly once", gotLost, wantLost)
	}
}

// rtcpFanInLayerPublication registers one simulcast layer of "publisher"
// (through newTestLayerPublication) with an egress target per receiver. The
// publication has no source peer, so keyframe requests are scheduled in
// router.videoKeyFrameRetries but nothing is written.
func rtcpFanInLayerPublication(t *testing.T, router *Router, layer string, receiverIDs ...string) *publication {
	t.Helper()
	pub := newTestLayerPublication(t, router, layer)
	track := pub.tracks["receiver"].track
	pub.tracks = make(map[string]*publicationTarget, len(receiverIDs))
	for _, receiverID := range receiverIDs {
		pub.tracks[receiverID] = newPublicationTarget(track, targetVideoQueueDepth)
	}
	return pub
}

// rtcpFanInForwardFrame forwards one single-packet frame of a layer the way
// the video pacer does. Every layer of the publisher is marked as actively
// receiving first, since layer selection only considers active layers.
func rtcpFanInForwardFrame(t *testing.T, router *Router, layers map[string]*publication, layer string, sequence uint16) *rtp.Packet {
	t.Helper()
	now := time.Now().UnixNano()
	for _, pub := range layers {
		pub.lastPacketAt.Store(now)
	}
	packet := &rtp.Packet{Header: rtp.Header{
		SequenceNumber: sequence, Timestamp: uint32(sequence) * 3000, Marker: true,
	}}
	forwardTestFrame(t, router, layers[layer], packet)
	return packet
}

// rtcpFanInTakeKeyFrameRetries stops and removes every scheduled keyframe
// retry series and returns them, so the caller sees exactly the series the
// preceding step started.
func rtcpFanInTakeKeyFrameRetries(router *Router) map[videoKeyFrameRequestKey]*videoKeyFrameRetry {
	router.mu.Lock()
	defer router.mu.Unlock()
	taken := make(map[videoKeyFrameRequestKey]*videoKeyFrameRetry, len(router.videoKeyFrameRetries))
	for key, request := range router.videoKeyFrameRetries {
		request.timer.Stop()
		taken[key] = request
		delete(router.videoKeyFrameRetries, key)
	}
	return taken
}

// rtcpFanInBeforeRetryTimer runs scenario until one run finishes before the
// first retry timer could have fired. A fired timer removes its series from
// the fixture (the publications have no senders), so a run in which the test
// goroutine was descheduled for a whole retry delay is repeated rather than
// judged.
func rtcpFanInBeforeRetryTimer[T any](t *testing.T, scenario func() T) T {
	t.Helper()
	for range 10 {
		started := time.Now()
		result := scenario()
		if time.Since(started) < videoKeyFrameRetryDelay {
			return result
		}
	}
	t.Fatalf("scenario never finished within the %s keyframe retry delay", videoKeyFrameRetryDelay)
	panic("unreachable")
}

func rtcpFanInDrain(target *publicationTarget) []*rtp.Packet {
	var packets []*rtp.Packet
	for {
		select {
		case packet := <-target.pending:
			packets = append(packets, packet)
		default:
			return packets
		}
	}
}

// rtcpFanInExpectFrame drains every receiver's mailbox on one layer and
// checks that exactly the listed receivers were handed the frame.
func rtcpFanInExpectFrame(t *testing.T, pub *publication, frame *rtp.Packet, receiverIDs ...string) {
	t.Helper()
	for receiverID, target := range pub.tracks {
		got := rtcpFanInDrain(target)
		if !slices.Contains(receiverIDs, receiverID) {
			if len(got) != 0 {
				t.Fatalf("%s got %d packets of the %s layer it is not on", receiverID, len(got), pub.layer)
			}
			continue
		}
		if len(got) != 1 || got[0] != frame {
			t.Fatalf("%s got %d packets of the %s layer, want exactly the forwarded frame", receiverID, len(got), pub.layer)
		}
	}
}

func TestLayerTransitionKeyFrameRetriesPerReceiver(t *testing.T) {
	for _, test := range []struct {
		name      string
		receivers []string
		// wantSeries is the number of retry series the transition starts
		// against the low layer's publisher; wantRequests is the PLIs those
		// series send in total (one immediately, the rest every
		// videoKeyFrameRetryDelay).
		wantSeries   int
		wantRequests int
	}{
		{name: "one receiver", receivers: []string{"receiver-1"}, wantSeries: 1, wantRequests: videoKeyFrameRequestCount},
		// KNOWN ISSUE (B2): keyframe retries are keyed per (receiver,
		// publication), so receivers that step down to the same layer in the
		// same frame each start their own series against the one encoder that
		// feeds them all: three receivers cost 3 PLIs at once and 9 within
		// two retry delays. Desired: one series per publication no matter how
		// many receivers switched together. When that is fixed, wantSeries
		// becomes 1 and wantRequests becomes videoKeyFrameRequestCount in the
		// two rows below, and the per-receiver key lookup in the loop at the
		// end of this test has to follow the new key.
		{name: "two receivers", receivers: []string{"receiver-1", "receiver-2"}, wantSeries: 2, wantRequests: 2 * videoKeyFrameRequestCount},
		{name: "three receivers", receivers: []string{"receiver-1", "receiver-2", "receiver-3"}, wantSeries: 3, wantRequests: 3 * videoKeyFrameRequestCount},
	} {
		t.Run(test.name, func(t *testing.T) {
			var low *publication
			retries := rtcpFanInBeforeRetryTimer(t, func() map[videoKeyFrameRequestKey]*videoKeyFrameRetry {
				router := NewRouter()
				layers := make(map[string]*publication)
				for _, layer := range []string{"low", "medium"} {
					layers[layer] = rtcpFanInLayerPublication(t, router, layer, test.receivers...)
				}
				low = layers["low"]
				for _, receiverID := range test.receivers {
					router.SetVideoSubscriptionsWithLayer(receiverID, []string{"publisher"}, "medium")
				}
				joined := rtcpFanInForwardFrame(t, router, layers, "medium", 1)
				rtcpFanInExpectFrame(t, layers["medium"], joined, test.receivers...)
				// The requests made when the receivers first joined the medium
				// layer are not under test.
				rtcpFanInTakeKeyFrameRetries(router)

				// Every receiver's link degrades in the same adaptation tick.
				for _, receiverID := range test.receivers {
					router.SetVideoSubscriptionsWithLayer(receiverID, []string{"publisher"}, "low")
				}
				stale := rtcpFanInForwardFrame(t, router, layers, "medium", 2)
				rtcpFanInExpectFrame(t, layers["medium"], stale)
				switched := rtcpFanInForwardFrame(t, router, layers, "low", 2)
				rtcpFanInExpectFrame(t, layers["low"], switched, test.receivers...)
				return rtcpFanInTakeKeyFrameRetries(router)
			})

			if len(retries) != test.wantSeries {
				t.Fatalf("%d receivers switching to low together started %d keyframe retry series, want %d: %+v",
					len(test.receivers), len(retries), test.wantSeries, slices.Collect(maps.Keys(retries)))
			}
			requests := 0
			for _, request := range retries {
				requests += 1 + request.remaining
			}
			if requests != test.wantRequests {
				t.Fatalf("the transition budgets %d PLIs to the low layer's publisher, want %d", requests, test.wantRequests)
			}
			for _, receiverID := range test.receivers {
				request := retries[videoKeyFrameRequestKey{receiverID: receiverID, publicationKey: low.key}]
				if request == nil {
					t.Fatalf("no retry series for %s on %s: %+v", receiverID, low.key, slices.Collect(maps.Keys(retries)))
				}
				if request.publication != low || request.remaining != videoKeyFrameRequestCount-1 {
					t.Fatalf("retry series for %s = publication %q with %d retries left, want %q with %d",
						receiverID, request.publication.key, request.remaining, low.key, videoKeyFrameRequestCount-1)
				}
			}
		})
	}
}

// TestSimulcastMixedLayersAcrossFourReceivers is the 1 good + 3 bad room seen
// from one publisher's simulcast layers: three receivers step down to low and
// back while the fourth stays on high throughout.
func TestSimulcastMixedLayersAcrossFourReceivers(t *testing.T) {
	weak := []string{"weak-1", "weak-2", "weak-3"}
	const strong = "strong"
	everyone := append(slices.Clone(weak), strong)

	type transitions struct {
		low, high        *publication
		stepDown, stepUp map[videoKeyFrameRequestKey]*videoKeyFrameRetry
	}
	observed := rtcpFanInBeforeRetryTimer(t, func() transitions {
		router := NewRouter()
		layers := make(map[string]*publication)
		for _, layer := range cameraLayersByQuality {
			layers[layer] = rtcpFanInLayerPublication(t, router, layer, everyone...)
		}
		for _, receiverID := range everyone {
			router.SetVideoSubscriptionsWithLayer(receiverID, []string{"publisher"}, "high")
		}
		// forwardAll forwards one frame of every layer and checks which
		// receivers each layer reached.
		forwardAll := func(sequence uint16, onLow, onHigh []string) {
			t.Helper()
			frame := rtcpFanInForwardFrame(t, router, layers, "low", sequence)
			rtcpFanInExpectFrame(t, layers["low"], frame, onLow...)
			frame = rtcpFanInForwardFrame(t, router, layers, "medium", sequence)
			rtcpFanInExpectFrame(t, layers["medium"], frame)
			frame = rtcpFanInForwardFrame(t, router, layers, "high", sequence)
			rtcpFanInExpectFrame(t, layers["high"], frame, onHigh...)
		}

		// Everybody starts on the high layer.
		forwardAll(1, nil, everyone)
		rtcpFanInTakeKeyFrameRetries(router)

		// The three weak receivers step down in the same adaptation tick.
		for _, receiverID := range weak {
			router.SetVideoSubscriptionsWithLayer(receiverID, []string{"publisher"}, "low")
		}
		forwardAll(2, weak, []string{strong})
		forwardAll(3, weak, []string{strong})
		if got := layers["high"].tracks[strong].lastSentLayer; got != "high" {
			t.Fatalf("strong receiver's high-layer marker = %q after the others stepped down, want it untouched", got)
		}
		result := transitions{low: layers["low"], high: layers["high"]}
		result.stepDown = rtcpFanInTakeKeyFrameRetries(router)

		// Their links recover and they climb back to high together.
		for _, receiverID := range weak {
			router.SetVideoSubscriptionsWithLayer(receiverID, []string{"publisher"}, "high")
		}
		forwardAll(4, nil, everyone)
		result.stepUp = rtcpFanInTakeKeyFrameRetries(router)
		return result
	})

	// The step down asks only the low layer's encoder for a keyframe, and the
	// step back up only the high layer's on behalf of the receivers that
	// re-entered it. Neither transition schedules anything for the receiver
	// that stayed on high, and nothing ever targets the medium layer. (How
	// many series the weak receivers start is pinned as B2 in
	// TestLayerTransitionKeyFrameRetriesPerReceiver, not here.)
	for _, transition := range []struct {
		name    string
		retries map[videoKeyFrameRequestKey]*videoKeyFrameRetry
		layer   *publication
	}{
		{name: "step down to low", retries: observed.stepDown, layer: observed.low},
		{name: "step back up to high", retries: observed.stepUp, layer: observed.high},
	} {
		if len(transition.retries) == 0 {
			t.Errorf("%s scheduled no keyframe request for the receivers entering the %s layer", transition.name, transition.layer.layer)
		}
		for key, request := range transition.retries {
			if key.receiverID == strong {
				t.Errorf("%s scheduled a keyframe retry for the receiver that never left high: %+v", transition.name, key)
			}
			if key.publicationKey != transition.layer.key || request.publication != transition.layer {
				t.Errorf("%s scheduled a keyframe retry on %q, want only %q", transition.name, key.publicationKey, transition.layer.key)
			}
		}
	}
}
