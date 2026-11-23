package media

import (
	"math"
	"sync/atomic"
	"time"
)

// forwardJitter measures, for one publication, the RFC 3550 interarrival
// jitter of the packets the SFU forwards, at the moment it forwards them: what
// a receiver on a perfect downlink would measure. It covers the publisher's
// uplink queueing and anything the SFU adds before forwarding (frame assembly
// and pacing for video). A receiver discounts it from its streams so a
// sender's queueing is not charged to its own link (B13 in
// docs/network-testing.md). The sender's own report of the same jitter
// reaches the SFU over that sender's bad uplink in an RTCP receiver report,
// once a second at best, and goes missing or stale exactly when the uplink is
// worst; every gap left the receiver with no discount.
//
// observe runs on the publication's single forwarding goroutine; jitterMs may
// be read from any goroutine.
type forwardJitter struct {
	started       bool
	lastTimestamp uint32
	lastArrival   time.Time
	jitter        float64 // seconds, RFC 3550 estimate
	windowStart   time.Time
	windowMax     float64 // seconds, highest estimate seen in the window
	windowPackets int
	partialAt     time.Time

	// result is the last complete window's highest estimate in microseconds
	// plus one (0 before the first window completes); recent holds the
	// windows before it, like forwardLoss.
	result atomic.Int64
	recent [forwardLossRecentWindows - 1]atomic.Int64
	// partial is the window in progress, like forwardLoss.partial: a sender's
	// new queueing reaches receivers' samples before its window completes.
	partial atomic.Int64
}

// observe records one packet forwarded to the publication's receivers, with
// its RTP timestamp and the codec's clock rate.
func (j *forwardJitter) observe(timestamp uint32, clockRate uint32, now time.Time) {
	if clockRate == 0 {
		return
	}
	if !j.started {
		j.started = true
		j.lastTimestamp, j.lastArrival = timestamp, now
		j.windowStart, j.partialAt = now, now
		return
	}
	// D(i-1, i) = (arrival difference) - (RTP timestamp difference); the
	// signed timestamp difference survives the 32-bit wrap.
	difference := now.Sub(j.lastArrival).Seconds() -
		float64(int32(timestamp-j.lastTimestamp))/float64(clockRate)
	j.lastTimestamp, j.lastArrival = timestamp, now
	j.jitter += (math.Abs(difference) - j.jitter) / 16
	if now.Sub(j.windowStart) >= forwardLossWindow {
		j.closeWindow()
		j.windowStart, j.partialAt = now, now
		j.windowMax = j.jitter
		j.windowPackets = 1
		j.partial.Store(0)
		return
	}
	if j.jitter > j.windowMax {
		j.windowMax = j.jitter
	}
	j.windowPackets++
	if now.Sub(j.partialAt) >= forwardPartialInterval && j.windowPackets >= forwardPartialMinPackets {
		j.partialAt = now
		j.partial.Store(int64(math.Round(j.windowMax*1e6)) + 1)
	}
}

func (j *forwardJitter) closeWindow() {
	for index := len(j.recent) - 1; index > 0; index-- {
		j.recent[index].Store(j.recent[index-1].Load())
	}
	if len(j.recent) > 0 {
		j.recent[0].Store(j.result.Load())
	}
	j.result.Store(int64(math.Round(j.windowMax*1e6)) + 1)
}

// jitterMs reports the highest jitter, in milliseconds, of the window in
// progress and the last forwardLossRecentWindows complete windows; ok is
// false with neither. Like the loss, the worst recent window keeps a burst
// that a receiver's one-second sample caught but the SFU's matching window
// split from reading as the receiver's own jitter.
func (j *forwardJitter) jitterMs() (int, bool) {
	value := j.result.Load()
	if partial := j.partial.Load(); partial > value {
		value = partial
	}
	if value == 0 {
		return 0, false
	}
	for index := range j.recent {
		if earlier := j.recent[index].Load(); earlier > value {
			value = earlier
		}
	}
	return int(math.Round(float64(value-1) / 1000)), true
}

// ForwardJitter reports the jitter of sourceID's audio and camera packets as
// the SFU forwards them, in milliseconds, or -1 when it has no measurement
// for that kind. For a simulcast camera it is the layer that forwarded the
// most packets, the one most receivers get (as ForwardLoss picks it).
func (r *Router) ForwardJitter(sourceID string) (audioJitterMs, videoJitterMs int) {
	audioJitterMs, videoJitterMs = -1, -1
	var videoPackets int64 = -1
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, pub := range r.pubs {
		if pub.sourceID != sourceID {
			continue
		}
		jitterMs, ok := pub.forwardJitter.jitterMs()
		if !ok {
			continue
		}
		switch pub.role {
		case SourceRoleAudio:
			audioJitterMs = jitterMs
		case SourceRoleCamera:
			_, packets, _ := pub.forwardLoss.lossTenths()
			if packets > videoPackets {
				videoPackets, videoJitterMs = packets, jitterMs
			}
		}
	}
	return audioJitterMs, videoJitterMs
}
