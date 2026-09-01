package config

import "testing"

func TestStoreUpdateValidatesAndHidesAdminPassword(t *testing.T) {
	cfg := Config{AdminPassword: "admin", MaxParticipants: 5, DefaultVideoFPS: 15,
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
