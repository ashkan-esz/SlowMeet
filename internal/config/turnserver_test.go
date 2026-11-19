package config

import (
	"strings"
	"testing"
)

// turnServerEnv gives LoadFromEnv a valid built-in relay configuration and
// then applies overrides, so each case states only what it changes. Every
// related variable is set explicitly so a developer's shell cannot leak in.
func turnServerEnv(t *testing.T, overrides map[string]string) {
	t.Helper()
	baseline := map[string]string{
		"TURN_SERVER_ENABLED":         "true",
		"TURN_SERVER_PORT":            "",
		"TURN_SERVER_TLS_PORT":        "",
		"TURN_SERVER_TLS_CERT_FILE":   "",
		"TURN_SERVER_TLS_KEY_FILE":    "",
		"TURN_SERVER_REALM":           "",
		"TURN_SERVER_RELAY_PORT_MIN":  "",
		"TURN_SERVER_RELAY_PORT_MAX":  "",
		"TURN_SERVER_RELAY_IP":        "",
		"TURN_SHARED_SECRET":          "shared-secret",
		"TURN_CREDENTIAL_TTL_SECONDS": "",
		"TURN_URL":                    "",
		"TURN_URLS":                   "",
		"ICE_UDP_PORT_MIN":            "",
		"ICE_UDP_PORT_MAX":            "",
		"ICE_PUBLIC_IP":               "",
		"ICE_TRANSPORT_POLICY":        "",
	}
	for key, value := range overrides {
		baseline[key] = value
	}
	for key, value := range baseline {
		t.Setenv(key, value)
	}
}

func TestLoadFromEnvLeavesTheBuiltInRelayOffByDefault(t *testing.T) {
	turnServerEnv(t, map[string]string{"TURN_SERVER_ENABLED": "", "TURN_SHARED_SECRET": ""})

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv() error = %v", err)
	}
	if cfg.TURNServerEnabled || cfg.TURNServerTLSEnabled() {
		t.Fatalf("the built-in relay must be opt-in: %+v", cfg)
	}
	if cfg.TURNServerPort != 3478 || cfg.TURNServerTLSPort != 5349 {
		t.Fatalf("listen ports = %d/%d, want 3478/5349", cfg.TURNServerPort, cfg.TURNServerTLSPort)
	}
	if cfg.TURNServerRelayPortMin != 49152 || cfg.TURNServerRelayPortMax != 49999 {
		t.Fatalf("relay range = %d-%d, want 49152-49999", cfg.TURNServerRelayPortMin, cfg.TURNServerRelayPortMax)
	}
	if cfg.TURNServerRealm != "slowmeet" {
		t.Fatalf("realm = %q, want slowmeet", cfg.TURNServerRealm)
	}
}

func TestLoadFromEnvParsesBuiltInRelaySettings(t *testing.T) {
	turnServerEnv(t, map[string]string{
		"TURN_SERVER_PORT":           "13478",
		"TURN_SERVER_TLS_PORT":       "15349",
		"TURN_SERVER_TLS_CERT_FILE":  "/certs/fullchain.pem",
		"TURN_SERVER_TLS_KEY_FILE":   "/certs/privkey.pem",
		"TURN_SERVER_REALM":          "meet.example.com",
		"TURN_SERVER_RELAY_PORT_MIN": "40000",
		"TURN_SERVER_RELAY_PORT_MAX": "40999",
		"TURN_SERVER_RELAY_IP":       "10.0.0.5",
	})

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv() error = %v", err)
	}
	if !cfg.TURNServerEnabled || cfg.TURNServerPort != 13478 || cfg.TURNServerTLSPort != 15349 {
		t.Fatalf("unexpected listen settings: %+v", cfg)
	}
	if cfg.TURNServerTLSCertFile != "/certs/fullchain.pem" || cfg.TURNServerTLSKeyFile != "/certs/privkey.pem" {
		t.Fatalf("unexpected certificate files: %q %q", cfg.TURNServerTLSCertFile, cfg.TURNServerTLSKeyFile)
	}
	if cfg.TURNServerRealm != "meet.example.com" || cfg.TURNServerRelayIP != "10.0.0.5" {
		t.Fatalf("unexpected realm or relay IP: %q %q", cfg.TURNServerRealm, cfg.TURNServerRelayIP)
	}
	if cfg.TURNServerRelayPortMin != 40000 || cfg.TURNServerRelayPortMax != 40999 {
		t.Fatalf("relay range = %d-%d", cfg.TURNServerRelayPortMin, cfg.TURNServerRelayPortMax)
	}
	if !cfg.TURNServerTLSEnabled() {
		t.Fatal("a TLS port with both certificate files must enable TURN over TLS")
	}
}

func TestBuiltInRelayTLSNeedsAPortAndBothFiles(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{name: "no certificate configured", env: nil, want: false},
		{name: "certificate configured", env: map[string]string{
			"TURN_SERVER_TLS_CERT_FILE": "/c.pem", "TURN_SERVER_TLS_KEY_FILE": "/k.pem",
		}, want: true},
		{name: "TLS port zero", env: map[string]string{
			"TURN_SERVER_TLS_PORT":      "0",
			"TURN_SERVER_TLS_CERT_FILE": "/c.pem", "TURN_SERVER_TLS_KEY_FILE": "/k.pem",
		}, want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			turnServerEnv(t, test.env)
			cfg, err := LoadFromEnv()
			if err != nil {
				t.Fatalf("LoadFromEnv() error = %v", err)
			}
			if got := cfg.TURNServerTLSEnabled(); got != test.want {
				t.Fatalf("TURNServerTLSEnabled() = %v, want %v", got, test.want)
			}
		})
	}
}

