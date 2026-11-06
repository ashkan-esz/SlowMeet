package httpserver

import (
	"bytes"
	"cmp"
	"compress/gzip"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"html"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/ratelimit"
	"SlowMeet/internal/signaling"
	webassets "SlowMeet/web"
)

// Password attempts on password-checking surfaces are throttled per client IP
// to blunt online guessing.
const (
	passwordFailuresPerMinute = 10
	passwordFailureBurst      = 10
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
	store, err := config.LoadStore(cfg, logger)
	if err != nil {
		logger.Warn("config_persistence_unavailable", "error", err)
		store = config.NewStore(cfg)
	}
	meetingState := meeting.New(store.Snapshot().MaxParticipants)
	hub := signaling.NewHub(meetingState, store, logger)
	app := &Server{hub: hub}
	roomPreviewLimiter := ratelimit.New(passwordFailuresPerMinute, passwordFailureBurst)
	adminLimiter := ratelimit.New(passwordFailuresPerMinute, passwordFailureBurst)
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

		cfg := store.Snapshot()
		clientIP := ratelimit.ClientIPWithTrustedProxyCIDRs(r, cfg.TrustedProxyCIDRs)
		passwordRequired := cfg.MeetingPassword != ""
		if passwordRequired && !roomPreviewLimiter.AllowAttempt(clientIP) {
			writeAPIJSON(w, http.StatusTooManyRequests, map[string]string{"error": "too_many_attempts"})
			return
		}
		if !cfg.CheckMeetingPassword(request.Password) {
			if request.Password != "" {
				writeAPIJSON(w, http.StatusForbidden, map[string]string{"error": "invalid_password"})
				return
			}
			writeAPIJSON(w, http.StatusUnauthorized, map[string]string{"error": "password_required"})
			return
		}
		if passwordRequired {
			roomPreviewLimiter.RefundAttempt(clientIP)
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
		writeICEConfig(w, cfg, browserICEServers(cfg, time.Now(), false))
	})
	mux.HandleFunc("/ice-config/credentials", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		if !requireMethod(w, r, http.MethodGet) {
			return
		}
		const bearerPrefix = "Bearer "
		authorization := r.Header.Get("Authorization")
		if !strings.HasPrefix(authorization, bearerPrefix) || strings.TrimSpace(strings.TrimPrefix(authorization, bearerPrefix)) == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		token := strings.TrimPrefix(authorization, bearerPrefix)
		if strings.TrimSpace(token) != token || !hub.ValidateActiveReconnectToken(token) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		cfg := store.Snapshot()
		writeICEConfig(w, cfg, browserICEServers(cfg, time.Now(), true))
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
		if cfg.AdminPassword == "" {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		clientIP := ratelimit.ClientIPWithTrustedProxyCIDRs(r, cfg.TrustedProxyCIDRs)
		if !adminLimiter.AllowAttempt(clientIP) {
			http.Error(w, "too many attempts", http.StatusTooManyRequests)
			return
		}
		if !store.CheckAdminPassword(r.Header.Get("X-Admin-Password")) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		adminLimiter.RefundAttempt(clientIP)
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
	mux.Handle("/", newStaticFileHandler(cfg.AppName))
	app.handler = withSecurityHeaders(withGzip(mux))
	app.ready.Store(true)
	return app
}

func newStaticFileHandler(appName string) http.Handler {
	appName = cmp.Or(appName, "SlowMeet")
	etags := make(map[string]string)
	brandedHTML := make(map[string][]byte)
	// precompressed holds level-9 gzip variants built once at startup: cold
	// page loads get the smallest representation without per-request CPU, and
	// the bytes can never drift from the asset they were built from.
	precompressed := make(map[string][]byte)
	compressedEtags := make(map[string]string)
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
		if strings.HasSuffix(name, ".html") {
			contents = []byte(strings.ReplaceAll(string(contents), "{{APP_NAME}}", html.EscapeString(appName)))
			brandedHTML["/"+name] = contents
			if name == "index.html" {
				brandedHTML["/"] = contents
			}
		}
		etag := fmt.Sprintf("\"%x\"", sha256.Sum256(contents))
		etags["/"+name] = etag
		if name == "index.html" {
			etags["/"] = etag
		}
		if compressed, ok := gzipBytes(contents); ok {
			key := "/" + name
			precompressed[key] = compressed
			compressedEtags[key] = fmt.Sprintf("\"%x-gz\"", sha256.Sum256(compressed))
			if name == "index.html" {
				precompressed["/"] = compressed
				compressedEtags["/"] = compressedEtags[key]
			}
		}
		return nil
	})
	if err != nil {
		panic(fmt.Sprintf("prepare embedded static assets: %v", err))
	}
	staticFiles := http.FileServer(http.FS(webassets.Files))

	// servePrecompressed writes the gzip variant for a compressible asset.
	// The ETag identifies the compressed representation, so identity and gzip
	// caches never mix. Range requests fall back to the identity path, where
	// byte semantics are simplest.
	servePrecompressed := func(w http.ResponseWriter, r *http.Request, key, cacheControl string) bool {
		compressed, ok := precompressed[key]
		if !ok || r.Header.Get("Range") != "" || !acceptsGzip(r) {
			return false
		}
		etag := compressedEtags[key]
		w.Header().Set("Content-Encoding", "gzip")
		w.Header().Add("Vary", "Accept-Encoding")
		w.Header().Set("ETag", etag)
		w.Header().Set("Cache-Control", cacheControl)
		if matchesETag(r.Header.Get("If-None-Match"), etag) {
			w.WriteHeader(http.StatusNotModified)
			return true
		}
		// ServeContent derives the Content-Type from the asset name; the root
		// path has no extension to read, and an empty name makes it sniff the
		// gzip body as "application/x-gzip" — which nosniff turns into a
		// browser download instead of a rendered page.
		name := strings.TrimPrefix(key, "/")
		if name == "" {
			name = "index.html"
		}
		http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(compressed))
		return true
	}

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, ok := brandedHTML[r.URL.Path]; ok {
			if r.Method == http.MethodGet || r.Method == http.MethodHead {
				if servePrecompressed(w, r, r.URL.Path, "no-cache") {
					return
				}
				etag := etags[r.URL.Path]
				w.Header().Set("ETag", etag)
				w.Header().Set("Cache-Control", "no-cache")
				if matchesETag(r.Header.Get("If-None-Match"), etag) {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
			name := strings.TrimPrefix(r.URL.Path, "/")
			if name == "" {
				name = "index.html"
			}
			http.ServeContent(w, r, name, time.Time{}, bytes.NewReader(brandedHTML[r.URL.Path]))
			return
		}
		if r.Method == http.MethodGet || r.Method == http.MethodHead {
			if _, ok := etags[r.URL.Path]; ok {
				cacheControl := "public, max-age=0, must-revalidate"
				if strings.HasSuffix(r.URL.Path, ".html") || r.URL.Path == "/" {
					cacheControl = "no-cache"
				}
				if servePrecompressed(w, r, r.URL.Path, cacheControl) {
					return
				}
				w.Header().Set("ETag", etags[r.URL.Path])
				w.Header().Set("Cache-Control", cacheControl)
				if matchesETag(r.Header.Get("If-None-Match"), etags[r.URL.Path]) {
					w.WriteHeader(http.StatusNotModified)
					return
				}
			}
		}
		staticFiles.ServeHTTP(w, r)
	})
}

