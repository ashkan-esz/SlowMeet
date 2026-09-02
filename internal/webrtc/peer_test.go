package webrtc

import "testing"

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
