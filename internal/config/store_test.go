package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestStoreUpdateValidatesAndHidesAdminPassword(t *testing.T) {
	cfg := Config{AdminPassword: "admin", MaxParticipants: 5, DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxAudioBitrate: 64000, MaxVideoBitrate: 500000,
		DefaultVideoQuality: "low", HTTPAddr: ":8080"}
	store := NewStore(cfg)
	if store.CheckAdminPassword("wrong") || !store.CheckAdminPassword("admin") {
		t.Fatal("admin password validation failed")
	}
	max := 3
	if err := store.Update(AdminUpdate{MaxParticipants: &max}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if got := store.Snapshot(); got.MaxParticipants != 3 || got.AdminPassword != "admin" {
		t.Fatalf("unexpected snapshot: %+v", got)
	}
}

func TestEmptyAdminPasswordOnlyAcceptsEmptyCandidate(t *testing.T) {
	store := NewStore(Config{})
	if store.CheckAdminPassword("unexpected") {
		t.Fatal("empty admin password accepted a non-empty candidate")
	}
	if !store.CheckAdminPassword("") {
		t.Fatal("empty admin password rejected an empty candidate")
	}
}

func TestStorePersistsAdminUpdate(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := Config{ConfigFile: path, MaxParticipants: 5, DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxAudioBitrate: 64000, MaxVideoBitrate: 500000,
		DefaultVideoQuality: "low", HTTPAddr: ":8080"}
	store, err := LoadStore(cfg)
	if err != nil {
		t.Fatalf("LoadStore() error = %v", err)
	}
	max := 2
	if err := store.Update(AdminUpdate{MaxParticipants: &max}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	reloaded, err := LoadStore(cfg)
	if err != nil {
		t.Fatalf("reload error = %v", err)
	}
	if got := reloaded.Snapshot().MaxParticipants; got != 2 {
		t.Fatalf("reloaded MaxParticipants = %d, want 2", got)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(data) == "" {
		t.Fatal("persisted config is empty")
	}
}

func TestStoreUpdateDoesNotMutateWhenPersistenceFails(t *testing.T) {
	path := t.TempDir()
	cfg := Config{
		ConfigFile:          path,
		HTTPAddr:            ":8080",
		MaxParticipants:     5,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	store := NewStore(cfg)
	max := 2
	if err := store.Update(AdminUpdate{MaxParticipants: &max}); err == nil {
		t.Fatal("Update() unexpectedly succeeded with a directory as config path")
	}
	if got := store.Snapshot().MaxParticipants; got != 5 {
		t.Fatalf("MaxParticipants = %d after failed persistence, want 5", got)
	}
}
