// Package ratelimit provides a compact in-process token bucket used to slow
// down online password guessing on the meeting, roster-preview, and admin
// surfaces. Tokens are consumed by reported failures only, so legitimate
// traffic is never throttled, and a key over its budget means the caller
// should reject further attempts from that client.
package ratelimit

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// maxBuckets bounds memory under address-spoofing floods; unseen keys are
// rejected while the map is full until idle entries are swept.
const maxBuckets = 4096

type bucket struct {
	tokens float64
	last   time.Time
}

type Limiter struct {
	mu        sync.Mutex
	buckets   map[string]*bucket
	rate      float64 // tokens per second
	burst     float64
	now       func() time.Time
	lastSweep time.Time
}

// New creates a limiter that allows burst failures per key and refills
// continuously at failuresPerMinute.
func New(failuresPerMinute, burst int) *Limiter {
	if failuresPerMinute <= 0 {
		failuresPerMinute = 1
	}
	if burst <= 0 {
		burst = 1
	}
	return &Limiter{
		buckets:   make(map[string]*bucket),
		rate:      float64(failuresPerMinute) / 60,
		burst:     float64(burst),
		now:       time.Now,
		lastSweep: time.Now(),
	}
}

// ReportFailure consumes one attempt of budget for key and reports whether
// the caller may continue issuing password attempts for it.
func (l *Limiter) ReportFailure(key string) bool {
	if key == "" {
		return true
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	l.sweepLocked(now)
	b := l.buckets[key]
	if b == nil {
		if len(l.buckets) >= maxBuckets {
			return false
		}
		b = &bucket{tokens: l.burst, last: now}
		l.buckets[key] = b
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(b.tokens+elapsed*l.rate, l.burst)
	}
	b.last = now
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// sweepLocked drops buckets that have had enough idle time to refill fully,
// keeping the map bounded without a background goroutine.
func (l *Limiter) sweepLocked(now time.Time) {
	if now.Sub(l.lastSweep) < time.Minute {
		return
	}
	l.lastSweep = now
	idleLimit := 2 * time.Duration(l.burst/l.rate*float64(time.Second))
	for key, b := range l.buckets {
		if now.Sub(b.last) > idleLimit {
			delete(l.buckets, key)
		}
	}
}

// ClientIP extracts the best-effort client identity from a request. Trusting
// RemoteAddr (not proxy headers) keeps the limiter spoof-resistant behind the
// supported single-reverse-proxy deployments.
func ClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(strings.TrimSpace(r.RemoteAddr))
	if err != nil {
		return strings.TrimSpace(r.RemoteAddr)
	}
	return host
}
