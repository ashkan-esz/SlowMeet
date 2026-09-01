package config

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sync"
)

type Store struct {
	mu   sync.RWMutex
	cfg  Config
	path string
}

func NewStore(cfg Config) *Store {
	return &Store{cfg: cfg}
}

func LoadStore(cfg Config) (*Store, error) {
	store := &Store{cfg: cfg, path: cfg.ConfigFile}
	if store.path == "" {
		return store, nil
	}
	data, err := os.ReadFile(store.path)
	if errors.Is(err, os.ErrNotExist) {
		return store, nil
	}
	if err != nil {
		return nil, err
	}
	var update AdminUpdate
	if err := json.Unmarshal(data, &update); err != nil {
		return nil, err
	}
	if err := store.apply(update); err != nil {
		return nil, err
	}
	return store, nil
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
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
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
	if err := s.apply(update); err != nil {
		return err
	}
	return s.persistLocked()
}

func (s *Store) apply(update AdminUpdate) error {
	next := s.cfg
	if update.MaxParticipants != nil {
		next.MaxParticipants = *update.MaxParticipants
	}
	if update.MaxVideoBitrate != nil {
		next.MaxVideoBitrate = *update.MaxVideoBitrate
	}
	if update.MaxVideoFPS != nil {
		next.MaxVideoFPS = *update.MaxVideoFPS
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

func (s *Store) persistLocked() error {
	if s.path == "" {
		return nil
	}
	data, err := json.MarshalIndent(AdminUpdate{
		MaxParticipants: intPointer(s.cfg.MaxParticipants),
		MaxVideoBitrate: intPointer(s.cfg.MaxVideoBitrate),
		MaxVideoFPS:     intPointer(s.cfg.MaxVideoFPS),
		MaxAudioBitrate: intPointer(s.cfg.MaxAudioBitrate),
		ScreenShare:     boolPointer(s.cfg.EnableScreenShare),
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0750); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(s.path), ".lowmeet-config-*")
	if err != nil {
		return err
	}
	tempName := temp.Name()
	defer os.Remove(tempName)
	if err := temp.Chmod(0600); err != nil {
		_ = temp.Close()
		return err
	}
	if _, err := temp.Write(data); err != nil {
		_ = temp.Close()
		return err
	}
	if err := temp.Close(); err != nil {
		return err
	}
	return os.Rename(tempName, s.path)
}

func intPointer(value int) *int { return &value }

func boolPointer(value bool) *bool { return &value }
