package media

import (
	"errors"
	"sync/atomic"
	"testing"
	"time"

	"SlowMeet/internal/metrics"
	"github.com/pion/rtp"
)

func TestAudioBudgetAdmitsCompliantCatchUpBurst(t *testing.T) {
	for _, rate := range []int{3_000, 12_000} {
		now := time.Unix(0, 0)
		limiter := newAudioBitrateLimiterAt(rate, func() time.Time { return now })
		now = now.Add(time.Second)
		bytes := rate / 50
		for i := range 50 {
			if !limiter.allow(bytes) {
				t.Fatalf("rate %d: compliant catch-up packet %d dropped", rate, i)
			}
		}
	}
}

func TestAudioBudgetBoundsSilenceCreditAndSustainedExcess(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newAudioBitrateLimiterAt(3_000, func() time.Time { return now })
	now = now.Add(time.Hour)
	for range 60 {
		if !limiter.allow(100) {
			t.Fatal("two-second audio credit was not available")
		}
	}
	if limiter.allow(1) {
		t.Fatal("silence accumulated more than two seconds of credit")
	}
	allowed := 0
	for range 1_000 {
		now = now.Add(10 * time.Millisecond)
		if limiter.allow(100) {
			allowed += 100
		}
	}
	if allowed > 30_000 || allowed < 29_000 {
		t.Fatalf("sustained admitted bytes = %d, want the 3000 B/s cap", allowed)
	}
}

func TestAudioBudgetCapReductionDoesNotGrantFreshCredit(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newAudioBitrateLimiterAt(12_000, func() time.Time { return now })
	if !limiter.allow(24_000) {
		t.Fatal("initial two-second credit unavailable")
	}
	limiter.setRate(3_000)
	if limiter.allow(1) {
		t.Fatal("cap reduction refilled an exhausted audio budget")
	}
	now = now.Add(100 * time.Millisecond)
	if !limiter.allow(300) || limiter.allow(1) {
		t.Fatal("reduced cap did not control subsequent refill")
	}
}

func TestAudioBudgetClockRollbackDoesNotGrantCredit(t *testing.T) {
	now := time.Unix(100, 0)
	limiter := newAudioBitrateLimiterAt(3_000, func() time.Time { return now })
	if !limiter.allow(6_000) {
		t.Fatal("initial audio budget unavailable")
	}
	now = now.Add(-time.Second)
	if limiter.allow(1) {
		t.Fatal("clock rollback granted credit")
	}
	now = now.Add(time.Second)
	if limiter.allow(1) {
		t.Fatal("returning to the previous clock value granted duplicate credit")
	}
	now = now.Add(100 * time.Millisecond)
	if !limiter.allow(300) {
		t.Fatal("normal time advance failed to refill")
	}
}

func TestAudioMailboxBoundsPacketsAndEvictsExpiredWork(t *testing.T) {
	now := time.Unix(0, 0)
	drops := &metrics.AudioDrops{}
	mailbox := newAudioMailbox(drops, func() time.Time { return now })
	packet := &rtp.Packet{Header: rtp.Header{Version: 2}, Payload: make([]byte, 100)}
	for range 256 {
		if !mailbox.enqueue(packet) {
			t.Fatal("catch-up mailbox dropped an in-bound burst")
		}
	}
	if mailbox.enqueue(packet) {
		t.Fatal("audio mailbox exceeded its 256-packet bound")
	}
	now = now.Add(81 * time.Millisecond)
	if !mailbox.enqueue(packet) {
		t.Fatal("expired backlog prevented a fresh packet")
	}
	if got := drops.Snapshot(); got.QueueOverflow != 1 || got.QueueExpired != 256 {
		t.Fatalf("drop counts = %+v, want overflow=1 expired=256", got)
	}
	oversized := &rtp.Packet{Header: rtp.Header{Version: 2}, Payload: make([]byte, receiveMTU)}
	if mailbox.enqueue(oversized) {
		t.Fatal("audio mailbox accepted a packet above its byte bound")
	}
}

func TestAudioMailboxDrainsImmediatelyAndIsolatesSlowReceiver(t *testing.T) {
	var clock atomic.Int64
	now := func() time.Time { return time.Unix(0, clock.Load()) }
	drops := &metrics.AudioDrops{}
	slow := newAudioMailbox(drops, now)
	healthy := newAudioMailbox(&metrics.AudioDrops{}, now)
	stop := make(chan struct{})
	done := make(chan struct{})
	started := make(chan struct{})
	release := make(chan struct{})
	slowFinished := make(chan struct{})
	healthyFinished := make(chan struct{})
	healthyPackets := make(chan uint16, 256)
	go func() {
		defer close(slowFinished)
		slow.writePackets(func(*rtp.Packet) error {
			select {
			case <-started:
			default:
				close(started)
			}
			<-release
			return nil
		}, done, stop)
	}()
	go func() {
		defer close(healthyFinished)
		healthy.writePackets(func(packet *rtp.Packet) error {
			healthyPackets <- packet.SequenceNumber
			return nil
		}, done, stop)
	}()
	t.Cleanup(func() { close(stop); close(release); <-slowFinished; <-healthyFinished })
	first := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 1}}
	slow.enqueue(first)
	select {
	case <-started:
	case <-time.After(time.Second):
		t.Fatal("slow writer did not start")
	}
	for i := range 200 {
		packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: uint16(i + 2)}}
		if !slow.enqueue(packet) || !healthy.enqueue(packet) {
			t.Fatal("bounded catch-up burst overflowed")
		}
	}
	for i := range 200 {
		select {
		case seq := <-healthyPackets:
			if seq != uint16(i+2) {
				t.Fatalf("healthy packet = %d, want %d", seq, i+2)
			}
		case <-time.After(time.Second):
			t.Fatal("slow receiver or pacing delayed a healthy receiver")
		}
	}
	clock.Store(int64(81 * time.Millisecond))
	// A fresh enqueue evicts the slow receiver's expired work without pacing
	// or waiting for the already-blocked socket write to return.
	if !slow.enqueue(first) {
		t.Fatal("fresh audio was blocked behind an expired backlog")
	}
	if got := drops.Snapshot().QueueExpired; got != 200 {
		t.Fatalf("expired packets = %d, want 200", got)
	}
}

func TestAudioMailboxCountsWriteFailures(t *testing.T) {
	drops := &metrics.AudioDrops{}
	mailbox := newAudioMailbox(drops, time.Now)
	stop := make(chan struct{})
	finished := make(chan struct{})
	written := make(chan struct{}, 1)
	go func() {
		defer close(finished)
		mailbox.writePackets(func(*rtp.Packet) error {
			written <- struct{}{}
			return errors.New("receiver gone")
		}, nil, stop)
	}()
	mailbox.enqueue(&rtp.Packet{Header: rtp.Header{Version: 2}})
	select {
	case <-written:
	case <-time.After(time.Second):
		t.Fatal("audio writer did not run")
	}
	close(stop)
	<-finished
	if got := drops.Snapshot().WriteFailures; got != 1 {
		t.Fatalf("write failures = %d, want 1", got)
	}
}
