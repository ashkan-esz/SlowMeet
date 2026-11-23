package media

import (
	"sync/atomic"
	"time"
)

// forwardLossWindow is the length of one forwarded-loss measurement window.
const forwardLossWindow = time.Second

// forwardLoss measures, for one publication, the share of the publisher's
// sequence numbers the SFU did not forward: what a receiver on a perfect
// downlink would count as lost. It covers everything between the publisher's
// encoder and the receivers' links — uplink loss the SFU's NACKs did not
// recover in time, frames skipped because their retransmissions came after
// they were forwarded, and frames the FPS gate or a full pacer queue dropped.
// A receiver discounts it from its streams so that loss is not charged to its
// own link (B1 in docs/network-testing.md). A sender's own uplink report
// cannot do this: the SFU's NACKs recover its packets, so the sender reads
// 0 % while the late ones are still never forwarded.
//
// observe runs on the publication's single forwarding goroutine; lossTenths
// may be read from any goroutine.
type forwardLoss struct {
	started     bool
	lastSeq     uint16
	ext         int64 // extended sequence number of lastSeq
	windowStart time.Time
	firstExt    int64
	maxExt      int64
	count       int64
	partialAt   time.Time

	// result is the last complete window: loss in tenths of a percent in the
	// low 32 bits and the window's forwarded packet count above, or 0 before
	// the first window completes.
	result atomic.Int64
	// partial is the window in progress, in result's encoding, refreshed at
	// most every forwardPartialInterval once it spans forwardPartialMinPackets
	// sequence numbers; 0 when it does not yet. An impairment reaches a
	// receiver's one-second sample before the window that holds it completes;
	// with completed windows only, the first second of a sender's new loss
	// was under-reported and the receiver charged the rest to its own link.
	partial atomic.Int64
}

const (
	// forwardPartialInterval is how often the window in progress is
	// published; forwardPartialMinPackets is the fewest sequence numbers it
	// must span to be worth reporting.
	forwardPartialInterval   = 250 * time.Millisecond
	forwardPartialMinPackets = 10
)

// The reported loss is the higher of the window in progress and the last
// complete window. A receiver samples its own streams on its own one-second
// clock, so a window boundary on either side can put a burst of unforwarded
// packets in the receiver's sample but not in the SFU's matching window; the
// window in progress (published every 250 ms) together with the last
// complete one covers that. Holding the worst of the last three windows as
// well over-stated a sender's loss: each window is a noisy count of about 50
// audio packets, the worst of four read a 10 % uplink as 14-20 %, and the
// excess cancelled a receiver's own download loss.

// observe records one packet forwarded to the publication's receivers.
func (f *forwardLoss) observe(sequence uint16, now time.Time) {
	if !f.started {
		f.started = true
		f.lastSeq = sequence
		f.ext = 0
		f.startWindow(0, now)
		f.count = 1
		return
	}
	delta := int64(int16(sequence - f.lastSeq))
	ext := f.ext + delta
	if delta > 0 {
		f.lastSeq, f.ext = sequence, ext
	}
	if now.Sub(f.windowStart) >= forwardLossWindow {
		f.closeWindow()
		f.startWindow(ext, now)
		f.count = 1
		return
	}
	if ext < f.firstExt {
		// A late packet from before the window began: it was forwarded, but
		// belongs to the previous span.
		return
	}
	if ext > f.maxExt {
		f.maxExt = ext
	}
	f.count++
	if now.Sub(f.partialAt) >= forwardPartialInterval && f.maxExt-f.firstExt+1 >= forwardPartialMinPackets {
		f.partialAt = now
		if value, ok := f.windowValue(); ok {
			f.partial.Store(value)
		}
	}
}

func (f *forwardLoss) startWindow(ext int64, now time.Time) {
	f.windowStart = now
	f.partialAt = now
	f.partial.Store(0)
	f.firstExt = ext
	f.maxExt = ext
	f.count = 0
}

// windowValue is the current window's loss in result's encoding.
func (f *forwardLoss) windowValue() (int64, bool) {
	expected := f.maxExt - f.firstExt + 1
	if expected <= 0 || f.count <= 0 {
		return 0, false
	}
	forwarded := f.count
	if forwarded > expected {
		forwarded = expected
	}
	return f.count<<32 | (expected-forwarded)*1000/expected, true
}

func (f *forwardLoss) closeWindow() {
	value, ok := f.windowValue()
	if !ok {
		return
	}
	f.result.Store(value)
}

// lossTenths reports the higher forwarded loss, in tenths of a percent, of the
// window in progress and the last complete window,
// and how many packets the latest complete one forwarded (the window in
// progress's before the first completes); ok is false with neither.
func (f *forwardLoss) lossTenths() (loss10 int, packets int64, ok bool) {
	value, partial := f.result.Load(), f.partial.Load()
	if value == 0 && partial == 0 {
		return 0, 0, false
	}
	packets = value >> 32
	if value == 0 {
		packets = partial >> 32
	}
	loss10 = -1
	consider := func(candidate int64) {
		if candidate != 0 && int(candidate&0xffffffff) > loss10 {
			loss10 = int(candidate & 0xffffffff)
		}
	}
	consider(value)
	consider(partial)
	return loss10, packets, true
}

// ForwardLoss reports the share of sourceID's audio and camera packets the SFU
// did not forward over the last measurement window, in tenths of a percent, or
// -1 when it has no measurement for that kind. For a simulcast camera it is
// the layer that forwarded the most packets, the one most receivers get.
func (r *Router) ForwardLoss(sourceID string) (audioLoss10, videoLoss10 int) {
	audioLoss10, videoLoss10 = -1, -1
	var videoPackets int64
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, pub := range r.pubs {
		if pub.sourceID != sourceID {
			continue
		}
		loss10, packets, ok := pub.forwardLoss.lossTenths()
		if !ok {
			continue
		}
		switch pub.role {
		case SourceRoleAudio:
			audioLoss10 = loss10
		case SourceRoleCamera:
			if packets > videoPackets {
				videoPackets, videoLoss10 = packets, loss10
			}
		}
	}
	return audioLoss10, videoLoss10
}
