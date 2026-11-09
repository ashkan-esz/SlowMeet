package httpserver

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/signaling"
	"github.com/gorilla/websocket"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
		AppName:             "SlowMeet",
		HTTPAddr:            ":8080",
		ConfigFile:          filepath.Join(t.TempDir(), "config.json"),
		AdminPassword:       "admin-secret",
		MaxParticipants:     5,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
		EnableScreenShare:   true,
	}
}

func TestHealthAndPublicConfig(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d, want 200", health.Code)
	}

	public := httptest.NewRecorder()
	handler.ServeHTTP(public, httptest.NewRequest(http.MethodGet, "/config", nil))
	if public.Code != http.StatusOK {
		t.Fatalf("config status = %d, want 200", public.Code)
	}
	var values map[string]any
	if err := json.NewDecoder(public.Body).Decode(&values); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if values["max_video_bitrate"] != float64(500000) {
		t.Fatalf("unexpected public config: %#v", values)
	}
	if values["default_video_quality"] != "low" {
		t.Fatalf("unexpected default video quality: %#v", values["default_video_quality"])
	}
	if values["max_video_quality"] != "ultra" {
		t.Fatalf("unexpected maximum video quality: %#v", values["max_video_quality"])
	}
	if _, exposed := values["admin_password"]; exposed {
		t.Fatal("public config exposed admin password")
	}
	if got := public.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("public config Cache-Control = %q, want no-store", got)
	}

	metrics := httptest.NewRecorder()
	handler.ServeHTTP(metrics, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if metrics.Code != http.StatusOK || !strings.Contains(metrics.Body.String(), "slowmeet_peer_connections 0") ||
		strings.Contains(metrics.Body.String(), "slowmeet_average_rtt_ms") ||
		strings.Contains(metrics.Body.String(), "slowmeet_last_network_sample_timestamp_seconds") ||
		strings.Contains(metrics.Body.String(), "slowmeet_last_video_kbps") ||
		!strings.Contains(metrics.Body.String(), "slowmeet_network_sample_available 0") {
		t.Fatalf("unexpected metrics response: %s", metrics.Body.String())
	}

	handler.hub.Metrics().ObserveNetwork(84, 4, 8, 521, 32)
	withSample := httptest.NewRecorder()
	handler.ServeHTTP(withSample, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := withSample.Body.String()
	if !strings.Contains(body, "slowmeet_last_network_sample_timestamp_seconds ") ||
		!strings.Contains(body, "slowmeet_last_rtt_ms 84") ||
		!strings.Contains(body, "slowmeet_last_packet_loss_percent 0.4") {
		t.Fatalf("metrics response omitted observed network sample: %s", body)
	}
}

func TestStaticAssetsUseETagCaching(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))

	asset := httptest.NewRecorder()
	handler.ServeHTTP(asset, httptest.NewRequest(http.MethodGet, "/js/protocol.js", nil))
	if asset.Code != http.StatusOK || asset.Body.Len() == 0 {
		t.Fatalf("asset response = %d, body length = %d; want 200 with content", asset.Code, asset.Body.Len())
	}
	etag := asset.Header().Get("ETag")
	if etag == "" {
		t.Fatal("asset response did not include an ETag")
	}
	if got := asset.Header().Get("Cache-Control"); got != "public, max-age=0, must-revalidate" {
		t.Fatalf("asset Cache-Control = %q, want public, max-age=0, must-revalidate", got)
	}

	conditional := httptest.NewRequest(http.MethodGet, "/js/protocol.js", nil)
	conditional.Header.Set("If-None-Match", etag)
	notModified := httptest.NewRecorder()
	handler.ServeHTTP(notModified, conditional)
	if notModified.Code != http.StatusNotModified || notModified.Body.Len() != 0 {
		t.Fatalf("conditional asset response = %d with body length %d; want 304 with empty body", notModified.Code, notModified.Body.Len())
	}

	html := httptest.NewRecorder()
	handler.ServeHTTP(html, httptest.NewRequest(http.MethodGet, "/", nil))
	if html.Code != http.StatusOK {
		t.Fatalf("HTML response status = %d, want 200", html.Code)
	}
	if got := html.Header().Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("HTML Cache-Control = %q, want no-cache", got)
	}
	if html.Header().Get("ETag") == "" {
		t.Fatal("HTML response did not include an ETag")
	}
}

func TestStaticAssetWithNonMatchingETagReturnsContent(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	request := httptest.NewRequest(http.MethodGet, "/css/style.css", nil)
	request.Header.Set("If-None-Match", `"different-content"`)
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK || response.Body.Len() == 0 {
		t.Fatalf("non-matching ETag response = %d, body length = %d; want 200 with content", response.Code, response.Body.Len())
	}
}

