package signaling

import (
	"sync"
	"testing"
	"time"
)

func (p *testParticipant) sourceQualityFor(participantID string) []Message {
	p.mu.Lock()
	defer p.mu.Unlock()
	var found []Message
	for _, msg := range p.events {
		if msg.Type == TypeSourceQuality && msg.ParticipantID == participantID {
			found = append(found, msg)
		}
	}
	return found
}

// A participant's reported uplink reaches the rest of the room as
// source_quality, so receivers can tell a sender's bad uplink from their own
// bad downlink (B1); a worsening is relayed at once, an easing after the
// minimum interval, a change below the step never, and a joiner is told the
// current value.
func TestHubRelaysReportedUplinkQuality(t *testing.T) {
	_, socketURL := newFourSeatHub(t, 5*time.Second)
	sender := joinTestParticipant(t, socketURL, "Avery", "")
	receiver := joinTestParticipant(t, socketURL, "Blake", "")
	waitForRoster(t, []*testParticipant{sender, receiver})

	report := func(loss10, jitterMs int) {
		t.Helper()
		if err := sender.conn.WriteJSON(Message{Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: sender.id,
			RTTMs: 40, PacketLoss10: 0, JitterMs: 3, VideoKbps: 300, AudioKbps: 30,
			UplinkLoss10: loss10, UplinkJitterMs: jitterMs}); err != nil {
			t.Fatalf("send network state: %v", err)
		}
	}

	report(120, 30)
	waitWithin(t, 3*time.Second, "the receiver is told the sender's uplink", func() bool {
		return len(receiver.sourceQualityFor(sender.id)) == 1
	})
	if got := receiver.sourceQualityFor(sender.id)[0]; got.UplinkLoss10 != 120 || got.UplinkJitterMs != 30 {
		t.Fatalf("relayed uplink = loss10 %d jitter %d, want 120 and 30", got.UplinkLoss10, got.UplinkJitterMs)
	}

	// A change below the step is never relayed.
	report(125, 32)
	time.Sleep(300 * time.Millisecond)
	if got := len(receiver.sourceQualityFor(sender.id)); got != 1 {
		t.Fatalf("receiver got %d source_quality messages, want 1 (no relay for a change below the step)", got)
	}

	// A worsening is relayed at once, even inside the minimum interval: until
	// it arrives the receiver charges it to its own link.
	report(300, 30)
	waitWithin(t, 500*time.Millisecond, "a worsening is relayed at once", func() bool {
		messages := receiver.sourceQualityFor(sender.id)
		return len(messages) == 2 && messages[1].UplinkLoss10 == 300
	})
	if got := len(sender.sourceQualityFor(sender.id)); got != 0 {
		t.Fatalf("the sender was told its own uplink %d times", got)
	}

	// An easing inside the interval waits, then the hub's own refresh relays
	// it without another report.
	report(100, 30)
	time.Sleep(300 * time.Millisecond)
	if got := len(receiver.sourceQualityFor(sender.id)); got != 2 {
		t.Fatalf("receiver got %d source_quality messages, want 2 (an easing waits for the interval)", got)
	}
	waitWithin(t, 3*time.Second, "the easing is relayed after the interval", func() bool {
		messages := receiver.sourceQualityFor(sender.id)
		return len(messages) == 3 && messages[2].UplinkLoss10 == 100
	})

	// A participant joining later learns the current value in its replay.
	joiner := joinTestParticipant(t, socketURL, "Casey", "")
	waitWithin(t, 3*time.Second, "the joiner is told the sender's uplink", func() bool {
		messages := joiner.sourceQualityFor(sender.id)
		return len(messages) == 1 && messages[0].UplinkLoss10 == 100
	})

	// Out-of-range reports are rejected by validation.
	invalid := Message{Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: sender.id, UplinkLoss10: 1001}
	if err := invalid.Validate(); err == nil {
		t.Fatal("an uplink loss above 100 % passed validation")
	}
}

