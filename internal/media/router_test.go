package media

import (
	"fmt"
	"testing"
	"time"

	"SlowMeet/internal/webrtc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

func TestRouteRTCPFeedbackTargetsSourceTrack(t *testing.T) {
	const sourceSSRC = 1234
	pli := &rtcp.PictureLossIndication{SenderSSRC: 10, MediaSSRC: 20}
	fir := &rtcp.FullIntraRequest{
		SenderSSRC: 11,
		MediaSSRC:  21,
		FIR:        []rtcp.FIREntry{{SSRC: 22, SequenceNumber: 3}},
	}
	nack := &rtcp.TransportLayerNack{
		SenderSSRC: 12,
		MediaSSRC:  23,
		Nacks:      []rtcp.NackPair{{PacketID: 44, LostPackets: 3}},
	}
	routed := routeRTCPFeedback([]rtcp.Packet{pli, fir, nack}, sourceSSRC)
	if len(routed) != 3 {
		t.Fatalf("routed packet count = %d, want 3", len(routed))
	}
	routedPLI, ok := routed[0].(*rtcp.PictureLossIndication)
	if !ok || routedPLI.MediaSSRC != sourceSSRC || routedPLI.SenderSSRC != pli.SenderSSRC {
		t.Fatalf("routed PLI = %+v, want source SSRC %d", routed[0], sourceSSRC)
	}
	routedFIR, ok := routed[1].(*rtcp.FullIntraRequest)
	if !ok || routedFIR.MediaSSRC != sourceSSRC || len(routedFIR.FIR) != 1 || routedFIR.FIR[0].SSRC != sourceSSRC {
		t.Fatalf("routed FIR = %+v, want source SSRC %d", routed[1], sourceSSRC)
	}
	routedNACK, ok := routed[2].(*rtcp.TransportLayerNack)
	if !ok || routedNACK.MediaSSRC != sourceSSRC || routedNACK.SenderSSRC != nack.SenderSSRC ||
		len(routedNACK.Nacks) != 1 || routedNACK.Nacks[0] != nack.Nacks[0] {
		t.Fatalf("routed NACK = %+v, want source SSRC %d with its original packet IDs", routed[2], sourceSSRC)
	}
	if pli.MediaSSRC != 20 || fir.MediaSSRC != 21 || fir.FIR[0].SSRC != 22 || nack.MediaSSRC != 23 {
		t.Fatal("routing feedback mutated the receiver's RTCP packets")
	}
}

func TestBitrateLimiterDropsWithoutQueueingAndRefills(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(100_000, func() time.Time { return now })

	if !limiter.allow(10_000) {
		t.Fatal("initial burst should be allowed")
	}
	if limiter.allow(1) {
		t.Fatal("packet should be dropped when the bucket is empty")
	}

	now = now.Add(10 * time.Millisecond)
	if !limiter.allow(100) {
		t.Fatal("packet should be allowed after the bucket refills")
	}
}

func TestBitrateLimiterZeroRateDoesNotShape(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(0, func() time.Time { return now })

	if !limiter.allow(1_000_000) {
		t.Fatal("zero rate should disable shaping")
	}
}

func TestBitrateLimiterSetRateAppliesImmediately(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(0, func() time.Time { return now })
	limiter.setRate(100_000)

	if !limiter.allow(10_000) {
		t.Fatal("new rate should allow an initial burst")
	}
	if limiter.allow(1) {
		t.Fatal("new rate should be enforced immediately")
	}
}

func TestBitrateLimiterCapsVideoFramesWithoutQueueing(t *testing.T) {
	limiter := newBitrateLimiterAt(0, time.Now)
	limiter.setFPS(10)

	if !limiter.allowFrame(0) {
		t.Fatal("first frame should be allowed")
	}
	if limiter.allowFrame(4_500) {
		t.Fatal("frame inside the FPS interval should be dropped")
	}
	if !limiter.allowFrame(9_000) {
		t.Fatal("frame at the FPS interval should be allowed")
	}
	if !limiter.allowFrame(9_000) {
		t.Fatal("packets from an allowed frame should remain allowed")
	}
}

func TestScreenShareFPSRemainsLimited(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(10_000, func() time.Time { return now })
	limiter.setFPS(10)

	if !limiter.allowFrame(0) {
		t.Fatal("first screen-share frame should fit the initial FPS budget")
	}
	if limiter.allowFrame(4_500) {
		t.Fatal("screen-share FPS should be limited")
	}
	if !limiter.allowFrame(9_000) {
		t.Fatal("screen-share FPS should resume at the configured interval")
	}
}

func TestBitrateLimiterPacesInsteadOfDroppingWhenBudgetRefills(t *testing.T) {
	limiter := newBitrateLimiter(10_000)
	if !limiter.allow(1_200) {
		t.Fatal("initial burst should be available")
	}
	start := time.Now()
	if !limiter.waitForBytes(1_200, make(chan struct{})) {
		t.Fatal("pacer unexpectedly stopped")
	}
	if elapsed := time.Since(start); elapsed < 90*time.Millisecond || elapsed > time.Second {
		t.Fatalf("paced packet wait = %s, want about 120ms", elapsed)
	}
}

func TestRateForKindConvertsConfiguredBitsToBytes(t *testing.T) {
	limits := Limits{MaxVideoBitrate: 800_000, MaxAudioBitrate: 96_000}
	if got := rateForKind(pion.RTPCodecTypeVideo, limits); got != 100_000 {
		t.Fatalf("video byte rate = %d, want 100000", got)
	}
	if got := rateForKind(pion.RTPCodecTypeAudio, limits); got != 12_000 {
		t.Fatalf("audio byte rate = %d, want 12000", got)
	}
	if got := rateForKind(pion.RTPCodecTypeVideo, Limits{}); got != 0 {
		t.Fatalf("zero video limit byte rate = %d, want 0", got)
	}
}

func TestVideoFrameQueueDropsOnlyWholeFrames(t *testing.T) {
	queue := make(chan videoFrame, 1)
	first := videoFrame{packets: []*rtp.Packet{{Header: rtp.Header{Timestamp: 1}}, {Header: rtp.Header{Timestamp: 1, Marker: true}}}}
	second := videoFrame{packets: []*rtp.Packet{{Header: rtp.Header{Timestamp: 2}}, {Header: rtp.Header{Timestamp: 2, Marker: true}}}}
	if !enqueueVideoFrame(queue, first) {
		t.Fatal("first complete frame should fit the queue")
	}
	if enqueueVideoFrame(queue, second) {
		t.Fatal("queue overflow should reject the whole next frame")
	}
	queued := <-queue
	if len(queued.packets) != 2 || queued.packets[0].Timestamp != queued.packets[1].Timestamp {
		t.Fatal("queue must not expose a partial frame")
	}
}

func TestVideoFrameBufferWaitsForCompleteFrame(t *testing.T) {
	var frame videoFrameBuffer
	first := &rtp.Packet{Header: rtp.Header{Timestamp: 10, SequenceNumber: 101}, Payload: make([]byte, 900)}
	reordered := &rtp.Packet{Header: rtp.Header{Timestamp: 10, SequenceNumber: 100}, Payload: make([]byte, 900)}
	last := &rtp.Packet{Header: rtp.Header{Timestamp: 10, SequenceNumber: 102, Marker: true}, Payload: make([]byte, 900)}

	if packets, _, complete := frame.add(first); complete || len(packets) != 0 {
		t.Fatal("frame was exposed before its marker packet")
	}
	if packets, _, complete := frame.add(reordered); complete || len(packets) != 0 {
		t.Fatal("out-of-order frame packets should wait for the marker")
	}
	duplicate := &rtp.Packet{Header: first.Header, Payload: first.Payload}
	if packets, _, complete := frame.add(duplicate); complete || len(packets) != 0 {
		t.Fatal("duplicate RTP sequence should not complete or extend the frame")
	}
	packets, frameBytes, complete := frame.add(last)
	if !complete || len(packets) != 3 || frameBytes != first.MarshalSize()+reordered.MarshalSize()+last.MarshalSize() {
		t.Fatalf("completed frame = (%d packets, %d bytes, %t), want (3 packets, full size, true)", len(packets), frameBytes, complete)
	}
	if packets[0].SequenceNumber != 100 || packets[1].SequenceNumber != 101 || packets[2].SequenceNumber != 102 {
		t.Fatalf("frame sequence order = [%d %d %d], want [100 101 102]", packets[0].SequenceNumber, packets[1].SequenceNumber, packets[2].SequenceNumber)
	}

	incomplete := &rtp.Packet{Header: rtp.Header{Timestamp: 20, SequenceNumber: 103}, Payload: []byte{1}}
	replacement := &rtp.Packet{Header: rtp.Header{Timestamp: 30, SequenceNumber: 104, Marker: true}, Payload: []byte{2}}
	frame.add(incomplete)
	packets, _, complete = frame.add(replacement)
	if !complete || len(packets) != 1 || packets[0] != replacement {
		t.Fatal("timestamp change should discard an incomplete frame")
	}
	stale := &rtp.Packet{Header: rtp.Header{Timestamp: 20, SequenceNumber: 105, Marker: true}, Payload: []byte{3}}
	if packets, _, complete = frame.add(stale); complete || len(packets) != 0 {
		t.Fatal("late packet from an older completed frame should be ignored")
	}

	current := &rtp.Packet{Header: rtp.Header{Timestamp: 40, SequenceNumber: 106}, Payload: []byte{4}}
	late := &rtp.Packet{Header: rtp.Header{Timestamp: 35, SequenceNumber: 107, Marker: true}, Payload: []byte{5}}
	currentMarker := &rtp.Packet{Header: rtp.Header{Timestamp: 40, SequenceNumber: 108, Marker: true}, Payload: []byte{6}}
	frame.add(current)
	if packets, _, complete = frame.add(late); complete || len(packets) != 0 {
		t.Fatal("late packet should not reset the active frame")
	}
	packets, _, complete = frame.add(currentMarker)
	if !complete || len(packets) != 2 || packets[0] != current || packets[1] != currentMarker {
		t.Fatal("late older frame should not discard the active newer frame")
	}
}

func TestVideoFrameBufferAcceptsRTPTimeStampWrap(t *testing.T) {
	var frame videoFrameBuffer
	first := &rtp.Packet{Header: rtp.Header{Timestamp: 0xfffffff0, SequenceNumber: 0}}
	sequenceBeforeWrap := &rtp.Packet{Header: rtp.Header{Timestamp: 0xfffffff0, SequenceNumber: 65535}}
	last := &rtp.Packet{Header: rtp.Header{Timestamp: 0xfffffff0, SequenceNumber: 1, Marker: true}}
	frame.add(first)
	frame.add(sequenceBeforeWrap)
	packets, _, complete := frame.add(last)
	if !complete || len(packets) != 3 {
		t.Fatal("frame should complete across RTP sequence wrap")
	}
	if packets[0] != sequenceBeforeWrap || packets[1] != first || packets[2] != last {
		t.Fatal("RTP sequence wrap should sort as 65535, 0, 1")
	}
	afterWrap := &rtp.Packet{Header: rtp.Header{Timestamp: 0x10, SequenceNumber: 0, Marker: true}}
	if packets, _, complete := frame.add(afterWrap); !complete || len(packets) != 1 || packets[0] != afterWrap {
		t.Fatal("newer timestamp after uint32 wrap should be accepted")
	}
}

func TestBitrateLimiterPacesOversizedPacketAndChargesDebt(t *testing.T) {
	limiter := newBitrateLimiter(10_000)
	if !limiter.waitForBytes(2_000, make(chan struct{})) {
		t.Fatal("oversized RTP packet should be paced and admitted")
	}
	start := time.Now()
	if !limiter.waitForBytes(100, make(chan struct{})) {
		t.Fatal("pacer unexpectedly stopped")
	}
	if elapsed := time.Since(start); elapsed < 50*time.Millisecond {
		t.Fatalf("oversized packet debt was not paced, next packet wait = %s", elapsed)
	}
}

func newTestPublicationTarget(track *pion.TrackLocalStaticRTP) *publicationTarget {
	return &publicationTarget{track: track, pending: make(chan *rtp.Packet, 2), done: make(chan struct{})}
}

func TestRouterSetLimitsUpdatesExistingPublication(t *testing.T) {
	router := NewRouter(Limits{MaxAudioBitrate: 64_000, MaxVideoBitrate: 500_000, MaxVideoFPS: 30})
	pub := &publication{
		key:      "source/audio",
		sourceID: "source",
		role:     SourceRoleAudio,
		remote:   &pion.TrackRemote{},
		limiter:  newBitrateLimiter(8_000),
	}
	router.pubs[pub.key] = pub

	router.SetLimits(Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 180_000, MaxVideoFPS: 10})

	if router.limits != (Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 180_000, MaxVideoFPS: 10}) {
		t.Fatalf("router limits = %+v, want audio=32000 video=180000 fps=10", router.limits)
	}
	// The fixture's zero-value TrackRemote reports an unknown kind, which the
	// router maps onto the video budget.
	if pub.limiter.rate != 180_000/8 {
		t.Fatalf("existing publication byte rate = %d, want %d", int(pub.limiter.rate), 180_000/8)
	}
}

