// Package ratelimit provides a compact in-process token bucket used to slow
// down online password guessing on the meeting, roster-preview, and admin
// surfaces. Callers reserve a token before checking credentials and refund it
// after successful authentication, so failed guesses consume the budget.
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
	return NewWithClock(failuresPerMinute, burst, time.Now)
}

// NewWithClock creates a limiter using now for token refill and idle sweeps.
// It is intended for deterministic tests and should normally receive time.Now.
func NewWithClock(failuresPerMinute, burst int, now func() time.Time) *Limiter {
	if failuresPerMinute <= 0 {
		failuresPerMinute = 1
	}
	if burst <= 0 {
		burst = 1
	}
	if now == nil {
		now = time.Now
	}
	current := now()
	return &Limiter{
		buckets:   make(map[string]*bucket),
		rate:      float64(failuresPerMinute) / 60,
		burst:     float64(burst),
		now:       now,
		lastSweep: current,
	}
}

// AllowAttempt reserves one token before credential verification. A denied
// reservation must not be followed by a password check.
func (l *Limiter) AllowAttempt(key string) bool {
	if key == "" {
		return false
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

// RefundAttempt returns a reserved token after successful authentication.
func (l *Limiter) RefundAttempt(key string) {
	if key == "" {
		return
	}
	now := l.now()
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.buckets[key]
	if b == nil {
		return
	}
	if elapsed := now.Sub(b.last).Seconds(); elapsed > 0 {
		b.tokens = min(b.tokens+elapsed*l.rate, l.burst)
	}
	b.last = now
	b.tokens = min(b.tokens+1, l.burst)
}

// ReportFailure retains the original failure-only accounting API for callers
// that cannot reserve before checking. New authentication paths should use
// AllowAttempt and RefundAttempt so verification itself is rate limited.
func (l *Limiter) ReportFailure(key string) bool {
	return l.AllowAttempt(key)
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

// ClientIP returns the socket peer address without trusting proxy headers.
func ClientIP(r *http.Request) string {
	return ClientIPWithTrustedProxyCIDRs(r, nil)
}

// ClientIPWithTrustedProxyCIDRs resolves an X-Forwarded-For chain only when
// the immediate socket peer matches one of trustedProxyCIDRs. It walks from
// the nearest hop toward the client, stopping at the first untrusted address.
// Invalid proxy CIDRs or forwarded values are ignored safely.
func ClientIPWithTrustedProxyCIDRs(r *http.Request, trustedProxyCIDRs []string) string {
	peer := socketPeerIP(r.RemoteAddr)
	if peer == nil {
		return socketPeerKey(r.RemoteAddr)
	}
	trusted := parseTrustedProxyCIDRs(trustedProxyCIDRs)
	if !isTrusted(peer, trusted) {
		return peer.String()
	}

	forwarded := strings.Join(r.Header.Values("X-Forwarded-For"), ",")
	if len(forwarded) == 0 || len(forwarded) > 8192 {
		return peer.String()
	}
	parts := strings.Split(forwarded, ",")
	chain := make([]net.IP, 0, len(parts))
	for _, part := range parts {
		ip := net.ParseIP(strings.TrimSpace(part))
		if ip == nil {
			return peer.String()
		}
		chain = append(chain, ip)
	}

	client := peer
	for i := len(chain) - 1; i >= 0 && isTrusted(client, trusted); i-- {
		client = chain[i]
	}
	return client.String()
}

func socketPeerIP(remoteAddr string) net.IP {
	host := strings.TrimSpace(remoteAddr)
	if parsedHost, _, err := net.SplitHostPort(host); err == nil {
		host = parsedHost
	}
	return net.ParseIP(host)
}

func socketPeerKey(remoteAddr string) string {
	if ip := socketPeerIP(remoteAddr); ip != nil {
		return ip.String()
	}
	if remoteAddr = strings.TrimSpace(remoteAddr); remoteAddr != "" {
		return remoteAddr
	}
	return "unknown"
}

func parseTrustedProxyCIDRs(cidrs []string) []*net.IPNet {
	trusted := make([]*net.IPNet, 0, len(cidrs))
	for _, cidr := range cidrs {
		_, network, err := net.ParseCIDR(strings.TrimSpace(cidr))
		if err == nil {
			trusted = append(trusted, network)
		}
	}
	return trusted
}

func isTrusted(ip net.IP, trusted []*net.IPNet) bool {
	for _, network := range trusted {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
