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
	MeetingPassword     string
	AdminPassword       string
	STUNServers         []string
	TURNURL             string
	TURNUsername        string
	TURNPassword        string
	MaxParticipants     int
	DefaultVideoQuality string
	DefaultVideoFPS     int
	DefaultAudioBitrate int
	MaxVideoBitrate     int
	MaxAudioBitrate     int
	EnableScreenShare   bool
	LogLevel            string
}

func LoadFromEnv() (Config, error) {
	cfg := Config{
		AppEnv:              envString("APP_ENV", "production"),
		HTTPAddr:            envString("HTTP_ADDR", ":8080"),
		MeetingPassword:     os.Getenv("MEETING_PASSWORD"),
		AdminPassword:       os.Getenv("ADMIN_PASSWORD"),
		STUNServers:         splitCSV(os.Getenv("STUN_SERVERS")),
		TURNURL:             os.Getenv("TURN_URL"),
		TURNUsername:        os.Getenv("TURN_USERNAME"),
		TURNPassword:        os.Getenv("TURN_PASSWORD"),
		MaxParticipants:     envInt("MAX_PARTICIPANTS", 5),
		DefaultVideoQuality: envString("DEFAULT_VIDEO_QUALITY", "low"),
		DefaultVideoFPS:     envInt("DEFAULT_VIDEO_FPS", 15),
		DefaultAudioBitrate: envInt("DEFAULT_AUDIO_BITRATE", 32000),
		MaxVideoBitrate:     envInt("MAX_VIDEO_BITRATE", 500000),
		MaxAudioBitrate:     envInt("MAX_AUDIO_BITRATE", 64000),
		EnableScreenShare:   envBool("ENABLE_SCREEN_SHARE", true),
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
	if c.MaxParticipants < 1 {
		return fmt.Errorf("MAX_PARTICIPANTS must be at least 1")
	}
	if c.DefaultVideoFPS < 1 || c.DefaultVideoFPS > 60 {
		return fmt.Errorf("DEFAULT_VIDEO_FPS must be between 1 and 60")
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

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
}

func envBool(key string, fallback bool) bool {
	value, err := strconv.ParseBool(os.Getenv(key))
	if err != nil {
		return fallback
	}
	return value
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
