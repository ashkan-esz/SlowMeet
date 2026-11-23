package media

import (
	"testing"
	"time"
)

// The forwarded-loss window counts the publisher's sequence numbers the SFU
// did not forward, which is what a receiver on a perfect downlink sees as
// lost (B1).
func TestForwardLossMeasuresUnforwardedSequences(t *testing.T) {
	start := time.Unix(1_800_000_000, 0)
	var loss forwardLoss
	if _, _, ok := loss.lossTenths(); ok {
		t.Fatal("a measurement was reported before any window completed")
	}

	// Window 1: 100 sequences, all forwarded.
	base := uint16(65_500)
	at := start
	for offset := uint16(0); offset < 100; offset++ {
		loss.observe(base+offset, at)
		at = at.Add(5 * time.Millisecond)
	}
	// Window 2 starts across the wrap: every tenth sequence skipped, as for a
	// frame the SFU never forwarded, plus one late packet from window 1.
	at = start.Add(forwardLossWindow)
	loss.observe(base+100, at) // closes window 1
	if loss10, packets, ok := loss.lossTenths(); !ok || loss10 != 0 || packets != 100 {
		t.Fatalf("clean window = loss10 %d over %d packets (ok %t), want 0 over 100", loss10, packets, ok)
	}
	for offset := uint16(101); offset < 200; offset++ {
		if offset%10 == 0 {
			continue
		}
		loss.observe(base+offset, at)
		if offset == 150 {
			loss.observe(base+50, at) // late, from the previous window
		}
	}
	loss.observe(base+200, start.Add(2*forwardLossWindow)) // closes window 2
	loss10, packets, ok := loss.lossTenths()
	// Span 100..199 is 100 sequences: the one that opened the window and 90
	// more were forwarded, 9 skipped (110, 120, ... 190): 9 % lost. The late
	// packet from window 1 is not counted.
	if !ok || packets != 91 {
		t.Fatalf("gapped window forwarded %d packets (ok %t), want 91", packets, ok)
	}
	if loss10 != 90 {
		t.Fatalf("gapped window loss = %d tenths of a percent, want 90", loss10)
	}
}

func TestRouterForwardLossPicksAudioAndBusiestCameraLayer(t *testing.T) {
	router := NewRouter()
	add := func(key string, role SourceRole, layer string, loss10, packets int64) {
		pub := &publication{key: key, sourceID: "p", role: role, layer: layer}
		pub.forwardLoss.result.Store(packets<<32 | loss10)
		router.pubs[key] = pub
	}
	if audio, video := router.ForwardLoss("p"); audio != -1 || video != -1 {
		t.Fatalf("no publications = audio %d video %d, want -1 and -1", audio, video)
	}
	add("p/audio", SourceRoleAudio, "", 80, 50)
	add("p/camera/low", SourceRoleCamera, "low", 300, 20)
	add("p/camera/medium", SourceRoleCamera, "medium", 120, 90)
	if audio, video := router.ForwardLoss("p"); audio != 80 || video != 120 {
		t.Fatalf("forward loss = audio %d video %d, want 80 and the busiest layer's 120", audio, video)
	}
}

// The window in progress is reported before it closes, so a sender's new
// loss reaches receivers while their own samples already show it: with
// completed windows only, the newest one held just the start of an
// impairment and the receiver charged the rest to its own link.
func TestForwardLossReportsWindowInProgress(t *testing.T) {
	start := time.Unix(1_800_000_000, 0)
	var loss forwardLoss
	// A clean completed window first.
	at := start
	sequence := uint16(0)
	for ; sequence < 50; sequence++ {
		loss.observe(sequence, at)
		at = at.Add(20 * time.Millisecond)
	}
	at = start.Add(forwardLossWindow)
	loss.observe(sequence, at) // closes the clean window, opens the next
	sequence++
	if loss10, _, _ := loss.lossTenths(); loss10 != 0 {
		t.Fatalf("clean window loss = %d, want 0", loss10)
	}

	// The next window loses every other sequence. Before forwardPartialInterval
	// has passed nothing of it is reported.
	windowStart := at
	observeHalf := func(until time.Duration) {
		for at.Sub(windowStart) < until {
			at = at.Add(20 * time.Millisecond)
			loss.observe(sequence+1, at) // sequence itself is never forwarded
			sequence += 2
		}
	}
	observeHalf(forwardPartialInterval - 30*time.Millisecond)
	if loss10, _, _ := loss.lossTenths(); loss10 != 0 {
		t.Fatalf("loss reported %d before the window in progress was published", loss10)
	}
	observeHalf(forwardPartialInterval + 30*time.Millisecond)
	loss10, packets, ok := loss.lossTenths()
	if !ok || loss10 < 400 {
		t.Fatalf("window in progress = loss10 %d (ok %t), want about 500 before the window closes", loss10, ok)
	}
	if packets != 50 {
		t.Fatalf("packet count = %d, want the last complete window's 50", packets)
	}

	// Too few sequences in a new window are not reported on their own.
	var short forwardLoss
	short.observe(0, start)
	short.observe(5, start.Add(forwardPartialInterval+time.Millisecond))
	if _, _, ok := short.lossTenths(); ok {
		t.Fatal("a window in progress spanning fewer than forwardPartialMinPackets sequences was reported")
	}
}
