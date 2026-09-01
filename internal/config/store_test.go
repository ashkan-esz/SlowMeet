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