// gzipBytes returns the level-9 gzip encoding of data when it is actually
// smaller; tiny assets (like the 189-byte SVG favicon) are served identity.
func gzipBytes(data []byte) ([]byte, bool) {
	var buf bytes.Buffer
	writer, err := gzip.NewWriterLevel(&buf, gzip.BestCompression)
	if err != nil {
		return nil, false
	}
	if _, err := writer.Write(data); err != nil {
		return nil, false
	}
	if err := writer.Close(); err != nil {
		return nil, false
	}
	if buf.Len() < len(data) {
		return buf.Bytes(), true
	}
	return nil, false
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
		"screen_share_enabled":       cfg.EnableScreenShare,
		"retain_chat_history":        cfg.RetainChatHistory,
		"enabled_connection_methods": cfg.EffectiveEnabledConnectionMethods(),
	})
}

type browserConnectionMethod struct {
	ID           string `json:"id"`
	Label        string `json:"label"`
	Enabled      bool   `json:"enabled"`
	Available    bool   `json:"available"`
	AdminEnabled bool   `json:"admin_enabled"`
	Reason       string `json:"reason,omitempty"`
}

func browserConnectionMethods(cfg config.Config, servers []browserICEServer) []browserConnectionMethod {
	enabled := make(map[string]bool)
	configuredTURN := make(map[string]bool)
	for _, id := range cfg.EffectiveEnabledConnectionMethods() {
		enabled[id] = true
	}
	for _, rawURL := range cfg.EffectiveTURNURLs() {
		if id := turnConnectionMethod(rawURL); id != "" {
			configuredTURN[id] = true
		}
	}
	available := map[string]bool{"direct": cfg.ICETransportPolicy != "relay"}
	for _, server := range servers {
		for _, rawURL := range server.URLs {
			if id := turnConnectionMethod(rawURL); id != "" {
				available[id] = true
			}
		}
	}
	methods := []browserConnectionMethod{
		{ID: "auto", Label: "Automatic", Enabled: true, Available: true, AdminEnabled: true},
		{ID: "direct", Label: "Direct", Available: available["direct"], AdminEnabled: enabled["direct"]},
		{ID: "turn-udp", Label: "TURN over UDP", Available: available["turn-udp"], AdminEnabled: enabled["turn-udp"]},
		{ID: "turn-tcp", Label: "TURN over TCP", Available: available["turn-tcp"], AdminEnabled: enabled["turn-tcp"]},
		{ID: "turn-tls", Label: "TURN over TLS", Available: available["turn-tls"], AdminEnabled: enabled["turn-tls"]},
	}
	for i := range methods {
		method := &methods[i]
		method.Enabled = method.Enabled || (method.Available && method.AdminEnabled)
		if method.ID == "auto" || method.Enabled {
			continue
		}
		switch {
		case !method.Available:
			method.Reason = "Not configured on this server"
			if configuredTURN[method.ID] {
				method.Reason = "TURN credentials are unavailable"
			}
			if method.ID == "direct" && cfg.ICETransportPolicy == "relay" {
				method.Reason = "Disabled by the server ICE policy"
			}
		case !method.AdminEnabled:
			method.Reason = "Disabled by the administrator"
		}
	}
	return methods
}

