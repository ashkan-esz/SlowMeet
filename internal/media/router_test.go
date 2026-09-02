package media

import (
	"testing"
	"time"

	"SlowMeet/internal/webrtc"
	pion "github.com/pion/webrtc/v4"
)

func TestBitrateLimiterDropsWithoutQueueingAndRefills(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(100_000, func() time.Time { return now })

	if !limiter.allow(10_000) {
		t.Fatal("initial burst should be allowed")
	}
	if limiter.allow(1) {
		t.Fatal("packet should be dropped when the bucket is empty")
	}

	now = now.Add(10 * time.Millisecond)
	if !limiter.allow(100) {
		t.Fatal("packet should be allowed after the bucket refills")
	}
}

func TestBitrateLimiterZeroRateDoesNotShape(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(0, func() time.Time { return now })

	if !limiter.allow(1_000_000) {
		t.Fatal("zero rate should disable shaping")
	}
}

func TestBitrateLimiterSetRateAppliesImmediately(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(0, func() time.Time { return now })
	limiter.setRate(100_000)

	if !limiter.allow(10_000) {
		t.Fatal("new rate should allow an initial burst")
	}
	if limiter.allow(1) {
		t.Fatal("new rate should be enforced immediately")
	}
}

func TestBitrateLimiterCapsVideoFramesWithoutQueueing(t *testing.T) {
	limiter := newBitrateLimiterAt(0, time.Now)
	limiter.setFPS(10)

	if !limiter.allowFrame(0) {
		t.Fatal("first frame should be allowed")
	}
	if limiter.allowFrame(4_500) {
		t.Fatal("frame inside the FPS interval should be dropped")
	}
	if !limiter.allowFrame(9_000) {
		t.Fatal("frame at the FPS interval should be allowed")
	}
	if !limiter.allowFrame(9_000) {
		t.Fatal("packets from an allowed frame should remain allowed")
	}
}

func TestRouterSetLimitsUpdatesExistingPublication(t *testing.T) {
	router := NewRouter(Limits{MaxAudioBitrate: 64_000, MaxVideoBitrate: 500_000, MaxVideoFPS: 30})
	router.SetLimits(Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 180_000, MaxVideoFPS: 10})

	if router.limits != (Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 180_000, MaxVideoFPS: 10}) {
		t.Fatalf("router limits = %+v, want audio=32000 video=180000 fps=10", router.limits)
	}
}

func TestUnregisterRemovesSourcePublicationsAndSubscriptions(t *testing.T) {
	router := NewRouter()
	sourcePeer := &webrtc.Peer{}
	targetPeer := &webrtc.Peer{}
	router.peers["source"] = sourcePeer
	router.peers["target"] = targetPeer
	router.offerers["source"] = func() error { return nil }
	router.offerers["target"] = func() error { return nil }
	router.pubs["source/audio"] = &publication{
		sourceID: "source",
		tracks:   map[string]*pion.TrackLocalStaticRTP{"target": nil},
	}
	router.pubs["other/audio"] = &publication{
		sourceID: "other",
		tracks:   map[string]*pion.TrackLocalStaticRTP{"source": nil, "target": nil},
	}

	router.Unregister("source")

	if _, exists := router.peers["source"]; exists {
		t.Fatal("source peer was not removed")
	}
	if _, exists := router.offerers["source"]; exists {
		t.Fatal("source offerer was not removed")
	}
	if _, exists := router.pubs["source/audio"]; exists {
		t.Fatal("source publication was not removed")
	}
	if _, exists := router.pubs["other/audio"].tracks["source"]; exists {
		t.Fatal("source subscription was not removed")
	}
	if _, exists := router.pubs["other/audio"].tracks["target"]; !exists {
		t.Fatal("unrelated subscription was removed")
	}
}

func TestRemovePublicationDoesNotDeleteReplacement(t *testing.T) {
	router := NewRouter()
	old := &publication{
		key:      "source/audio",
		sourceID: "source",
	}
	replacement := &publication{
		key:      "source/audio",
		sourceID: "source",
	}
	router.pubs["source/audio"] = replacement

	router.removePublication(old)

	if got := router.pubs["source/audio"]; got != replacement {
		t.Fatal("replacement publication was deleted by stale forwarder")
	}
}
