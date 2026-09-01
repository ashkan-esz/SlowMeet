package signaling

import (
	"net/http"
	"testing"
)

func TestSameOrigin(t *testing.T) {
	cases := []struct {
		name    string
		origin  string
		allowed bool
	}{
		{"same host", "https://meet.example.com", true},
		{"same host with port", "http://localhost:8080", true},
		{"missing origin", "", true},
		{"different host", "https://evil.example.com", false},
		{"malformed origin", "://bad", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r, err := http.NewRequest(http.MethodGet, "http://localhost:8080/ws", nil)
			if err != nil {
				t.Fatal(err)
			}
			r.Host = "localhost:8080"
			if tc.name == "same host" || tc.name == "different host" || tc.name == "malformed origin" {
				r.Host = "meet.example.com"
			}
			r.Header.Set("Origin", tc.origin)
			if got := sameOrigin(r); got != tc.allowed {
				t.Fatalf("sameOrigin() = %v, want %v", got, tc.allowed)
			}
		})
	}
}
