package media

import (
	"testing"
	"time"

	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

// The weak-network floors are the minimum server caps a degraded connection
// can receive: the config validation floors are 24 kbps audio and the client
// adaptation ladder bottoms out near 90-100 kbps video. These tests pin the
// router's behavior at those budgets: audio drops instead of blocking, video
// paces with a bounded delay, and video pacing never delays audio.

func TestWeakNetworkLimitsConvertToByteBudgets(t *testing.T) {
	limits := Limits{MaxVideoBitrate: 100_000, MaxAudioBitrate: 24_000}
	if got := rateForKind(pion.RTPCodecTypeAudio, limits); got != 3_000 {
		t.Fatalf("audio byte rate at the 24kbps floor = %d, want 3000", got)
	}
	if got := rateForKind(pion.RTPCodecTypeVideo, limits); got != 12_500 {
		t.Fatalf("video byte rate at the 100kbps floor = %d, want 12500", got)
	}
}

func TestAudioBudgetDropsInsteadOfQueueingAtFloor(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(3_000, func() time.Time { return now })

	// The burst absorbs 12 consecutive 100-byte Opus packets (20ms frames at
	// 24kbps carry ~60 bytes plus RTP overhead); the 13th exceeds the bucket
	// and must be dropped outright — never queued, never awaited.
	for i := 0; i < 12; i++ {
		if !limiter.allow(100) {
			t.Fatalf("packet %d should fit the initial 1200-byte burst", i+1)
		}
	}
	if limiter.allow(100) {
		t.Fatal("audio over budget must be dropped, not queued or paced")
	}

	now = now.Add(400 * time.Millisecond)
	if !limiter.allow(100) {
		t.Fatal("audio should resume once the 3000 B/s budget refills")
	}
}

func TestVideoFloorAdmitsOneFrameThenPaces(t *testing.T) {
	stop := make(chan struct{})
	limiter := newBitrateLimiter(12_500)

	start := time.Now()
	if !limiter.waitForBytes(12_000, stop) {
		t.Fatal("a full frame should be admitted immediately at the floor")
	}
	if elapsed := time.Since(start); elapsed > 200*time.Millisecond {
		t.Fatalf("first full frame wait = %s, want immediate admission with debt charged", elapsed)
	}

	start = time.Now()
	if !limiter.waitForBytes(1_000, stop) {
		t.Fatal("pacer unexpectedly stopped")
	}
	elapsed := time.Since(start)
	if elapsed < 700*time.Millisecond {
		t.Fatalf("next frame wait = %s, want ~940ms of pacing debt at 100kbps", elapsed)
	}
	if elapsed > 3*time.Second {
		t.Fatalf("next frame wait = %s, pacing delay is unbounded", elapsed)
	}
}

func TestVideoPacingDoesNotDelayAudioAtWeakNetworkFloor(t *testing.T) {
	router := NewRouter()
	videoTarget := newPublicationTarget(nil, targetVideoQueueDepth)
	audioTarget := newPublicationTarget(nil, targetAudioQueueDepth)
	videoPub := &publication{tracks: map[string]*publicationTarget{"receiver": videoTarget}, limiter: newBitrateLimiter(12_500)}
	audioPub := &publication{tracks: map[string]*publicationTarget{"receiver": audioTarget}}
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(videoPub, frames, stop) }()
	t.Cleanup(func() { close(stop); <-finished })

	// A 14.4KB frame needs more than a second of pacing at the 100kbps floor,
	// so the pacer goroutine is guaranteed to still be busy when audio fires.
	var frame []*rtp.Packet
	for i := 0; i < 12; i++ {
		frame = append(frame, &rtp.Packet{Header: rtp.Header{SequenceNumber: uint16(1 + i)}, Payload: make([]byte, 1200)})
	}
	frames <- videoFrame{packets: frame}

	start := time.Now()
	audioPacket := &rtp.Packet{Header: rtp.Header{SequenceNumber: 100}}
	router.forwardAudioPacket(audioPub, audioPacket)
	select {
	case got := <-audioTarget.pending:
		if got != audioPacket {
			t.Fatal("audio mailbox received a different packet")
		}
	case <-time.After(250 * time.Millisecond):
		t.Fatal("video pacing at the weak-network floor delayed audio forwarding")
	}
	if elapsed := time.Since(start); elapsed > 250*time.Millisecond {
		t.Fatalf("audio forwarding took %s while video was paced", elapsed)
	}
}
