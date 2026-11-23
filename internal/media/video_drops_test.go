package media

import (
	"testing"
	"time"

	"SlowMeet/internal/metrics"

	"github.com/pion/rtp"
)

func TestVideoFrameDropsAreCountedByCause(t *testing.T) {
	var drops metrics.VideoDrops
	limiter := newBitrateLimiterAt(0, time.Now)
	pub := &publication{limiter: limiter, videoDrops: &drops}
	var frame videoFrameBuffer
	var history videoFrameHistory
	frames := make(chan videoFrame, 1)
	feed := func(packets []*rtp.Packet) {
		for _, packet := range packets {
			queueVideoPacket(pub, &frame, &history, frames, packet)
		}
	}
	want := func(step string, expected metrics.VideoDropSnapshot) {
		t.Helper()
		if got := drops.Snapshot(); got != expected {
			t.Fatalf("%s: drops = %+v, want %+v", step, got, expected)
		}
	}

	feed(fastLinkFramePackets(9_000, 100, 2))
	want("a frame the queue has room for", metrics.VideoDropSnapshot{})

	feed(fastLinkFramePackets(18_000, 200, 2))
	want("a frame arriving while the queue is full", metrics.VideoDropSnapshot{FramesQueueFull: 1})

	feed(fastLinkFramePackets(27_000, 300, maxFramePackets+1))
	want("a frame with more packets than the limit", metrics.VideoDropSnapshot{FramesQueueFull: 1, FramesTooLarge: 1})

	// The oversized frame's last packet is also the one that exceeds the limit
	// when the frame is exactly one packet too long; the count must not depend
	// on which packet ends the frame.
	feed(fastLinkFramePackets(36_000, 1_000, maxFramePackets+40))
	want("a much larger frame", metrics.VideoDropSnapshot{FramesQueueFull: 1, FramesTooLarge: 2})

	<-frames
	limiter.setFPS(10)
	feed(fastLinkFramePackets(900_000, 2_000, 1))
	<-frames
	feed(fastLinkFramePackets(900_000+4_500, 2_001, 1))
	want("a frame sooner than the frame-rate ceiling allows",
		metrics.VideoDropSnapshot{FramesQueueFull: 1, FramesTooLarge: 2, FramesFPSLimit: 1})
}

func TestVideoMailboxDropsAndPeakAreCounted(t *testing.T) {
	var drops metrics.VideoDrops
	router := NewRouter()
	// A two-packet mailbox with no writer: the third packet has no room.
	target := newPublicationTarget(nil, 2)
	pub := &publication{
		tracks:     map[string]*publicationTarget{"receiver": target},
		limiter:    newBitrateLimiterAt(0, time.Now),
		videoDrops: &drops,
	}
	frames := make(chan videoFrame, 1)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	t.Cleanup(func() {
		close(stop)
		<-finished
	})

	frames <- videoFrame{packets: fastLinkFramePackets(9_000, 100, 3)}
	deadline := time.Now().Add(2 * time.Second)
	for drops.Snapshot().MailboxPackets == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := drops.Snapshot(); got.MailboxPackets != 1 || got.MailboxPeak != 2 {
		t.Fatalf("drops = %+v, want one refused packet and a peak of 2", got)
	}

	var none *metrics.VideoDrops
	none.MailboxDrop()
	none.ObserveMailbox(3)
	if got := none.Snapshot(); got != (metrics.VideoDropSnapshot{}) {
		t.Fatalf("a nil counter reported %+v", got)
	}
}

func TestFramesBehindALargeKeyframeAreNotDropped(t *testing.T) {
	// A 150 KB keyframe at the 3 Mbps default keeps the pacer busy for about
	// 300 ms. The next frames of the publisher arrive during that time;
	// dropping any of them leaves the receiver unable to continue from the
	// keyframe.
	const followers = 12
	var drops metrics.VideoDrops
	router := NewRouter()
	target := newPublicationTarget(nil, targetVideoQueueDepth)
	pub := &publication{
		tracks:     map[string]*publicationTarget{"receiver": target},
		limiter:    newBitrateLimiterAt(3_000_000/8, time.Now),
		videoDrops: &drops,
	}
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	t.Cleanup(func() {
		close(stop)
		<-finished
	})

	var frame videoFrameBuffer
	var history videoFrameHistory
	feed := func(packets []*rtp.Packet) {
		for _, packet := range packets {
			queueVideoPacket(pub, &frame, &history, frames, packet)
		}
	}
	const keyframePackets = 125
	feed(fastLinkFramePackets(9_000, 1_000, keyframePackets))
	sequence := uint16(1_000 + keyframePackets)
	for index := 0; index < followers; index++ {
		feed(fastLinkFramePackets(uint32(9_000+3_000*(index+1)), sequence, 2))
		sequence += 2
	}

	wanted := keyframePackets + 2*followers
	deadline := time.After(5 * time.Second)
	for received := 0; received < wanted; received++ {
		select {
		case <-target.pending:
		case <-deadline:
			t.Fatalf("receiver got %d of %d packets; drops = %+v", received, wanted, drops.Snapshot())
		}
	}
	if got := drops.Snapshot(); got.FramesQueueFull != 0 || got.MailboxPackets != 0 {
		t.Fatalf("frames behind a large keyframe were dropped: %+v", got)
	}
}
