package httpserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"SlowMeet/internal/config"
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
	if _, exposed := values["admin_password"]; exposed {
		t.Fatal("public config exposed admin password")
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
		strings.NewReader(`{"max_participants":3,"max_video_bitrate":250000}`))
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
	if values["max_participants"] != float64(3) || values["max_video_bitrate"] != float64(250000) {
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
	if _, exposed := values["admin_password"]; exposed {
		t.Fatal("admin password was exposed")
	}
}
