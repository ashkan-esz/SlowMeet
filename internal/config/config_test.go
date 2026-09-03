package config

import (
	"testing"
	"time"
)

func TestLoadFromEnvAppliesDefaults(t *testing.T) {
	t.Setenv("APP_ENV", "")
	t.Setenv("HTTP_ADDR", "")
	t.Setenv("MAX_PARTICIPANTS", "")
	t.Setenv("DEFAULT_VIDEO_QUALITY", "")
	t.Setenv("MAX_VIDEO_QUALITY", "")
	t.Setenv("DEFAULT_VIDEO_FPS", "")
	t.Setenv("DEFAULT_AUDIO_BITRATE", "")
	t.Setenv("MAX_VIDEO_BITRATE", "")
	t.Setenv("MAX_AUDIO_BITRATE", "")
	t.Setenv("ENABLE_SCREEN_SHARE", "")
	t.Setenv("RECONNECT_TIMEOUT_SECONDS", "")
	t.Setenv("TURN_URL", "")
	t.Setenv("TURN_URLS", "")
	t.Setenv("TURN_USERNAME", "")
	t.Setenv("TURN_PASSWORD", "")
	t.Setenv("TURN_SHARED_SECRET", "")
	t.Setenv("TURN_CREDENTIAL_TTL_SECONDS", "")
	t.Setenv("ICE_IPV4_ONLY", "")
	t.Setenv("ICE_UDP_PORT_MIN", "")
	t.Setenv("ICE_UDP_PORT_MAX", "")
	t.Setenv("LOG_LEVEL", "")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv() error = %v", err)
	}
	if cfg.HTTPAddr != ":8080" || cfg.MaxParticipants != 5 {
		t.Fatalf("unexpected defaults: %+v", cfg)
	}
	if cfg.DefaultVideoQuality != "low" || cfg.DefaultVideoFPS != 15 {
		t.Fatalf("unexpected media defaults: %+v", cfg)
	}
	if cfg.MaxVideoQuality != "high" {
		t.Fatalf("unexpected maximum video quality: %+v", cfg)
	}
	if cfg.MaxVideoFPS != 30 {
		t.Fatalf("unexpected maximum FPS: %+v", cfg)
	}
	if cfg.ICEUDPPortMin != 50000 || cfg.ICEUDPPortMax != 50100 {
		t.Fatalf("unexpected ICE UDP port range: %d-%d", cfg.ICEUDPPortMin, cfg.ICEUDPPortMax)
	}
	if cfg.TURNCredentialTTL != 24*time.Hour {
		t.Fatalf("unexpected TURN credential TTL: %s", cfg.TURNCredentialTTL)
	}
	if !cfg.ICEIPv4Only {
		t.Fatal("expected IPv4-only ICE default")
	}
	if cfg.ReconnectTimeout != 30*time.Second {
		t.Fatalf("unexpected reconnect timeout: %s", cfg.ReconnectTimeout)
	}
}

func TestLoadFromEnvParsesTURNAndIPv4Settings(t *testing.T) {
	t.Setenv("TURN_URL", "turn:legacy.example.com:3478")
	t.Setenv("TURN_URLS", "turn:turn.example.com:3478?transport=udp, turns:turn.example.com:443?transport=tcp")
	t.Setenv("TURN_SHARED_SECRET", "shared-secret")
	t.Setenv("TURN_CREDENTIAL_TTL_SECONDS", "600")
	t.Setenv("ICE_IPV4_ONLY", "false")

	cfg, err := LoadFromEnv()
	if err != nil {
		t.Fatalf("LoadFromEnv() error = %v", err)
	}
	if got := cfg.EffectiveTURNURLs(); len(got) != 2 || got[0] != "turn:turn.example.com:3478?transport=udp" ||
		got[1] != "turns:turn.example.com:443?transport=tcp" {
		t.Fatalf("unexpected TURN URLs: %#v", got)
	}
	if cfg.TURNCredentialTTL != 10*time.Minute || cfg.ICEIPv4Only {
		t.Fatalf("unexpected TURN/IPv4 settings: %+v", cfg)
	}
}

