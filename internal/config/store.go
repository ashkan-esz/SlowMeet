package config

import (
	"bytes"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
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
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&update); err != nil {
		var lenient AdminUpdate
		if lenientErr := json.Unmarshal(data, &lenient); lenientErr != nil {
			return nil, err
		}
		// A typo'd key would otherwise be silently dropped by the next admin
		// update that persists the file. Load the known subset, but say so.
		slog.Default().Warn("config_persistence_unknown_keys",
			"file", store.path,
			"unknown_keys", unknownJSONKeys(data),
			"decode_error", err.Error())
		update = lenient
	}
	if err := store.apply(update); err != nil {
		return nil, err
	}
	return store, nil
}

// unknownJSONKeys lists the top-level keys in a persisted config that are not
// part of AdminUpdate, so operators can spot typos.
func unknownJSONKeys(data []byte) []string {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil
	}
	known := map[string]struct{}{
		"max_participants":           {},
		"default_video_quality":      {},
		"max_video_quality":          {},
		"max_video_bitrate":          {},
		"max_video_fps":              {},
		"max_audio_bitrate":          {},
		"screen_share_enabled":       {},
		"retain_chat_history":        {},
		"enabled_connection_methods": {},
	}
	var unknown []string
	for key := range raw {
		if _, ok := known[key]; !ok {
			unknown = append(unknown, key)
		}
	}
	sort.Strings(unknown)
	return unknown
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
	// Digest comparison keeps the check constant-time without leaking the
	// configured password's length through an early size test.
	return subtle.ConstantTimeCompare(digest(candidate), digest(c.AdminPassword)) == 1
}

type AdminUpdate struct {
	MaxParticipants          *int      `json:"max_participants"`
	DefaultVideoQuality      *string   `json:"default_video_quality"`
	MaxVideoQuality          *string   `json:"max_video_quality"`
	MaxVideoBitrate          *int      `json:"max_video_bitrate"`
	MaxVideoFPS              *int      `json:"max_video_fps"`
	MaxAudioBitrate          *int      `json:"max_audio_bitrate"`
	ScreenShare              *bool     `json:"screen_share_enabled"`
	RetainChatHistory        *bool     `json:"retain_chat_history"`
	EnabledConnectionMethods *[]string `json:"enabled_connection_methods"`
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
	if update.RetainChatHistory != nil {
		next.RetainChatHistory = *update.RetainChatHistory
	}
	if update.EnabledConnectionMethods != nil {
		next.EnabledConnectionMethods = make([]string, len(*update.EnabledConnectionMethods))
		copy(next.EnabledConnectionMethods, *update.EnabledConnectionMethods)
	}
	if err := next.Validate(); err != nil {
		return Config{}, err
	}
	return next, nil
}

func persist(cfg Config, path string) error {
	if path == "" {
		return nil
	}
	data, err := json.MarshalIndent(AdminUpdate{
		MaxParticipants:          intPointer(cfg.MaxParticipants),
		DefaultVideoQuality:      stringPointer(cfg.DefaultVideoQuality),
		MaxVideoQuality:          stringPointer(cfg.EffectiveMaxVideoQuality()),
		MaxVideoBitrate:          intPointer(cfg.MaxVideoBitrate),
		MaxVideoFPS:              intPointer(cfg.MaxVideoFPS),
		MaxAudioBitrate:          intPointer(cfg.MaxAudioBitrate),
		ScreenShare:              boolPointer(cfg.EnableScreenShare),
		RetainChatHistory:        boolPointer(cfg.RetainChatHistory),
		EnabledConnectionMethods: stringSlicePointer(cfg.EffectiveEnabledConnectionMethods()),
	}, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0750); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	temp, err := os.CreateTemp(filepath.Dir(path), ".slowmeet-config-*")
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

func stringSlicePointer(value []string) *[]string { return &value }
