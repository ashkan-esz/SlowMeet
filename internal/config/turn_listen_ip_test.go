package config

import (
	"strings"
	"testing"
)

func TestTURNServerListenIP(t *testing.T) {
	relayEnv := func(t *testing.T, listenIP string) {
		t.Helper()
		t.Setenv("TURN_SERVER_ENABLED", "true")
		t.Setenv("TURN_SHARED_SECRET", "secret")
		t.Setenv("TURN_SERVER_LISTEN_IP", listenIP)
	}

	t.Run("unset listens on every address", func(t *testing.T) {
		relayEnv(t, "")
		cfg, err := LoadFromEnv()
		if err != nil {
			t.Fatalf("LoadFromEnv() error = %v", err)
		}
		if cfg.TURNServerListenIP != "" {
			t.Fatalf("TURNServerListenIP = %q, want empty", cfg.TURNServerListenIP)
		}
	})
	for _, address := range []string{"203.0.113.9", "2001:db8::9", " 203.0.113.9 "} {
		t.Run("accepts "+strings.TrimSpace(address), func(t *testing.T) {
			relayEnv(t, address)
			cfg, err := LoadFromEnv()
			if err != nil {
				t.Fatalf("LoadFromEnv() error = %v", err)
			}
			if want := strings.TrimSpace(address); cfg.TURNServerListenIP != want {
				t.Fatalf("TURNServerListenIP = %q, want %q", cfg.TURNServerListenIP, want)
			}
		})
	}
	for _, address := range []string{"0.0.0.0", "::", "224.0.0.1", "255.255.255.255", "meet.example.com", "203.0.113.9:443"} {
		t.Run("rejects "+address, func(t *testing.T) {
			relayEnv(t, address)
			if _, err := LoadFromEnv(); err == nil || !strings.Contains(err.Error(), "TURN_SERVER_LISTEN_IP") {
				t.Fatalf("LoadFromEnv() error = %v, want it to name TURN_SERVER_LISTEN_IP", err)
			}
		})
	}
	t.Run("is not checked while the relay is off", func(t *testing.T) {
		t.Setenv("TURN_SERVER_ENABLED", "false")
		t.Setenv("TURN_SERVER_LISTEN_IP", "not an address")
		if _, err := LoadFromEnv(); err != nil {
			t.Fatalf("LoadFromEnv() error = %v, want the relay's settings ignored while it is off", err)
		}
	})
}