func turnConnectionMethod(raw string) string {
	parts := strings.SplitN(raw, "?", 2)
	address := strings.ToLower(parts[0])
	if strings.HasPrefix(address, "turns:") {
		return "turn-tls"
	}
	if !strings.HasPrefix(address, "turn:") {
		return ""
	}
	transport := "udp"
	if len(parts) == 2 {
		for _, parameter := range strings.Split(parts[1], "&") {
			pair := strings.SplitN(parameter, "=", 2)
			if len(pair) == 2 && strings.EqualFold(pair[0], "transport") {
				transport = strings.ToLower(pair[1])
			}
		}
	}
	switch transport {
	case "udp":
		return "turn-udp"
	case "tcp":
		return "turn-tcp"
	default:
		return ""
	}
}

type browserICEServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

func browserICEServers(cfg config.Config, now time.Time, includeCredentials bool) []browserICEServer {
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
	turnServer := browserICEServer{URLs: turnURLs}
	if includeCredentials {
		turnServer.Username = username
		turnServer.Credential = credential
	}
	return append(servers, turnServer)
}

func writeICEConfig(w http.ResponseWriter, cfg config.Config, iceServers []browserICEServer) {
	iceTransportPolicy := cfg.ICETransportPolicy
	if iceTransportPolicy == "" {
		iceTransportPolicy = "all"
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"ice_servers":          iceServers,
		"ice_transport_policy": iceTransportPolicy,
		"simulcast_enabled":    cfg.SimulcastEnabled,
		"connection_methods":   browserConnectionMethods(cfg, iceServers),
	})
}