func TestLoadFromEnvRejectsInvalidBuiltInRelaySettings(t *testing.T) {
	tests := []struct {
		name      string
		env       map[string]string
		wantError string
	}{
		{name: "no shared secret", env: map[string]string{"TURN_SHARED_SECRET": ""}, wantError: "TURN_SHARED_SECRET"},
		{name: "credentials disabled", env: map[string]string{"TURN_CREDENTIAL_TTL_SECONDS": "0"}, wantError: "TURN_CREDENTIAL_TTL_SECONDS"},
		{name: "listen port zero", env: map[string]string{"TURN_SERVER_PORT": "0"}, wantError: "TURN_SERVER_PORT"},
		{name: "listen port too high", env: map[string]string{"TURN_SERVER_PORT": "70000"}, wantError: "TURN_SERVER_PORT"},
		{name: "negative TLS port", env: map[string]string{"TURN_SERVER_TLS_PORT": "-1"}, wantError: "TURN_SERVER_TLS_PORT"},
		{name: "TLS port equals plain port", env: map[string]string{"TURN_SERVER_TLS_PORT": "3478"}, wantError: "must differ"},
		{name: "certificate without key", env: map[string]string{"TURN_SERVER_TLS_CERT_FILE": "/c.pem"}, wantError: "set together"},
		{name: "key without certificate", env: map[string]string{"TURN_SERVER_TLS_KEY_FILE": "/k.pem"}, wantError: "set together"},
		{name: "blank realm", env: map[string]string{"TURN_SERVER_REALM": "   "}, wantError: "TURN_SERVER_REALM"},
		{name: "relay range reversed", env: map[string]string{
			"TURN_SERVER_RELAY_PORT_MIN": "45000", "TURN_SERVER_RELAY_PORT_MAX": "44000",
		}, wantError: "TURN relay port range"},
		{name: "relay range zero", env: map[string]string{"TURN_SERVER_RELAY_PORT_MIN": "0"}, wantError: "TURN relay port range"},
		{name: "relay range overlaps ICE range", env: map[string]string{
			"TURN_SERVER_RELAY_PORT_MIN": "49900", "TURN_SERVER_RELAY_PORT_MAX": "50000",
		}, wantError: "must not overlap"},
		{name: "relay range contains ICE range", env: map[string]string{
			"TURN_SERVER_RELAY_PORT_MIN": "40000", "TURN_SERVER_RELAY_PORT_MAX": "60000",
		}, wantError: "must not overlap"},
		{name: "listen port inside relay range", env: map[string]string{"TURN_SERVER_PORT": "49500"}, wantError: "outside the TURN relay port range"},
		{name: "relay IP not an address", env: map[string]string{"TURN_SERVER_RELAY_IP": "relay.example.com"}, wantError: "TURN_SERVER_RELAY_IP"},
		{name: "relay IP is IPv6", env: map[string]string{"TURN_SERVER_RELAY_IP": "2001:db8::1"}, wantError: "TURN_SERVER_RELAY_IP"},
		{name: "enabled flag not boolean", env: map[string]string{"TURN_SERVER_ENABLED": "maybe"}, wantError: "TURN_SERVER_ENABLED"},
		{name: "port not a number", env: map[string]string{"TURN_SERVER_PORT": "turn"}, wantError: "TURN_SERVER_PORT"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			turnServerEnv(t, test.env)
			_, err := LoadFromEnv()
			if err == nil {
				t.Fatal("expected the configuration to be rejected")
			}
			if !strings.Contains(err.Error(), test.wantError) {
				t.Fatalf("error = %q, want it to mention %q", err, test.wantError)
			}
		})
	}
}

func TestBuiltInRelayRangeMayOverlapAnUnrestrictedICERange(t *testing.T) {
	// ICE_UDP_PORT_MIN/MAX of 0 means the SFU uses the system's ephemeral
	// ports, so there is no fixed range to collide with.
	turnServerEnv(t, map[string]string{"ICE_UDP_PORT_MIN": "0", "ICE_UDP_PORT_MAX": "0"})
	if _, err := LoadFromEnv(); err != nil {
		t.Fatalf("LoadFromEnv() error = %v", err)
	}
}

func TestDisabledBuiltInRelayIgnoresItsSettings(t *testing.T) {
	// A deployment that uses an external TURN server (or none) must keep
	// starting whatever the relay variables hold.
	turnServerEnv(t, map[string]string{
		"TURN_SERVER_ENABLED":        "false",
		"TURN_SHARED_SECRET":         "",
		"TURN_SERVER_PORT":           "0",
		"TURN_SERVER_TLS_PORT":       "0",
		"TURN_SERVER_TLS_CERT_FILE":  "/only-a-cert.pem",
		"TURN_SERVER_RELAY_PORT_MIN": "50000",
		"TURN_SERVER_RELAY_PORT_MAX": "50100",
		"TURN_SERVER_RELAY_IP":       "not-an-ip",
		"TURN_URLS":                  "turn:turn.example.com:3478?transport=udp",
	})

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv() error = %v", err)
	}
	if cfg.TURNServerEnabled || cfg.TURNServerTLSEnabled() {
		t.Fatalf("the relay must stay disabled: %+v", cfg)
	}
	if got := cfg.EffectiveTURNURLs(); len(got) != 1 || got[0] != "turn:turn.example.com:3478?transport=udp" {
		t.Fatalf("external TURN URLs must be unaffected: %#v", got)
	}
}