func TestICEConfigPublicMetadataRedactsTURNSecrets(t *testing.T) {
	cfg := testConfig(t)
	cfg.STUNServers = []string{"stun:stun.example.com:3478"}
	cfg.TURNURLs = []string{
		"turn:turn.example.com:3478?transport=udp",
		"turns:turn.example.com:443?transport=tcp",
	}
	cfg.TURNSharedSecret = "shared-secret"
	cfg.TURNUsername = "legacy-user"
	cfg.TURNPassword = "legacy-password"
	cfg.TURNCredentialTTL = time.Hour
	cfg.ICETransportPolicy = "relay"
	cfg.SimulcastEnabled = true
	handler := New(cfg, NewLogger("error"))

	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ice-config", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("ICE config status = %d, body = %s", response.Code, response.Body.String())
	}
	var values struct {
		ICETransportPolicy string `json:"ice_transport_policy"`
		SimulcastEnabled   bool   `json:"simulcast_enabled"`
		ConnectionMethods  []struct {
			ID           string `json:"id"`
			Enabled      bool   `json:"enabled"`
			Available    bool   `json:"available"`
			AdminEnabled bool   `json:"admin_enabled"`
			Reason       string `json:"reason"`
		} `json:"connection_methods"`
		ICEServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"ice_servers"`
	}
	if err := json.NewDecoder(response.Body).Decode(&values); err != nil {
		t.Fatalf("decode ICE config: %v", err)
	}
	if len(values.ICEServers) != 2 {
		t.Fatalf("ICE server count = %d, want 2: %#v", len(values.ICEServers), values)
	}
	if values.ICETransportPolicy != "relay" || !values.SimulcastEnabled {
		t.Fatalf("ICE/simulcast settings were not returned: policy=%q simulcast=%t", values.ICETransportPolicy, values.SimulcastEnabled)
	}
	methods := make(map[string]struct {
		Enabled      bool
		Available    bool
		AdminEnabled bool
		Reason       string
	})
	for _, method := range values.ConnectionMethods {
		methods[method.ID] = struct {
			Enabled      bool
			Available    bool
			AdminEnabled bool
			Reason       string
		}{method.Enabled, method.Available, method.AdminEnabled, method.Reason}
	}
	if !methods["auto"].Enabled || methods["direct"].Enabled || methods["direct"].Available ||
		!methods["turn-udp"].Enabled || !methods["turn-udp"].Available ||
		!methods["turn-tls"].Enabled || !methods["turn-tls"].Available ||
		methods["turn-tcp"].Enabled || methods["turn-tcp"].Available {
		t.Fatalf("unexpected connection method availability: %#v", methods)
	}
	if values.ICEServers[0].URLs[0] != "stun:stun.example.com:3478" {
		t.Fatalf("unexpected STUN server: %#v", values.ICEServers[0])
	}
	turn := values.ICEServers[1]
	if len(turn.URLs) != 2 || turn.Username != "" || turn.Credential != "" {
		t.Fatalf("unexpected TURN server: %#v", turn)
	}
	for _, secret := range []string{"shared-secret", "legacy-user", "legacy-password"} {
		if strings.Contains(response.Body.String(), secret) {
			t.Fatalf("public ICE config exposed TURN secret %q", secret)
		}
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("ICE config Cache-Control = %q, want no-store", got)
	}
}

func TestPublicMeetingAdmittedSessionCanRequestTURNCredentials(t *testing.T) {
	cfg := testConfig(t)
	cfg.TURNURLs = []string{"turn:turn.example.com:3478?transport=udp"}
	cfg.TURNSharedSecret = "shared-secret"
	cfg.TURNCredentialTTL = time.Hour
	app := New(cfg, NewLogger("error"))
	server := httptest.NewServer(app)
	defer server.Close()
	defer app.Close()

	socketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	conn, _, err := websocket.DefaultDialer.Dial(socketURL, nil)
	if err != nil {
		t.Fatalf("dial public meeting: %v", err)
	}
	defer conn.Close()
	if err := conn.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion,
		Type:    signaling.TypeJoin,
		Name:    "Public member",
	}); err != nil {
		t.Fatalf("join public meeting: %v", err)
	}
	_ = conn.SetReadDeadline(time.Now().Add(3 * time.Second))
	var joined signaling.Message
	if err := conn.ReadJSON(&joined); err != nil {
		t.Fatalf("read public meeting admission: %v", err)
	}
	if joined.Type != signaling.TypeParticipant || joined.ReconnectToken == "" {
		t.Fatalf("public meeting admission response = %+v", joined)
	}

	request, err := http.NewRequest(http.MethodGet, server.URL+"/ice-config/credentials", nil)
	if err != nil {
		t.Fatalf("create public meeting credential request: %v", err)
	}
	request.Header.Set("Authorization", "Bearer "+joined.ReconnectToken)
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatalf("request public meeting TURN credentials: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("public meeting credential status = %d", response.StatusCode)
	}
	var values struct {
		ICEServers []struct {
			Username   string `json:"username"`
			Credential string `json:"credential"`
		} `json:"ice_servers"`
	}
	if err := json.NewDecoder(response.Body).Decode(&values); err != nil {
		t.Fatalf("decode public meeting TURN credentials: %v", err)
	}
	if len(values.ICEServers) != 1 || values.ICEServers[0].Username == "" || values.ICEServers[0].Credential == "" {
		t.Fatalf("public meeting did not receive TURN credentials: %#v", values.ICEServers)
	}
	if got := response.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("public meeting credentials Cache-Control = %q, want no-store", got)
	}
}

func TestICECredentialsRequireActiveAdmittedSession(t *testing.T) {
	cfg := testConfig(t)
	cfg.TURNURLs = []string{"turn:turn.example.com:3478?transport=udp"}
	cfg.TURNSharedSecret = "shared-secret"
	cfg.TURNUsername = "legacy-user"
	cfg.TURNPassword = "legacy-password"
	cfg.TURNCredentialTTL = time.Hour
	cfg.MeetingPassword = "room-secret"
	cfg.MaxParticipants = 1
	app := New(cfg, NewLogger("error"))
	server := httptest.NewServer(app)
	defer server.Close()
	defer app.Close()

	getCredentials := func(token string) *http.Response {
		t.Helper()
		request, err := http.NewRequest(http.MethodGet, server.URL+"/ice-config/credentials", nil)
		if err != nil {
			t.Fatalf("create credential request: %v", err)
		}
		if token != "" {
			request.Header.Set("Authorization", "Bearer "+token)
		}
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("get ICE credentials: %v", err)
		}
		return response
	}
	for _, token := range []string{"", "not-a-session-token"} {
		response := getCredentials(token)
		response.Body.Close()
		if response.StatusCode != http.StatusUnauthorized {
			t.Fatalf("credentials with token %q status = %d, want 401", token, response.StatusCode)
		}
		if got := response.Header.Get("Cache-Control"); got != "no-store" {
			t.Fatalf("unauthorized credentials Cache-Control = %q, want no-store", got)
		}
	}

	socketURL := "ws" + strings.TrimPrefix(server.URL, "http") + "/ws"
	wrongPassword, _, err := websocket.DefaultDialer.Dial(socketURL, nil)
	if err != nil {
		t.Fatalf("dial wrong-password participant: %v", err)
	}
	if err := wrongPassword.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion, Type: signaling.TypeJoin, Name: "Denied", Password: "wrong",
	}); err != nil {
		wrongPassword.Close()
		t.Fatalf("join with wrong password: %v", err)
	}
	var denied signaling.Message
	if err := wrongPassword.ReadJSON(&denied); err != nil {
		wrongPassword.Close()
		t.Fatalf("read wrong-password response: %v", err)
	}
	wrongPassword.Close()
	if denied.Type != signaling.TypeError || denied.ReconnectToken != "" {
		t.Fatalf("wrong-password join response = %+v", denied)
	}

	admitted, _, err := websocket.DefaultDialer.Dial(socketURL, nil)
	if err != nil {
		t.Fatalf("dial admitted participant: %v", err)
	}
	defer admitted.Close()
	if err := admitted.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion, Type: signaling.TypeJoin, Name: "Admitted", Password: "room-secret",
	}); err != nil {
		t.Fatalf("join protected meeting: %v", err)
	}
	_ = admitted.SetReadDeadline(time.Now().Add(3 * time.Second))
	var joined signaling.Message
	if err := admitted.ReadJSON(&joined); err != nil {
		t.Fatalf("read admitted participant response: %v", err)
	}
	if joined.Type != signaling.TypeParticipant || joined.ReconnectToken == "" {
		t.Fatalf("admitted join response = %+v", joined)
	}

	credentialResponse := getCredentials(joined.ReconnectToken)
	defer credentialResponse.Body.Close()
	if credentialResponse.StatusCode != http.StatusOK {
		t.Fatalf("admitted credentials status = %d, body = %s", credentialResponse.StatusCode, "")
	}
	var credentialValues struct {
		ICEServers []struct {
			URLs       []string `json:"urls"`
			Username   string   `json:"username"`
			Credential string   `json:"credential"`
		} `json:"ice_servers"`
	}
	if err := json.NewDecoder(credentialResponse.Body).Decode(&credentialValues); err != nil {
		t.Fatalf("decode admitted ICE credentials: %v", err)
	}
	if len(credentialValues.ICEServers) != 1 || credentialValues.ICEServers[0].Username == "" ||
		credentialValues.ICEServers[0].Credential == "" ||
		!strings.Contains(credentialValues.ICEServers[0].Username, ":browser") ||
		credentialValues.ICEServers[0].Username == "legacy-user" ||
		credentialValues.ICEServers[0].Credential == "legacy-password" {
		t.Fatalf("unexpected admitted TURN credentials: %#v", credentialValues.ICEServers)
	}
	if got := credentialResponse.Header.Get("Cache-Control"); got != "no-store" {
		t.Fatalf("credential response Cache-Control = %q, want no-store", got)
	}

	full, _, err := websocket.DefaultDialer.Dial(socketURL, nil)
	if err != nil {
		t.Fatalf("dial capacity-rejected participant: %v", err)
	}
	if err := full.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion, Type: signaling.TypeJoin, Name: "Full", Password: "room-secret",
	}); err != nil {
		full.Close()
		t.Fatalf("join full meeting: %v", err)
	}
	_ = full.SetReadDeadline(time.Now().Add(3 * time.Second))
	var capacityDenied signaling.Message
	if err := full.ReadJSON(&capacityDenied); err != nil {
		full.Close()
		t.Fatalf("read capacity response: %v", err)
	}
	full.Close()
	if capacityDenied.Type != signaling.TypeError || capacityDenied.ReconnectToken != "" {
		t.Fatalf("capacity-rejected join response = %+v", capacityDenied)
	}

	if err := admitted.Close(); err != nil {
		t.Fatalf("close admitted session: %v", err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		response := getCredentials(joined.ReconnectToken)
		status := response.StatusCode
		response.Body.Close()
		if status == http.StatusUnauthorized {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("disconnected session token still issued credentials: status %d", status)
		}
		time.Sleep(10 * time.Millisecond)
	}

	fresh, _, err := websocket.DefaultDialer.Dial(socketURL, nil)
	if err != nil {
		t.Fatalf("dial fresh participant after disconnect: %v", err)
	}
	defer fresh.Close()
	if err := fresh.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion, Type: signaling.TypeJoin, Name: "Fresh", Password: "room-secret",
	}); err != nil {
		t.Fatalf("join after disconnected session: %v", err)
	}
	_ = fresh.SetReadDeadline(time.Now().Add(3 * time.Second))
	var freshJoined signaling.Message
	if err := fresh.ReadJSON(&freshJoined); err != nil {
		t.Fatalf("read fresh participant response: %v", err)
	}
	if freshJoined.Type != signaling.TypeParticipant || freshJoined.ReconnectToken == "" ||
		freshJoined.ReconnectToken == joined.ReconnectToken {
		t.Fatalf("fresh join response = %+v", freshJoined)
	}
	freshCredentials := getCredentials(freshJoined.ReconnectToken)
	defer freshCredentials.Body.Close()
	if freshCredentials.StatusCode != http.StatusOK {
		t.Fatalf("fresh session credentials status = %d", freshCredentials.StatusCode)
	}
}

func TestICEConfigMarksAdminDisabledMethods(t *testing.T) {
	cfg := testConfig(t)
	cfg.TURNURLs = []string{"turn:turn.example.com:3478?transport=udp"}
	cfg.TURNSharedSecret = "shared-secret"
	cfg.TURNCredentialTTL = time.Hour
	cfg.EnabledConnectionMethods = []string{"direct"}
	handler := New(cfg, NewLogger("error"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ice-config", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("ICE config status = %d", response.Code)
	}
	var values struct {
		Methods []struct {
			ID           string `json:"id"`
			Enabled      bool   `json:"enabled"`
			Available    bool   `json:"available"`
			AdminEnabled bool   `json:"admin_enabled"`
			Reason       string `json:"reason"`
		} `json:"connection_methods"`
	}
	if err := json.NewDecoder(response.Body).Decode(&values); err != nil {
		t.Fatalf("decode ICE config: %v", err)
	}
	methods := make(map[string]struct {
		Enabled      bool
		Available    bool
		AdminEnabled bool
		Reason       string
	})
	for _, method := range values.Methods {
		methods[method.ID] = struct {
			Enabled      bool
			Available    bool
			AdminEnabled bool
			Reason       string
		}{method.Enabled, method.Available, method.AdminEnabled, method.Reason}
	}
	if !methods["direct"].Enabled || !methods["turn-udp"].Available || methods["turn-udp"].AdminEnabled ||
		methods["turn-udp"].Enabled || methods["turn-udp"].Reason != "Disabled by the administrator" {
		t.Fatalf("unexpected admin-disabled method details: %#v", methods)
	}
}

func TestICEConfigDisablesUnconfiguredTURNMethods(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/ice-config", nil))
	if response.Code != http.StatusOK {
		t.Fatalf("ICE config status = %d", response.Code)
	}
	var values struct {
		Methods []struct {
			ID        string `json:"id"`
			Enabled   bool   `json:"enabled"`
			Available bool   `json:"available"`
			Reason    string `json:"reason"`
		} `json:"connection_methods"`
	}
	if err := json.NewDecoder(response.Body).Decode(&values); err != nil {
		t.Fatalf("decode ICE config: %v", err)
	}
	methods := make(map[string]struct {
		Enabled   bool
		Available bool
		Reason    string
	})
	for _, method := range values.Methods {
		methods[method.ID] = struct {
			Enabled   bool
			Available bool
			Reason    string
		}{method.Enabled, method.Available, method.Reason}
	}
	for _, id := range []string{"turn-udp", "turn-tcp", "turn-tls"} {
		if methods[id].Enabled || methods[id].Available || methods[id].Reason != "Not configured on this server" {
			t.Errorf("unconfigured method %q details = %#v", id, methods[id])
		}
	}
}

func TestAdminConfigRequiresPasswordAndUpdatesRuntimeValues(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/admin/config", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d, want 401", unauthorized.Code)
	}

	request := httptest.NewRequest(http.MethodPost, "/admin/config",
		strings.NewReader(`{"max_participants":3,"default_video_quality":"medium","max_video_quality":"medium","max_video_bitrate":250000}`))
	request.Header.Set("X-Admin-Password", "admin-secret")
	updated := httptest.NewRecorder()
	handler.ServeHTTP(updated, request)
	if updated.Code != http.StatusOK {
		t.Fatalf("updated status = %d, body = %s", updated.Code, updated.Body.String())
	}

	public := httptest.NewRecorder()
	handler.ServeHTTP(public, httptest.NewRequest(http.MethodGet, "/config", nil))
	var values map[string]any
	if err := json.NewDecoder(public.Body).Decode(&values); err != nil {
		t.Fatalf("decode updated config: %v", err)
	}
	if values["max_participants"] != float64(3) || values["default_video_quality"] != "medium" ||
		values["max_video_quality"] != "medium" || values["max_video_bitrate"] != float64(250000) {
		t.Fatalf("runtime config was not updated: %#v", values)
	}
}

func TestPasswordSurfacesRateLimitFailedAttempts(t *testing.T) {
	cfg := testConfig(t)
	cfg.MeetingPassword = "room-secret"
	handler := New(cfg, NewLogger("error"))

	previewSuccess := httptest.NewRecorder()
	handler.ServeHTTP(previewSuccess, httptest.NewRequest(http.MethodPost, "/room/participants", strings.NewReader(`{"password":"room-secret"}`)))
	if previewSuccess.Code != http.StatusOK {
		t.Fatalf("correct preview password status = %d, want 200", previewSuccess.Code)
	}

	// Roster preview: failures beyond the burst are throttled per client IP.
	for attempt := 0; attempt < passwordFailureBurst; attempt++ {
		request := httptest.NewRequest(http.MethodPost, "/room/participants", strings.NewReader(`{"password":"wrong"}`))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusForbidden {
			t.Fatalf("wrong-password attempt %d status = %d, want 403", attempt+1, response.Code)
		}
	}
	throttled := httptest.NewRecorder()
	handler.ServeHTTP(throttled, httptest.NewRequest(http.MethodPost, "/room/participants", strings.NewReader(`{"password":"wrong"}`)))
	if throttled.Code != http.StatusTooManyRequests {
		t.Fatalf("throttled preview status = %d, want 429", throttled.Code)
	}
	correctPreviewAfterThrottle := httptest.NewRecorder()
	handler.ServeHTTP(correctPreviewAfterThrottle, httptest.NewRequest(http.MethodPost, "/room/participants", strings.NewReader(`{"password":"room-secret"}`)))
	if correctPreviewAfterThrottle.Code != http.StatusTooManyRequests {
		t.Fatalf("correct preview password after exhaustion = %d, want 429", correctPreviewAfterThrottle.Code)
	}

	// The admin endpoint has its own budget: wrong passwords are throttled
	// before verification, even when a new request carries the correct password.
	adminSuccessRequest := httptest.NewRequest(http.MethodGet, "/admin/config", nil)
	adminSuccessRequest.Header.Set("X-Admin-Password", "admin-secret")
	adminSuccessResponse := httptest.NewRecorder()
	handler.ServeHTTP(adminSuccessResponse, adminSuccessRequest)
	if adminSuccessResponse.Code != http.StatusOK {
		t.Fatalf("correct admin password status = %d, want 200", adminSuccessResponse.Code)
	}
	for attempt := 0; attempt < passwordFailureBurst; attempt++ {
		request := httptest.NewRequest(http.MethodGet, "/admin/config", nil)
		request.Header.Set("X-Admin-Password", "wrong")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("admin attempt %d status = %d, want 401", attempt+1, response.Code)
		}
	}
	adminThrottled := httptest.NewRecorder()
	throttledRequest := httptest.NewRequest(http.MethodGet, "/admin/config", nil)
	throttledRequest.Header.Set("X-Admin-Password", "wrong")
	handler.ServeHTTP(adminThrottled, throttledRequest)
	if adminThrottled.Code != http.StatusTooManyRequests {
		t.Fatalf("throttled admin status = %d, want 429", adminThrottled.Code)
	}

	adminRequest := httptest.NewRequest(http.MethodGet, "/admin/config", nil)
	adminRequest.Header.Set("X-Admin-Password", "admin-secret")
	adminResponse := httptest.NewRecorder()
	handler.ServeHTTP(adminResponse, adminRequest)
	if adminResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("correct admin password after throttled wrong attempts = %d, want 429", adminResponse.Code)
	}
}

func TestPasswordLimitUsesOnlyTrustedForwardedClientAddresses(t *testing.T) {
	cfg := testConfig(t)
	cfg.MeetingPassword = "room-secret"
	cfg.TrustedProxyCIDRs = []string{"10.0.0.0/8"}
	handler := New(cfg, NewLogger("error"))
	request := func(remoteAddr, forwarded string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/room/participants", strings.NewReader(`{"password":"wrong"}`))
		req.RemoteAddr = remoteAddr
		req.Header.Set("X-Forwarded-For", forwarded)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, req)
		return response
	}

	for _, clientIP := range []string{"198.51.100.1", "198.51.100.2"} {
		for attempt := 0; attempt < passwordFailureBurst; attempt++ {
			if response := request("10.0.0.2:443", clientIP); response.Code != http.StatusForbidden {
				t.Fatalf("trusted client %s attempt %d status = %d, want 403", clientIP, attempt+1, response.Code)
			}
		}
		if response := request("10.0.0.2:443", clientIP); response.Code != http.StatusTooManyRequests {
			t.Fatalf("trusted client %s attempt beyond burst status = %d, want 429", clientIP, response.Code)
		}
	}

	// An untrusted socket peer cannot rotate X-Forwarded-For to evade its key.
	for attempt := 0; attempt < passwordFailureBurst; attempt++ {
		if response := request("203.0.113.9:443", "198.51.100."+fmt.Sprint(attempt+1)); response.Code != http.StatusForbidden {
			t.Fatalf("untrusted peer attempt %d status = %d, want 403", attempt+1, response.Code)
		}
	}
	if response := request("203.0.113.9:443", "198.51.100.99"); response.Code != http.StatusTooManyRequests {
		t.Fatalf("untrusted peer spoofed header bypass status = %d, want 429", response.Code)
	}
}

func TestAdminConfigGetReturnsPublicRuntimeValues(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	request := httptest.NewRequest(http.MethodGet, "/admin/config", nil)
	request.Header.Set("X-Admin-Password", "admin-secret")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	var values map[string]any
	if err := json.NewDecoder(response.Body).Decode(&values); err != nil {
		t.Fatalf("decode config: %v", err)
	}
	if values["max_participants"] != float64(5) {
		t.Fatalf("unexpected public config: %#v", values)
	}
	if values["default_video_fps"] != float64(15) || values["default_audio_bitrate"] != float64(32000) {
		t.Fatalf("default media settings missing from admin config: %#v", values)
	}
	if _, exposed := values["admin_password"]; exposed {
		t.Fatal("admin password was exposed")
	}
	if got := response.Header().Get("Cache-Control"); got != "no-store" {
		t.Fatalf("admin config Cache-Control = %q, want no-store", got)
	}
}

func TestAdminCapacityUpdateAffectsWebSocketAdmission(t *testing.T) {
	cfg := testConfig(t)
	cfg.MaxParticipants = 1
	app := New(cfg, NewLogger("error"))
	server := httptest.NewServer(app)
	defer server.Close()
	defer app.Close()

	socketURL := "ws" + strings.TrimPrefix(server.URL, "http")
	first, _, err := websocket.DefaultDialer.Dial(socketURL+"/ws", nil)
	if err != nil {
		t.Fatalf("dial first participant: %v", err)
	}
	defer first.Close()
	if err := first.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion, Type: signaling.TypeJoin, Name: "Ashkan",
	}); err != nil {
		t.Fatalf("join first participant: %v", err)
	}
	var firstJoined signaling.Message
	if err := first.ReadJSON(&firstJoined); err != nil {
		t.Fatalf("read first join response: %v", err)
	}
	if firstJoined.Type != signaling.TypeParticipant {
		t.Fatalf("first join response = %+v", firstJoined)
	}

	updateCapacity := func(t *testing.T, max int) {
		t.Helper()
		body := strings.NewReader(fmt.Sprintf(`{"max_participants":%d}`, max))
		request, err := http.NewRequest(http.MethodPost, server.URL+"/admin/config", body)
		if err != nil {
			t.Fatalf("create capacity update: %v", err)
		}
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Admin-Password", "admin-secret")
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatalf("update capacity: %v", err)
		}
		defer response.Body.Close()
		if response.StatusCode != http.StatusOK {
			t.Fatalf("capacity update status = %d", response.StatusCode)
		}
	}

	updateCapacity(t, 2)
	second, _, err := websocket.DefaultDialer.Dial(socketURL+"/ws", nil)
	if err != nil {
		t.Fatalf("dial second participant: %v", err)
	}
	defer second.Close()
	if err := second.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion, Type: signaling.TypeJoin, Name: "Ali",
	}); err != nil {
		t.Fatalf("join second participant: %v", err)
	}
	var secondJoined signaling.Message
	if err := second.ReadJSON(&secondJoined); err != nil {
		t.Fatalf("read second join response: %v", err)
	}
	if secondJoined.Type != signaling.TypeParticipant {
		t.Fatalf("second join response = %+v", secondJoined)
	}

	updateCapacity(t, 1)
	third, _, err := websocket.DefaultDialer.Dial(socketURL+"/ws", nil)
	if err != nil {
		t.Fatalf("dial third participant: %v", err)
	}
	defer third.Close()
	if err := third.WriteJSON(signaling.Message{
		Version: signaling.ProtocolVersion, Type: signaling.TypeJoin, Name: "Sara",
	}); err != nil {
		t.Fatalf("join third participant: %v", err)
	}
	var thirdResponse signaling.Message
	if err := third.ReadJSON(&thirdResponse); err != nil {
		t.Fatalf("read third join response: %v", err)
	}
	if thirdResponse.Type != signaling.TypeError || thirdResponse.Error != "meeting is full" {
		t.Fatalf("third join response = %+v", thirdResponse)
	}
}

func TestAdminConfigRejectsUnknownAndTrailingJSON(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	cases := []string{
		`{"max_participants":3,"unexpected":true}`,
		`{"max_participants":3}{"max_participants":2}`,
	}
	for _, body := range cases {
		request := httptest.NewRequest(http.MethodPost, "/admin/config", strings.NewReader(body))
		request.Header.Set("X-Admin-Password", "admin-secret")
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, request)
		if response.Code != http.StatusBadRequest {
			t.Errorf("body %q status = %d, want 400", body, response.Code)
		}
	}
}

func TestReadOnlyEndpointsRejectNonGETRequests(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	for _, path := range []string{"/health", "/ready", "/config", "/ice-config", "/ice-config/credentials", "/metrics"} {
		request := httptest.NewRequest(http.MethodPost, path, nil)
		response := httptest.NewRecorder()

		handler.ServeHTTP(response, request)
		if response.Code != http.StatusMethodNotAllowed {
			t.Errorf("%s status = %d, want 405", path, response.Code)
		}
		if got := response.Header().Get("Allow"); got != http.MethodGet {
			t.Errorf("%s Allow = %q, want GET", path, got)
		}
	}
}

func TestAdminConfigAdvertisesSupportedMethods(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	request := httptest.NewRequest(http.MethodPut, "/admin/config", nil)
	request.Header.Set("X-Admin-Password", "admin-secret")
	response := httptest.NewRecorder()

	handler.ServeHTTP(response, request)
	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("status = %d, want 405", response.Code)
	}
	if got := response.Header().Get("Allow"); got != "GET, POST" {
		t.Fatalf("Allow = %q, want GET, POST", got)
	}
}

func TestSecurityHeadersArePresent(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	for _, path := range []string{"/", "/health", "/admin"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))

		if response.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s missing nosniff header", path)
		}
		if response.Header().Get("X-Frame-Options") != "DENY" {
			t.Errorf("%s missing frame protection header", path)
		}
		if response.Header().Get("Content-Security-Policy") == "" {
			t.Errorf("%s missing CSP header", path)
		}
		if strings.Contains(response.Header().Get("Content-Security-Policy"), "'unsafe-inline'") {
			t.Errorf("%s CSP allows unsafe inline content", path)
		}
		if response.Header().Get("Permissions-Policy") == "" {
			t.Errorf("%s missing permissions policy", path)
		}
	}
}

func TestFrontendAssetsAreEmbeddedAndServed(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	for _, path := range []string{"/", "/admin.html", "/js/admin-utils.js"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", path, response.Code)
		}
		if response.Body.Len() == 0 {
			t.Fatalf("%s returned an empty body", path)
		}
		if path != "/js/admin-utils.js" && !strings.Contains(response.Body.String(), "SlowMeet") {
			t.Errorf("%s does not contain the default app name", path)
		}
	}
}

func TestFrontendUsesConfiguredAppNameAndEscapesHTML(t *testing.T) {
	cfg := testConfig(t)
	cfg.AppName = `Example "Meet" & <Meet>`
	handler := New(cfg, NewLogger("error"))

	for path, want := range map[string]string{
		"/":           `<title>Example &#34;Meet&#34; &amp; &lt;Meet&gt;</title>`,
		"/index.html": `<title>Example &#34;Meet&#34; &amp; &lt;Meet&gt;</title>`,
		"/admin.html": `<title>Example &#34;Meet&#34; &amp; &lt;Meet&gt; admin</title>`,
	} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", path, response.Code)
		}
		body := response.Body.String()
		if !strings.Contains(body, want) {
			t.Errorf("%s body does not contain escaped title %q", path, want)
		}
		if !strings.Contains(body, `aria-label="Example &#34;Meet&#34; &amp; &lt;Meet&gt; home"`) {
			t.Errorf("%s body does not contain an escaped brand label", path)
		}
		if strings.Contains(body, "{{APP_NAME}}") || strings.Contains(body, "<Meet>") {
			t.Errorf("%s contains an unresolved or unescaped app name", path)
		}
	}
}

