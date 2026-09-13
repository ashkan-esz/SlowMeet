package config

import (
	"crypto/hmac"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/base64"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	AppEnv              string
	HTTPAddr            string
	ConfigFile          string
	MeetingPassword     string
	AdminPassword       string
	STUNServers         []string
	TURNURL             string
	TURNURLs            []string
	TURNUsername        string
	TURNPassword        string
	TURNSharedSecret    string
	TURNCredentialTTL   time.Duration
	ICEIPv4Only         bool
	ICEUDPPortMin       int
	ICEUDPPortMax       int
	MaxParticipants     int
	DefaultVideoQuality string
	MaxVideoQuality     string
	DefaultVideoFPS     int
	MaxVideoFPS         int
	DefaultAudioBitrate int
	MaxVideoBitrate     int
	MaxAudioBitrate     int
	EnableScreenShare   bool
	RetainChatHistory   bool
	ReconnectTimeout    time.Duration
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
	maxVideoFPS, err := envInt("MAX_VIDEO_FPS", 60)
	if err != nil {
		return Config{}, err
	}
	defaultAudioBitrate, err := envInt("DEFAULT_AUDIO_BITRATE", 32000)
	if err != nil {
		return Config{}, err
	}
	maxVideoBitrate, err := envInt("MAX_VIDEO_BITRATE", 3000000)
	if err != nil {
		return Config{}, err
	}
	maxAudioBitrate, err := envInt("MAX_AUDIO_BITRATE", 96000)
	if err != nil {
		return Config{}, err
	}
	enableScreenShare, err := envBool("ENABLE_SCREEN_SHARE", true)
	if err != nil {
		return Config{}, err
	}
	reconnectSeconds, err := envInt("RECONNECT_TIMEOUT_SECONDS", 30)
	if err != nil {
		return Config{}, err
	}
	iceUDPPortMin, err := envInt("ICE_UDP_PORT_MIN", 50000)
	if err != nil {
		return Config{}, err
	}
	iceUDPPortMax, err := envInt("ICE_UDP_PORT_MAX", 50100)
	if err != nil {
		return Config{}, err
	}
	turnCredentialTTLSeconds, err := envInt("TURN_CREDENTIAL_TTL_SECONDS", 86400)
	if err != nil {
		return Config{}, err
	}
	iceIPv4Only, err := envBool("ICE_IPV4_ONLY", true)
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
		TURNURLs:            splitCSV(os.Getenv("TURN_URLS")),
		TURNUsername:        os.Getenv("TURN_USERNAME"),
		TURNPassword:        os.Getenv("TURN_PASSWORD"),
		TURNSharedSecret:    os.Getenv("TURN_SHARED_SECRET"),
		TURNCredentialTTL:   time.Duration(turnCredentialTTLSeconds) * time.Second,
		ICEIPv4Only:         iceIPv4Only,
		ICEUDPPortMin:       iceUDPPortMin,
		ICEUDPPortMax:       iceUDPPortMax,
		MaxParticipants:     maxParticipants,
		DefaultVideoQuality: envString("DEFAULT_VIDEO_QUALITY", "low"),
		MaxVideoQuality:     envString("MAX_VIDEO_QUALITY", "ultra"),
		DefaultVideoFPS:     defaultVideoFPS,
		MaxVideoFPS:         maxVideoFPS,
		DefaultAudioBitrate: defaultAudioBitrate,
		MaxVideoBitrate:     maxVideoBitrate,
		MaxAudioBitrate:     maxAudioBitrate,
		EnableScreenShare:   enableScreenShare,
		ReconnectTimeout:    time.Duration(reconnectSeconds) * time.Second,
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
	if (c.ICEUDPPortMin == 0) != (c.ICEUDPPortMax == 0) ||
		(c.ICEUDPPortMin != 0 &&
			(c.ICEUDPPortMin < 1 || c.ICEUDPPortMin > 65535 ||
				c.ICEUDPPortMax < 1 || c.ICEUDPPortMax > 65535 ||
				c.ICEUDPPortMin > c.ICEUDPPortMax)) {
		return fmt.Errorf("ICE UDP port range must be between 1 and 65535 with minimum <= maximum")
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
	if c.ReconnectTimeout < 0 || c.ReconnectTimeout > 10*time.Minute {
		return fmt.Errorf("RECONNECT_TIMEOUT_SECONDS must be between 0 and 600")
	}
	if c.TURNCredentialTTL != 0 &&
		(c.TURNCredentialTTL < time.Minute || c.TURNCredentialTTL > 7*24*time.Hour) {
		return fmt.Errorf("TURN_CREDENTIAL_TTL_SECONDS must be between 60 and 604800")
	}
	if c.DefaultVideoQuality == "" {
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must not be empty")
	}
	switch c.DefaultVideoQuality {
	case "low", "medium", "high", "very-good", "ultra":
	default:
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must be one of low, medium, high, very-good, or ultra")
	}
	maxVideoQuality := c.MaxVideoQuality
	if maxVideoQuality == "" {
		maxVideoQuality = "ultra"
	}
	switch maxVideoQuality {
	case "low", "medium", "high", "very-good", "ultra":
	default:
		return fmt.Errorf("MAX_VIDEO_QUALITY must be one of low, medium, high, very-good, or ultra")
	}
	if videoQualityRank(c.DefaultVideoQuality) > videoQualityRank(maxVideoQuality) {
		return fmt.Errorf("DEFAULT_VIDEO_QUALITY must not exceed MAX_VIDEO_QUALITY")
	}
	if c.LogLevel != "" && c.LogLevel != "info" && c.LogLevel != "debug" {
		return fmt.Errorf("LOG_LEVEL must be info or debug")
	}
	return nil
}

func (c Config) EffectiveMaxVideoQuality() string {
	if c.MaxVideoQuality == "" {
		return "ultra"
	}
	return c.MaxVideoQuality
}

func (c Config) EffectiveTURNURLs() []string {
	if len(c.TURNURLs) > 0 {
		return append([]string(nil), c.TURNURLs...)
	}
	if c.TURNURL != "" {
		return []string{c.TURNURL}
	}
	return nil
}

// TURNCredentials returns coturn REST API credentials when a shared secret is
// configured. The username contains the expiry timestamp expected by coturn.
func (c Config) TURNCredentials(subject string, now time.Time) (string, string, bool) {
	if c.TURNSharedSecret == "" || c.TURNCredentialTTL <= 0 {
		return "", "", false
	}
	expiresAt := now.Add(c.TURNCredentialTTL).Unix()
	username := fmt.Sprintf("%d:%s", expiresAt, subject)
	mac := hmac.New(sha1.New, []byte(c.TURNSharedSecret))
	_, _ = mac.Write([]byte(username))
	return username, base64.StdEncoding.EncodeToString(mac.Sum(nil)), true
}

func videoQualityRank(quality string) int {
	switch quality {
	case "medium":
		return 1
	case "high":
		return 2
	case "very-good":
		return 3
	case "ultra":
		return 4
	default:
		return 0
	}
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