func TestPublicationTargetMailboxDropsInsteadOfBlocking(t *testing.T) {
	track, err := pion.NewTrackLocalStaticRTP(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeOpus, ClockRate: 48000},
		"source|audio", "slowmeet-source-audio",
	)
	if err != nil {
		t.Fatalf("create egress track: %v", err)
	}
	target := newTestPublicationTarget(track)

	// Without a writer running the mailbox fills to its depth, and further
	// enqueues must drop instead of blocking the publisher's read loop.
	packet := &rtp.Packet{Header: rtp.Header{SSRC: 111}, Payload: []byte{1}}
	for i := 0; i < 10; i++ {
		target.enqueue(packet)
	}
	if got := len(target.pending); got != cap(target.pending) {
		t.Fatalf("mailbox held %d packets, want depth %d with excess dropped", got, cap(target.pending))
	}

	// Mailbox entries share the caller's packet on purpose: pion v4 WriteRTP
	// copies the whole packet into pooled storage before rewriting its header,
	// so concurrent target writers never mutate the shared packet. Pin the
	// contract so a pion upgrade that changes this is caught.
	first := <-target.pending
	if first != packet {
		t.Fatal("mailbox no longer shares the caller's packet pointer; re-verify the pinned pion WriteRTP copy semantics and the enqueue comment")
	}

	target.stop()
	select {
	case <-target.done:
	case <-time.After(time.Second):
		t.Fatal("target stop did not close its done channel")
	}
}

