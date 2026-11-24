package metrics

import (
	"sync/atomic"
	"time"
)

// VideoDrops counts video the SFU did not pass on, by cause and without
// participant labels. Frames are dropped whole before pacing; mailbox drops
// are single packets a receiver's writer had no room for. Every method is
// safe on a nil receiver, so publications built in tests need no counter.
type VideoDrops struct {
	queueFull   atomic.Uint64
	fpsLimit    atomic.Uint64
	tooLarge    atomic.Uint64
	mailbox     atomic.Uint64
	mailboxPeak atomic.Int64
	queuePeak   atomic.Int64
	waitMax     atomic.Int64
	keyFrames   atomic.Uint64
}

type VideoDropSnapshot struct {
	// FramesQueueFull: the pacing queue was full when the frame completed.
	FramesQueueFull uint64
	// FramesFPSLimit: the frame came sooner than the frame-rate ceiling allows.
	FramesFPSLimit uint64
	// FramesTooLarge: the frame had more packets or bytes than the SFU buffers.
	FramesTooLarge uint64
	// MailboxPackets: packets a receiver's full mailbox refused.
	MailboxPackets uint64
	// MailboxPeak: the fullest any receiver's video mailbox has been.
	MailboxPeak int64
	// FrameQueuePeak: the most frames that have waited for the pacer at once.
	FrameQueuePeak int64
	// FrameWaitMax: the longest a frame has waited in that queue.
	FrameWaitMax time.Duration
	// KeyFrames: keyframes publishers have started to send. Each costs many
	// times an ordinary frame, so a count that climbs quickly explains a
	// stream that crawls.
	KeyFrames uint64
}

func (m *VideoDrops) KeyFrame() {
	if m != nil {
		m.keyFrames.Add(1)
	}
}

func (m *VideoDrops) FrameQueueFull() {
	if m != nil {
		m.queueFull.Add(1)
	}
}

func (m *VideoDrops) FrameFPSLimit() {
	if m != nil {
		m.fpsLimit.Add(1)
	}
}

func (m *VideoDrops) FrameTooLarge() {
	if m != nil {
		m.tooLarge.Add(1)
	}
}

func (m *VideoDrops) MailboxDrop() {
	if m != nil {
		m.mailbox.Add(1)
	}
}

// ObserveMailbox records a receiver mailbox holding fill packets.
func (m *VideoDrops) ObserveMailbox(fill int) {
	if m == nil {
		return
	}
	for {
		peak := m.mailboxPeak.Load()
		if int64(fill) <= peak || m.mailboxPeak.CompareAndSwap(peak, int64(fill)) {
			return
		}
	}
}

// ObserveFrameQueue records a frame leaving the pacing queue: depth frames
// were queued with it, and it had waited that long for the pacer. Loss shows
// in the drop counters; this is the delay a queue that does not drop adds.
func (m *VideoDrops) ObserveFrameQueue(depth int, waited time.Duration) {
	if m == nil {
		return
	}
	storeMax(&m.queuePeak, int64(depth))
	storeMax(&m.waitMax, int64(waited))
}

func storeMax(peak *atomic.Int64, value int64) {
	for {
		current := peak.Load()
		if value <= current || peak.CompareAndSwap(current, value) {
			return
		}
	}
}

func (m *VideoDrops) Snapshot() VideoDropSnapshot {
	if m == nil {
		return VideoDropSnapshot{}
	}
	return VideoDropSnapshot{
		KeyFrames:       m.keyFrames.Load(),
		FrameQueuePeak:  m.queuePeak.Load(),
		FrameWaitMax:    time.Duration(m.waitMax.Load()),
		FramesQueueFull: m.queueFull.Load(),
		FramesFPSLimit:  m.fpsLimit.Load(),
		FramesTooLarge:  m.tooLarge.Load(),
		MailboxPackets:  m.mailbox.Load(),
		MailboxPeak:     m.mailboxPeak.Load(),
	}
}
