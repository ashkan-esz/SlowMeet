package config

import "sync"

type Store struct {
	mu  sync.RWMutex
	cfg Config
}

func NewStore(cfg Config) *Store {
	return &Store{cfg: cfg}
}

func (s *Store) Snapshot() Config {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.cfg
}

func (s *Store) CheckAdminPassword(candidate string) bool {
	return s.Snapshot().checkAdminPassword(candidate)
}

func (c Config) checkAdminPassword(candidate string) bool {
	if c.AdminPassword == "" || len(candidate) != len(c.AdminPassword) {
		return c.AdminPassword == ""
	}
	return subtleCompare(candidate, c.AdminPassword)
}

func subtleCompare(a, b string) bool {
	var result byte
	for i := range []byte(a) {
		result |= []byte(a)[i] ^ []byte(b)[i]
	}
	return result == 0
}

type AdminUpdate struct {
	MaxParticipants *int  `json:"max_participants"`
	MaxVideoBitrate *int  `json:"max_video_bitrate"`
	MaxVideoFPS     *int  `json:"max_video_fps"`
	MaxAudioBitrate *int  `json:"max_audio_bitrate"`
	ScreenShare     *bool `json:"screen_share_enabled"`
}

func (s *Store) Update(update AdminUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := s.cfg
	if update.MaxParticipants != nil {
		next.MaxParticipants = *update.MaxParticipants
	}
	if update.MaxVideoBitrate != nil {
		next.MaxVideoBitrate = *update.MaxVideoBitrate
	}
	if update.MaxVideoFPS != nil {
		next.DefaultVideoFPS = *update.MaxVideoFPS
	}
	if update.MaxAudioBitrate != nil {
		next.MaxAudioBitrate = *update.MaxAudioBitrate
	}
	if update.ScreenShare != nil {
		next.EnableScreenShare = *update.ScreenShare
	}
	if err := next.Validate(); err != nil {
		return err
	}
	s.cfg = next
	return nil
}
