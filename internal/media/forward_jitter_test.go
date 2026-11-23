package media

import (
	"testing"
	"time"
)

// The forwarded jitter is the RFC 3550 interarrival jitter of the packets as
// the SFU forwards them: what a receiver on a perfect downlink measures, and
// what it must discount so a sender's queueing is not charged to its own link
// (B13).
func TestForwardJitterMeasuresForwardedInterarrivalJitter(t *testing.T) {
	start := time.Unix(1_800_000_000, 0)
	for _, test := range []struct {
		name      string
		clockRate uint32
		step      uint32        // RTP timestamp step per packet
		interval  time.Duration // nominal arrival spacing
		offset    func(index int) time.Duration
		wantMs    int
	}{
		{
			name: "steady audio", clockRate: 48000, step: 960, interval: 20 * time.Millisecond,
			offset: func(int) time.Duration { return 0 }, wantMs: 0,
		},
		{
			// Every other packet 20 ms late: |D| = 20 ms on every packet, so
			// the estimate converges on 20 ms.
			name: "audio alternating 20 ms late", clockRate: 48000, step: 960, interval: 20 * time.Millisecond,
			offset: func(index int) time.Duration { return time.Duration(index%2) * 20 * time.Millisecond }, wantMs: 20,
		},
		{
			name: "video alternating 10 ms late", clockRate: 90000, step: 3000, interval: 33333 * time.Microsecond,
			offset: func(index int) time.Duration { return time.Duration(index%2) * 10 * time.Millisecond }, wantMs: 10,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			var jitter forwardJitter
			if _, ok := jitter.jitterMs(); ok {
				t.Fatal("a measurement was reported before any window completed")
			}
			// Starts just below 2^32, so the timestamp wraps within the first
			// seconds; a wrap must not read as a giant jump.
			timestamp := uint32(4_294_000_000)
			for index := 0; index < 400; index++ {
				at := start.Add(time.Duration(index)*test.interval + test.offset(index))
				jitter.observe(timestamp, test.clockRate, at)
				timestamp += test.step
			}
			got, ok := jitter.jitterMs()
			if !ok {
				t.Fatal("no measurement after several windows")
			}
			if diff := got - test.wantMs; diff < -1 || diff > 1 {
				t.Fatalf("forwarded jitter = %d ms, want %d ms (±1)", got, test.wantMs)
			}
		})
	}
}

// The reported jitter is the higher of the window in progress and the last
// complete window, so one jittery second is still discounted while a
// receiver's sample overlaps it, and it ages out once a clean window
// completes after it.
func TestForwardJitterReportsLastCompleteWindow(t *testing.T) {
	start := time.Unix(1_800_000_000, 0)
	var jitter forwardJitter
	timestamp := uint32(0)
	at := start
	send := func(seconds int, lateEveryOther time.Duration) {
		for index := 0; index < seconds*50; index++ {
			jitter.observe(timestamp, 48000, at.Add(time.Duration(index%2)*lateEveryOther))
			timestamp += 960
			at = at.Add(20 * time.Millisecond)
		}
	}
	send(2, 0)
	send(2, 40*time.Millisecond)
	if got, _ := jitter.jitterMs(); got < 30 {
		t.Fatalf("after a jittery second the reported jitter is %d ms, want the jittery window (about 40 ms)", got)
	}
	send(1, 0)
	if got, _ := jitter.jitterMs(); got < 30 {
		t.Fatalf("one clean second later the reported jitter is %d ms; the jittery window must still count", got)
	}
	send(3, 0)
	if got, _ := jitter.jitterMs(); got > 2 {
		t.Fatalf("after %d clean windows the reported jitter is %d ms, want about 0", 3, got)
	}
}

// A codec without a clock rate gives nothing to measure.
func TestForwardJitterIgnoresUnknownClockRate(t *testing.T) {
	var jitter forwardJitter
	start := time.Unix(1_800_000_000, 0)
	for index := 0; index < 200; index++ {
		jitter.observe(uint32(index*960), 0, start.Add(time.Duration(index)*20*time.Millisecond))
	}
	if _, ok := jitter.jitterMs(); ok {
		t.Fatal("a measurement was reported without a clock rate")
	}
}

func TestRouterForwardJitterPicksAudioAndBusiestCameraLayer(t *testing.T) {
	router := NewRouter()
	add := func(key string, role SourceRole, layer string, jitterMs, packets int64) {
		pub := &publication{key: key, sourceID: "p", role: role, layer: layer}
		pub.forwardLoss.result.Store(packets << 32)
		pub.forwardJitter.result.Store(jitterMs*1000 + 1)
		router.pubs[key] = pub
	}
	if audio, video := router.ForwardJitter("p"); audio != -1 || video != -1 {
		t.Fatalf("no publications = audio %d video %d, want -1 and -1", audio, video)
	}
	add("p/audio", SourceRoleAudio, "", 35, 50)
	add("p/camera/low", SourceRoleCamera, "low", 80, 20)
	add("p/camera/medium", SourceRoleCamera, "medium", 12, 90)
	if audio, video := router.ForwardJitter("p"); audio != 35 || video != 12 {
		t.Fatalf("forward jitter = audio %d video %d, want 35 and the busiest layer's 12", audio, video)
	}
	if audio, video := router.ForwardJitter("other"); audio != -1 || video != -1 {
		t.Fatalf("another source = audio %d video %d, want -1 and -1", audio, video)
	}
}

// The jitter of the window in progress is reported before it closes, like the
// loss: a sender's new queueing reaches receivers' samples first.
func TestForwardJitterReportsWindowInProgress(t *testing.T) {
	start := time.Unix(1_800_000_000, 0)
	var jitter forwardJitter
	timestamp := uint32(0)
	at := start
	send := func(packets int, lateEveryOther time.Duration) {
		for index := 0; index < packets; index++ {
			jitter.observe(timestamp, 48000, at.Add(time.Duration(index%2)*lateEveryOther))
			timestamp += 960
			at = at.Add(20 * time.Millisecond)
		}
	}
	send(60, 0) // one clean completed window (and a little of the next)
	if got, ok := jitter.jitterMs(); !ok || got > 1 {
		t.Fatalf("clean window jitter = %d ms (ok %t), want about 0", got, ok)
	}
	// Half a second of 40 ms queueing, inside the window that is still open.
	send(25, 40*time.Millisecond)
	if got, _ := jitter.jitterMs(); got < 20 {
		t.Fatalf("window in progress jitter = %d ms, want the queueing reported before the window closes", got)
	}
}
