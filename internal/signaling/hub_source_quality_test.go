package signaling

import (
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
// bad downlink (B1); small or rapid changes are not relayed, and a joiner is
// told the current value.
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

	// Below the step, and a real change inside the minimum interval: neither
	// is relayed.
	report(125, 32)
	report(300, 30)
	time.Sleep(300 * time.Millisecond)
	if got := len(receiver.sourceQualityFor(sender.id)); got != 1 {
		t.Fatalf("receiver got %d source_quality messages, want 1 (no relay for a small or rapid change)", got)
	}
	if got := len(sender.sourceQualityFor(sender.id)); got != 0 {
		t.Fatalf("the sender was told its own uplink %d times", got)
	}

	// After the interval a real change is relayed.
	time.Sleep(sourceQualityMinInterval)
	report(300, 30)
	waitWithin(t, 3*time.Second, "a later change is relayed", func() bool {
		messages := receiver.sourceQualityFor(sender.id)
		return len(messages) == 2 && messages[1].UplinkLoss10 == 300
	})

	// A participant joining later learns the current value in its replay.
	joiner := joinTestParticipant(t, socketURL, "Casey", "")
	waitWithin(t, 3*time.Second, "the joiner is told the sender's uplink", func() bool {
		messages := joiner.sourceQualityFor(sender.id)
		return len(messages) == 1 && messages[0].UplinkLoss10 == 300
	})

	// Out-of-range reports are rejected by validation.
	invalid := Message{Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: sender.id, UplinkLoss10: 1001}
	if err := invalid.Validate(); err == nil {
		t.Fatal("an uplink loss above 100 % passed validation")
	}
}
