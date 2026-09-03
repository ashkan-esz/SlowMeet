package httpserver

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"SlowMeet/internal/config"
	"SlowMeet/internal/signaling"
	"github.com/gorilla/websocket"
)

func testConfig(t *testing.T) config.Config {
	t.Helper()
	return config.Config{
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
	if values["max_video_quality"] != "high" {
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
	if metrics.Code != http.StatusOK || !strings.Contains(metrics.Body.String(), "lowmeet_peer_connections 0") ||
		!strings.Contains(metrics.Body.String(), "lowmeet_average_rtt_ms 0.0") ||
		!strings.Contains(metrics.Body.String(), "lowmeet_network_sample_available 0") {
		t.Fatalf("unexpected metrics response: %s", metrics.Body.String())
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
	for _, path := range []string{"/health", "/ready", "/config", "/metrics"} {
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
