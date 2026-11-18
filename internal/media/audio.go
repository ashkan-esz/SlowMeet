package media

import (
	"sync"
	"time"

	"SlowMeet/internal/metrics"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

const (
	audioBurstWindow      = 2 * time.Second
	maxQueuedAudioPackets = 256
	maxAudioMailboxAge    = 80 * time.Millisecond
	maxAudioMailboxBytes  = maxQueuedAudioPackets * receiveMTU
)

type queuedAudioPacket struct {
	packet *rtp.Packet
	at     time.Time
	bytes  int
}

// audioMailbox absorbs TCP catch-up bursts, not playback delay. Its writer
// drains immediately; expired entries never survive a blocked receiver.
type audioMailbox struct {
	mu      sync.Mutex
	pending [maxQueuedAudioPackets]queuedAudioPacket
	head    int
	count   int
	bytes   int
	wake    chan struct{}
	drops   *metrics.AudioDrops
	now     func() time.Time
}

func newAudioMailbox(drops *metrics.AudioDrops, now func() time.Time) *audioMailbox {
	return &audioMailbox{wake: make(chan struct{}, 1), drops: drops, now: now}
}

func (q *audioMailbox) discardLocked() queuedAudioPacket {
	packet := q.pending[q.head]
	q.pending[q.head] = queuedAudioPacket{}
	q.head = (q.head + 1) % len(q.pending)
	q.count--
	q.bytes -= packet.bytes
	return packet
}

func (q *audioMailbox) expireLocked(now time.Time) {
	var expired uint64
	for q.count > 0 && now.Sub(q.pending[q.head].at) > maxAudioMailboxAge {
		q.discardLocked()
		expired++
	}
	if expired > 0 {
		q.drops.QueueExpired.Add(expired)
	}
}

func (q *audioMailbox) enqueue(packet *rtp.Packet) bool {
	bytes := packet.MarshalSize()
	q.mu.Lock()
	now := q.now()
	q.expireLocked(now)
	if bytes > receiveMTU || q.count == len(q.pending) || q.bytes+bytes > maxAudioMailboxBytes {
		q.mu.Unlock()
		q.drops.QueueOverflow.Add(1)
		return false
	}
	tail := (q.head + q.count) % len(q.pending)
	q.pending[tail] = queuedAudioPacket{packet: packet, at: now, bytes: bytes}
	q.count++
	q.bytes += bytes
	q.mu.Unlock()
	select {
	case q.wake <- struct{}{}:
	default:
	}
	return true
}

func (q *audioMailbox) next() *rtp.Packet {
	q.mu.Lock()
	defer q.mu.Unlock()
	q.expireLocked(q.now())
	if q.count == 0 {
		return nil
	}
	return q.discardLocked().packet
}

func (q *audioMailbox) writePackets(write func(*rtp.Packet) error, done, stopped <-chan struct{}) {
	for {
		select {
		case <-done:
			return
		case <-stopped:
			return
		default:
		}
		if packet := q.next(); packet != nil {
			if err := write(packet); err != nil {
				q.drops.WriteFailures.Add(1)
			}
			continue
		}
		select {
		case <-done:
			return
		case <-stopped:
			return
		case <-q.wake:
		}
	}
}

func newPublicationBitrateLimiter(kind pion.RTPCodecType, rate int) *bitrateLimiter {
	if kind == pion.RTPCodecTypeAudio {
		return newAudioBitrateLimiterAt(rate, time.Now)
	}
	return newBitrateLimiter(rate)
}

func newAudioBitrateLimiterAt(rate int, now func() time.Time) *bitrateLimiter {
	limiter := &bitrateLimiter{now: now, last: now(), burstWindow: audioBurstWindow}
	limiter.setRate(rate)
	return limiter
}
