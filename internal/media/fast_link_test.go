package media

import (
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/rtp"
)

// Fast-link coverage: a publisher on a very good uplink sends large frames at
// the full frame rate and the server cap. These tests pin what the router does
// at the good end of the range, where every other limiter and frame-buffer
// test exercises the weak-network floor.

// fastLinkFramePackets builds one frame of count packets with consecutive
// sequence numbers, the marker on the last packet, and 1200 bytes on the wire
// per packet (12-byte RTP header plus payload).
func fastLinkFramePackets(timestamp uint32, firstSequence uint16, count int) []*rtp.Packet {
	packets := make([]*rtp.Packet, 0, count)
	for i := 0; i < count; i++ {
		packets = append(packets, &rtp.Packet{
			Header: rtp.Header{
				Version:        2,
				Timestamp:      timestamp,
				SequenceNumber: firstSequence + uint16(i),
				Marker:         i == count-1,
			},
			Payload: make([]byte, 1188),
		})
	}
	return packets
}

func TestVideoFrameBufferMaxPacketsBoundary(t *testing.T) {
	// A 1080p keyframe at the 3 Mbps default cap can reach ~150 KB, more than
	// 128 full-size packets; the old 128-packet limit dropped such keyframes
	// whole, so receivers kept asking for one that never arrived (B3). Frames
	// up to maxFramePackets are forwarded; only larger ones are dropped.
	tests := []struct {
		name         string
		packets      int
		wantComplete bool
	}{
		{name: "127 packets", packets: 127, wantComplete: true},
		{name: "129 packets, over the old limit", packets: 129, wantComplete: true},
		{name: "200 packet 1080p keyframe", packets: 200, wantComplete: true},
		{name: "packets at the limit", packets: maxFramePackets, wantComplete: true},
		{name: "one packet over the limit", packets: maxFramePackets + 1, wantComplete: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var buffer videoFrameBuffer
			frame := fastLinkFramePackets(90_000, 1_000, test.packets)
			var got []*rtp.Packet
			complete := false
			for i, packet := range frame {
				packets, _, done := buffer.add(packet)
				if done && i != len(frame)-1 {
					t.Fatalf("frame completed at packet %d before its marker", i)
				}
				got, complete = packets, done
			}
			if complete != test.wantComplete {
				t.Fatalf("%d-packet frame complete = %t, want %t", test.packets, complete, test.wantComplete)
			}
			if complete {
				if len(got) != test.packets {
					t.Fatalf("complete frame has %d packets, want %d", len(got), test.packets)
				}
				for i, packet := range got {
					if packet != frame[i] {
						t.Fatalf("packet %d out of order: seq %d, want %d", i, packet.SequenceNumber, frame[i].SequenceNumber)
					}
				}
			} else if len(got) != 0 {
				t.Fatalf("dropped frame exposed %d packets", len(got))
			}

			// Either way the buffer must start clean on the next frame.
			next := fastLinkFramePackets(93_000, 1_000+uint16(test.packets), 10)
			var nextComplete bool
			var nextPackets []*rtp.Packet
			for _, packet := range next {
				nextPackets, _, nextComplete = buffer.add(packet)
			}
			if !nextComplete || len(nextPackets) != len(next) {
				t.Fatalf("frame after a %d-packet frame: complete=%t packets=%d, want a complete 10-packet frame",
					test.packets, nextComplete, len(nextPackets))
			}
		})
	}
}

