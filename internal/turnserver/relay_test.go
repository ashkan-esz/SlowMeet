package turnserver

import (
	"errors"
	"net"
	"testing"
	"time"

	"github.com/pion/turn/v5"

	"SlowMeet/internal/config"
)

var loopback = net.IPv4(127, 0, 0, 1)

func TestSelectRelayAddresses(t *testing.T) {
	publicIP := net.ParseIP("203.0.113.7")
	tests := []struct {
		name           string
		cfg            config.Config
		wantRelay      net.IP // nil: any usable IPv4 address
		wantPublic     net.IP
		wantTranslates bool
	}{
		{
			name:      "public address on a local interface",
			cfg:       config.Config{ICEPublicIP: "127.0.0.1"},
			wantRelay: loopback, wantPublic: loopback, wantTranslates: false,
		},
		{
			name:       "public address that is not local",
			cfg:        config.Config{ICEPublicIP: "203.0.113.7"},
			wantPublic: publicIP, wantTranslates: true,
		},
		{
			name:      "explicit relay address",
			cfg:       config.Config{ICEPublicIP: "203.0.113.7", TURNServerRelayIP: "127.0.0.1"},
			wantRelay: loopback, wantPublic: publicIP, wantTranslates: true,
		},
		{
			// The SFU listens on the public address this host owns, so the
			// relay must reach it there, whatever address its own sockets use.
			name:      "explicit relay address on a host that owns its public address",
			cfg:       config.Config{ICEPublicIP: "127.0.0.1", TURNServerRelayIP: "127.0.0.2"},
			wantRelay: net.IPv4(127, 0, 0, 2), wantPublic: loopback, wantTranslates: false,
		},
		{
			name:           "no public address",
			cfg:            config.Config{},
			wantTranslates: false,
		},
		{
			name:           "IPv6 public address",
			cfg:            config.Config{ICEPublicIP: "2001:db8::1"},
			wantTranslates: false,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			addresses, err := selectRelayAddresses(test.cfg)
			if err != nil {
				t.Fatalf("selectRelayAddresses() error = %v", err)
			}
			if addresses.relayIP == nil || addresses.relayIP.To4() == nil {
				t.Fatalf("relay IP = %v, want an IPv4 address", addresses.relayIP)
			}
			if test.wantRelay != nil && !addresses.relayIP.Equal(test.wantRelay) {
				t.Fatalf("relay IP = %v, want %v", addresses.relayIP, test.wantRelay)
			}
			if !addresses.publicIP.Equal(test.wantPublic) {
				t.Fatalf("public IP = %v, want %v", addresses.publicIP, test.wantPublic)
			}
			if got := addresses.translates(); got != test.wantTranslates {
				t.Fatalf("translates() = %v, want %v", got, test.wantTranslates)
			}
			if !addresses.permits(addresses.relayIP) {
				t.Fatal("the relay address itself must be a permitted peer")
			}
		})
	}
}

func TestSelectRelayAddressesRejectsAnInvalidOverride(t *testing.T) {
	for _, relayIP := range []string{"not-an-ip", "2001:db8::1"} {
		if _, err := selectRelayAddresses(config.Config{TURNServerRelayIP: relayIP}); err == nil {
			t.Fatalf("TURN_SERVER_RELAY_IP=%q was accepted", relayIP)
		}
	}
}

func TestRelayAddressesPermitOnlyTheServersOwnAddresses(t *testing.T) {
	addresses := relayAddresses{relayIP: net.IPv4(10, 0, 0, 5).To4(), publicIP: net.ParseIP("203.0.113.7").To4()}
	for _, allowed := range []string{"10.0.0.5", "203.0.113.7", "::ffff:10.0.0.5"} {
		if !addresses.permits(net.ParseIP(allowed)) {
			t.Fatalf("%s is this server and must be permitted", allowed)
		}
	}
	for _, denied := range []string{"10.0.0.6", "203.0.113.8", "127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "2001:db8::1"} {
		if addresses.permits(net.ParseIP(denied)) {
			t.Fatalf("%s is not this server and must be denied", denied)
		}
	}
	withoutPublic := relayAddresses{relayIP: net.IPv4(10, 0, 0, 5).To4()}
	if withoutPublic.permits(nil) || withoutPublic.permits(net.ParseIP("203.0.113.7")) {
		t.Fatal("without a public address only the relay address is permitted")
	}
}