// A sender that pauses its camera on a bad uplink has no camera jitter to
// report (-1), but its microphone still crosses the same queue. The audio
// uplink jitter is relayed on its own, so a receiver can discount the
// sender's audio stream instead of charging that queueing to its own link
// (the B1 leftover: a fast participant stuck below the top level).
func TestHubRelaysAudioUplinkJitter(t *testing.T) {
	_, socketURL := newFourSeatHub(t, 5*time.Second)
	sender := joinTestParticipant(t, socketURL, "Avery", "")
	receiver := joinTestParticipant(t, socketURL, "Blake", "")
	waitForRoster(t, []*testParticipant{sender, receiver})

	report := func(cameraJitterMs, audioJitterMs int) {
		t.Helper()
		if err := sender.conn.WriteJSON(Message{Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: sender.id,
			RTTMs: 40, PacketLoss10: 0, JitterMs: 3, VideoKbps: 0, AudioKbps: 30,
			UplinkLoss10: -1, UplinkJitterMs: cameraJitterMs, AudioUplinkJitterMs: audioJitterMs}); err != nil {
			t.Fatalf("send network state: %v", err)
		}
	}

	report(-1, 40)
	waitWithin(t, 3*time.Second, "the receiver is told the sender's audio uplink jitter", func() bool {
		return len(receiver.sourceQualityFor(sender.id)) == 1
	})
	if got := receiver.sourceQualityFor(sender.id)[0]; got.UplinkJitterMs != -1 || got.AudioUplinkJitterMs != 40 {
		t.Fatalf("relayed jitter = camera %d audio %d, want -1 and 40", got.UplinkJitterMs, got.AudioUplinkJitterMs)
	}

	// A change in the audio jitter alone is worth relaying once the minimum
	// interval has passed; one below the step is not.
	time.Sleep(sourceQualityMinInterval)
	report(-1, 45)
	time.Sleep(300 * time.Millisecond)
	if got := len(receiver.sourceQualityFor(sender.id)); got != 1 {
		t.Fatalf("receiver got %d source_quality messages, want 1 (an audio jitter change below the step)", got)
	}
	report(-1, 12)
	waitWithin(t, 3*time.Second, "an audio jitter change is relayed", func() bool {
		messages := receiver.sourceQualityFor(sender.id)
		return len(messages) == 2 && messages[1].AudioUplinkJitterMs == 12
	})

	// A joiner learns the audio jitter in its replay.
	joiner := joinTestParticipant(t, socketURL, "Casey", "")
	waitWithin(t, 3*time.Second, "the joiner is told the sender's audio uplink jitter", func() bool {
		messages := joiner.sourceQualityFor(sender.id)
		return len(messages) == 1 && messages[0].AudioUplinkJitterMs == 12
	})

	for _, value := range []int{-2, 120001} {
		invalid := Message{Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: sender.id, AudioUplinkJitterMs: value}
		if err := invalid.Validate(); err == nil {
			t.Fatalf("an audio uplink jitter of %d passed validation", value)
		}
	}
}

// The SFU's own measurement of a sender's loss and jitter reaches the room
// on the hub's clock, not only when that sender's next report arrives: the
// report came about once a second and the relay waited for it, so a sender's
// new loss reached receivers a second or two after their own samples showed
// it, long enough for a participant on a fast link to step down on it.
func TestHubPushesForwardMeasurementWithoutSenderReport(t *testing.T) {
	var measured struct {
		sync.Mutex
		audioLoss10, videoLoss10, audioJitterMs, videoJitterMs int
	}
	set := func(audioLoss10, videoLoss10, audioJitterMs, videoJitterMs int) {
		measured.Lock()
		measured.audioLoss10, measured.videoLoss10 = audioLoss10, videoLoss10
		measured.audioJitterMs, measured.videoJitterMs = audioJitterMs, videoJitterMs
		measured.Unlock()
	}
	set(0, 0, 2, 2)
	hub, socketURL := newFourSeatHub(t, 5*time.Second, func(h *Hub) {
		h.forwardQualityForTest = func(string) (int, int, int, int) {
			measured.Lock()
			defer measured.Unlock()
			return measured.audioLoss10, measured.videoLoss10, measured.audioJitterMs, measured.videoJitterMs
		}
	})
	sender := joinTestParticipant(t, socketURL, "Avery", "")
	receiver := joinTestParticipant(t, socketURL, "Blake", "")
	waitForRoster(t, []*testParticipant{sender, receiver})

	// One report creates the sender's state; the measurement, not the
	// report, is what is relayed.
	if err := sender.conn.WriteJSON(Message{Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: sender.id,
		RTTMs: 40, VideoKbps: 300, AudioKbps: 30, UplinkLoss10: 0, UplinkJitterMs: 0, AudioUplinkJitterMs: 0}); err != nil {
		t.Fatalf("send network state: %v", err)
	}
	waitWithin(t, 3*time.Second, "the first measurement is relayed", func() bool {
		return len(receiver.sourceQualityFor(sender.id)) == 1
	})

	// The SFU measures the sender's uplink getting worse; no further report
	// arrives. The hub relays it within a refresh or two.
	set(150, 300, 45, 60)
	waitWithin(t, 4*sourceQualityRefreshInterval, "a worse measurement is pushed without a report", func() bool {
		messages := receiver.sourceQualityFor(sender.id)
		if len(messages) != 2 {
			return false
		}
		got := messages[1]
		return got.UplinkLoss10 == 300 && got.AudioLoss10 == 150 && got.UplinkJitterMs == 60 && got.AudioUplinkJitterMs == 45
	})

	// An easing waits for the minimum interval, then is pushed too.
	set(0, 0, 3, 3)
	time.Sleep(2 * sourceQualityRefreshInterval)
	if got := len(receiver.sourceQualityFor(sender.id)); got != 2 {
		t.Fatalf("receiver got %d source_quality messages, want 2 (an easing waits for the interval)", got)
	}
	waitWithin(t, sourceQualityMinInterval+4*sourceQualityRefreshInterval, "the easing is pushed after the interval", func() bool {
		messages := receiver.sourceQualityFor(sender.id)
		return len(messages) == 3 && messages[2].UplinkLoss10 == 0 && messages[2].AudioUplinkJitterMs == 3
	})

	// A closed hub stops refreshing.
	hub.Close()
	set(500, 500, 90, 90)
	time.Sleep(4 * sourceQualityRefreshInterval)
	if got := len(receiver.sourceQualityFor(sender.id)); got != 3 {
		t.Fatalf("a closed hub relayed again: %d source_quality messages, want 3", got)
	}
}