func TestBrandedHTMLSupportsETagsAndHead(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	get := httptest.NewRecorder()
	handler.ServeHTTP(get, httptest.NewRequest(http.MethodGet, "/", nil))
	if get.Code != http.StatusOK {
		t.Fatalf("GET / status = %d, want 200", get.Code)
	}
	etag := get.Header().Get("ETag")
	if etag == "" {
		t.Fatal("GET / did not return an ETag")
	}
	if get.Header().Get("Cache-Control") != "no-cache" {
		t.Fatalf("Cache-Control = %q, want no-cache", get.Header().Get("Cache-Control"))
	}

	conditional := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("If-None-Match", etag)
	handler.ServeHTTP(conditional, request)
	if conditional.Code != http.StatusNotModified {
		t.Fatalf("conditional GET status = %d, want 304", conditional.Code)
	}

	head := httptest.NewRecorder()
	handler.ServeHTTP(head, httptest.NewRequest(http.MethodHead, "/", nil))
	if head.Code != http.StatusOK || head.Body.Len() != 0 {
		t.Fatalf("HEAD / status/body = %d/%d, want 200/0", head.Code, head.Body.Len())
	}
}

func TestCloseMarksServerNotReady(t *testing.T) {
	server := New(testConfig(t), NewLogger("error"))
	defer server.Close()

	before := httptest.NewRecorder()
	server.ServeHTTP(before, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if before.Code != http.StatusOK {
		t.Fatalf("ready before close = %d, want 200", before.Code)
	}

	server.Close()
	after := httptest.NewRecorder()
	server.ServeHTTP(after, httptest.NewRequest(http.MethodGet, "/ready", nil))
	if after.Code != http.StatusServiceUnavailable {
		t.Fatalf("ready after close = %d, want 503", after.Code)
	}
}

func TestHealthAllowsHeadRequests(t *testing.T) {
	server := httptest.NewServer(New(testConfig(t), NewLogger("error")))
	defer server.Close()

	response, err := http.Head(server.URL + "/health")
	if err != nil {
		t.Fatalf("HEAD /health: %v", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("HEAD /health status = %d, want 200", response.StatusCode)
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatalf("read HEAD body: %v", err)
	}
	if len(body) != 0 {
		t.Fatalf("HEAD /health body = %q, want empty", body)
	}
}

func TestGzipCompressesStaticAssetsAndSkipsUpgrades(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))

	compressed := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/js/app.js", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	handler.ServeHTTP(compressed, request)
	if compressed.Code != http.StatusOK {
		t.Fatalf("asset status = %d, want 200", compressed.Code)
	}
	if got := compressed.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if compressed.Header().Get("Content-Length") != "" {
		t.Fatal("a compressed response must not carry the pre-compression length")
	}
	if compressed.Body.Len() >= len(appJSUncompressedSizeProbe) {
		t.Fatalf("compressed body = %d bytes, want smaller than the plain asset", compressed.Body.Len())
	}
	if vary := compressed.Header().Get("Vary"); !strings.Contains(vary, "Accept-Encoding") {
		t.Fatalf("Vary = %q, want Accept-Encoding", vary)
	}

	plain := httptest.NewRecorder()
	handler.ServeHTTP(plain, httptest.NewRequest(http.MethodGet, "/js/app.js", nil))
	if got := plain.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("plain client Content-Encoding = %q, want none", got)
	}

	upgrade := httptest.NewRecorder()
	upgradeRequest := httptest.NewRequest(http.MethodGet, "/health", nil)
	upgradeRequest.Header.Set("Accept-Encoding", "gzip")
	upgradeRequest.Header.Set("Upgrade", "websocket")
	upgradeRequest.Header.Set("Connection", "Upgrade")
	handler.ServeHTTP(upgrade, upgradeRequest)
	if got := upgrade.Header().Get("Content-Encoding"); got == "gzip" {
		t.Fatal("an upgrade request must not be gzipped")
	}
}

