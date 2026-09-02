package config

import "testing"

func TestLoadFromEnvAppliesDefaults(t *testing.T) {
	t.Setenv("APP_ENV", "")
	t.Setenv("HTTP_ADDR", "")
	t.Setenv("MAX_PARTICIPANTS", "")
	t.Setenv("DEFAULT_VIDEO_QUALITY", "")
	t.Setenv("DEFAULT_VIDEO_FPS", "")
	t.Setenv("DEFAULT_AUDIO_BITRATE", "")
	t.Setenv("MAX_VIDEO_BITRATE", "")
	t.Setenv("MAX_AUDIO_BITRATE", "")
	t.Setenv("ENABLE_SCREEN_SHARE", "")
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
	if cfg.MaxVideoFPS != 30 {
		t.Fatalf("unexpected maximum FPS: %+v", cfg)
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
	cfg.LogLevel = "trace"
	if err := cfg.Validate(); err == nil {
		t.Fatal("unknown log level was accepted")
	}
}
