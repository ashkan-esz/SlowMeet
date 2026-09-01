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
