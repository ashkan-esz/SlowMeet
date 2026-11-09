package media

import (
	"testing"
	"time"

	"github.com/pion/rtp"
)

func TestTargetVideoLossBoundaries(t *testing.T) {
	target := newPublicationTarget(nil, 1)
	packet := &rtp.Packet{Header: rtp.Header{Timestamp: 5, SequenceNumber: 65535}}
	target.enqueue(&rtp.Packet{})
	if target.enqueueVideo(packet) || !target.hasVideoLoss(packet) {
		t.Fatal("a full mailbox must record the dropped packet")
	}
	otherTime := &rtp.Packet{Header: rtp.Header{Timestamp: 6, SequenceNumber: 65535}}
	otherSequence := &rtp.Packet{Header: rtp.Header{Timestamp: 5, SequenceNumber: 0}}
	if target.hasVideoLoss(otherTime) || target.hasVideoLoss(otherSequence) {
		t.Fatal("a different timestamp or wrapped sequence must not match")
	}
	losses := target.videoLosses.Load()
	losses.mu.Lock()
	losses.slots[int(packet.SequenceNumber)%len(losses.slots)].expires = time.Now().Add(-time.Second)
	losses.mu.Unlock()
	if target.hasVideoLoss(packet) {
		t.Fatal("an expired loss must not match")
	}
}

func TestVideoPacerRepairsOnlyDroppedTarget(t *testing.T) {
	router := NewRouter()
	slow := newPublicationTarget(nil, 1)
	healthy := newPublicationTarget(nil, 8)
	pub := &publication{tracks: map[string]*publicationTarget{"slow": slow, "healthy": healthy}, limiter: newBitrateLimiter(0)}
	queue := make(chan videoFrame, 8)
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, queue, stop) }()
	t.Cleanup(func() { close(stop); <-finished })

	var buffer videoFrameBuffer
	var history videoFrameHistory
	packet := &rtp.Packet{Header: rtp.Header{Timestamp: 100, SequenceNumber: 65535, Marker: true}}
	slow.enqueue(&rtp.Packet{})
	if queueVideoPacket(pub, &buffer, &history, queue, packet) {
		t.Fatal("the original frame is not a duplicate")
	}
	receive := func(target *publicationTarget) *rtp.Packet {
		t.Helper()
		select {
		case got := <-target.pending:
			return got
		case <-time.After(time.Second):
			t.Fatal("timed out waiting for a paced packet")
			return nil
		}
	}
	if receive(healthy) != packet {
		t.Fatal("the healthy target must receive the original while the slow target records loss")
	}
	firstBarrier := &rtp.Packet{Header: rtp.Header{Timestamp: 150, SequenceNumber: 0, Marker: true}}
	queue <- videoFrame{packets: []*rtp.Packet{firstBarrier}}
	if receive(healthy) != firstBarrier || !slow.hasVideoLoss(packet) {
		t.Fatal("the slow target must record the original loss")
	}
	if !queueVideoPacket(pub, &buffer, &history, queue, packet) {
		t.Fatal("the returning packet must be identified as a duplicate")
	}
	queue <- videoFrame{packets: []*rtp.Packet{packet}, repairTargets: router.videoLossTargets(pub, packet)}
	// A following ordinary frame is a barrier: once it reaches the healthy
	// target, the preceding repair attempt has run while slow is still full.
	barrier := &rtp.Packet{Header: rtp.Header{Timestamp: 200, SequenceNumber: 0, Marker: true}}
	queue <- videoFrame{packets: []*rtp.Packet{barrier}}
	if receive(healthy) != barrier || !slow.hasVideoLoss(packet) {
		t.Fatal("a repair rejected by a full mailbox must remain eligible")
	}
	<-slow.pending
	queue <- videoFrame{packets: []*rtp.Packet{packet}, repairTargets: router.videoLossTargets(pub, packet)}
	if receive(slow) != packet {
		t.Fatal("the slow target must receive the repair")
	}
	queue <- videoFrame{packets: []*rtp.Packet{packet}, repairTargets: []*publicationTarget{slow}}
	barrier2 := &rtp.Packet{Header: rtp.Header{Timestamp: 300, SequenceNumber: 1, Marker: true}}
	queue <- videoFrame{packets: []*rtp.Packet{barrier2}}
	if receive(healthy) != barrier2 {
		t.Fatal("healthy target must not receive the targeted repair")
	}
	if slow.hasVideoLoss(packet) {
		t.Fatal("an accepted repair must clear the loss")
	}
	if receive(slow) != barrier2 {
		t.Fatal("a duplicate queued repair must not be sent twice")
	}
}

func TestVideoLossTargetsExcludesReplacedTarget(t *testing.T) {
	router := NewRouter()
	old := newPublicationTarget(nil, 1)
	old.enqueue(&rtp.Packet{})
	packet := &rtp.Packet{Header: rtp.Header{Timestamp: 1, SequenceNumber: 1}}
	old.enqueueVideo(packet)
	replacement := newPublicationTarget(nil, 1)
	pub := &publication{tracks: map[string]*publicationTarget{"receiver": replacement}}
	if len(router.videoLossTargets(pub, packet)) != 0 {
		t.Fatal("a replaced target's loss must not transfer to its replacement")
	}
}

func TestVideoPacerSkipsReplacedRepairTarget(t *testing.T) {
	router := NewRouter()
	old := newPublicationTarget(nil, 1)
	old.enqueue(&rtp.Packet{})
	packet := &rtp.Packet{Header: rtp.Header{Timestamp: 1, SequenceNumber: 1}}
	old.enqueueVideo(packet)
	replacement := newPublicationTarget(nil, 1)
	pub := &publication{tracks: map[string]*publicationTarget{"receiver": replacement}, limiter: newBitrateLimiter(0)}
	frames := make(chan videoFrame, 2)
	frames <- videoFrame{packets: []*rtp.Packet{packet}, repairTargets: []*publicationTarget{old}}
	barrier := &rtp.Packet{Header: rtp.Header{Timestamp: 2, SequenceNumber: 2}}
	frames <- videoFrame{packets: []*rtp.Packet{barrier}}
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	defer func() { close(stop); <-finished }()
	select {
	case got := <-replacement.pending:
		if got != barrier {
			t.Fatal("a queued repair must not reach a replacement target")
		}
	case <-time.After(time.Second):
		t.Fatal("pacer did not reach the barrier")
	}
	if len(old.pending) != 1 {
		t.Fatal("a queued repair must not reach the removed target")
	}
}
