package meeting

import (
	"errors"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
)

var (
	ErrMeetingFull = errors.New("meeting is full")
	ErrInvalidName = errors.New("name must be between 1 and 32 characters")
)

type Participant struct {
	ID       string    `json:"id"`
	Name     string    `json:"name"`
	JoinedAt time.Time `json:"joined_at"`
}

type Meeting struct {
	mu           sync.RWMutex
	max          int
	participants map[string]Participant
}

func New(maxParticipants int) *Meeting {
	return &Meeting{max: maxParticipants, participants: make(map[string]Participant)}
}

func (m *Meeting) Join(name string) (Participant, error) {
	name = strings.TrimSpace(name)
	if len([]rune(name)) < 1 || len([]rune(name)) > 32 {
		return Participant{}, ErrInvalidName
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if len(m.participants) >= m.max {
		return Participant{}, ErrMeetingFull
	}
	participant := Participant{ID: uuid.NewString(), Name: name, JoinedAt: time.Now().UTC()}
	m.participants[participant.ID] = participant
	return participant, nil
}

func (m *Meeting) Leave(id string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.participants[id]; !ok {
		return false
	}
	delete(m.participants, id)
	return true
}

func (m *Meeting) SetMaxParticipants(max int) {
	if max < 1 {
		return
	}
	m.mu.Lock()
	m.max = max
	m.mu.Unlock()
}

func (m *Meeting) List() []Participant {
	m.mu.RLock()
	defer m.mu.RUnlock()
	result := make([]Participant, 0, len(m.participants))
	for _, participant := range m.participants {
		result = append(result, participant)
	}
	return result
}