func newTestLayerPublication(t *testing.T, router *Router, layer string) *publication {
	t.Helper()
	track, err := pion.NewTrackLocalStaticRTP(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
		"publisher|camera|"+layer, "slowmeet-publisher-camera",
	)
	if err != nil {
		t.Fatalf("create %s layer track: %v", layer, err)
	}
	key := publicationKey("publisher", SourceRoleCamera, layer)
	pub := &publication{
		key: key, sourceID: "publisher", role: SourceRoleCamera, layer: layer,
		trackID: "publisher|camera|" + layer, streamID: "slowmeet-publisher-camera",
		tracks: map[string]*publicationTarget{"receiver": newTestPublicationTarget(track)},
	}
	for rank, quality := range cameraLayersByQuality {
		pub.layerKeys[rank] = publicationKey("publisher", SourceRoleCamera, quality)
	}
	router.pubs[key] = pub
	t.Cleanup(func() {
		router.mu.Lock()
		for _, request := range router.videoKeyFrameRetries {
			request.timer.Stop()
		}
		router.mu.Unlock()
	})
	return pub
}

func forwardTestFrame(t *testing.T, router *Router, pub *publication, packets ...*rtp.Packet) {
	t.Helper()
	targets, layerStarts := router.resolveFrameTargets(pub)
	for _, packet := range packets {
		for _, target := range targets {
			target.enqueue(packet)
		}
	}
	for _, receiverID := range layerStarts {
		router.requestVideoKeyFrameForPublication(pub, receiverID)
	}
}

