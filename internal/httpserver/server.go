package httpserver

import (
	"cmp"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync/atomic"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/signaling"
	webassets "SlowMeet/web"
)

type Server struct {
	handler http.Handler
	hub     *signaling.Hub
	ready   atomic.Bool
}

type participantPreviewRequest struct {
	Password string `json:"password"`
}

type participantPreviewEntry struct {
	Name string `json:"name"`
}

type participantPreviewResponse struct {
	Participants []participantPreviewEntry `json:"participants"`
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
			"max_video_quality":     cfg.EffectiveMaxVideoQuality(),
			"default_video_fps":     cfg.DefaultVideoFPS,
			"default_audio_bitrate": cfg.DefaultAudioBitrate,
			"max_video_bitrate":     cfg.MaxVideoBitrate,
			"max_video_fps":         cfg.MaxVideoFPS,
			"max_audio_bitrate":     cfg.MaxAudioBitrate,
			"screen_share_enabled":  cfg.EnableScreenShare,
			"retain_chat_history":   cfg.RetainChatHistory,
		})
	})
	participantPreview := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		var request participantPreviewRequest
		decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			writeAPIJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			writeAPIJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_request"})
			return
		}

		if !store.Snapshot().CheckMeetingPassword(request.Password) {
			status := http.StatusUnauthorized
			errorCode := "password_required"
			if request.Password != "" {
				status = http.StatusForbidden
				errorCode = "invalid_password"
			}
			writeAPIJSON(w, status, map[string]string{"error": errorCode})
			return
		}

		active := meetingState.List()
		slices.SortFunc(active, func(a, b meeting.Participant) int {
			if order := a.JoinedAt.Compare(b.JoinedAt); order != 0 {
				return order
			}
			return cmp.Compare(a.ID, b.ID)
		})
		response := participantPreviewResponse{
			Participants: make([]participantPreviewEntry, 0, len(active)),
		}
		for _, participant := range active {
			response.Participants = append(response.Participants, participantPreviewEntry{Name: participant.Name})
		}
		writeAPIJSON(w, http.StatusOK, response)
	})
	mux.Handle("POST /room/participants", participantPreview)
	mux.HandleFunc("/room/participants", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		requireMethod(w, r, http.MethodPost)
	})
	mux.HandleFunc("/ice-config", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		cfg := store.Snapshot()
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"ice_servers": browserICEServers(cfg, time.Now()),
		})
	})
	mux.HandleFunc("/metrics", func(w http.ResponseWriter, r *http.Request) {
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		cfg := store.Snapshot()
		snapshot := hub.Metrics().Snapshot()
		w.Header().Set("Content-Type", "text/plain; version=0.0.4")
		_, _ = fmt.Fprintf(w, "slowmeet_active_participants %d\n", meetingState.Count())
		_, _ = fmt.Fprintf(w, "slowmeet_peer_connections %d\n", snapshot.PeerConnections)
		_, _ = fmt.Fprintf(w, "slowmeet_connection_failures_total %d\n", snapshot.ConnectionFailures)
		_, _ = fmt.Fprintf(w, "slowmeet_reconnects_total %d\n", snapshot.Reconnects)
		_, _ = fmt.Fprintf(w, "slowmeet_network_samples_total %d\n", snapshot.NetworkSamples)
		_, _ = fmt.Fprintf(w, "slowmeet_network_sample_available %d\n", boolMetric(snapshot.HasNetworkSample))
		if snapshot.HasNetworkSample {
			_, _ = fmt.Fprintf(w, "slowmeet_last_network_sample_timestamp_seconds %d\n", snapshot.LastNetworkSample)
		}
		if snapshot.HasRTT {
			_, _ = fmt.Fprintf(w, "slowmeet_average_rtt_ms %.1f\n", snapshot.AverageRTTMs)
			_, _ = fmt.Fprintf(w, "slowmeet_last_rtt_ms %d\n", snapshot.LastRTTMs)
		}
		if snapshot.HasPacketLoss {
			_, _ = fmt.Fprintf(w, "slowmeet_last_packet_loss_percent %.1f\n", float64(snapshot.LastPacketLoss10)/10)
		}
		if snapshot.HasJitter {
			_, _ = fmt.Fprintf(w, "slowmeet_last_jitter_ms %d\n", snapshot.LastJitterMs)
		}
		if snapshot.HasVideo {
			_, _ = fmt.Fprintf(w, "slowmeet_last_video_kbps %d\n", snapshot.LastVideoKbps)
		}
		if snapshot.HasAudio {
			_, _ = fmt.Fprintf(w, "slowmeet_last_audio_kbps %d\n", snapshot.LastAudioKbps)
		}
		_, _ = fmt.Fprintf(w, "slowmeet_max_participants %d\n", cfg.MaxParticipants)
		_, _ = fmt.Fprintf(w, "slowmeet_max_video_bitrate %d\n", cfg.MaxVideoBitrate)
		_, _ = fmt.Fprintf(w, "slowmeet_max_audio_bitrate %d\n", cfg.MaxAudioBitrate)
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
			w.Header().Set("Allow", http.MethodGet+", "+http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		}
	})
	mux.Handle("/ws", hub)
	mux.Handle("/admin", http.RedirectHandler("/admin.html", http.StatusFound))
	mux.Handle("/", newStaticFileHandler())
	app.handler = withSecurityHeaders(mux)
	app.ready.Store(true)
	return app
}

