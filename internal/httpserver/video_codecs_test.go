package httpserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"
)

// videoCodecSettings reads the codec list and default from a config endpoint.
func videoCodecSettings(t *testing.T, handler http.Handler, path string) ([]string, string) {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("X-Admin-Password", "admin-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("GET %s status = %d, body = %s", path, response.Code, response.Body.String())
	}
	var values struct {
		VideoCodecs       []string `json:"video_codecs"`
		DefaultVideoCodec string   `json:"default_video_codec"`
	}
	if err := json.NewDecoder(response.Body).Decode(&values); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	return values.VideoCodecs, values.DefaultVideoCodec
}

func postAdminConfig(handler http.Handler, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/admin/config", strings.NewReader(body))
	request.Header.Set("X-Admin-Password", "admin-secret")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func TestConfigEndpointsReportVideoCodecs(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	for _, path := range []string{"/config", "/admin/config"} {
		codecs, defaultCodec := videoCodecSettings(t, handler, path)
		if !slices.Equal(codecs, []string{"av1", "vp9", "vp8", "h264"}) || defaultCodec != "av1" {
			t.Fatalf("%s codecs = %v default = %q, want all four with av1", path, codecs, defaultCodec)
		}
	}
}

func TestAdminUpdatesVideoCodecs(t *testing.T) {
	handler := New(testConfig(t), NewLogger("error"))
	response := postAdminConfig(handler, `{"video_codecs":["vp8","vp9"],"default_video_codec":"vp9"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("update status = %d, body = %s", response.Code, response.Body.String())
	}
	// The admin response and the public endpoint both carry the new values,
	// in the server's order rather than the order they were sent in.
	var confirmed struct {
		VideoCodecs       []string `json:"video_codecs"`
		DefaultVideoCodec string   `json:"default_video_codec"`
	}
	if err := json.NewDecoder(response.Body).Decode(&confirmed); err != nil {
		t.Fatalf("decode update response: %v", err)
	}
	if !slices.Equal(confirmed.VideoCodecs, []string{"vp9", "vp8"}) || confirmed.DefaultVideoCodec != "vp9" {
		t.Fatalf("update response codecs = %v default = %q", confirmed.VideoCodecs, confirmed.DefaultVideoCodec)
	}
	codecs, defaultCodec := videoCodecSettings(t, handler, "/config")
	if !slices.Equal(codecs, []string{"vp9", "vp8"}) || defaultCodec != "vp9" {
		t.Fatalf("public codecs = %v default = %q after the update", codecs, defaultCodec)
	}
}

func TestAdminRejectsInvalidVideoCodecs(t *testing.T) {
	tests := []struct {
		name string
		body string
	}{
		{name: "default outside the list", body: `{"video_codecs":["vp8"],"default_video_codec":"av1"}`},
		{name: "list without vp8", body: `{"video_codecs":["av1","vp9"]}`},
		{name: "unknown codec", body: `{"video_codecs":["vp8","h265"]}`},
		{name: "unknown default", body: `{"default_video_codec":"h265"}`},
		{name: "duplicate codec", body: `{"video_codecs":["vp8","vp8"]}`},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			handler := New(testConfig(t), NewLogger("error"))
			response := postAdminConfig(handler, test.body)
			if response.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body = %s", response.Code, response.Body.String())
			}
			codecs, defaultCodec := videoCodecSettings(t, handler, "/config")
			if !slices.Equal(codecs, []string{"av1", "vp9", "vp8", "h264"}) || defaultCodec != "av1" {
				t.Fatalf("a rejected update changed the settings: %v default %q", codecs, defaultCodec)
			}
		})
	}
}