func TestForwardPacketSelectsActiveLayerAndRequestsKeyframeOnTransition(t *testing.T) {
	router := NewRouter()
	router.videoSubscriptionsSet["receiver"] = true
	router.videoSubscriptions["receiver"] = map[string]struct{}{"publisher": {}}
	router.cameraLayers["receiver"] = "medium"

	now := time.Now()
	medium := newTestLayerPublication(t, router, "medium")
	low := newTestLayerPublication(t, router, "low")
	medium.lastPacketAt.Store(now.UnixNano())
	low.lastPacketAt.Store(now.UnixNano())

	// The first frame forwarded to a receiver inside a layer marks the layer
	// start and schedules a bounded keyframe request for its publisher.
	forwardTestFrame(t, router, medium, &rtp.Packet{Header: rtp.Header{Timestamp: 100, Marker: true}})
	if len(medium.tracks["receiver"].pending) != 1 {
		t.Fatal("selected layer packet was not enqueued for the receiver")
	}
	key, request := onlyVideoKeyFrameRetry(t, router)
	if key.receiverID != "receiver" || key.publicationKey != medium.key || request.publication != medium {
		t.Fatalf("layer entry keyframe request key = %+v, want a receiver-scoped retry on the medium publication", key)
	}

	// The receiver's preference moves to low: medium stops forwarding, clears
	// its marker, and low takes over with its own keyframe request.
	router.cameraLayers["receiver"] = "low"
	forwardTestFrame(t, router, medium, &rtp.Packet{Header: rtp.Header{Timestamp: 101, Marker: true}})
	if len(medium.tracks["receiver"].pending) != 1 {
		t.Fatal("receiver still received packets from a non-selected layer")
	}
	if medium.tracks["receiver"].lastSentLayer != "" {
		t.Fatal("medium layer marker was not cleared after the receiver moved away")
	}
	forwardTestFrame(t, router, low, &rtp.Packet{Header: rtp.Header{Timestamp: 102, Marker: true}})
	if len(low.tracks["receiver"].pending) != 1 {
		t.Fatal("receiver did not receive packets from the newly selected layer")
	}
	stopVideoKeyFrameRetry(router, key)
}

