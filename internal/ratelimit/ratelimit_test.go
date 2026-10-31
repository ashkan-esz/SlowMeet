package ratelimit

import (
	"net/http/httptest"
	"testing"
	"time"
)

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