func TestTURNCredentialsAreTimeLimitedAndDeterministic(t *testing.T) {
	cfg := Config{TURNSharedSecret: "shared-secret", TURNCredentialTTL: time.Hour}
	now := time.Unix(1700000000, 0)

	username, credential, ok := cfg.TURNCredentials("participant-1", now)
	if !ok {
		t.Fatal("expected TURN credentials to be generated")
	}
	if username != "1700003600:participant-1" {
		t.Fatalf("unexpected TURN username: %q", username)
	}
	if credential == "" {
		t.Fatal("expected non-empty TURN credential")
	}
	if otherUsername, otherCredential, otherOK := cfg.TURNCredentials("participant-1", now.Add(time.Second)); !otherOK ||
		otherUsername == username || otherCredential == credential {
		t.Fatal("expected credentials to change as expiry changes")
	}
}

func TestMeetingPasswordUsesConstantTimeComparisonSemantics(t *testing.T) {
	cfg := Config{MeetingPassword: "secret"}
	if cfg.CheckMeetingPassword("wrong") || !cfg.CheckMeetingPassword("secret") {
		t.Fatal("expected only the configured password to be accepted")
	}
}

func TestLoadFromEnvRejectsInvalidValues(t *testing.T) {
	t.Setenv("MAX_PARTICIPANTS", "0")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("expected invalid participant limit to fail")
	}

	t.Setenv("MAX_PARTICIPANTS", "101")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("expected excessive participant limit to fail")
	}
}

func TestLoadFromEnvRejectsMalformedTypedValues(t *testing.T) {
	t.Setenv("MAX_PARTICIPANTS", "not-a-number")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("expected malformed integer to fail")
	}

	t.Setenv("MAX_PARTICIPANTS", "5")
	t.Setenv("ENABLE_SCREEN_SHARE", "sometimes")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("expected malformed boolean to fail")
	}

	t.Setenv("ENABLE_SCREEN_SHARE", "true")
	t.Setenv("RECONNECT_TIMEOUT_SECONDS", "not-a-number")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("expected malformed reconnect timeout to fail")
	}
}

func TestLoadFromEnvRejectsInvalidICEUDPPortRange(t *testing.T) {
	t.Setenv("ICE_UDP_PORT_MIN", "50100")
	t.Setenv("ICE_UDP_PORT_MAX", "50000")
	if _, err := LoadFromEnv(); err == nil {
		t.Fatal("expected reversed ICE UDP port range to fail")
	}
}

func TestValidateRejectsUnknownQualityAndLogLevel(t *testing.T) {
	cfg := Config{
		HTTPAddr:            ":8080",
		MaxParticipants:     5,
		DefaultVideoQuality: "ultra",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
		LogLevel:            "info",
	}
	if err := cfg.Validate(); err == nil {
		t.Fatal("unknown video quality was accepted")
	}

	cfg.DefaultVideoQuality = "low"
	cfg.MaxVideoQuality = "low"
	if err := cfg.Validate(); err != nil {
		t.Fatalf("matching maximum video quality rejected: %v", err)
	}
	cfg.DefaultVideoQuality = "medium"
	if err := cfg.Validate(); err == nil {
		t.Fatal("default quality above maximum was accepted")
	}
	cfg.DefaultVideoQuality = "low"
	cfg.MaxVideoQuality = "ultra"
	if err := cfg.Validate(); err == nil {
		t.Fatal("unknown maximum video quality was accepted")
	}
	cfg.MaxVideoQuality = ""
	cfg.LogLevel = "trace"
	if err := cfg.Validate(); err == nil {
		t.Fatal("unknown log level was accepted")
	}
}