func TestSetPublicationActivePausesAndResumesMatchingRole(t *testing.T) {
	router := NewRouter()
	screen := &publication{key: "owner/screen", sourceID: "owner", role: SourceRoleScreen}
	camera := &publication{key: "owner/camera", sourceID: "owner", role: SourceRoleCamera}
	router.pubs[screen.key] = screen
	router.pubs[camera.key] = camera

	router.SetPublicationActive("owner", SourceRoleScreen, false)
	if !screen.paused.Load() {
		t.Fatal("screen publication was not paused")
	}
	if camera.paused.Load() {
		t.Fatal("pausing screen publication also paused the camera")
	}

	router.SetPublicationActive("owner", SourceRoleScreen, true)
	if screen.paused.Load() {
		t.Fatal("screen publication was not resumed")
	}
}

func TestUnregisterRemovesSourcePublicationsAndSubscriptions(t *testing.T) {
	router := NewRouter()
	sourcePeer := &webrtc.Peer{}
	targetPeer := &webrtc.Peer{}
	router.peers["source"] = sourcePeer
	router.peers["target"] = targetPeer
	router.offerers["source"] = func() error { return nil }
	router.offerers["target"] = func() error { return nil }
	router.pubs["source/audio"] = &publication{
		sourceID: "source",
		tracks:   map[string]*publicationTarget{"target": nil},
	}
	router.pubs["other/audio"] = &publication{
		sourceID: "other",
		tracks:   map[string]*publicationTarget{"source": nil, "target": nil},
	}
	router.SetVideoSubscriptionsWithLayer("source", []string{"other"}, "medium")

	router.Unregister("source")

	if _, exists := router.peers["source"]; exists {
		t.Fatal("source peer was not removed")
	}
	if _, exists := router.offerers["source"]; exists {
		t.Fatal("source offerer was not removed")
	}
	if _, exists := router.videoSubscriptionsSet["source"]; exists {
		t.Fatal("source video subscription preference was not removed")
	}
	if _, exists := router.pubs["source/audio"]; exists {
		t.Fatal("source publication was not removed")
	}
	if _, exists := router.pubs["other/audio"].tracks["source"]; exists {
		t.Fatal("source subscription was not removed")
	}
	if _, exists := router.pubs["other/audio"].tracks["target"]; !exists {
		t.Fatal("unrelated subscription was removed")
	}
}

func TestUnregisterRemovesPublisherLayerSendersFromReceivers(t *testing.T) {
	router := NewRouter()
	receiver, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create receiver peer: %v", err)
	}
	t.Cleanup(func() { _ = receiver.Close() })
	offers := 0
	router.Register("receiver", receiver, func() error {
		offers++
		return nil
	})
	track, err := pion.NewTrackLocalStaticRTP(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
		"publisher|camera|low", "slowmeet-publisher-camera",
	)
	if err != nil {
		t.Fatalf("create layer track: %v", err)
	}
	sender, err := receiver.AddTrack(track)
	if err != nil {
		t.Fatalf("add layer sender: %v", err)
	}
	key := publicationKey("publisher", SourceRoleCamera, "low")
	router.pubs[key] = &publication{
		key: key, sourceID: "publisher", role: SourceRoleCamera, layer: "low",
		tracks:  map[string]*publicationTarget{"receiver": newTestPublicationTarget(track)},
		senders: map[string]*pion.RTPSender{"receiver": sender},
	}

	router.Unregister("publisher")

	if _, exists := router.pubs[key]; exists {
		t.Fatal("publisher layer remained after unregister")
	}
	if got := len(receiver.Connection().GetSenders()); got != 0 {
		t.Fatalf("receiver retained %d sender(s), want 0", got)
	}
	if offers != 1 {
		t.Fatalf("receiver offers = %d, want one renegotiation", offers)
	}
}

func TestVideoSubscriptionPolicyPreservesLegacyAudioAndScreen(t *testing.T) {
	router := NewRouter()
	visibleCamera := &publication{sourceID: "visible", role: SourceRoleCamera}
	hiddenCamera := &publication{sourceID: "hidden", role: SourceRoleCamera}
	audio := &publication{sourceID: "hidden", role: SourceRoleAudio}
	screen := &publication{sourceID: "hidden", role: SourceRoleScreen}

	if !router.shouldSubscribeLocked(hiddenCamera, "receiver") {
		t.Fatal("receivers without preferences should keep legacy all-camera behavior")
	}
	router.SetVideoSubscriptionsWithLayer("receiver", []string{"visible"}, "medium")
	if !router.shouldSubscribeLocked(visibleCamera, "receiver") {
		t.Fatal("visible camera was not allowed")
	}
	if router.shouldSubscribeLocked(hiddenCamera, "receiver") {
		t.Fatal("off-page camera was allowed")
	}
	if !router.shouldSubscribeLocked(audio, "receiver") {
		t.Fatal("audio subscription must remain unconditional")
	}
	if !router.shouldSubscribeLocked(screen, "receiver") {
		t.Fatal("screen share subscription must remain unconditional")
	}
	router.SetVideoSubscriptionsWithLayer("receiver", nil, "medium")
	if router.shouldSubscribeLocked(visibleCamera, "receiver") {
		t.Fatal("an empty subscription list should disable all camera tracks")
	}
}

