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
	store, err := config.LoadStore(cfg)
	if err != nil {
		logger.Warn("config_persistence_unavailable", "error", err)
		store = config.NewStore(cfg)
	}
	meetingState := meeting.New(cfg.MaxParticipants)
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
		cfg := store.Snapshot()
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
	mux.HandleFunc("/admin/config", func(w http.ResponseWriter, r *http.Request) {
		cfg := store.Snapshot()
		if cfg.AdminPassword == "" || !store.CheckAdminPassword(r.Header.Get("X-Admin-Password")) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		switch r.Method {
		case http.MethodGet:
			writePublicConfig(w, store.Snapshot())
		case http.MethodPost:
			var update config.AdminUpdate
			if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&update); err != nil {
				http.Error(w, "invalid configuration", http.StatusBadRequest)
				return
			}
			if err := store.Update(update); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			snapshot := store.Snapshot()
			meetingState.SetMaxParticipants(snapshot.MaxParticipants)
			writePublicConfig(w, snapshot)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.Handle("/ws", signaling.NewHub(meetingState, store, logger))
	mux.Handle("/admin", http.RedirectHandler("/admin.html", http.StatusFound))
	mux.Handle("/", http.FileServer(http.Dir("web")))
	return mux
}

func writePublicConfig(w http.ResponseWriter, cfg config.Config) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"max_participants": cfg.MaxParticipants, "max_video_bitrate": cfg.MaxVideoBitrate,
		"max_video_fps": cfg.DefaultVideoFPS, "max_audio_bitrate": cfg.MaxAudioBitrate,
		"screen_share_enabled": cfg.EnableScreenShare,
	})
}

func NewLogger(level string) *slog.Logger {
	var logLevel slog.Level
	if level == "debug" {
		logLevel = slog.LevelDebug
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
}