func requireMethod(w http.ResponseWriter, r *http.Request, method string) bool {
	// HEAD is allowed wherever GET is: monitors probe the health endpoints
	// with it, and net/http strips the body automatically.
	if r.Method == method || (method == http.MethodGet && r.Method == http.MethodHead) {
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

// gzipWriterPool keeps the per-response compression buffers reusable; page
// load traffic bursts heavily and every asset request would otherwise
// allocate one.
var gzipWriterPool = sync.Pool{
	New: func() any {
		writer, _ := gzip.NewWriterLevel(nil, gzip.BestSpeed)
		return writer
	},
}

// withGzip compresses compressible responses for clients that accept it. The
// embedded assets are several hundred kilobytes of JavaScript and CSS;
// shipping them uncompressed dominates a cold page load. WebSocket upgrades
// are skipped (the connection is hijacked after the handshake), as are range
// requests, where a re-encoded body would break byte semantics.
func withGzip(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !acceptsGzip(r) || r.Header.Get("Range") != "" {
			next.ServeHTTP(w, r)
			return
		}
		gz := gzipWriterPool.Get().(*gzip.Writer)
		defer gzipWriterPool.Put(gz)
		gz.Reset(w)
		defer gz.Close()
		wrapped := &gzipResponseWriter{ResponseWriter: w, gz: gz}
		next.ServeHTTP(wrapped, r)
	})
}

func acceptsGzip(r *http.Request) bool {
	if strings.HasPrefix(strings.ToLower(r.Header.Get("Upgrade")), "websocket") {
		return false
	}
	return strings.Contains(strings.ToLower(r.Header.Get("Accept-Encoding")), "gzip")
}

func compressibleContentType(contentType string) bool {
	contentType = strings.ToLower(contentType)
	if before, _, found := strings.Cut(contentType, ";"); found {
		contentType = strings.TrimSpace(before)
	}
	if strings.HasPrefix(contentType, "text/") {
		return true
	}
	switch contentType {
	case "application/javascript", "application/json", "image/svg+xml":
		return true
	default:
		return false
	}
}

// gzipResponseWriter decides at WriteHeader time whether the response body is
// worth compressing, based on the handler's Content-Type.
type gzipResponseWriter struct {
	http.ResponseWriter
	gz          *gzip.Writer
	enabled     bool
	wroteHeader bool
}

func (g *gzipResponseWriter) WriteHeader(status int) {
	if g.wroteHeader {
		return
	}
	g.wroteHeader = true
	// A handler that already chose an encoding (the precompressed static
	// assets) must not be compressed a second time.
	if g.Header().Get("Content-Encoding") == "" && compressibleContentType(g.Header().Get("Content-Type")) {
		g.enabled = true
		g.Header().Del("Content-Length")
		g.Header().Set("Content-Encoding", "gzip")
		g.Header().Add("Vary", "Accept-Encoding")
	} else {
		g.enabled = false
	}
	g.ResponseWriter.WriteHeader(status)
}

func (g *gzipResponseWriter) Write(payload []byte) (int, error) {
	if !g.wroteHeader {
		g.WriteHeader(http.StatusOK)
	}
	if g.enabled {
		return g.gz.Write(payload)
	}
	return g.ResponseWriter.Write(payload)
}

// Flush pushes compressed bytes through so streamed responses are not
// buffered by the compressor.
func (g *gzipResponseWriter) Flush() {
	if g.enabled {
		_ = g.gz.Flush()
	}
	if flusher, ok := g.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

// Unwrap lets http.ResponseController reach the underlying writer for
// handlers that need deadline or hijack control.
func (g *gzipResponseWriter) Unwrap() http.ResponseWriter {
	return g.ResponseWriter
}

func NewLogger(level string) *slog.Logger {
	var logLevel slog.Level
	if level == "debug" {
		logLevel = slog.LevelDebug
	}
	return slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: logLevel}))
}