func TestSetVideoSubscriptionsAddsAndRemovesCameraTracks(t *testing.T) {
	router := NewRouter()
	peer, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create receiver peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	offers := 0
	router.Register("receiver", peer, func() error {
		offers++
		return nil
	})
	publication := &publication{
		key: "camera/camera", sourceID: "camera", role: SourceRoleCamera,
		trackID: "camera|camera", streamID: "slowmeet-camera-camera",
		codec:   pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
		tracks:  make(map[string]*publicationTarget),
		senders: make(map[string]*pion.RTPSender),
	}
	router.pubs[publication.key] = publication

	router.SetVideoSubscriptionsWithLayer("receiver", []string{"camera"}, "medium")
	if publication.tracks["receiver"] == nil || offers != 1 {
		t.Fatalf("camera was not added and renegotiated: tracks=%v offers=%d", publication.tracks, offers)
	}
	router.SetVideoSubscriptionsWithLayer("receiver", nil, "medium")
	if _, exists := publication.tracks["receiver"]; exists || offers != 2 {
		t.Fatalf("camera was not removed and renegotiated: tracks=%v offers=%d", publication.tracks, offers)
	}
}

func TestSetVideoSubscriptionsLayerSwitchDoesNotRenegotiate(t *testing.T) {
	router := NewRouter()
	peer, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create receiver peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	offers := 0
	router.Register("receiver", peer, func() error {
		offers++
		return nil
	})
	for _, layer := range []string{"low", "medium", "high"} {
		key := publicationKey("camera", SourceRoleCamera, layer)
		router.pubs[key] = &publication{
			key: key, sourceID: "camera", role: SourceRoleCamera, layer: layer,
			trackID: "camera|camera|" + layer, streamID: "slowmeet-camera-camera",
			codec:  pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
			tracks: make(map[string]*publicationTarget), senders: make(map[string]*pion.RTPSender),
		}
	}

	router.SetVideoSubscriptionsWithLayer("receiver", []string{"camera"}, "medium")
	if offers != 1 {
		t.Fatalf("offers after pre-negotiating 3 layer tracks = %d, want 1", offers)
	}
	for _, layer := range []string{"low", "medium", "high"} {
		if router.pubs[publicationKey("camera", SourceRoleCamera, layer)].tracks["receiver"] == nil {
			t.Errorf("camera %s layer was not pre-negotiated", layer)
		}
	}
	router.SetVideoSubscriptionsWithLayer("receiver", []string{"camera"}, "low")
	if offers != 1 {
		t.Fatalf("layer switch caused renegotiation: offers = %d, want 1", offers)
	}
	if got := router.cameraLayers["receiver"]; got != "low" {
		t.Fatalf("selected camera layer = %q, want low", got)
	}
}

func TestRemovePublicationDoesNotDeleteReplacement(t *testing.T) {
	router := NewRouter()
	old := &publication{
		key:      "source/audio",
		sourceID: "source",
	}
	replacement := &publication{
		key:      "source/audio",
		sourceID: "source",
	}
	router.pubs["source/audio"] = replacement

	router.removePublication(old)

	if got := router.pubs["source/audio"]; got != replacement {
		t.Fatal("replacement publication was deleted by stale forwarder")
	}
}

func TestRolePublicationIdentity(t *testing.T) {
	for _, test := range []struct {
		role     SourceRole
		key      string
		trackID  string
		streamID string
	}{
		{SourceRoleAudio, "p1/audio", "p1|audio", "slowmeet-p1-audio"},
		{SourceRoleCamera, "p1/camera", "p1|camera", "slowmeet-p1-camera"},
		{SourceRoleScreen, "p1/screen", "p1|screen", "slowmeet-p1-screen"},
	} {
		pub := &publication{
			key: test.key, sourceID: "p1", role: test.role,
			trackID: test.trackID, streamID: test.streamID,
		}
		if pub.key != test.key || pub.trackID != test.trackID || pub.streamID != test.streamID {
			t.Fatalf("publication identity = %+v, want key=%q track=%q stream=%q", pub, test.key, test.trackID, test.streamID)
		}
	}
}