// appJSUncompressedSizeProbe mirrors the rough size of the plain app.js asset
// so the gzip test can prove compression without re-reading the embed.
var appJSUncompressedSizeProbe = make([]byte, 200_000)

func TestPrecompressedAssetServingAndRepresentationEtags(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))

	compressed := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/js/app.js", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	handler.ServeHTTP(compressed, request)
	if compressed.Code != http.StatusOK {
		t.Fatalf("compressed asset status = %d, want 200", compressed.Code)
	}
	etag := compressed.Header().Get("ETag")
	if !strings.HasSuffix(etag, `-gz"`) {
		t.Fatalf("compressed representation ETag = %q, want the -gz variant", etag)
	}
	if compressed.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("compressed asset was not served precompressed")
	}

	revalidate := httptest.NewRecorder()
	revalidateRequest := httptest.NewRequest(http.MethodGet, "/js/app.js", nil)
	revalidateRequest.Header.Set("Accept-Encoding", "gzip")
	revalidateRequest.Header.Set("If-None-Match", etag)
	handler.ServeHTTP(revalidate, revalidateRequest)
	if revalidate.Code != http.StatusNotModified {
		t.Fatalf("compressed revalidation status = %d, want 304", revalidate.Code)
	}

	identity := httptest.NewRecorder()
	handler.ServeHTTP(identity, httptest.NewRequest(http.MethodGet, "/js/app.js", nil))
	if identity.Header().Get("Content-Encoding") != "" {
		t.Fatal("identity client received an encoded body")
	}
	if identity.Header().Get("ETag") == etag {
		t.Fatal("identity and gzip representations must carry distinct ETags")
	}
}

