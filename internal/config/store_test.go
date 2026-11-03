package config

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestStoreSnapshotIsolatesConfigSlices(t *testing.T) {
	constructors := []struct {
		name string
		new  func(Config) (*Store, error)
	}{
		{name: "NewStore", new: func(cfg Config) (*Store, error) { return NewStore(cfg), nil }},
		{name: "LoadStore", new: func(cfg Config) (*Store, error) { return LoadStore(cfg, nil) }},
	}

	for _, constructor := range constructors {
		t.Run(constructor.name, func(t *testing.T) {
			cfg := Config{
				STUNServers:              []string{"stun:one"},
				TURNURLs:                 []string{"turn:one"},
				EnabledConnectionMethods: []string{"direct"},
				TrustedProxyCIDRs:        []string{"10.0.0.0/8"},
			}
			store, err := constructor.new(cfg)
			if err != nil {
				t.Fatalf("create store: %v", err)
			}

			cfg.STUNServers[0] = "stun:mutated"
			cfg.TURNURLs[0] = "turn:mutated"
			cfg.EnabledConnectionMethods[0] = "mutated"
			cfg.TrustedProxyCIDRs[0] = "192.0.2.0/24"

			want := Config{
				STUNServers:              []string{"stun:one"},
				TURNURLs:                 []string{"turn:one"},
				EnabledConnectionMethods: []string{"direct"},
				TrustedProxyCIDRs:        []string{"10.0.0.0/8"},
			}
			snapshot := store.Snapshot()
			if !reflect.DeepEqual(snapshot.STUNServers, want.STUNServers) ||
				!reflect.DeepEqual(snapshot.TURNURLs, want.TURNURLs) ||
				!reflect.DeepEqual(snapshot.EnabledConnectionMethods, want.EnabledConnectionMethods) ||
				!reflect.DeepEqual(snapshot.TrustedProxyCIDRs, want.TrustedProxyCIDRs) {
				t.Fatalf("store retained caller-owned slices: got %+v", snapshot)
			}

			snapshot.STUNServers[0] = "stun:snapshot-mutated"
			snapshot.TURNURLs[0] = "turn:snapshot-mutated"
			snapshot.EnabledConnectionMethods[0] = "snapshot-mutated"
			snapshot.TrustedProxyCIDRs[0] = "198.51.100.0/24"
			if got := store.Snapshot(); !reflect.DeepEqual(got.STUNServers, want.STUNServers) ||
				!reflect.DeepEqual(got.TURNURLs, want.TURNURLs) ||
				!reflect.DeepEqual(got.EnabledConnectionMethods, want.EnabledConnectionMethods) ||
				!reflect.DeepEqual(got.TrustedProxyCIDRs, want.TrustedProxyCIDRs) {
				t.Fatalf("snapshot mutation changed store config: got %+v", got)
			}
		})
	}
}