func TestUnpublishRemovesOnlySelectedRole(t *testing.T) {
	router := NewRouter()
	router.pubs["p1/audio"] = &publication{key: "p1/audio", sourceID: "p1", role: SourceRoleAudio}
	router.pubs["p1/camera"] = &publication{key: "p1/camera", sourceID: "p1", role: SourceRoleCamera}
	router.pubs["p1/screen"] = &publication{key: "p1/screen", sourceID: "p1", role: SourceRoleScreen}

	router.Unpublish("p1", SourceRoleScreen)

	if _, exists := router.pubs["p1/screen"]; exists {
		t.Fatal("screen publication was not removed")
	}
	if _, exists := router.pubs["p1/audio"]; !exists {
		t.Fatal("audio publication was removed with screen")
	}
	if _, exists := router.pubs["p1/camera"]; !exists {
		t.Fatal("camera publication was removed with screen")
	}
}

func TestUnpublishRemovesEveryCameraLayer(t *testing.T) {
	router := NewRouter()
	for _, layer := range []string{"low", "medium", "high"} {
		key := publicationKey("p1", SourceRoleCamera, layer)
		router.pubs[key] = &publication{key: key, sourceID: "p1", role: SourceRoleCamera, layer: layer}
	}
	router.pubs["p1/audio"] = &publication{key: "p1/audio", sourceID: "p1", role: SourceRoleAudio}

	router.Unpublish("p1", SourceRoleCamera)

	for _, layer := range []string{"low", "medium", "high"} {
		if _, exists := router.pubs[publicationKey("p1", SourceRoleCamera, layer)]; exists {
			t.Errorf("camera %s publication remains after unpublish", layer)
		}
	}
	if _, exists := router.pubs["p1/audio"]; !exists {
		t.Fatal("audio publication was removed with camera layers")
	}
}

func TestCameraLayerFromRID(t *testing.T) {
	for _, test := range []struct{ rid, want string }{
		{"low", "low"}, {"medium", "medium"}, {"high", "high"},
		{"q", "low"}, {"h", "medium"}, {"f", "high"}, {"", ""}, {"unknown", ""},
	} {
		if got := CameraLayerFromRID(test.rid); got != test.want {
			t.Errorf("CameraLayerFromRID(%q) = %q, want %q", test.rid, got, test.want)
		}
	}
}

func newVideoKeyFrameRetryPublication(t *testing.T, receiverIDs ...string) (*Router, *publication) {
	t.Helper()

	source, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create source peer: %v", err)
	}
	t.Cleanup(func() { _ = source.Close() })

	const key = "publisher/camera"
	pub := &publication{
		key:      key,
		sourceID: "publisher",
		role:     SourceRoleCamera,
		source:   source,
		remote:   &pion.TrackRemote{},
		senders:  make(map[string]*pion.RTPSender, len(receiverIDs)),
	}
	for _, receiverID := range receiverIDs {
		pub.senders[receiverID] = &pion.RTPSender{}
	}

	router := NewRouter()
	router.pubs[key] = pub
	t.Cleanup(func() {
		router.mu.Lock()
		for _, request := range router.videoKeyFrameRetries {
			request.timer.Stop()
		}
		router.mu.Unlock()
	})
	return router, pub
}

func onlyVideoKeyFrameRetry(t *testing.T, router *Router) (videoKeyFrameRequestKey, *videoKeyFrameRetry) {
	t.Helper()
	router.mu.RLock()
	defer router.mu.RUnlock()
	if len(router.videoKeyFrameRetries) != 1 {
		t.Fatalf("scheduled video keyframe retries = %d, want 1", len(router.videoKeyFrameRetries))
	}
	for key, request := range router.videoKeyFrameRetries {
		return key, request
	}
	panic("unreachable")
}

func stopVideoKeyFrameRetry(router *Router, key videoKeyFrameRequestKey) {
	router.mu.Lock()
	if request := router.videoKeyFrameRetries[key]; request != nil {
		request.timer.Stop()
	}
	router.mu.Unlock()
}

func TestPublisherKeyFrameRetrySurvivesSubscriberRemoval(t *testing.T) {
	router, _ := newVideoKeyFrameRetryPublication(t, "selected", "remaining")
	router.RequestVideoKeyFrameForPublisher("publisher")

	key, request := onlyVideoKeyFrameRetry(t, router)
	if key.receiverID != "" {
		t.Fatalf("publisher-wide retry is scoped to receiver %q, want publication scope", key.receiverID)
	}
	stopVideoKeyFrameRetry(router, key)
	router.Unregister("selected")
	router.retryVideoKeyFrame(key, request)

	router.mu.RLock()
	continued := router.videoKeyFrameRetries[key] == request
	remaining := request.remaining
	router.mu.RUnlock()
	if !continued {
		t.Fatal("publisher retry stopped after one receiver was removed while another remained")
	}
	if remaining != videoKeyFrameRequestCount-2 {
		t.Fatalf("remaining retry count = %d, want %d", remaining, videoKeyFrameRequestCount-2)
	}
	stopVideoKeyFrameRetry(router, key)
}

