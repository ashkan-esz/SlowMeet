package httpserver

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"sync/atomic"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/signaling"
)

type Server struct {
	handler http.Handler
	hub     *signaling.Hub
	ready   atomic.Bool
}

func New(cfg config.Config, logger *slog.Logger) *Server {
	store, err := config.LoadStore(cfg)
	if err != nil {
		logger.Warn("config_persistence_unavailable", "error", err)
		store = config.NewStore(cfg)
	}
	meetingState := meeting.New(store.Snapshot().MaxParticipants)
	hub := signaling.NewHub(meetingState, store, logger)
	app := &Server{hub: hub}
	mux := http.NewServeMux()
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ok"})
	})
	mux.HandleFunc("/ready", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		if !app.ready.Load() {
			http.Error(w, "not ready", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{"status": "ready"})
	})
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		cfg := store.Snapshot()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"max_participants":      cfg.MaxParticipants,
			"default_video_quality": cfg.DefaultVideoQuality,
			"default_video_fps":     cfg.DefaultVideoFPS,
			"default_audio_bitrate": cfg.DefaultAudioBitrate,
			"max_video_bitrate":     cfg.MaxVideoBitrate,
			"max_video_fps":         cfg.MaxVideoFPS,
			"max_audio_bitrate":     cfg.MaxAudioBitrate,
			"screen_share_enabled":  cfg.EnableScreenShare,
		})
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		cfg := store.Snapshot()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(w, "lowmeet_active_participants %d\n", meetingState.Count())
		_, _ = fmt.Fprintf(w, "lowmeet_max_participants %d\n", cfg.MaxParticipants)
		_, _ = fmt.Fprintf(w, "lowmeet_max_video_bitrate %d\n", cfg.MaxVideoBitrate)
		_, _ = fmt.Fprintf(w, "lowmeet_max_audio_bitrate %d\n", cfg.MaxAudioBitrate)
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
			decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
			decoder.DisallowUnknownFields()
			if err := decoder.Decode(&update); err != nil {
				http.Error(w, "invalid configuration", http.StatusBadRequest)
				return
			}
			var trailing any
			if err := decoder.Decode(&trailing); err != io.EOF {
				http.Error(w, "invalid configuration", http.StatusBadRequest)
				return
			}
			if err := store.Update(update); err != nil {
				http.Error(w, err.Error(), http.StatusBadRequest)
				return
			}
			snapshot := store.Snapshot()
			meetingState.SetMaxParticipants(snapshot.MaxParticipants)
			hub.BroadcastConfig(snapshot)
			writePublicConfig(w, snapshot)
		default:
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.Handle("/ws", hub)
	mux.Handle("/admin", http.RedirectHandler("/admin.html", http.StatusFound))
	mux.Handle("/", http.FileServer(http.Dir("web")))
	app.handler = withSecurityHeaders(mux)
	app.ready.Store(true)
	return app
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.handler.ServeHTTP(w, r)
}

func (s *Server) Close() {
	s.ready.Store(false)
	s.hub.Close()
}

func writePublicConfig(w http.ResponseWriter, cfg config.Config) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"max_participants": cfg.MaxParticipants, "max_video_bitrate": cfg.MaxVideoBitrate,
		"default_video_quality": cfg.DefaultVideoQuality,
		"max_video_fps":         cfg.MaxVideoFPS, "max_audio_bitrate": cfg.MaxAudioBitrate,
		"screen_share_enabled": cfg.EnableScreenShare,
	})
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	if r.Method == method {
		return true
	}
	w.Header().Set("Allow", method)
	http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	return false
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; "+
				"connect-src 'self'; media-src 'self' blob:; img-src 'self' data:; "+
				"frame-ancestors 'none'; base-uri 'none'; form-action 'self'")
		w.Header().Set("Permissions-Policy", "camera=(self), microphone=(self), display-capture=(self)")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		next.ServeHTTP(w, r)
	})
}

func NewLogger(level string) *slog.Logger {
	var logLevel slog.Level
	if level == "debug" {
		logLevel = slog.LevelDebug
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
}
