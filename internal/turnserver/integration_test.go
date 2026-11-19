package turnserver

import (
	"fmt"
	"net"
	"testing"
	"time"

	ice "github.com/pion/ice/v4"
	pion "github.com/pion/webrtc/v4"

	sfu "SlowMeet/internal/webrtc"
)

// TestBrowserReachesTheSFUThroughTheRelay runs the whole relayed path with
// real ICE on both sides: a relay-only peer (the browser) allocates on the
// built-in relay with app-issued credentials and exchanges data with a peer
// built by the SFU's own constructor, whose only advertised address is
// ICE_PUBLIC_IP.
//
// The last case is a container on a bridge network or a VM behind 1:1 NAT:
// the public address belongs to no interface, the SFU's sockets are on the
// local address, and the relay has to translate between the two.
func TestBrowserReachesTheSFUThroughTheRelay(t *testing.T) {
	//
	// With the relay policy (ICE_TRANSPORT_POLICY=relay) the SFU has no host
	// candidate: it allocates on the same relay, and media goes from one relay
	// socket to another.
	tests := []struct {
		name      string
		transport string
		publicIP  string
		policy    string
	}{
		{name: "udp", transport: "udp", publicIP: "127.0.0.1", policy: "all"},
		{name: "tcp", transport: "tcp", publicIP: "127.0.0.1", policy: "all"},
		{name: "udp with a public address that is not local", transport: "udp", publicIP: "203.0.113.7", policy: "all"},
		{name: "tcp with a public address that is not local", transport: "tcp", publicIP: "203.0.113.7", policy: "all"},
		{name: "relay-only SFU", transport: "udp", publicIP: "127.0.0.1", policy: "relay"},
		{name: "relay-only SFU with a public address that is not local", transport: "udp", publicIP: "203.0.113.7", policy: "relay"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			publicIP := net.ParseIP(test.publicIP)
			translated := !publicIP.IsLoopback()
			if translated && routedLocalIPv4(publicIP).IsLoopback() {
				t.Skip("this host has only loopback addresses, so the SFU has no local address to translate to")
			}
			cfg := testConfig(t, 8)
			cfg.ICEPublicIP = test.publicIP
			// The SFU's media ports stay outside the relay range, as the
			// configuration requires in production.
			cfg.ICEUDPPortMin, cfg.ICEUDPPortMax = freeRelayRange(t, 8)
			for cfg.ICEUDPPortMin <= cfg.TURNServerRelayPortMax && cfg.TURNServerRelayPortMin <= cfg.ICEUDPPortMax {
				cfg.ICEUDPPortMin, cfg.ICEUDPPortMax = freeRelayRange(t, 8)
			}
			server := startRelay(t, cfg)
			if server.addresses.translates() != translated {
				t.Fatalf("translates() = %v for public address %s and relay address %v",
					server.addresses.translates(), test.publicIP, server.addresses.relayIP)
			}
			username, password := browserCredentials(t, cfg)
			relayPort := server.udp[0].LocalAddr().(*net.UDPAddr).Port
			if test.transport == "tcp" {
				relayPort = server.tcp.Addr().(*net.TCPAddr).Port
			}
			relayURL := fmt.Sprintf("turn:127.0.0.1:%d?transport=%s", relayPort, test.transport)

			// As internal/signaling builds it: the SFU's peer is given the
			// TURN server only when it has no reachable address of its own.
			var sfuTURNURLs []string
			sfuUsername, sfuPassword := "", ""
			if test.policy == "relay" {
				sfuTURNURLs = []string{relayURL}
				sfuUsername, sfuPassword, _ = cfg.TURNCredentials("sfu", time.Now())
			}
			sfuPeer, err := sfu.NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(
				nil, sfuTURNURLs, sfuUsername, sfuPassword,
				cfg.ICEUDPPortMin, cfg.ICEUDPPortMax, true, test.policy, cfg.ICEPublicIP)
			if err != nil {
				t.Fatalf("create SFU peer: %v", err)
			}
			defer sfuPeer.Close()
			received := make(chan string, 1)
			sfuPeer.Connection().OnDataChannel(func(channel *pion.DataChannel) {
				channel.OnMessage(func(message pion.DataChannelMessage) {
					select {
					case received <- string(message.Data):
					default:
					}
					_ = channel.SendText("from the sfu")
				})
			})

			var settings pion.SettingEngine
			settings.SetIncludeLoopbackCandidate(true)
			settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
			browser, err := pion.NewAPI(pion.WithSettingEngine(settings)).NewPeerConnection(pion.Configuration{
				ICETransportPolicy: pion.ICETransportPolicyRelay,
				ICEServers: []pion.ICEServer{{
					URLs:       []string{relayURL},
					Username:   username,
					Credential: password,
				}},
			})
			if err != nil {
				t.Fatalf("create browser peer: %v", err)
			}
			defer browser.Close()
			channel, err := browser.CreateDataChannel("relay", nil)
			if err != nil {
				t.Fatalf("create data channel: %v", err)
			}
			replied := make(chan string, 1)
			channel.OnOpen(func() { _ = channel.SendText("through the relay") })
			channel.OnMessage(func(message pion.DataChannelMessage) {
				select {
				case replied <- string(message.Data):
				default:
				}
			})

			offer, err := browser.CreateOffer(nil)
			if err != nil {
				t.Fatalf("create offer: %v", err)
			}
			browserGathered := pion.GatheringCompletePromise(browser)
			if err := browser.SetLocalDescription(offer); err != nil {
				t.Fatalf("set browser local description: %v", err)
			}
			waitFor(t, "the browser gathers its relay candidate", browserGathered)
			if err := sfuPeer.SetRemoteOffer(browser.LocalDescription().SDP); err != nil {
				t.Fatalf("SFU set remote offer: %v", err)
			}
			sfuGathered := pion.GatheringCompletePromise(sfuPeer.Connection())
			if _, err := sfuPeer.CreateAnswer(); err != nil {
				t.Fatalf("SFU create answer: %v", err)
			}
			waitFor(t, "the SFU gathers its candidate", sfuGathered)
			if err := browser.SetRemoteDescription(*sfuPeer.Connection().LocalDescription()); err != nil {
				t.Fatalf("set browser remote description: %v", err)
			}

			// Data in both directions proves both translations.
			for direction, messages := range map[string]chan string{"browser to SFU": received, "SFU to browser": replied} {
				select {
				case <-messages:
				case <-time.After(20 * time.Second):
					t.Fatalf("no data %s through the relay (browser ICE state %s, allocations %d)",
						direction, browser.ICEConnectionState(), server.AllocationCount())
				}
			}

			pair, err := browser.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
			if err != nil || pair == nil {
				t.Fatalf("selected candidate pair: %v, %v", pair, err)
			}
			if pair.Local.Typ != pion.ICECandidateTypeRelay {
				t.Fatalf("browser's selected local candidate is %s, want relay", pair.Local.Typ)
			}
			if pair.Local.Port < uint16(cfg.TURNServerRelayPortMin) || pair.Local.Port > uint16(cfg.TURNServerRelayPortMax) {
				t.Fatalf("relay candidate port %d is outside the relay range %d-%d", pair.Local.Port,
					cfg.TURNServerRelayPortMin, cfg.TURNServerRelayPortMax)
			}
			if got := net.ParseIP(pair.Local.Address); !got.Equal(server.addresses.relayIP) {
				t.Fatalf("relay candidate address %s, want the relay address %v", pair.Local.Address, server.addresses.relayIP)
			}
			if test.policy == "relay" {
				// Relay socket to relay socket: both are advertised by the
				// relay address and neither is translated.
				if got := net.ParseIP(pair.Remote.Address); pair.Remote.Typ != pion.ICECandidateTypeRelay ||
					!got.Equal(server.addresses.relayIP) {
					t.Fatalf("the browser reached the SFU at %s %s, want its relay candidate on %v",
						pair.Remote.Typ, pair.Remote.Address, server.addresses.relayIP)
				}
				if server.AllocationCount() < 2 {
					t.Fatalf("AllocationCount() = %d, want the browser's and the SFU's", server.AllocationCount())
				}
				return
			}
			// The browser knows the SFU only by its public address.
			if got := net.ParseIP(pair.Remote.Address); !got.Equal(publicIP) {
				t.Fatalf("the browser reached the SFU at %s, want the public address %s", pair.Remote.Address, test.publicIP)
			}
			if server.AllocationCount() < 1 {
				t.Fatal("the connected browser holds no allocation on the relay")
			}
		})
	}
}

func waitFor(t *testing.T, what string, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatalf("timed out waiting until %s", what)
	}
}
