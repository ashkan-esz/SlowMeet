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
