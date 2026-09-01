package httpserver

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"os"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/signaling"
)

func New(cfg config.Config, logger *slog.Logger) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/ready", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	})
	mux.HandleFunc("/config", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"max_participants":      cfg.MaxParticipants,
			"default_video_quality": cfg.DefaultVideoQuality,
			"default_video_fps":     cfg.DefaultVideoFPS,
			"default_audio_bitrate": cfg.DefaultAudioBitrate,
			"max_video_bitrate":     cfg.MaxVideoBitrate,
			"max_audio_bitrate":     cfg.MaxAudioBitrate,
			"screen_share_enabled":  cfg.EnableScreenShare,
		})
	})
	mux.Handle("/ws", signaling.NewHub(meeting.New(cfg.MaxParticipants), cfg, logger))
	mux.Handle("/", http.FileServer(http.Dir("web")))
	return mux
}

func NewLogger(level string) *slog.Logger {
	var logLevel slog.Level
	if level == "debug" {
		logLevel = slog.LevelDebug
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
}
