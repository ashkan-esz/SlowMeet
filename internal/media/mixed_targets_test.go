package media

import (
	"testing"
	"time"

	"github.com/pion/rtp"
)

// The weak-network room guarantee: one publication serving receivers on very
// different links must pace once per packet and let each receiver's mailbox
// absorb (or record) its own loss. These tests exercise multi-target
// forwarding under a non-zero limiter — every other multi-target test runs
// with the limiter disabled, which hides pacing-debt interactions.

func mixedTargetsPublication(limiterRate int) (*Router, *publication, *publicationTarget, *publicationTarget, *publicationTarget) {
	router := NewRouter()
	healthy := newPublicationTarget(nil, targetVideoQueueDepth)
	saturated := newPublicationTarget(nil, 1)
	slow := newPublicationTarget(nil, 4)
	saturated.enqueue(&rtp.Packet{})
	pub := &publication{
		tracks: map[string]*publicationTarget{
			"healthy":   healthy,
			"saturated": saturated,
			"slow":      slow,
		},
		limiter: newBitrateLimiter(limiterRate),
	}
	return router, pub, healthy, saturated, slow
}

func mixedTargetPacket(sequence uint16, payloadBytes int) *rtp.Packet {
	return &rtp.Packet{
		Header:  rtp.Header{SequenceNumber: sequence, Marker: true},
		Payload: make([]byte, payloadBytes),
	}
}

func TestMixedRateTargetsIsolateLossUnderPacing(t *testing.T) {
	router, pub, healthy, saturated, slow := mixedTargetsPublication(12_500)
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	t.Cleanup(func() { close(stop); <-finished })

	// Three full-size packets at the 100kbps floor pace through shared debt
	// (~240ms); the healthy and slow mailboxes absorb all three while the
	// saturated one records its own losses.
	const packetCount = 3
	var packets []*rtp.Packet
	for i := 0; i < packetCount; i++ {
		packets = append(packets, mixedTargetPacket(uint16(200+i), 1200))
	}
	frames <- videoFrame{packets: packets}

	receive := func(target *publicationTarget, name string) *rtp.Packet {
		t.Helper()
		select {
		case got := <-target.pending:
			return got
		case <-time.After(3 * time.Second):
			t.Fatalf("%s target did not receive paced packets", name)
			return nil
		}
	}
	for i, want := range packets {
		if got := receive(healthy, "healthy"); got != want {
			t.Fatalf("healthy packet %d = %+v, want %+v (order must be preserved)", i, got.Header, want.Header)
		}
	}
	for _, packet := range packets[1:] {
		if !saturated.hasVideoLoss(packet) {
			t.Fatalf("saturated target did not record the loss of packet %d", packet.SequenceNumber)
		}
		if healthy.hasVideoLoss(packet) || slow.hasVideoLoss(packet) {
			t.Fatal("a loss recorded by the saturated target leaked into another receiver")
		}
	}

	// Drain the slow receiver's queued originals so the repair check below
	// cannot mistake a queued packet for a targeted repair.
	for i := 0; i < packetCount; i++ {
		if got := receive(slow, "slow"); got.Header.SequenceNumber != packets[i].SequenceNumber {
			t.Fatalf("slow packet %d = %d, want %d (order must be preserved)",
				i, got.Header.SequenceNumber, packets[i].SequenceNumber)
		}
	}

	// A duplicate of a lost packet must be delivered only to the receiver
	// that actually lost it, once its mailbox has room again.
	lost := packets[2]
	<-saturated.pending
	frames <- videoFrame{packets: []*rtp.Packet{lost}, repairTargets: router.videoLossTargets(pub, lost)}
	if got := receive(saturated, "saturated"); got != lost {
		t.Fatalf("repair reached the saturated target as %+v, want the lost packet", got.Header)
	}
	if saturated.hasVideoLoss(lost) {
		t.Fatal("an accepted repair must clear the loss")
	}
	select {
	case got := <-healthy.pending:
		t.Fatalf("healthy receiver got a targeted repair: %+v", got.Header)
	case got := <-slow.pending:
		t.Fatalf("slow receiver got a targeted repair: %+v", got.Header)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestSharedPacerDebtStaysBoundedForHealthyTarget(t *testing.T) {
	router, pub, healthy, _, _ := mixedTargetsPublication(12_500)
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	t.Cleanup(func() { close(stop); <-finished })

	const packetCount = 8
	frames <- videoFrame{packets: func() []*rtp.Packet {
		var packets []*rtp.Packet
		for i := 0; i < packetCount; i++ {
			packets = append(packets, mixedTargetPacket(uint16(300+i), 1200))
		}
		return packets
	}()}

	start := time.Now()
	for i := 0; i < packetCount; i++ {
		select {
		case <-healthy.pending:
		case <-time.After(3 * time.Second):
			t.Fatalf("healthy receiver stalled at packet %d behind shared pacing debt", i)
		}
	}
	// Eight 1200B packets at the 12,500 B/s floor pace for roughly 700ms;
	// anything past a generous multiple means the shared pacer starved the
	// healthy receiver.
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("healthy receiver drained in %s, shared pacing debt is unbounded", elapsed)
	}
}