// A change measured while a sender is in its reconnect grace window cannot
// reach the room (its connection is gone), and must not be recorded as sent:
// the refresher used to mark it sent without broadcasting it, so after the
// resume the room kept the stale value until the next real change.
func TestHubRelaysChangeMeasuredDuringReconnectAfterResume(t *testing.T) {
	var measured struct {
		sync.Mutex
		videoLoss10 int
	}
	set := func(videoLoss10 int) {
		measured.Lock()
		measured.videoLoss10 = videoLoss10
		measured.Unlock()
	}
	set(0)
	_, socketURL := newFourSeatHub(t, 5*time.Second, func(h *Hub) {
		h.forwardQualityForTest = func(string) (int, int, int, int) {
			measured.Lock()
			defer measured.Unlock()
			return 0, measured.videoLoss10, 2, 2
		}
	})
	sender := joinTestParticipant(t, socketURL, "Avery", "")
	receiver := joinTestParticipant(t, socketURL, "Blake", "")
	waitForRoster(t, []*testParticipant{sender, receiver})
	report := func(p *testParticipant) {
		t.Helper()
		if err := p.conn.WriteJSON(Message{Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: p.id,
			RTTMs: 40, VideoKbps: 300, AudioKbps: 30, UplinkLoss10: 0, UplinkJitterMs: 0, AudioUplinkJitterMs: 0}); err != nil {
			t.Fatalf("send network state: %v", err)
		}
	}
	report(sender)
	waitWithin(t, 3*time.Second, "the first value is relayed", func() bool {
		return len(receiver.sourceQualityFor(sender.id)) == 1
	})

	// The sender drops; while it is in its grace window the SFU's measurement
	// of its uplink gets worse. Nothing can be relayed for it now.
	senderID, token := sender.id, sender.token
	sender.reset()
	time.Sleep(300 * time.Millisecond)
	set(400)
	time.Sleep(4 * sourceQualityRefreshInterval)
	if got := len(receiver.sourceQualityFor(senderID)); got != 1 {
		t.Fatalf("receiver got %d source_quality messages while the sender was gone, want 1", got)
	}

	// The sender resumes and reports; the room must now hear the worse value.
	back := joinTestParticipant(t, socketURL, "Avery", token)
	if back.id != senderID {
		t.Fatalf("resume changed the participant id from %s to %s", senderID, back.id)
	}
	report(back)
	waitWithin(t, 3*time.Second, "the change measured during the grace window is relayed after the resume", func() bool {
		messages := receiver.sourceQualityFor(senderID)
		return len(messages) >= 2 && messages[len(messages)-1].UplinkLoss10 == 400
	})
}