// The precompressed root page must keep the HTML content type: ServeContent
// derives the type from the asset name, and the root path carries no
// extension — an empty name sniffs the gzip body as "application/x-gzip",
// which nosniff turns into a browser download instead of a rendered page.
func TestPrecompressedRootPageKeepsHTMLContentType(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))

	for _, path := range []string{"/", "/index.html"} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest(http.MethodGet, path, nil)
		request.Header.Set("Accept-Encoding", "gzip")
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s status = %d, want 200", path, recorder.Code)
		}
		if got := recorder.Header().Get("Content-Type"); got != "text/html; charset=utf-8" {
			t.Fatalf("%s Content-Type = %q, want text/html; charset=utf-8", path, got)
		}
		if recorder.Header().Get("Content-Encoding") != "gzip" {
			t.Fatalf("%s was not served precompressed", path)
		}
	}

	head := httptest.NewRecorder()
	headRequest := httptest.NewRequest(http.MethodHead, "/", nil)
	headRequest.Header.Set("Accept-Encoding", "gzip")
	handler.ServeHTTP(head, headRequest)
	if head.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d, want 200", head.Code)
	}
	if head.Header().Get("Content-Type") != "text/html; charset=utf-8" {
		t.Fatalf("HEAD Content-Type = %q, want text/html; charset=utf-8", head.Header().Get("Content-Type"))
	}
}

