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
	return &Store{cfg: cfg, path: cfg.ConfigFile}
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
	if c.AdminPassword == "" {
		return candidate == ""
	}
	if len(candidate) != len(c.AdminPassword) {
		return false
	}
	return subtleCompare(candidate, c.AdminPassword)
}

func subtleCompare(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

type AdminUpdate struct {
	MaxParticipants     *int    `json:"max_participants"`
	DefaultVideoQuality *string `json:"default_video_quality"`
	MaxVideoQuality     *string `json:"max_video_quality"`
	MaxVideoBitrate     *int    `json:"max_video_bitrate"`
	MaxVideoFPS         *int    `json:"max_video_fps"`
	MaxAudioBitrate     *int    `json:"max_audio_bitrate"`
	ScreenShare         *bool   `json:"screen_share_enabled"`
}

func (s *Store) Update(update AdminUpdate) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	next, err := updatedConfig(s.cfg, update)
	if err != nil {
		return err
	}
	if err := persist(next, s.path); err != nil {
		return err
	}
	s.cfg = next
	return nil
}

func (s *Store) apply(update AdminUpdate) error {
	next, err := updatedConfig(s.cfg, update)
	if err != nil {
		return err
	}
	s.cfg = next
	return nil
}

func updatedConfig(current Config, update AdminUpdate) (Config, error) {
	next := current
	if update.MaxParticipants != nil {
		next.MaxParticipants = *update.MaxParticipants
	}
	if update.DefaultVideoQuality != nil {
		next.DefaultVideoQuality = *update.DefaultVideoQuality
	}
	if update.MaxVideoQuality != nil {
		next.MaxVideoQuality = *update.MaxVideoQuality
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
		return Config{}, err
	}
	return next, nil
}

func (s *Store) persistLocked() error {
	return persist(s.cfg, s.path)
}

func persist(cfg Config, path string) error {
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(AdminUpdate{
		MaxParticipants:     intPointer(cfg.MaxParticipants),
		DefaultVideoQuality: stringPointer(cfg.DefaultVideoQuality),
		MaxVideoQuality:     stringPointer(cfg.EffectiveMaxVideoQuality()),
		MaxVideoBitrate:     intPointer(cfg.MaxVideoBitrate),
		MaxVideoFPS:         intPointer(cfg.MaxVideoFPS),
		MaxAudioBitrate:     intPointer(cfg.MaxAudioBitrate),
		ScreenShare:         boolPointer(cfg.EnableScreenShare),
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".lowmeet-config-*")
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
	return os.Rename(tempName, path)
}

func intPointer(value int) *int { return &value }

func stringPointer(value string) *string { return &value }

func boolPointer(value bool) *bool { return &value }