func newGenerator(t *testing.T, ports int, publicIP net.IP) *relayAddressGenerator {
	t.Helper()
	portMin, portMax := freeRelayRange(t, ports)
	generator := &relayAddressGenerator{
		addresses: relayAddresses{
			relayIP:  loopback.To4(),
			publicIP: publicIP,
			// As selectRelayAddresses decides it: a public address this host
			// does not own is translated.
			translate: publicIP != nil && !publicIP.IsLoopback(),
		},
		portMin: portMin,
		portMax: portMax,
	}
	if err := generator.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
	return generator
}

func TestRelayAddressGeneratorUsesEveryPortBeforeFailing(t *testing.T) {
	generator := newGenerator(t, 3, nil)
	seen := map[int]bool{}
	for range 3 {
		conn, address, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4"})
		if err != nil {
			t.Fatalf("AllocatePacketConn() error = %v with ports still free", err)
		}
		defer conn.Close()
		udp := address.(*net.UDPAddr)
		if !udp.IP.Equal(loopback) || udp.Port < generator.portMin || udp.Port > generator.portMax || seen[udp.Port] {
			t.Fatalf("relay address %v is outside the range or reused (%v)", udp, seen)
		}
		if conn.LocalAddr().(*net.UDPAddr).Port != udp.Port {
			t.Fatalf("advertised port %d differs from the bound socket %v", udp.Port, conn.LocalAddr())
		}
		seen[udp.Port] = true
	}
	_, _, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4"})
	if !errors.Is(err, errRelayPortsExhausted) {
		t.Fatalf("error = %v, want errRelayPortsExhausted once the range is full", err)
	}
}

func TestRelayAddressGeneratorRefusesWhatTheSFUCannotUse(t *testing.T) {
	generator := newGenerator(t, 2, nil)

	if _, _, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp6"}); !errors.Is(err, errIPv4RelayOnly) {
		t.Fatalf("IPv6 relay: error = %v, want errIPv4RelayOnly", err)
	}
	for _, port := range []int{generator.portMin - 1, generator.portMax + 1, 53} {
		_, _, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4", RequestedPort: port})
		if !errors.Is(err, errRelayPortOutOfRange) {
			t.Fatalf("requested port %d: error = %v, want errRelayPortOutOfRange", port, err)
		}
	}
	conn, address, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{
		Network: "udp4", RequestedPort: generator.portMax,
	})
	if err != nil {
		t.Fatalf("a requested port inside the range must be honored: %v", err)
	}
	if address.(*net.UDPAddr).Port != generator.portMax {
		t.Fatalf("relay address = %v, want port %d", address, generator.portMax)
	}
	_ = conn.Close()

	if _, _, err := generator.AllocateListener(turn.AllocateListenerConfig{Network: "tcp4"}); !errors.Is(err, errTCPRelayDisabled) {
		t.Fatalf("TCP relay listener: error = %v, want errTCPRelayDisabled", err)
	}
	if _, err := generator.AllocateConn(turn.AllocateConnConfig{Network: "tcp4"}); !errors.Is(err, errTCPRelayDisabled) {
		t.Fatalf("TCP relay connection: error = %v, want errTCPRelayDisabled", err)
	}
}

