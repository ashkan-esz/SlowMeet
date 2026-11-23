package metrics

import "sync/atomic"

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

func (m *VideoDrops) Snapshot() VideoDropSnapshot {
	if m == nil {
		return VideoDropSnapshot{}
	}
	return VideoDropSnapshot{
		FramesQueueFull: m.queueFull.Load(),
		FramesFPSLimit:  m.fpsLimit.Load(),
		FramesTooLarge:  m.tooLarge.Load(),
		MailboxPackets:  m.mailbox.Load(),
		MailboxPeak:     m.mailboxPeak.Load(),
	}
}
