package meeting

import (
	"errors"
	"testing"
)

func TestJoinAndLeaveParticipant(t *testing.T) {
	m := New(2)
	first, err := m.Join(" Ashkan ")
	if err != nil {
		t.Fatalf("first Join() error = %v", err)
	}
	if first.Name != "Ashkan" || first.ID == "" {
		t.Fatalf("unexpected participant: %+v", first)
	}

	if _, err := m.Join("Ali"); err != nil {
		t.Fatalf("second Join() error = %v", err)
	}
	if _, err := m.Join("Sara"); !errors.Is(err, ErrMeetingFull) {
		t.Fatalf("third Join() error = %v, want ErrMeetingFull", err)
	}

	if !m.Leave(first.ID) || m.Leave("missing") {
		t.Fatal("unexpected leave result")
	}
	if got := len(m.List()); got != 1 {
		t.Fatalf("List() length = %d, want 1", got)
	}
	if got := m.Count(); got != 1 {
		t.Fatalf("Count() = %d, want 1", got)
	}
}

func TestJoinRejectsInvalidNames(t *testing.T) {
	m := New(5)
	for _, name := range []string{"", "   ", string(make([]byte, 33)), "Ash\nkan", string([]byte{0xff})} {
		if _, err := m.Join(name); !errors.Is(err, ErrInvalidName) {
			t.Errorf("Join(%q) error = %v, want ErrInvalidName", name, err)
		}
	}
}

func TestSetMaxParticipantsDoesNotEvictExistingParticipants(t *testing.T) {
	m := New(3)
	for _, name := range []string{"Ashkan", "Ali", "Sara"} {
		if _, err := m.Join(name); err != nil {
			t.Fatalf("Join(%q) error = %v", name, err)
		}
	}

	m.SetMaxParticipants(1)
	if got := m.Count(); got != 3 {
		t.Fatalf("Count() = %d, want existing participants preserved", got)
	}
	if _, err := m.Join("Reza"); !errors.Is(err, ErrMeetingFull) {
		t.Fatalf("Join() error = %v, want ErrMeetingFull", err)
	}
}

func TestRaisedHandQueueIsFIFOAndCompacts(t *testing.T) {
	m := New(3)
	first, _ := m.Join("Ashkan")
	second, _ := m.Join("Ali")
	third, _ := m.Join("Sara")

	changed, err := m.SetRaisedHand(first.ID, true)
	if err != nil || len(changed) != 1 || changed[0].HandOrder != 1 {
		t.Fatalf("first raise = %+v, error = %v", changed, err)
	}
	changed, err = m.SetRaisedHand(second.ID, true)
	if err != nil || len(changed) != 1 || changed[0].HandOrder != 2 {
		t.Fatalf("second raise = %+v, error = %v", changed, err)
	}
	if changed, err = m.SetRaisedHand(second.ID, true); err != nil || changed != nil {
		t.Fatalf("duplicate raise = %+v, error = %v, want no change", changed, err)
	}

	changed, err = m.SetRaisedHand(first.ID, false)
	if err != nil || len(changed) != 2 {
		t.Fatalf("first lower = %+v, error = %v, want two changed participants", changed, err)
	}
	if changed[0].ID != first.ID || changed[0].RaisedHand || changed[0].HandOrder != 0 ||
		changed[1].ID != second.ID || !changed[1].RaisedHand || changed[1].HandOrder != 1 {
		t.Fatalf("compacted queue = %+v", changed)
	}
	if changed, err = m.SetRaisedHand(first.ID, false); err != nil || changed != nil {
		t.Fatalf("duplicate lower = %+v, error = %v, want no change", changed, err)
	}

	if changed, err = m.SetRaisedHand("missing", true); !errors.Is(err, ErrParticipantNotFound) || changed != nil {
		t.Fatalf("unknown participant = %+v, error = %v", changed, err)
	}
	if !m.Leave(second.ID) {
		t.Fatal("expected raised participant leave to succeed")
	}
	if got := m.List(); len(got) != 2 {
		t.Fatalf("participants after leave = %d, want 2", len(got))
	}
	if changed, err = m.SetRaisedHand(third.ID, true); err != nil || len(changed) != 1 || changed[0].HandOrder != 1 {
		t.Fatalf("raise after leave = %+v, error = %v", changed, err)
	}
}
