package webrtc

import (
	"sort"
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

// The custom interceptor registry must negotiate SDP content-identical to
// pion's default construction: the removed stats interceptor contributes no
// MediaEngine state, so codec, header-extension, and feedback negotiation
// must not shift. Volatile per-connection fields (the o= line, ICE
// credentials, the DTLS fingerprint, and the random SSRC/CNAME and
// stream/track identifiers pion generates per connection) are stripped, and
// the remaining lines are compared as multisets: pion emits the a=extmap
// lines of an m-section in map-iteration order (mediaengine.go
// negotiatedHeaderExtensions), which is not even stable between two default
// constructions — the ID-to-URI mapping is the negotiated contract, not the
// line order.
func TestCustomRegistrySDPMatchesDefaultInterceptors(t *testing.T) {
	normalize := func(sdp string) []string {
		var kept []string
		for _, line := range strings.Split(sdp, "\n") {
			line = strings.TrimRight(line, "\r")
			if strings.HasPrefix(line, "o=") ||
				strings.HasPrefix(line, "a=ice-ufrag") ||
				strings.HasPrefix(line, "a=ice-pwd") ||
				strings.HasPrefix(line, "a=fingerprint") ||
				strings.HasPrefix(line, "a=ssrc") ||
				strings.HasPrefix(line, "a=msid") {
				continue
			}
			kept = append(kept, line)
		}
		return kept
	}

	defaultPC, err := pion.NewAPI(pion.WithSettingEngine(pion.SettingEngine{})).
		NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create default peer connection: %v", err)
	}
	defer defaultPC.Close()
	customPeer, err := newPeerWithPortRange(pion.Configuration{}, 0, 0, false, "")
	if err != nil {
		t.Fatalf("create custom-registry peer: %v", err)
	}
	defer customPeer.Close()

	for _, connection := range []*pion.PeerConnection{defaultPC, customPeer.Connection()} {
		for _, kind := range []pion.RTPCodecType{pion.RTPCodecTypeAudio, pion.RTPCodecTypeVideo} {
			if _, err := connection.AddTransceiverFromKind(kind,
				pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionSendrecv}); err != nil {
				t.Fatalf("add %s transceiver: %v", kind, err)
			}
		}
	}

	defaultOffer, err := defaultPC.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create default offer: %v", err)
	}
	customOffer, err := customPeer.Connection().CreateOffer(nil)
	if err != nil {
		t.Fatalf("create custom-registry offer: %v", err)
	}

	defaultLines := normalize(defaultOffer.SDP)
	customLines := normalize(customOffer.SDP)
	sort.Strings(defaultLines)
	sort.Strings(customLines)
	if len(defaultLines) != len(customLines) {
		t.Fatalf("custom-registry SDP has %d lines, default has %d\ncustom:\n%s\ndefault:\n%s",
			len(customLines), len(defaultLines), customOffer.SDP, defaultOffer.SDP)
	}
	for index := range defaultLines {
		if defaultLines[index] != customLines[index] {
			t.Fatalf("custom-registry SDP differs at sorted line %d\ncustom full SDP:\n%s\ndefault full SDP:\n%s",
				index, customOffer.SDP, defaultOffer.SDP)
		}
	}
}
