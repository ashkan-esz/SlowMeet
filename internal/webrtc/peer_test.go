package webrtc

import (
	"testing"

	pion "github.com/pion/webrtc/v4"
)

func TestNewPeerCreatesConnection(t *testing.T) {
	peer, err := NewPeer([]string{"stun:stun.example.com:3478"})
	if err != nil {
		t.Fatalf("NewPeer() error = %v", err)
	}
	defer peer.Close()
	if peer.Connection() == nil {
		t.Fatal("Connection() returned nil")
	}
}

func TestNewPeerWithTURNCreatesConnection(t *testing.T) {
	peer, err := NewPeerWithTURN(
		[]string{"stun:stun.example.com:3478"},
		"turn:turn.example.com:3478",
		"turn-user",
		"turn-password",
	)
	if err != nil {
		t.Fatalf("NewPeerWithTURN() error = %v", err)
	}
	defer peer.Close()
	if peer.Connection() == nil {
		t.Fatal("Connection() returned nil")
	}
}

func TestNewPeerWithTURNAndPortRangeCreatesConnection(t *testing.T) {
	peer, err := NewPeerWithTURNAndPortRange(nil, "", "", "", 50000, 50010)
	if err != nil {
		t.Fatalf("NewPeerWithTURNAndPortRange() error = %v", err)
	}
	defer peer.Close()
}

func TestNewPeerWithTURNURLsAndIPv4OnlyCreatesConnection(t *testing.T) {
	peer, err := NewPeerWithTURNURLsAndPortRange(
		nil,
		[]string{"turn:turn.example.com:3478?transport=udp", "turns:turn.example.com:443?transport=tcp"},
		"turn-user",
		"turn-password",
		50000,
		50010,
		true,
	)
	if err != nil {
		t.Fatalf("NewPeerWithTURNURLsAndPortRange() error = %v", err)
	}
	defer peer.Close()
}

func TestNewPeerWithPortRangeRejectsInvalidRange(t *testing.T) {
	if _, err := NewPeerWithPortRange(pion.Configuration{}, 50010, 50000); err == nil {
		t.Fatal("expected invalid ICE UDP port range to fail")
	}
}

func TestPeerCloseIsIdempotent(t *testing.T) {
	peer, err := NewPeer(nil)
	if err != nil {
		t.Fatalf("NewPeer() error = %v", err)
	}
	if err := peer.Close(); err != nil {
		t.Fatalf("first Close() error = %v", err)
	}
	if err := peer.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}
}
