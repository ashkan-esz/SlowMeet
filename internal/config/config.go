package config

import (
	"crypto/subtle"
	"fmt"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	AppEnv              string
	HTTPAddr            string
	ConfigFile          string
	MeetingPassword     string
	AdminPassword       string
	STUNServers         []string
	TURNURL             string
	TURNUsername        string
	TURNPassword        string
	MaxParticipants     int
	DefaultVideoQuality string
	DefaultVideoFPS     int
	MaxVideoFPS         int
	DefaultAudioBitrate int
	MaxVideoBitrate     int
	MaxAudioBitrate     int
	EnableScreenShare   bool
	LogLevel            string
}

const MaxAllowedParticipants = 100

func LoadFromEnv() (Config, error) {
	maxParticipants, err := envInt("MAX_PARTICIPANTS", 5)
	if err != nil {
		return Config{}, err
	}
	defaultVideoFPS, err := envInt("DEFAULT_VIDEO_FPS", 15)
	if err != nil {
		return Config{}, err
	}
	maxVideoFPS, err := envInt("MAX_VIDEO_FPS", 30)
	if err != nil {
		return Config{}, err
	}
	defaultAudioBitrate, err := envInt("DEFAULT_AUDIO_BITRATE", 32000)
	if err != nil {
		return Config{}, err
	}
	maxVideoBitrate, err := envInt("MAX_VIDEO_BITRATE", 500000)
	if err != nil {
		return Config{}, err
	}
	maxAudioBitrate, err := envInt("MAX_AUDIO_BITRATE", 64000)
	if err != nil {
		return Config{}, err
	}
	enableScreenShare, err := envBool("ENABLE_SCREEN_SHARE", true)
	if err != nil {
		return Config{}, err
	}
	cfg := Config{
		AppEnv:              envString("APP_ENV", "production"),
		HTTPAddr:            envString("HTTP_ADDR", ":8080"),
		ConfigFile:          envString("CONFIG_FILE", "config.json"),
		MeetingPassword:     os.Getenv("MEETING_PASSWORD"),
		AdminPassword:       os.Getenv("ADMIN_PASSWORD"),
		STUNServers:         splitCSV(os.Getenv("STUN_SERVERS")),
		TURNURL:             os.Getenv("TURN_URL"),
		TURNUsername:        os.Getenv("TURN_USERNAME"),
		TURNPassword:        os.Getenv("TURN_PASSWORD"),
		MaxParticipants:     maxParticipants,
		DefaultVideoQuality: envString("DEFAULT_VIDEO_QUALITY", "low"),
		DefaultVideoFPS:     defaultVideoFPS,
		MaxVideoFPS:         maxVideoFPS,
		DefaultAudioBitrate: defaultAudioBitrate,
		MaxVideoBitrate:     maxVideoBitrate,
		MaxAudioBitrate:     maxAudioBitrate,
		EnableScreenShare:   enableScreenShare,
		LogLevel:            envString("LOG_LEVEL", "info"),
	}
	if err := cfg.Validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c Config) Validate() error {
	if c.HTTPAddr == "" {
		return fmt.Errorf("HTTP_ADDR must not be empty")
	}
	if c.MaxParticipants < 1 || c.MaxParticipants > MaxAllowedParticipants {
		return fmt.Errorf("MAX_PARTICIPANTS must be between 1 and %d", MaxAllowedParticipants)
	}
	if c.DefaultVideoFPS < 1 || c.DefaultVideoFPS > 60 {
		return fmt.Errorf("DEFAULT_VIDEO_FPS must be between 1 and 60")
	}
	if c.MaxVideoFPS < c.DefaultVideoFPS || c.MaxVideoFPS > 60 {
		return fmt.Errorf("MAX_VIDEO_FPS must be between DEFAULT_VIDEO_FPS and 60")
	}
	if c.DefaultAudioBitrate < 1 || c.MaxAudioBitrate < c.DefaultAudioBitrate {
		return fmt.Errorf("audio bitrate configuration is invalid")
	}
	if c.MaxVideoBitrate < 1 {
		return fmt.Errorf("MAX_VIDEO_BITRATE must be positive")
	}
	if c.DefaultVideoQuality == "" {
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must not be empty")
	}
	switch c.DefaultVideoQuality {
	case "low", "medium", "high":
	default:
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must be one of low, medium, or high")
	}
	if c.LogLevel != "" && c.LogLevel != "info" && c.LogLevel != "debug" {
		return fmt.Errorf("LOG_LEVEL must be info or debug")
	}
	return nil
}

func (c Config) CheckMeetingPassword(candidate string) bool {
	if c.MeetingPassword == "" {
		return true
	}
	if len(candidate) != len(c.MeetingPassword) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(candidate), []byte(c.MeetingPassword)) == 1
}

func envString(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}

func envInt(key string, fallback int) (int, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return 0, fmt.Errorf("%s must be an integer: %w", key, err)
	}
	return parsed, nil
}

func envBool(key string, fallback bool) (bool, error) {
	value := os.Getenv(key)
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be a boolean: %w", key, err)
	}
	return parsed, nil
}

func splitCSV(value string) []string {
	var values []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			values = append(values, item)
		}
	}
	return values
}