func TestAcceptsGzipParsesQualityValues(t *testing.T) {
	request := func(acceptEncoding string) *http.Request {
		r := httptest.NewRequest(http.MethodGet, "/js/app.js", nil)
		if acceptEncoding != "" {
			r.Header.Set("Accept-Encoding", acceptEncoding)
		}
		return r
	}
	tests := []struct {
		acceptEncoding string
		want           bool
	}{
		{"gzip", true},
		{"gzip, deflate, br", true},
		{"deflate, GZIP", true},
		{"gzip;q=0.5", true},
		{"gzip ; q=0.8", true},
		{"gzip;q=0", false},
		{"gzip;q=0.000", false},
		{"gzip;q=garbage", true}, // malformed q defaults to accept
		{"deflate", false},
		{"", false},
	}
	for _, test := range tests {
		if got := acceptsGzip(request(test.acceptEncoding)); got != test.want {
			t.Errorf("acceptsGzip(%q) = %v, want %v", test.acceptEncoding, got, test.want)
		}
	}
}

func TestBrandedHTMLRejectsNonGETMethods(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, httptest.NewRequest(method, "/", nil))
		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s / status = %d, want 405", method, response.Code)
		}
		if allow := response.Header().Get("Allow"); !strings.Contains(allow, http.MethodGet) {
			t.Fatalf("%s / Allow = %q, want it to include GET", method, allow)
		}
	}
}