func TestRelayAddressGeneratorValidate(t *testing.T) {
	valid := relayAddresses{relayIP: loopback.To4()}
	tests := []struct {
		name      string
		generator relayAddressGenerator
		wantErr   error
	}{
		{name: "valid", generator: relayAddressGenerator{addresses: valid, portMin: 49152, portMax: 49999}},
		{name: "single port", generator: relayAddressGenerator{addresses: valid, portMin: 49152, portMax: 49152}},
		{name: "no relay address", generator: relayAddressGenerator{portMin: 49152, portMax: 49999}, wantErr: errIPv4RelayOnly},
		{name: "IPv6 relay address", generator: relayAddressGenerator{
			addresses: relayAddresses{relayIP: net.ParseIP("2001:db8::1")}, portMin: 49152, portMax: 49999,
		}, wantErr: errIPv4RelayOnly},
		{name: "reversed range", generator: relayAddressGenerator{addresses: valid, portMin: 50000, portMax: 49999}, wantErr: errRelayRangeInvalid},
		{name: "zero minimum", generator: relayAddressGenerator{addresses: valid, portMin: 0, portMax: 10}, wantErr: errRelayRangeInvalid},
		{name: "maximum too high", generator: relayAddressGenerator{addresses: valid, portMin: 1, portMax: 65536}, wantErr: errRelayRangeInvalid},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := test.generator.Validate(); !errors.Is(err, test.wantErr) {
				t.Fatalf("Validate() error = %v, want %v", err, test.wantErr)
			}
		})
	}
}

func TestRelaySocketIsPlainWhenThereIsNothingToRewriteOrCheck(t *testing.T) {
	// A host that owns its public address, with the SFU on any port: no layer
	// on the media path.
	generator := newGenerator(t, 1, loopback.To4())
	conn, _, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4"})
	if err != nil {
		t.Fatalf("AllocatePacketConn() error = %v", err)
	}
	defer conn.Close()
	if _, ok := conn.(*net.UDPConn); !ok {
		t.Fatalf("relay socket is %T, want an unwrapped *net.UDPConn", conn)
	}
}

