package media

import (
	"testing"
	"time"

	"SlowMeet/internal/metrics"

	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

func TestVideoKeyFrameStartIsRecognisedPerCodec(t *testing.T) {
	picture := []byte{0xAA, 0xBB, 0xCC, 0xDD}
	with := func(header ...byte) []byte { return append(header, picture...) }
	tests := []struct {
		name    string
		mime    string
		payload []byte
		want    bool
	}{
		{"VP8 keyframe", pion.MimeTypeVP8, with(0x10, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a), true},
		{"VP8 keyframe behind a picture ID", pion.MimeTypeVP8, with(0x90, 0x80, 0x05, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a), true},
		{"VP8 keyframe behind a long picture ID", pion.MimeTypeVP8,
			with(0x90, 0x80, 0x81, 0x05, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a), true},
		{"VP8 ordinary frame", pion.MimeTypeVP8, with(0x10, 0x01, 0x00, 0x00, 0x9d, 0x01, 0x2a), false},
		{"VP8 later packet of a keyframe", pion.MimeTypeVP8, with(0x00, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a), false},
		{"VP8 later partition", pion.MimeTypeVP8, with(0x11, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a), false},
		{"VP8 without the keyframe start code", pion.MimeTypeVP8, with(0x10, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00), false},
		{"VP8 with a reserved bit set", pion.MimeTypeVP8, with(0x50, 0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a), false},
		{"text that is not VP8 at all", pion.MimeTypeVP8, []byte("p2/camera"), false},

		{"VP9 keyframe", pion.MimeTypeVP9, with(0x88, 0x05), true},
		{"VP9 ordinary frame", pion.MimeTypeVP9, with(0xC8, 0x05), false},
		{"VP9 later packet of a keyframe", pion.MimeTypeVP9, with(0x80, 0x05), false},
		{"VP9 keyframe of a higher spatial layer", pion.MimeTypeVP9, with(0xA8, 0x05, 0x02, 0x00), false},
		{"VP9 keyframe of the lowest spatial layer", pion.MimeTypeVP9, with(0xA8, 0x05, 0x00, 0x00), true},

		{"AV1 new sequence", pion.MimeTypeAV1, with(0x08), true},
		{"AV1 new sequence, one element", pion.MimeTypeAV1, with(0x18), true},
		{"AV1 ordinary frame", pion.MimeTypeAV1, with(0x10), false},
		{"AV1 continuation", pion.MimeTypeAV1, with(0x88), false},

		{"H.264 picture that needs no other", pion.MimeTypeH264, with(0x65), true},
		{"H.264 parameter set", pion.MimeTypeH264, with(0x67), true},
		{"H.264 ordinary slice", pion.MimeTypeH264, with(0x41), false},
		{"H.264 aggregate with a parameter set", pion.MimeTypeH264,
			[]byte{0x78, 0x00, 0x02, 0x67, 0x42, 0x00, 0x01, 0x68}, true},
		{"H.264 aggregate whose second unit is the picture", pion.MimeTypeH264,
			[]byte{0x78, 0x00, 0x02, 0x06, 0x01, 0x00, 0x02, 0x65, 0x88}, true},
		{"H.264 aggregate of ordinary units", pion.MimeTypeH264,
			[]byte{0x78, 0x00, 0x02, 0x06, 0x01, 0x00, 0x02, 0x41, 0x9A}, false},
		{"H.264 truncated aggregate", pion.MimeTypeH264, []byte{0x78, 0x00, 0x09, 0x06}, false},
		{"H.264 first fragment of the picture", pion.MimeTypeH264, with(0x7C, 0x85), true},
		{"H.264 later fragment of the picture", pion.MimeTypeH264, with(0x7C, 0x05), false},
		{"H.264 first fragment of an ordinary slice", pion.MimeTypeH264, with(0x7C, 0x81), false},

		{"lower-case codec name", "video/av1", with(0x08), true},
		{"unknown codec", "video/H265", with(0x08), false},
		{"no codec", "", with(0x08), false},
		{"empty payload", pion.MimeTypeAV1, nil, false},
		{"one byte of VP8", pion.MimeTypeVP8, []byte{0x10}, false},
	}
	for _, test := range tests {
		if got := startsVideoKeyFrame(test.mime, test.payload); got != test.want {
			t.Errorf("%s: startsVideoKeyFrame = %v, want %v", test.name, got, test.want)
		}
	}
}

func TestKeyFrameComing(t *testing.T) {
	now := time.Now()
	ago := func(d time.Duration) int64 { return now.Add(-d).UnixNano() }
	tests := []struct {
		name               string
		started, forwarded int64
		since              int64
		want               bool
	}{
		{"no keyframe seen", 0, 0, ago(0), false},
		{"one is arriving", ago(time.Second), 0, ago(0), true},
		{"one is arriving after an earlier one went out", ago(time.Second), ago(10 * time.Second), ago(0), true},
		{"one started long ago and never went out", ago(keyFrameArrivalLimit + time.Second), 0, ago(0), false},
		{"the last one went out before the request", ago(3 * time.Second), ago(2 * time.Second), ago(time.Second), false},
		{"one went out after the request", ago(2 * time.Second), ago(500 * time.Millisecond), ago(time.Second), true},
	}
	for _, test := range tests {
		pub := &publication{}
		pub.lastKeyFrameStart.Store(test.started)
		pub.lastKeyFrameForward.Store(test.forwarded)
		if got := pub.keyFrameComing(now, test.since); got != test.want {
			t.Errorf("%s: keyFrameComing = %v, want %v", test.name, got, test.want)
		}
	}
}

func TestKeyFrameInTransit(t *testing.T) {
	now := time.Now()
	ago := func(d time.Duration) int64 { return now.Add(-d).UnixNano() }
	tests := []struct {
		name          string
		started, sent int64
		want          bool
	}{
		{"no keyframe seen", 0, 0, false},
		{"arriving or being sent", ago(2 * time.Second), 0, true},
		{"the next one is arriving", ago(time.Second), ago(8 * time.Second), true},
		{"started long ago and never sent", ago(keyFrameArrivalLimit + time.Second), 0, false},
		{"sent a moment ago", ago(3 * time.Second), ago(100 * time.Millisecond), true},
		{"sent a while ago", ago(3 * time.Second), ago(time.Second), false},
	}
	for _, test := range tests {
		pub := &publication{}
		pub.lastKeyFrameStart.Store(test.started)
		pub.lastKeyFrameSent.Store(test.sent)
		if got := pub.keyFrameInTransit(now); got != test.want {
			t.Errorf("%s: keyFrameInTransit = %v, want %v", test.name, got, test.want)
		}
	}
}

func vp8TestFrame(timestamp uint32, firstSequence uint16, count int, keyFrame bool) []*rtp.Packet {
	packets := fastLinkFramePackets(timestamp, firstSequence, count)
	for index, packet := range packets {
		packet.Payload[0] = 0x00
		if index == 0 {
			packet.Payload[0] = 0x10
		}
		packet.Payload[1] = 0x01
		if keyFrame {
			copy(packet.Payload[1:], []byte{0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a})
		}
	}
	return packets
}

func TestKeyFramesAreCountedOnceAndMarkedOnTheirWayOut(t *testing.T) {
	var drops metrics.VideoDrops
	router := NewRouter()
	target := newPublicationTarget(nil, targetVideoQueueDepth)
	pub := &publication{
		codec:      pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
		tracks:     map[string]*publicationTarget{"receiver": target},
		limiter:    newBitrateLimiterAt(0, time.Now),
		videoDrops: &drops,
	}
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	var frame videoFrameBuffer
	var history videoFrameHistory
	feed := func(packets []*rtp.Packet) {
		for _, packet := range packets {
			queueVideoPacket(pub, &frame, &history, frames, packet)
		}
	}

	keyFrame := vp8TestFrame(9_000, 100, 3, true)
	feed(keyFrame[:1])
	if !pub.keyFrameComing(time.Now(), time.Now().UnixNano()) {
		t.Fatal("a keyframe whose first packet arrived is not reported as coming")
	}
	feed(keyFrame[1:])
	// A retransmission of the first packet is the same keyframe.
	feed(keyFrame[:1])
	feed(vp8TestFrame(12_000, 103, 2, false))
	if got := drops.Snapshot().KeyFrames; got != 1 {
		t.Fatalf("keyframes counted = %d, want 1", got)
	}
	if first := <-frames; !first.keyFrame {
		t.Fatal("the queued keyframe is not marked as one")
	} else {
		frames <- first
	}

	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	t.Cleanup(func() {
		close(stop)
		<-finished
	})
	if !pub.keyFrameInTransit(time.Now()) {
		t.Fatal("a queued keyframe is not reported as in transit")
	}
	deadline := time.Now().Add(2 * time.Second)
	for pub.lastKeyFrameSent.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if pub.lastKeyFrameForward.Load() == 0 || pub.lastKeyFrameSent.Load() == 0 {
		t.Fatal("the pacer passed the keyframe on without recording it")
	}
	// It went out: a receiver that subscribes from now on needs a new one.
	if pub.keyFrameComing(time.Now(), time.Now().UnixNano()) {
		t.Fatal("a keyframe that already went out is still reported as coming")
	}
}

func TestKeyFrameRequestIsNotRepeatedOnceAKeyFrameIsComing(t *testing.T) {
	for _, coming := range []bool{false, true} {
		router, pub := newVideoKeyFrameRetryPublication(t, "viewer")
		router.RequestVideoKeyFrameForPublisher("publisher")
		key, request := onlyVideoKeyFrameRetry(t, router)
		stopVideoKeyFrameRetry(router, key)
		if coming {
			pub.lastKeyFrameStart.Store(time.Now().UnixNano())
		}
		router.retryVideoKeyFrame(key, request)

		router.mu.RLock()
		_, continued := router.videoKeyFrameRetries[key]
		router.mu.RUnlock()
		stopVideoKeyFrameRetry(router, key)
		if continued == coming {
			t.Fatalf("keyframe coming = %v: the series continued = %v", coming, continued)
		}
	}
}

func TestPacedVideoBytesSpeedUpALateFrame(t *testing.T) {
	now := time.Now()
	tests := []struct {
		name   string
		waited time.Duration
		want   int
	}{
		{"on time", 0, 1200},
		{"just under the first limit", videoCatchUpAfter - 50*time.Millisecond, 1200},
		{"late", videoCatchUpAfter + 50*time.Millisecond, 800},
		{"very late", videoCatchUpFastAfter + 50*time.Millisecond, 600},
	}
	for _, test := range tests {
		if got := pacedVideoBytes(1200, now.Add(-test.waited)); got != test.want {
			t.Errorf("%s: pacedVideoBytes = %d, want %d", test.name, got, test.want)
		}
	}
	if got := pacedVideoBytes(1200, time.Time{}); got != 1200 {
		t.Errorf("a frame with no queue time is charged %d, want its size", got)
	}
	if got := pacedVideoBytes(1, now.Add(-time.Hour)); got != 1 {
		t.Errorf("the smallest packet is charged %d, want 1", got)
	}
}

func TestASenderALittleOverTheRateDoesNotFallBehind(t *testing.T) {
	// A sender encoding at exactly the server's limit is a few percent over
	// it once headers are counted; this one is 30% over, for three seconds.
	// At the plain rate the queue would be 0.7 s behind by the end and keep
	// falling; the pacer must catch up instead.
	const rate = 3_000_000 / 8
	const fps = 60
	var drops metrics.VideoDrops
	router := NewRouter()
	target := newPublicationTarget(nil, targetVideoQueueDepth)
	pub := &publication{
		tracks:     map[string]*publicationTarget{"receiver": target},
		limiter:    newBitrateLimiterAt(rate, time.Now),
		videoDrops: &drops,
	}
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	go func() {
		for {
			select {
			case <-stop:
				return
			case <-target.pending:
			}
		}
	}()
	t.Cleanup(func() {
		close(stop)
		<-finished
	})

	var frame videoFrameBuffer
	var history videoFrameHistory
	const packetsPerFrame = 7
	payload := rate*13/10/fps/packetsPerFrame - 12
	sequence := uint16(1)
	ticker := time.NewTicker(time.Second / fps)
	defer ticker.Stop()
	for index := 0; index < 3*fps; index++ {
		<-ticker.C
		for part := 0; part < packetsPerFrame; part++ {
			queueVideoPacket(pub, &frame, &history, frames, &rtp.Packet{
				Header: rtp.Header{Version: 2, Timestamp: uint32(9_000 + 1_500*index),
					SequenceNumber: sequence, Marker: part == packetsPerFrame-1},
				Payload: make([]byte, payload),
			})
			sequence++
		}
	}
	got := drops.Snapshot()
	if got.FrameWaitMax > 600*time.Millisecond || got.FramesQueueFull != 0 {
		t.Fatalf("after three seconds 30%% over the rate: longest wait %v, %d frames dropped; want under 600ms and none",
			got.FrameWaitMax, got.FramesQueueFull)
	}
	if got.FrameQueuePeak == 0 {
		t.Fatal("the frame queue's peak was not recorded")
	}
}