func newStaticFileHandler() http.Handler {
	etags := make(map[string]string)
	err := fs.WalkDir(webassets.Files, ".", func(name string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		contents, err := fs.ReadFile(webassets.Files, name)
		if err != nil {
			return err
		}
		etag := fmt.Sprintf("\"%x\"", sha256.Sum256(contents))
		etags["/"+name] = etag
		if name == "index.html" {
			etags["/"] = etag
		}
		return nil
	})
	if err != nil {
		panic(fmt.Sprintf("prepare embedded static assets: %v", err))
	}
	staticFiles := http.FileServer(http.FS(webassets.Files))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			if etag, ok := etags[r.URL.Path]; ok {
				w.Header().Set("ETag", etag)
				if strings.HasSuffix(r.URL.Path, ".html") || r.URL.Path == "/" {
					w.Header().Set("Cache-Control", "no-cache")
				} else {
					w.Header().Set("Cache-Control", "public, max-age=0, must-revalidate")
				}
				if matchesETag(r.Header.Get("If-None-Match"), etag) {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}
		staticFiles.ServeHTTP(w, r)
	})
}

func matchesETag(header, etag string) bool {
	for _, candidate := range strings.Split(header, ",") {
		candidate = strings.TrimSpace(candidate)
		if candidate == "*" || candidate == etag || strings.TrimPrefix(candidate, "W/") == etag {
			return true
		}
	}
	return false
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
		"max_video_quality":     cfg.EffectiveMaxVideoQuality(),
		"default_video_fps":     cfg.DefaultVideoFPS, "default_audio_bitrate": cfg.DefaultAudioBitrate,
		"max_video_fps": cfg.MaxVideoFPS, "max_audio_bitrate": cfg.MaxAudioBitrate,
		"screen_share_enabled": cfg.EnableScreenShare,
		"retain_chat_history":  cfg.RetainChatHistory,
	})
}

type browserICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func browserICEServers(cfg config.Config, now time.Time) []browserICEServer {
	servers := make([]browserICEServer, 0, len(cfg.STUNServers)+1)
	for _, server := range cfg.STUNServers {
		servers = append(servers, browserICEServer{URLs: []string{server}})
	}
	turnURLs := cfg.EffectiveTURNURLs()
	if len(turnURLs) == 0 {
		return servers
	}
	username, credential, ok := cfg.TURNCredentials("browser", now)
	if !ok {
		return servers
	}
	return append(servers, browserICEServer{
		URLs:       turnURLs,
		Username:   username,
		Credential: credential,
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

func writeAPIJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func boolMetric(value bool) int {
	if value {
		return 1
	}
	return 0
}

func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; script-src 'self'; style-src 'self'; "+
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