func TestBitrateLimiterFPSGateAtSourceRate(t *testing.T) {
	// A source at the cap passes in full, including one whose ±1 ms (±90 tick)
	// capture jitter alternates short and long gaps: the gate used to drop
	// every short gap and lost half such a source's frames (B4). A source
	// faster than the cap is still held to the cap on average.
	const fastLinkFPSFrames = 600
	const fullRate = fastLinkFPSFrames * 99 / 100
	exact := func(ticks uint64) func(int) uint32 {
		return func(i int) uint32 { return uint32(90_000 + uint64(i)*ticks) }
	}
	jittered := func(ticks uint32) func(int) uint32 {
		return func(i int) uint32 {
			timestamp := 90_000 + uint32(i)*ticks
			if i%2 == 0 {
				return timestamp + 90
			}
			return timestamp - 90
		}
	}
	tests := []struct {
		name        string
		maxFPS      int
		timestamp   func(int) uint32
		wantAllowed int // expected count (±2); 0 means "at least fullRate"
	}{
		{name: "cap 60 exact 1500 ticks", maxFPS: 60, timestamp: exact(1_500)},
		{name: "cap 60 at 59.94 fps", maxFPS: 60, timestamp: func(i int) uint32 {
			return uint32(90_000 + uint64(i)*90_000*1_001/60_000)
		}},
		{name: "cap 30 exact", maxFPS: 30, timestamp: exact(3_000)},
		{name: "cap 60 with alternating 1ms jitter", maxFPS: 60, timestamp: jittered(1_500)},
		{name: "cap 30 with alternating 1ms jitter", maxFPS: 30, timestamp: jittered(3_000)},
		// Over the cap: 120 fps at a 60 cap keeps half, 45 fps at a 30 cap keeps two thirds.
		{name: "cap 60 with a 120 fps source", maxFPS: 60, timestamp: exact(750), wantAllowed: 300},
		{name: "cap 30 with a 45 fps source", maxFPS: 30, timestamp: exact(2_000), wantAllowed: 400},
		{name: "cap 30 with a jittered 60 fps source", maxFPS: 30, timestamp: jittered(1_500), wantAllowed: 300},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			now := time.Unix(0, 0)
			limiter := newBitrateLimiterAt(0, func() time.Time { return now })
			limiter.setFPS(test.maxFPS)
			allowed := 0
			for i := 0; i < fastLinkFPSFrames; i++ {
				timestamp := test.timestamp(i)
				verdict := limiter.allowFrame(timestamp)
				if verdict {
					allowed++
				}
				// Every later packet of the same frame shares its verdict.
				if again := limiter.allowFrame(timestamp); again != verdict {
					t.Fatalf("frame %d verdict changed between its packets: %t then %t", i, verdict, again)
				}
			}
			if test.wantAllowed == 0 {
				if allowed < fullRate {
					t.Fatalf("allowed %d of %d frames at the source rate, want at least %d",
						allowed, fastLinkFPSFrames, fullRate)
				}
				return
			}
			if allowed < test.wantAllowed-2 || allowed > test.wantAllowed+2 {
				t.Fatalf("allowed %d of %d frames from a source over the cap, want %d (the cap's share)",
					allowed, fastLinkFPSFrames, test.wantAllowed)
			}
		})
	}
}

func TestVideoPacerBurstVersusTargetMailbox(t *testing.T) {
	// The pacer admits packets back to back while the token bucket holds them,
	// and each target's mailbox (targetVideoQueueDepth) must absorb that burst
	// while its writer catches up. At the floor the burst is one packet; at the
	// 3 Mbps default cap it is larger than the mailbox, so a target whose
	// writer is momentarily stalled drops the tail of a burst even on a fast
	// link. This test records those numbers so a change to either side is seen.
	packetBytes := fastLinkFramePackets(0, 0, 1)[0].MarshalSize()
	if packetBytes != 1_200 {
		t.Fatalf("test packet size = %d, want 1200", packetBytes)
	}
	tests := []struct {
		name            string
		bitsPerSecond   int
		wantBurst       int
		wantPerFrame    int // packets admitted after one 30 fps frame interval
		burstFitsTarget bool
	}{
		{name: "100 kbps floor", bitsPerSecond: 100_000, wantBurst: 1, wantPerFrame: 0, burstFitsTarget: true},
		{name: "3 Mbps default cap", bitsPerSecond: 3_000_000, wantBurst: 31, wantPerFrame: 10, burstFitsTarget: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			var clock atomic.Int64
			limiter := newBitrateLimiterAt(test.bitsPerSecond/8, func() time.Time { return time.Unix(0, clock.Load()) })
			// A closed stop channel turns waitForBytes into a non-blocking probe:
			// it returns true only when the bucket admits the packet now.
			closed := make(chan struct{})
			close(closed)
			admitBackToBack := func() int {
				count := 0
				for count < 10_000 && limiter.waitForBytes(packetBytes, closed) {
					count++
				}
				return count
			}

			burst := admitBackToBack()
			if burst != test.wantBurst {
				t.Fatalf("back-to-back burst = %d packets, want %d", burst, test.wantBurst)
			}
			if fits := burst <= targetVideoQueueDepth; fits != test.burstFitsTarget {
				t.Fatalf("burst of %d packets fits a %d-packet target mailbox = %t, want %t",
					burst, targetVideoQueueDepth, fits, test.burstFitsTarget)
			}

			clock.Add(int64(time.Second / 30))
			if got := admitBackToBack(); got != test.wantPerFrame {
				t.Fatalf("packets admitted after one 30 fps frame interval = %d, want %d", got, test.wantPerFrame)
			}
		})
	}
}

