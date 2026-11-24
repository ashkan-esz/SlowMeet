package signaling

import (
	"sync"
	"testing"
	"time"
)

func (p *testParticipant) downlinkQuality() []Message {
	p.mu.Lock()
	defer p.mu.Unlock()
	var found []Message
	for _, msg := range p.events {
		if msg.Type == TypeDownlinkQuality {
			found = append(found, msg)
		}
	}
	return found
}

// Each room member is told its own download as the SFU measures it from that
// member's transport-cc feedback, and only its own: a worsening at once, the
// current value about once a second otherwise, nothing without a
// measurement.
func TestHubTellsEachMemberItsOwnDownlink(t *testing.T) {
	var measured sync.Mutex
	downlinks := map[string][2]int{}
	set := func(participantID string, loss10, jitterMs int) {
		measured.Lock()
		downlinks[participantID] = [2]int{loss10, jitterMs}
		measured.Unlock()
	}
	_, socketURL := newFourSeatHub(t, 5*time.Second, func(h *Hub) {
		h.downlinkQualityForTest = func(participantID string) (int, int) {
			measured.Lock()
			defer measured.Unlock()
			if value, ok := downlinks[participantID]; ok {
				return value[0], value[1]
			}
			return -1, -1
		}
	})
	avery := joinTestParticipant(t, socketURL, "Avery", "")
	blake := joinTestParticipant(t, socketURL, "Blake", "")
	waitForRoster(t, []*testParticipant{avery, blake})
	set(avery.id, 0, 2)

	waitWithin(t, 2*time.Second, "Avery is told its downlink", func() bool { return len(avery.downlinkQuality()) >= 1 })
	if got := avery.downlinkQuality()[0]; got.ParticipantID != avery.id || got.PacketLoss10 != 0 || got.JitterMs != 2 {
		t.Fatalf("Avery's downlink_quality = %+v, want its own loss 0 jitter 2", got)
	}

	// Steady: about once a second, not on every 250 ms refresh.
	before := len(avery.downlinkQuality())
	time.Sleep(2200 * time.Millisecond)
	if sent := len(avery.downlinkQuality()) - before; sent < 1 || sent > 3 {
		t.Fatalf("Avery got %d downlink_quality messages in 2.2 s of a steady link, want 1-3", sent)
	}

	// A worsening goes out at once.
	set(avery.id, 120, 30)
	waitWithin(t, 600*time.Millisecond, "a worsening reaches Avery at once", func() bool {
		messages := avery.downlinkQuality()
		last := messages[len(messages)-1]
		return last.PacketLoss10 == 120 && last.JitterMs == 30
	})
	// An easing within the next second or so.
	set(avery.id, 0, 2)
	waitWithin(t, 1600*time.Millisecond, "an easing reaches Avery", func() bool {
		messages := avery.downlinkQuality()
		return messages[len(messages)-1].PacketLoss10 == 0
	})

	// Blake has no measurement, so it is told nothing, and never Avery's.
	if got := blake.downlinkQuality(); len(got) != 0 {
		t.Fatalf("Blake, unmeasured, got %d downlink_quality messages: %+v", len(got), got[0])
	}
	set(blake.id, 80, 5)
	waitWithin(t, 2*time.Second, "Blake is told its own downlink", func() bool { return len(blake.downlinkQuality()) >= 1 })
	for _, msg := range blake.downlinkQuality() {
		if msg.ParticipantID != blake.id || msg.PacketLoss10 != 80 {
			t.Fatalf("Blake got %+v, want only its own loss 80", msg)
		}
	}
	for _, msg := range avery.downlinkQuality() {
		if msg.ParticipantID != avery.id {
			t.Fatalf("Avery got another participant's downlink: %+v", msg)
		}
	}
}

// downlink_quality is the server's to send; a client sending it is refused.
func TestDownlinkQualityIsServerOnly(t *testing.T) {
	if err := (Message{Version: ProtocolVersion, Type: TypeDownlinkQuality, PacketLoss10: 0}).Validate(); err == nil {
		t.Fatal("a client-sent downlink_quality validated")
	}
}