func TestRelaySocketForwardsOnlyToSFUAndRelayPorts(t *testing.T) {
	// The permitted peer is this server's own address, where other UDP
	// services may listen too. With the SFU's port range known, nothing else
	// on that address is reachable through the relay.
	generator := newGenerator(t, 2, loopback.To4())
	cfg := config.Config{TURNServerRelayPortMin: generator.portMin, TURNServerRelayPortMax: generator.portMax}
	sfu := sfuSocket(t, cfg)
	sfuPort := sfu.LocalAddr().(*net.UDPAddr).Port
	other := sfuSocket(t, cfg) // some other UDP service on this host
	for other.LocalAddr().(*net.UDPAddr).Port == sfuPort {
		other = sfuSocket(t, cfg)
	}
	generator.sfuPortMin, generator.sfuPortMax = sfuPort, sfuPort

	relay, relayAddress, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4"})
	if err != nil {
		t.Fatalf("AllocatePacketConn() error = %v", err)
	}
	defer relay.Close()
	if _, ok := relay.(*relayPacketConn); !ok {
		t.Fatalf("relay socket is %T, want one that checks peer ports", relay)
	}
	otherRelay, otherAddress, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4"})
	if err != nil {
		t.Fatalf("allocate a second relay socket: %v", err)
	}
	defer otherRelay.Close()

	if _, err := relay.WriteTo([]byte("to sfu"), sfu.LocalAddr()); err != nil {
		t.Fatalf("the SFU's media port must be reachable: %v", err)
	}
	if payload, source := readDatagram(t, sfu); payload != "to sfu" || source.String() != relayAddress.String() {
		t.Fatalf("SFU received %q from %v", payload, source)
	}
	if _, err := relay.WriteTo([]byte("to relay"), otherAddress); err != nil {
		t.Fatalf("another relay socket must be reachable: %v", err)
	}
	if payload, _ := readDatagram(t, otherRelay); payload != "to relay" {
		t.Fatalf("other relay received %q", payload)
	}

	n, err := relay.WriteTo([]byte("to another service"), other.LocalAddr())
	if !errors.Is(err, errPeerPortNotAllowed) || n != 0 {
		t.Fatalf("WriteTo a port that is neither SFU nor relay = %d, %v; want errPeerPortNotAllowed", n, err)
	}
	if err := other.SetReadDeadline(time.Now().Add(200 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if n, _, err := other.ReadFrom(make([]byte, 64)); err == nil {
		t.Fatalf("the other service received %d bytes through the relay", n)
	}
	// Without translation, what the SFU sends reaches the TURN layer with its
	// address unchanged.
	if _, err := sfu.WriteTo([]byte("from sfu"), relayAddress); err != nil {
		t.Fatal(err)
	}
	if payload, source := readDatagram(t, relay); payload != "from sfu" || source.String() != sfu.LocalAddr().String() {
		t.Fatalf("relay read %q from %v, want the SFU untranslated", payload, source)
	}
}

func TestRelayPacketConnRewritesOnlyTheSFUAddress(t *testing.T) {
	publicIP := net.ParseIP("203.0.113.7").To4()
	generator := newGenerator(t, 2, publicIP)

	relay, relayAddress, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4"})
	if err != nil {
		t.Fatalf("AllocatePacketConn() error = %v", err)
	}
	defer relay.Close()
	if _, ok := relay.(*relayPacketConn); !ok {
		t.Fatalf("relay socket is %T, want a translating one", relay)
	}
	if !relayAddress.(*net.UDPAddr).IP.Equal(loopback) {
		t.Fatalf("relay address = %v, want the local relay IP", relayAddress)
	}

	// A second relay socket is another participant's allocation (or the SFU's
	// own under a relay-only policy): its port is inside the relay range.
	otherRelay, otherAddress, err := generator.AllocatePacketConn(turn.AllocateListenerConfig{Network: "udp4"})
	if err != nil {
		t.Fatalf("allocate a second relay socket: %v", err)
	}
	defer otherRelay.Close()

	cfg := config.Config{TURNServerRelayPortMin: generator.portMin, TURNServerRelayPortMax: generator.portMax}
	sfu := sfuSocket(t, cfg)
	sfuPort := sfu.LocalAddr().(*net.UDPAddr).Port
	publicSFU := &net.UDPAddr{IP: publicIP, Port: sfuPort}

	// To the SFU: addressed publicly, delivered locally.
	if _, err := relay.WriteTo([]byte("to sfu"), publicSFU); err != nil {
		t.Fatalf("write to the public SFU address: %v", err)
	}
	payload, source := readDatagram(t, sfu)
	if payload != "to sfu" || source.String() != relayAddress.String() {
		t.Fatalf("SFU received %q from %v, want it from %v", payload, source, relayAddress)
	}
	if publicSFU.IP.String() != "203.0.113.7" {
		t.Fatal("the caller's destination address must not be modified")
	}

	// From the SFU: sent locally, reported with the public address.
	if _, err := sfu.WriteTo([]byte("from sfu"), relayAddress); err != nil {
		t.Fatalf("write from the SFU: %v", err)
	}
	payload, source = readDatagram(t, relay)
	if payload != "from sfu" || source.String() != publicSFU.String() {
		t.Fatalf("relay read %q from %v, want it reported as %v", payload, source, publicSFU)
	}

	// Relay to relay: the address stays local in both directions.
	if _, err := relay.WriteTo([]byte("to relay"), otherAddress); err != nil {
		t.Fatalf("write to another relay socket: %v", err)
	}
	payload, source = readDatagram(t, otherRelay)
	if payload != "to relay" || source.String() != relayAddress.String() {
		t.Fatalf("other relay read %q from %v, want it from %v", payload, source, relayAddress)
	}
	if _, err := otherRelay.WriteTo([]byte("from relay"), relayAddress); err != nil {
		t.Fatalf("write from another relay socket: %v", err)
	}
	payload, source = readDatagram(t, relay)
	if payload != "from relay" || source.String() != otherAddress.String() {
		t.Fatalf("relay read %q from %v, want it from %v", payload, source, otherAddress)
	}
	if !publicIP.Equal(net.ParseIP("203.0.113.7")) {
		t.Fatal("translation must not modify the configured public address")
	}
}
