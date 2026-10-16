package webrtc

import (
	"strings"
	"testing"
	"time"

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

func TestNewPeerWithPublicIPCreatesConnection(t *testing.T) {
	peer, err := NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(
		nil, nil, "", "", 50000, 50010, true, "all", "203.0.113.42",
	)
	if err != nil {
		t.Fatalf("NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP() error = %v", err)
	}
	defer peer.Close()
	if peer.Connection() == nil {
		t.Fatal("Connection() returned nil")
	}
}

func TestNewPeerWithLoopbackPublicIPGathersLoopbackCandidate(t *testing.T) {
	peer, err := NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(
		nil, nil, "", "", 50000, 50100, true, "all", "127.0.0.1",
	)
	if err != nil {
		t.Fatalf("create loopback peer: %v", err)
	}
	defer peer.Close()

	if _, err := peer.Connection().AddTransceiverFromKind(pion.RTPCodecTypeAudio); err != nil {
		t.Fatalf("add audio transceiver: %v", err)
	}
	gatheringComplete := pion.GatheringCompletePromise(peer.Connection())
	offer, err := peer.Connection().CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if err := peer.Connection().SetLocalDescription(offer); err != nil {
		t.Fatalf("set local offer: %v", err)
	}
	select {
	case <-gatheringComplete:
	case <-time.After(5 * time.Second):
		t.Fatal("ICE candidate gathering did not complete")
	}
	sdp := peer.Connection().LocalDescription().SDP
	if !strings.Contains(sdp, "127.0.0.1") {
		t.Fatalf("loopback candidate missing from local SDP:\n%s", sdp)
	}
	if strings.Contains(sdp, "192.168.") {
		t.Fatalf("non-loopback address leaked into loopback-only SDP:\n%s", sdp)
	}
}

func TestNewPeerWithInvalidPublicIPFails(t *testing.T) {
	if _, err := NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(
		nil, nil, "", "", 50000, 50010, true, "all", "not-an-ip",
	); err == nil {
		t.Fatal("expected invalid public IP to fail")
	}
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
