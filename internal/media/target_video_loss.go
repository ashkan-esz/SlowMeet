package media

import (
	"sync"
	"time"

	"github.com/pion/rtp"
)

const targetVideoLossSlots = 1024

type targetVideoLoss struct {
	timestamp uint32
	sequence  uint16
	expires   time.Time
}

// targetVideoLosses stores only packets dropped by this target's mailbox.
// Slots are bounded and never retain packet payloads.
type targetVideoLosses struct {
	mu    sync.Mutex
	slots [targetVideoLossSlots]targetVideoLoss
}

func (t *publicationTarget) enqueueVideo(packet *rtp.Packet) bool {
	accepted := t.enqueue(packet)
	losses := t.videoLosses.Load()
	if !accepted && losses == nil {
		candidate := &targetVideoLosses{}
		if t.videoLosses.CompareAndSwap(nil, candidate) {
			losses = candidate
		} else {
			losses = t.videoLosses.Load()
		}
	}
	if losses != nil {
		losses.mu.Lock()
		slot := &losses.slots[int(packet.SequenceNumber)%len(losses.slots)]
		if accepted {
			if slot.sequence == packet.SequenceNumber && slot.timestamp == packet.Timestamp {
				*slot = targetVideoLoss{}
			}
		} else {
			*slot = targetVideoLoss{timestamp: packet.Timestamp, sequence: packet.SequenceNumber, expires: time.Now().Add(videoRepairWindow)}
		}
		losses.mu.Unlock()
	}
	return accepted
}

func (t *publicationTarget) hasVideoLoss(packet *rtp.Packet) bool {
	losses := t.videoLosses.Load()
	if losses == nil {
		return false
	}
	losses.mu.Lock()
	slot := &losses.slots[int(packet.SequenceNumber)%len(losses.slots)]
	match := slot.sequence == packet.SequenceNumber && slot.timestamp == packet.Timestamp && time.Now().Before(slot.expires)
	losses.mu.Unlock()
	return match
}

func (r *Router) videoLossTargets(pub *publication, packet *rtp.Packet) []*publicationTarget {
	r.mu.RLock()
	defer r.mu.RUnlock()
	var targets []*publicationTarget
	for _, target := range pub.tracks {
		if target.hasVideoLoss(packet) {
			targets = append(targets, target)
		}
	}
	return targets
}
