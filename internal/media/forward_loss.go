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

	// result is the last complete window: loss in tenths of a percent in the
	// low 32 bits and the window's forwarded packet count above, or 0 before
	// the first window completes. recent holds the windows before it.
	result atomic.Int64
	recent [forwardLossRecentWindows - 1]atomic.Int64
}

// forwardLossRecentWindows is how many complete windows lossTenths takes the
// highest loss of. A receiver samples its own streams on its own one-second
// clock, so a window boundary on either side can put a burst of unforwarded
// packets in the receiver's sample but not in the SFU's matching window;
// reporting the worst recent window keeps such a burst from reading as the
// receiver's own loss.
const forwardLossRecentWindows = 3

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
}

func (f *forwardLoss) startWindow(ext int64, now time.Time) {
	f.windowStart = now
	f.firstExt = ext
	f.maxExt = ext
	f.count = 0
}

func (f *forwardLoss) closeWindow() {
	expected := f.maxExt - f.firstExt + 1
	if expected <= 0 || f.count <= 0 {
		return
	}
	forwarded := f.count
	if forwarded > expected {
		forwarded = expected
	}
	lossTenths := (expected - forwarded) * 1000 / expected
	for index := len(f.recent) - 1; index > 0; index-- {
		f.recent[index].Store(f.recent[index-1].Load())
	}
	if len(f.recent) > 0 {
		f.recent[0].Store(f.result.Load())
	}
	f.result.Store(f.count<<32 | lossTenths)
}

// lossTenths reports the highest forwarded loss, in tenths of a percent, of the
// last forwardLossRecentWindows complete windows, and how many packets the
// latest one forwarded; ok is false before the first window completes.
func (f *forwardLoss) lossTenths() (loss10 int, packets int64, ok bool) {
	value := f.result.Load()
	if value == 0 {
		return 0, 0, false
	}
	loss10 = int(value & 0xffffffff)
	for index := range f.recent {
		if earlier := f.recent[index].Load(); earlier != 0 && int(earlier&0xffffffff) > loss10 {
			loss10 = int(earlier & 0xffffffff)
		}
	}
	return loss10, value >> 32, true
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