func TestStoreUpdateValidatesAndHidesAdminPassword(t *testing.T) {
	cfg := Config{AdminPassword: "admin", MaxParticipants: 5, DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxAudioBitrate: 64000, MaxVideoBitrate: 500000,
		DefaultVideoQuality: "low", HTTPAddr: ":8080"}
	store := NewStore(cfg)
	if store.CheckAdminPassword("wrong") || !store.CheckAdminPassword("admin") {
		t.Fatal("admin password validation failed")
	}
	max := 3
	quality := "medium"
	maxQuality := "medium"
	retainChatHistory := true
	if err := store.Update(AdminUpdate{
		MaxParticipants: &max, DefaultVideoQuality: &quality, MaxVideoQuality: &maxQuality,
		RetainChatHistory: &retainChatHistory,
	}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	if got := store.Snapshot(); got.MaxParticipants != 3 || got.DefaultVideoQuality != "medium" ||
		got.MaxVideoQuality != "medium" || !got.RetainChatHistory || got.AdminPassword != "admin" {
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
	cfg := Config{
		ConfigFile:      path,
		MeetingPassword: "meeting-secret",
		AdminPassword:   "admin-secret",
		MaxParticipants: 5, DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxAudioBitrate: 64000, MaxVideoBitrate: 500000,
		DefaultVideoQuality: "low", HTTPAddr: ":8080"}
	store, err := LoadStore(cfg, nil)
	if err != nil {
		t.Fatalf("LoadStore() error = %v", err)
	}
	max := 2
	maxQuality := "medium"
	retainChatHistory := true
	if err := store.Update(AdminUpdate{MaxParticipants: &max, MaxVideoQuality: &maxQuality,
		RetainChatHistory: &retainChatHistory}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	reloaded, err := LoadStore(cfg, nil)
	if err != nil {
		t.Fatalf("reload error = %v", err)
	}
	if got := reloaded.Snapshot().MaxParticipants; got != 2 {
		t.Fatalf("reloaded MaxParticipants = %d, want 2", got)
	}
	if got := reloaded.Snapshot().MaxVideoQuality; got != "medium" {
		t.Fatalf("reloaded MaxVideoQuality = %q, want medium", got)
	}
	if !reloaded.Snapshot().RetainChatHistory {
		t.Fatal("reloaded RetainChatHistory = false, want true")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("ReadFile() error = %v", err)
	}
	if string(data) == "" {
		t.Fatal("persisted config is empty")
	}
	if strings.Contains(string(data), "meeting-secret") || strings.Contains(string(data), "admin-secret") {
		t.Fatal("persisted config contains a secret")
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("Stat() error = %v", err)
	}
	if got := info.Mode().Perm(); got != 0600 {
		t.Fatalf("persisted config mode = %04o, want 0600", got)
	}
}

func TestLoadStoreToleratesUnknownKeysWithWarning(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	cfg := Config{ConfigFile: path, HTTPAddr: ":8080", MaxParticipants: 5, DefaultVideoFPS: 15,
		MaxVideoFPS: 30, DefaultAudioBitrate: 32000, MaxAudioBitrate: 64000, MaxVideoBitrate: 500000,
		DefaultVideoQuality: "low"}
	if err := os.WriteFile(path, []byte(`{"max_paticipants":3,"max_participants":4}`), 0600); err != nil {
		t.Fatalf("write config fixture: %v", err)
	}
	store, err := LoadStore(cfg, nil)
	if err != nil {
		t.Fatalf("LoadStore() error = %v", err)
	}
	if got := store.Snapshot().MaxParticipants; got != 4 {
		t.Fatalf("MaxParticipants with typo'd sibling key = %d, want 4", got)
	}
	if keys := unknownJSONKeys([]byte(`{"max_paticipants":3,"max_participants":4}`)); len(keys) != 1 || keys[0] != "max_paticipants" {
		t.Fatalf("unknownJSONKeys() = %v, want [max_paticipants]", keys)
	}
}

func TestEnabledConnectionMethodsDefaultAndPersist(t *testing.T) {
	cfg := Config{HTTPAddr: ":8080", MaxParticipants: 5, DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxAudioBitrate: 64000, MaxVideoBitrate: 500000,
		DefaultVideoQuality: "low"}
	if got := cfg.EffectiveEnabledConnectionMethods(); strings.Join(got, ",") != "direct,turn-udp,turn-tcp,turn-tls" {
		t.Fatalf("default enabled methods = %v", got)
	}

	path := filepath.Join(t.TempDir(), "config.json")
	cfg.ConfigFile = path
	store, err := LoadStore(cfg, nil)
	if err != nil {
		t.Fatalf("LoadStore() error = %v", err)
	}
	enabled := []string{"direct", "turn-tls"}
	if err := store.Update(AdminUpdate{EnabledConnectionMethods: &enabled}); err != nil {
		t.Fatalf("Update() error = %v", err)
	}
	reloaded, err := LoadStore(cfg, nil)
	if err != nil {
		t.Fatalf("reload error = %v", err)
	}
	if got := reloaded.Snapshot().EffectiveEnabledConnectionMethods(); strings.Join(got, ",") != "direct,turn-tls" {
		t.Fatalf("reloaded enabled methods = %v", got)
	}
	disabled := []string{}
	if err := reloaded.Update(AdminUpdate{EnabledConnectionMethods: &disabled}); err != nil {
		t.Fatalf("disable all connection methods: %v", err)
	}
	fullyDisabled, err := LoadStore(cfg, nil)
	if err != nil {
		t.Fatalf("reload disabled methods: %v", err)
	}
	if got := fullyDisabled.Snapshot().EffectiveEnabledConnectionMethods(); len(got) != 0 {
		t.Fatalf("reloaded disabled methods = %v, want empty", got)
	}
}

func TestEnabledConnectionMethodsRejectUnknownOrDuplicate(t *testing.T) {
	for _, methods := range [][]string{{"unknown"}, {"direct", "direct"}} {
		cfg := Config{HTTPAddr: ":8080", EnabledConnectionMethods: methods}
		if err := cfg.Validate(); err == nil {
			t.Fatalf("Validate() accepted methods %v", methods)
		}
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