func TestPublisherKeyFrameRetryStopsWithoutSubscribers(t *testing.T) {
	router, _ := newVideoKeyFrameRetryPublication(t, "first", "second")
	router.RequestVideoKeyFrameForPublisher("publisher")

	key, request := onlyVideoKeyFrameRetry(t, router)
	if key.receiverID != "" {
		t.Fatalf("publisher-wide retry is scoped to receiver %q, want publication scope", key.receiverID)
	}
	router.Unregister("first")
	router.mu.RLock()
	continuedAfterOneRemoval := router.videoKeyFrameRetries[key] == request
	router.mu.RUnlock()
	if !continuedAfterOneRemoval {
		t.Fatal("publisher retry stopped while a subscriber remained")
	}
	router.Unregister("second")

	router.mu.RLock()
	_, continued := router.videoKeyFrameRetries[key]
	router.mu.RUnlock()
	if continued {
		stopVideoKeyFrameRetry(router, key)
		t.Fatal("publisher retry continued after its last subscriber was removed")
	}
}

func TestPublisherKeyFrameRetryIsCancelledByPublicationReplacement(t *testing.T) {
	router, pub := newVideoKeyFrameRetryPublication(t, "receiver")
	router.RequestVideoKeyFrameForPublisher("publisher")

	key, _ := onlyVideoKeyFrameRetry(t, router)
	if key.receiverID != "" {
		t.Fatalf("publisher-wide retry is scoped to receiver %q, want publication scope", key.receiverID)
	}
	stopVideoKeyFrameRetry(router, key)
	replacement := &publication{key: pub.key, sourceID: pub.sourceID, role: pub.role}
	pub.remote = nil // The zero-value TrackRemote is only a fixture for the scheduled retry.
	router.Unpublish("publisher", SourceRoleCamera)
	router.mu.Lock()
	router.pubs[pub.key] = replacement
	router.mu.Unlock()

	router.mu.RLock()
	_, continued := router.videoKeyFrameRetries[key]
	router.mu.RUnlock()
	if continued {
		stopVideoKeyFrameRetry(router, key)
		t.Fatal("old publication retry remained active after replacement")
	}
}

func BenchmarkRouterForwardPacket(b *testing.B) {
	benchmarks := []struct {
		name      string
		receivers int
		layered   bool
	}{
		{name: "1 receiver", receivers: 1},
		{name: "8 receivers", receivers: 8},
		{name: "8 receivers layer selection", receivers: 8, layered: true},
	}
	for _, benchmark := range benchmarks {
		b.Run(benchmark.name, func(b *testing.B) {
			router := NewRouter()
			var pub *publication
			var writers []chan struct{}
			for _, layer := range []string{"low", "medium", "high"} {
				key := publicationKey("publisher", SourceRoleCamera, layer)
				pub = &publication{
					key: key, sourceID: "publisher", role: SourceRoleCamera, layer: layer,
					trackID: "publisher|camera|" + layer, streamID: "slowmeet-publisher-camera",
					tracks:  make(map[string]*publicationTarget, benchmark.receivers),
					senders: make(map[string]*pion.RTPSender, benchmark.receivers),
					stopped: make(chan struct{}),
				}
				for rank, quality := range cameraLayersByQuality {
					pub.layerKeys[rank] = publicationKey("publisher", SourceRoleCamera, quality)
				}
				track, err := pion.NewTrackLocalStaticRTP(
					pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
					pub.trackID, pub.streamID,
				)
				if err != nil {
					b.Fatalf("create layer track: %v", err)
				}
				for receiver := 0; receiver < benchmark.receivers; receiver++ {
					receiverID := fmt.Sprintf("receiver-%d", receiver)
					target := newTestPublicationTarget(track)
					pub.tracks[receiverID] = target
					router.cameraLayers[receiverID] = "medium"
					go target.writePackets(pub.stoppedChannel())
				}
				writers = append(writers, pub.stopped)
				pub.lastPacketAt.Store(time.Now().UnixNano())
				router.pubs[key] = pub
			}
			b.Cleanup(func() {
				for _, stopped := range writers {
					close(stopped)
				}
			})

			packet := &rtp.Packet{
				Header:  rtp.Header{Version: 2, PayloadType: 96, SequenceNumber: 1, Timestamp: 1000, SSRC: 5},
				Payload: make([]byte, 1200),
			}
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				targets, _ := router.resolveFrameTargets(pub)
				for _, target := range targets {
					target.enqueue(packet)
				}
			}
		})
	}
}
