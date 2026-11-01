package ratelimit

import (
	"net/http/httptest"
	"testing"
	"time"
)

func TestAllowAttemptReservesBudgetAndRefundRestoresIt(t *testing.T) {
	current := time.Unix(0, 0)
	limiter := NewWithClock(60, 2, func() time.Time { return current })
	if !limiter.AllowAttempt("192.0.2.1") || !limiter.AllowAttempt("192.0.2.1") {
		t.Fatal("expected initial attempts to be allowed")
	}
	if limiter.AllowAttempt("192.0.2.1") {
		t.Fatal("expected exhausted attempt budget to reject before verification")
	}
	limiter.RefundAttempt("192.0.2.1")
	if !limiter.AllowAttempt("192.0.2.1") {
		t.Fatal("successful verification refund did not restore one attempt")
	}
	current = current.Add(time.Minute)
	if !limiter.AllowAttempt("192.0.2.1") {
		t.Fatal("refill did not restore attempt budget")
	}
}

func TestReportFailureAllowsBurstThenBlocks(t *testing.T) {
	limiter := New(60, 3)
	for i := 0; i < 3; i++ {
		if !limiter.ReportFailure("1.2.3.4") {
			t.Fatalf("attempt %d blocked within burst", i+1)
		}
	}
	if limiter.ReportFailure("1.2.3.4") {
		t.Fatal("attempt beyond burst was allowed")
	}
}

func TestReportFailureRefillsOverTime(t *testing.T) {
	current := time.Unix(0, 0)
	limiter := New(60, 1)
	limiter.now = func() time.Time { return current }

	if !limiter.ReportFailure("1.2.3.4") {
		t.Fatal("first attempt was blocked")
	}
	if limiter.ReportFailure("1.2.3.4") {
		t.Fatal("second attempt was allowed with an empty bucket")
	}
	current = current.Add(time.Second)
	if !limiter.ReportFailure("1.2.3.4") {
		t.Fatal("refilled token was not granted after one second")
	}
}

func TestReportFailureIsolatesKeys(t *testing.T) {
	limiter := New(60, 2)
	limiter.ReportFailure("1.2.3.4")
	limiter.ReportFailure("1.2.3.4")
	if limiter.ReportFailure("1.2.3.4") {
		t.Fatal("exhausted key was allowed")
	}
	if !limiter.ReportFailure("5.6.7.8") {
		t.Fatal("independent key was throttled by another key's failures")
	}
}

func TestReportFailureBoundsBucketCount(t *testing.T) {
	limiter := New(60, 1)
	for i := 0; i < maxBuckets; i++ {
		limiter.ReportFailure("10.0.0." + string(rune('a'+i%26)) + "-" + time.Unix(0, int64(i)).String())
	}
	// Map is full: an unseen key is rejected until idle entries are swept.
	if limiter.ReportFailure("unseen-key") {
		t.Fatal("unseen key was admitted while the bucket map was full")
	}
	current := time.Now().Add(time.Hour)
	limiter.now = func() time.Time { return current }
	if !limiter.ReportFailure("unseen-key") {
		t.Fatal("idle sweep did not make room for a new key")
	}
}

func TestClientIPStripsPort(t *testing.T) {
	request := httptest.NewRequest("POST", "/room/participants", nil)
	request.RemoteAddr = "203.0.113.7:54321"
	if got := ClientIP(request); got != "203.0.113.7" {
		t.Fatalf("client IP = %q, want 203.0.113.7", got)
	}
	request.RemoteAddr = "[2001:db8::1]:443"
	if got := ClientIP(request); got != "2001:db8::1" {
		t.Fatalf("IPv6 client IP = %q, want 2001:db8::1", got)
	}
}

func TestClientIPWithTrustedProxyCIDRs(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "10.0.0.2:443"
	request.Header.Set("X-Forwarded-For", "198.51.100.42, 10.0.0.1")
	if got := ClientIPWithTrustedProxyCIDRs(request, []string{"10.0.0.0/8"}); got != "198.51.100.42" {
		t.Fatalf("trusted proxy client IP = %q, want 198.51.100.42", got)
	}

	request.RemoteAddr = "203.0.113.8:443"
	request.Header.Set("X-Forwarded-For", "198.51.100.7")
	if got := ClientIPWithTrustedProxyCIDRs(request, []string{"10.0.0.0/8"}); got != "203.0.113.8" {
		t.Fatalf("untrusted peer spoofed client IP = %q, want socket peer 203.0.113.8", got)
	}

	request.RemoteAddr = "10.0.0.2:443"
	request.Header.Set("X-Forwarded-For", "198.51.100.42, invalid")
	if got := ClientIPWithTrustedProxyCIDRs(request, []string{"10.0.0.0/8"}); got != "10.0.0.2" {
		t.Fatalf("malformed forwarded chain IP = %q, want socket peer 10.0.0.2", got)
	}
}

func TestClientIPWithTrustedProxyCIDRsSupportsIPv6(t *testing.T) {
	request := httptest.NewRequest("GET", "/", nil)
	request.RemoteAddr = "[2001:db8:1::2]:443"
	request.Header.Set("X-Forwarded-For", "2001:db8:2::42")
	if got := ClientIPWithTrustedProxyCIDRs(request, []string{"2001:db8:1::/48"}); got != "2001:db8:2::42" {
		t.Fatalf("IPv6 forwarded client IP = %q, want 2001:db8:2::42", got)
	}
}