func TestHighRateFanOutToThreeHealthyTargets(t *testing.T) {
	// One fast publisher at 30 fps x 10 full-size packets (2.88 Mbps) under the
	// 3 Mbps default cap, fanned out to three healthy receivers: the budget is
	// never exhausted, so every receiver gets every packet in order and no
	// receiver records a mailbox loss.
	const (
		fastLinkFPS        = 30
		fastLinkFrameCount = 2 * fastLinkFPS
		packetsPerFrame    = 10
	)
	var clock atomic.Int64
	limiter := newBitrateLimiterAt(3_000_000/8, func() time.Time { return time.Unix(0, clock.Load()) })
	router := NewRouter()
	names := []string{"receiver-a", "receiver-b", "receiver-c"}
	pub := &publication{tracks: map[string]*publicationTarget{}, limiter: limiter}
	delivered := make(map[string]chan *rtp.Packet, len(names))
	drainStop := make(chan struct{})
	drainDone := make(chan struct{}, len(names))
	for _, name := range names {
		target := newPublicationTarget(nil, targetVideoQueueDepth)
		pub.tracks[name] = target
		out := make(chan *rtp.Packet, fastLinkFrameCount*packetsPerFrame)
		delivered[name] = out
		// The draining goroutine stands in for the target's egress writer.
		go func() {
			defer func() { drainDone <- struct{}{} }()
			for {
				select {
				case <-drainStop:
					return
				case packet := <-target.pending:
					out <- packet
				}
			}
		}()
	}
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	t.Cleanup(func() {
		close(stop)
		<-finished
		close(drainStop)
		for range names {
			<-drainDone
		}
	})

	sequence := uint16(65_000) // crosses the sequence wrap mid-test
	for frameIndex := 0; frameIndex < fastLinkFrameCount; frameIndex++ {
		packets := fastLinkFramePackets(uint32(frameIndex*90_000/fastLinkFPS), sequence, packetsPerFrame)
		sequence += packetsPerFrame
		frames <- videoFrame{packets: packets}
		for _, name := range names {
			for i, want := range packets {
				select {
				case got := <-delivered[name]:
					if got != want {
						t.Fatalf("%s frame %d packet %d = seq %d, want seq %d (order must be preserved)",
							name, frameIndex, i, got.SequenceNumber, want.SequenceNumber)
					}
				case <-time.After(3 * time.Second):
					t.Fatalf("%s did not receive frame %d packet %d", name, frameIndex, i)
				}
			}
		}
		limiter.mu.Lock()
		tokens := limiter.tokens
		limiter.mu.Unlock()
		if tokens < 0 {
			t.Fatalf("after frame %d the 3 Mbps budget is in pacing debt (%.0f bytes)", frameIndex, tokens)
		}
		// Real time between frames on the publisher's side.
		clock.Add(int64(time.Second / fastLinkFPS))
	}
	for _, name := range names {
		if losses := pub.tracks[name].videoLosses.Load(); losses != nil {
			t.Fatalf("%s recorded video loss on a fast link", name)
		}
		select {
		case extra := <-delivered[name]:
			t.Fatalf("%s received an unexpected extra packet seq %d", name, extra.SequenceNumber)
		default:
		}
	}
}
