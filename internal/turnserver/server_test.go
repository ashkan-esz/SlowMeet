package turnserver

import (
	"bytes"
	"crypto/tls"
	"io"
	"log/slog"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"

	"SlowMeet/internal/config"
)

const (
	testSecret  = "relay-test-secret"
	testRealm   = "relay.test"
	testTimeout = 5 * time.Second
)

func quietLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

// freeRelayRange returns a block of size consecutive UDP ports on loopback
// that were all free a moment ago.
func freeRelayRange(t *testing.T, size int) (int, int) {
	t.Helper()
	for range 50 {
		probe, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatalf("probe for free UDP ports: %v", err)
		}
		first := probe.LocalAddr().(*net.UDPAddr).Port
		_ = probe.Close()
		if first+size-1 > 65535 {
			continue
		}
		free := true
		for port := first; port < first+size; port++ {
			conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: port})
			if err != nil {
				free = false
				break
			}
			_ = conn.Close()
		}
		if free {
			return first, first + size - 1
		}
	}
	t.Fatalf("no block of %d free UDP ports found", size)
	return 0, 0
}

func freeTCPPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("probe for a free TCP port: %v", err)
	}
	defer listener.Close()
	return listener.Addr().(*net.TCPAddr).Port
}

// testConfig is a relay on loopback: the "SFU" it may forward to is 127.0.0.1,
// the listen ports are chosen by the OS, and relayPorts relay ports are free.
func testConfig(t *testing.T, relayPorts int) config.Config {
	t.Helper()
	portMin, portMax := freeRelayRange(t, relayPorts)
	return config.Config{
		TURNServerEnabled:      true,
		TURNSharedSecret:       testSecret,
		TURNCredentialTTL:      time.Hour,
		TURNServerRealm:        testRealm,
		TURNServerRelayPortMin: portMin,
		TURNServerRelayPortMax: portMax,
		TURNURLs:               []string{"turn:127.0.0.1:3478?transport=udp"},
		ICEPublicIP:            "127.0.0.1",
	}
}

func startRelay(t *testing.T, cfg config.Config) *Server {
	t.Helper()
	server, err := start(cfg, quietLogger(), "127.0.0.1")
	if err != nil {
		t.Fatalf("start relay: %v", err)
	}
	t.Cleanup(func() { _ = server.Close() })
	return server
}

func browserCredentials(t *testing.T, cfg config.Config) (string, string) {
	t.Helper()
	username, password, ok := cfg.TURNCredentials("browser", time.Now())
	if !ok {
		t.Fatal("the test configuration issues no TURN credentials")
	}
	return username, password
}

// newTURNClient connects a TURN client to the relay over transport (udp, tcp
// or tls) the way a browser would, without allocating yet.
func newTURNClient(t *testing.T, server *Server, transport, username, password string) *turn.Client {
	t.Helper()
	var (
		conn          net.PacketConn
		serverAddress string
	)
	switch transport {
	case "udp":
		socket, err := net.ListenPacket("udp4", "127.0.0.1:0")
		if err != nil {
			t.Fatalf("open client UDP socket: %v", err)
		}
		conn, serverAddress = socket, server.udp[0].LocalAddr().String()
	case "tcp":
		serverAddress = server.tcp.Addr().String()
		stream, err := net.DialTimeout("tcp", serverAddress, testTimeout)
		if err != nil {
			t.Fatalf("connect to the relay over TCP: %v", err)
		}
		conn = turn.NewSTUNConn(stream)
	case "tls":
		serverAddress = server.tls.Addr().String()
		dialer := &net.Dialer{Timeout: testTimeout}
		stream, err := tls.DialWithDialer(dialer, "tcp", serverAddress, &tls.Config{InsecureSkipVerify: true})
		if err != nil {
			t.Fatalf("connect to the relay over TLS: %v", err)
		}
		conn = turn.NewSTUNConn(stream)
	default:
		t.Fatalf("unknown transport %q", transport)
	}
	loggers := logging.NewDefaultLoggerFactory()
	loggers.DefaultLogLevel = logging.LogLevelDisabled
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: serverAddress,
		TURNServerAddr: serverAddress,
		Conn:           conn,
		Username:       username,
		Password:       password,
		Realm:          testRealm,
		LoggerFactory:  loggers,
	})
	if err != nil {
		t.Fatalf("create TURN client: %v", err)
	}
	t.Cleanup(func() {
		client.Close()
		_ = conn.Close()
	})
	if err := client.Listen(); err != nil {
		t.Fatalf("start TURN client: %v", err)
	}
	return client
}

// sfuSocket is a UDP socket standing in for one of the SFU's media ports. Its
// port is kept outside the relay range, as the SFU's are by configuration.
func sfuSocket(t *testing.T, cfg config.Config) *net.UDPConn {
	t.Helper()
	for range 50 {
		socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
		if err != nil {
			t.Fatalf("open SFU socket: %v", err)
		}
		port := socket.LocalAddr().(*net.UDPAddr).Port
		if port < cfg.TURNServerRelayPortMin || port > cfg.TURNServerRelayPortMax {
			t.Cleanup(func() { _ = socket.Close() })
			return socket
		}
		_ = socket.Close()
	}
	t.Fatal("could not open an SFU socket outside the relay range")
	return nil
}

func readDatagram(t *testing.T, conn net.PacketConn) (string, *net.UDPAddr) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(testTimeout)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	buffer := make([]byte, 1500)
	n, source, err := conn.ReadFrom(buffer)
	if err != nil {
		t.Fatalf("read datagram: %v", err)
	}
	udp, ok := source.(*net.UDPAddr)
	if !ok {
		t.Fatalf("datagram source is %T, want *net.UDPAddr", source)
	}
	return string(buffer[:n]), udp
}

func eventually(t *testing.T, what string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(testTimeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timed out waiting until %s", what)
}

func TestRelayForwardsBetweenABrowserAndTheSFU(t *testing.T) {
	for _, transport := range []string{"udp", "tcp", "tls"} {
		t.Run(transport, func(t *testing.T) {
			cfg := testConfig(t, 4)
			if transport == "tls" {
				cfg.TURNServerTLSPort = freeTCPPort(t)
				cfg.TURNServerTLSCertFile, cfg.TURNServerTLSKeyFile = writeCertificate(t, t.TempDir(), "relay.test")
			}
			server := startRelay(t, cfg)
			username, password := browserCredentials(t, cfg)
			client := newTURNClient(t, server, transport, username, password)

			relay, err := client.Allocate()
			if err != nil {
				t.Fatalf("allocate over %s: %v", transport, err)
			}
			defer relay.Close()
			relayAddress, ok := relay.LocalAddr().(*net.UDPAddr)
			if !ok || !relayAddress.IP.Equal(net.IPv4(127, 0, 0, 1)) {
				t.Fatalf("relayed address = %v, want one on the relay IP 127.0.0.1", relay.LocalAddr())
			}
			if relayAddress.Port < cfg.TURNServerRelayPortMin || relayAddress.Port > cfg.TURNServerRelayPortMax {
				t.Fatalf("relayed port %d is outside %d-%d", relayAddress.Port,
					cfg.TURNServerRelayPortMin, cfg.TURNServerRelayPortMax)
			}
			if got := server.AllocationCount(); got != 1 {
				t.Fatalf("AllocationCount() = %d, want 1", got)
			}

			sfu := sfuSocket(t, cfg)
			if _, err := relay.WriteTo([]byte("browser to sfu"), sfu.LocalAddr()); err != nil {
				t.Fatalf("send through the relay: %v", err)
			}
			payload, source := readDatagram(t, sfu)
			if payload != "browser to sfu" || source.Port != relayAddress.Port {
				t.Fatalf("SFU received %q from %v, want it from relay port %d", payload, source, relayAddress.Port)
			}
			if _, err := sfu.WriteTo([]byte("sfu to browser"), source); err != nil {
				t.Fatalf("reply to the relay: %v", err)
			}
			payload, peer := readDatagram(t, relay)
			if payload != "sfu to browser" || peer.String() != sfu.LocalAddr().String() {
				t.Fatalf("browser received %q from %v, want it from %v", payload, peer, sfu.LocalAddr())
			}
		})
	}
}

func TestRelayRejectsCredentialsItDidNotIssue(t *testing.T) {
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	validUser, validPassword := browserCredentials(t, cfg)
	expiredUser, expiredPassword, _ := cfg.TURNCredentials("browser", time.Now().Add(-2*time.Hour))
	otherSecret := cfg
	otherSecret.TURNSharedSecret = "a-different-secret"
	forgedUser, forgedPassword, _ := otherSecret.TURNCredentials("browser", time.Now())

	tests := []struct {
		name     string
		username string
		password string
	}{
		{name: "wrong password", username: validUser, password: strings.ToUpper(validPassword) + "x"},
		{name: "expired", username: expiredUser, password: expiredPassword},
		{name: "signed with another secret", username: forgedUser, password: forgedPassword},
		{name: "username without an expiry", username: "browser", password: validPassword},
		{name: "no credentials", username: "", password: ""},
	}
	for _, transport := range []string{"udp", "tcp"} {
		for _, test := range tests {
			t.Run(transport+"/"+test.name, func(t *testing.T) {
				client := newTURNClient(t, server, transport, test.username, test.password)
				if relay, err := client.Allocate(); err == nil {
					_ = relay.Close()
					t.Fatal("the relay allocated for credentials it must reject")
				}
			})
		}
	}
	if got := server.AllocationCount(); got != 0 {
		t.Fatalf("AllocationCount() = %d after only rejected requests, want 0", got)
	}
}

func TestRelayForwardsOnlyToTheSFU(t *testing.T) {
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	username, password := browserCredentials(t, cfg)
	client := newTURNClient(t, server, "udp", username, password)
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer relay.Close()

	if err := client.CreatePermission(&net.UDPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 50000}); err != nil {
		t.Fatalf("the SFU's own address must be permitted: %v", err)
	}
	for _, denied := range []string{"127.0.0.2", "10.0.0.1", "192.168.1.1", "169.254.169.254", "192.0.2.10", "8.8.8.8"} {
		peer := &net.UDPAddr{IP: net.ParseIP(denied), Port: 50000}
		if err := client.CreatePermission(peer); err == nil {
			t.Fatalf("the relay granted a permission for %s, which is not the SFU", denied)
		}
		if _, err := relay.WriteTo([]byte("must not be relayed"), peer); err == nil {
			t.Fatalf("the relay accepted data for %s, which is not the SFU", denied)
		}
	}
}

func TestRelayRefusesTCPAllocations(t *testing.T) {
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	username, password := browserCredentials(t, cfg)
	client := newTURNClient(t, server, "tcp", username, password)

	if allocation, err := client.AllocateTCP(); err == nil {
		_ = allocation.Close()
		t.Fatal("the relay granted a TCP relay address; only UDP relaying is offered")
	}
	if got := server.AllocationCount(); got != 0 {
		t.Fatalf("AllocationCount() = %d, want 0", got)
	}
}

func TestRelayAnswersSTUNBindingWithoutCredentials(t *testing.T) {
	// scripts/probe-stun-path.sh tests a UDP path with a bare STUN request.
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	client := newTURNClient(t, server, "udp", "", "")

	mapped, err := client.SendBindingRequest()
	if err != nil {
		t.Fatalf("STUN binding request: %v", err)
	}
	udp, ok := mapped.(*net.UDPAddr)
	if !ok || !udp.IP.Equal(net.IPv4(127, 0, 0, 1)) || udp.Port == 0 {
		t.Fatalf("mapped address = %v, want the client's loopback address", mapped)
	}
}

func TestRelayAllocatesInsideThePortRangeUntilItIsFull(t *testing.T) {
	cfg := testConfig(t, 2)
	server := startRelay(t, cfg)
	username, password := browserCredentials(t, cfg)

	ports := map[int]bool{}
	var first net.PacketConn
	for range 2 {
		relay, err := newTURNClient(t, server, "udp", username, password).Allocate()
		if err != nil {
			t.Fatalf("allocate while ports are free: %v", err)
		}
		defer relay.Close()
		if first == nil {
			first = relay
		}
		port := relay.LocalAddr().(*net.UDPAddr).Port
		if port < cfg.TURNServerRelayPortMin || port > cfg.TURNServerRelayPortMax || ports[port] {
			t.Fatalf("relay port %d is outside the range or reused (%v)", port, ports)
		}
		ports[port] = true
	}

	if relay, err := newTURNClient(t, server, "udp", username, password).Allocate(); err == nil {
		_ = relay.Close()
		t.Fatal("a third allocation succeeded with only two relay ports")
	}

	// Releasing an allocation frees its port for the next participant.
	if err := first.Close(); err != nil {
		t.Fatalf("release the first allocation: %v", err)
	}
	eventually(t, "the released relay port is allocated again", func() bool {
		relay, err := newTURNClient(t, server, "udp", username, password).Allocate()
		if err != nil {
			return false
		}
		t.Cleanup(func() { _ = relay.Close() })
		return true
	})
}

func TestRelayTranslatesAPublicAddressThatIsNotLocal(t *testing.T) {
	// A container on a bridge network, or a VM behind 1:1 NAT: browsers are
	// told the SFU is at the public address, which is not on any interface.
	cfg := testConfig(t, 4)
	cfg.ICEPublicIP = "203.0.113.7"
	cfg.TURNServerRelayIP = "127.0.0.1"
	server := startRelay(t, cfg)
	username, password := browserCredentials(t, cfg)
	client := newTURNClient(t, server, "udp", username, password)
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer relay.Close()
	relayAddress := relay.LocalAddr().(*net.UDPAddr)
	if !relayAddress.IP.Equal(net.IPv4(127, 0, 0, 1)) {
		t.Fatalf("relayed address = %v, want the local relay IP", relayAddress)
	}

	sfu := sfuSocket(t, cfg)
	sfuPort := sfu.LocalAddr().(*net.UDPAddr).Port
	publicSFU := &net.UDPAddr{IP: net.ParseIP("203.0.113.7"), Port: sfuPort}

	if _, err := relay.WriteTo([]byte("browser to sfu"), publicSFU); err != nil {
		t.Fatalf("send to the SFU's public address: %v", err)
	}
	payload, source := readDatagram(t, sfu)
	if payload != "browser to sfu" || !source.IP.Equal(net.IPv4(127, 0, 0, 1)) || source.Port != relayAddress.Port {
		t.Fatalf("SFU received %q from %v, want it locally from relay port %d", payload, source, relayAddress.Port)
	}
	if _, err := sfu.WriteTo([]byte("sfu to browser"), source); err != nil {
		t.Fatalf("reply to the relay: %v", err)
	}
	payload, peer := readDatagram(t, relay)
	if payload != "sfu to browser" || peer.String() != publicSFU.String() {
		t.Fatalf("browser received %q from %v, want it from the public address %v", payload, peer, publicSFU)
	}

	if err := client.CreatePermission(&net.UDPAddr{IP: net.ParseIP("192.0.2.10"), Port: sfuPort}); err == nil {
		t.Fatal("translation must not widen the set of permitted peers")
	}
}

func TestRelayServesTLSOnceACertificateAppears(t *testing.T) {
	// The installer starts the relay before a certificate exists when HTTPS
	// is not set up yet; the listener must come up and recover by itself.
	directory := t.TempDir()
	cfg := testConfig(t, 4)
	cfg.TURNServerTLSPort = freeTCPPort(t)
	cfg.TURNServerTLSCertFile = directory + "/fullchain.pem"
	cfg.TURNServerTLSKeyFile = directory + "/privkey.pem"
	server := startRelay(t, cfg)
	if server.tls == nil {
		t.Fatal("the TLS listener must start without a certificate on disk")
	}

	dial := func() (*tls.Conn, error) {
		return tls.DialWithDialer(&net.Dialer{Timeout: testTimeout}, "tcp", server.tls.Addr().String(),
			&tls.Config{InsecureSkipVerify: true})
	}
	if conn, err := dial(); err == nil {
		_ = conn.Close()
		t.Fatal("a TLS handshake succeeded without a certificate")
	}

	writeCertificateFiles(t, cfg.TURNServerTLSCertFile, cfg.TURNServerTLSKeyFile, "relay.test")
	conn, err := dial()
	if err != nil {
		t.Fatalf("TLS handshake after the certificate appeared: %v", err)
	}
	_ = conn.Close()

	username, password := browserCredentials(t, cfg)
	relay, err := newTURNClient(t, server, "tls", username, password).Allocate()
	if err != nil {
		t.Fatalf("allocate over TLS: %v", err)
	}
	_ = relay.Close()
}

func TestRelayWithoutCertificateFilesHasNoTLSListener(t *testing.T) {
	cfg := testConfig(t, 4)
	cfg.TURNServerTLSPort = freeTCPPort(t)
	server := startRelay(t, cfg)
	if server.tls != nil {
		t.Fatal("no certificate is configured, so TURN over TLS must stay off")
	}
}

func TestStartFailsWhenAListenPortIsTaken(t *testing.T) {
	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupy a TCP port: %v", err)
	}
	defer occupied.Close()
	port := occupied.Addr().(*net.TCPAddr).Port

	cfg := testConfig(t, 4)
	cfg.TURNServerPort = port
	server, err := start(cfg, quietLogger(), "127.0.0.1")
	if err == nil {
		_ = server.Close()
		t.Fatal("start succeeded although the TCP listen port is taken")
	}
	if !strings.Contains(err.Error(), "TCP") {
		t.Fatalf("error = %q, want it to name the TCP listener", err)
	}
	// The UDP socket bound before the failure must not be left behind.
	udp, err := net.ListenPacket("udp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		t.Fatalf("the UDP port is still held after a failed start: %v", err)
	}
	_ = udp.Close()
}

func TestStartFailsWhenTheRelayAddressIsNotLocal(t *testing.T) {
	cfg := testConfig(t, 4)
	cfg.TURNServerRelayIP = "203.0.113.9"
	server, err := start(cfg, quietLogger(), "127.0.0.1")
	if err == nil {
		_ = server.Close()
		t.Skip("this host binds addresses it does not own (ip_nonlocal_bind)")
	}
	if !strings.Contains(err.Error(), "203.0.113.9") {
		t.Fatalf("error = %q, want it to name the unusable relay address", err)
	}
}

func TestCloseReleasesListenersAndRelaySockets(t *testing.T) {
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	username, password := browserCredentials(t, cfg)
	relay, err := newTURNClient(t, server, "udp", username, password).Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	udpAddress := server.udp[0].LocalAddr().String()
	tcpAddress := server.tcp.Addr().String()
	relayAddress := relay.LocalAddr().String()

	if err := server.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	if err := server.Close(); err != nil {
		t.Fatalf("second Close() error = %v", err)
	}

	eventually(t, "the UDP listen port is free", func() bool {
		conn, err := net.ListenPacket("udp4", udpAddress)
		if err != nil {
			return false
		}
		return conn.Close() == nil
	})
	eventually(t, "the TCP listen port is free", func() bool {
		listener, err := net.Listen("tcp4", tcpAddress)
		if err != nil {
			return false
		}
		return listener.Close() == nil
	})
	eventually(t, "the relay socket is closed", func() bool {
		conn, err := net.ListenPacket("udp4", relayAddress)
		if err != nil {
			return false
		}
		return conn.Close() == nil
	})
	eventually(t, "no allocation is left", func() bool { return server.AllocationCount() == 0 })
}

func TestStartWithTheRelayDisabledBindsNothing(t *testing.T) {
	cfg := testConfig(t, 4)
	cfg.TURNServerEnabled = false
	cfg.TURNServerPort = freeTCPPort(t)
	server, err := Start(cfg, quietLogger())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	if server == nil || len(server.udp) != 0 || server.tcp != nil || server.tls != nil {
		t.Fatalf("a disabled relay must not listen: %+v", server)
	}
	if got := server.AllocationCount(); got != 0 {
		t.Fatalf("AllocationCount() = %d, want 0", got)
	}
	if err := server.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	var missing *Server
	if err := missing.Close(); err != nil || missing.AllocationCount() != 0 {
		t.Fatal("a nil relay must be safe to close and query")
	}
}

func TestStartLogsWhereTheRelayListensAndWarnsWithoutURLs(t *testing.T) {
	var output bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&output, nil))
	cfg := testConfig(t, 4)
	cfg.TURNURLs = nil
	server, err := start(cfg, logger, "127.0.0.1")
	if err != nil {
		t.Fatalf("start relay: %v", err)
	}
	defer server.Close()

	logs := output.String()
	for _, want := range []string{"turn_server_started", "relay_ip=127.0.0.1", "turn_server_without_urls"} {
		if !strings.Contains(logs, want) {
			t.Fatalf("startup logs lack %q:\n%s", want, logs)
		}
	}
	if strings.Contains(logs, testSecret) {
		t.Fatal("the shared secret must never be logged")
	}
}

// freeTURNPort returns a port free for TCP and UDP on every local address,
// which is how Start binds.
func freeTURNPort(t *testing.T) int {
	t.Helper()
	for range 50 {
		listener, err := net.Listen("tcp", ":0")
		if err != nil {
			t.Fatalf("probe for a free TURN port: %v", err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		_ = listener.Close()
		// A wildcard UDP bind fails if any single address holds the port.
		conn, err := net.ListenPacket("udp", net.JoinHostPort("", strconv.Itoa(port)))
		if err != nil {
			continue
		}
		_ = conn.Close()
		return port
	}
	t.Fatal("no port is free for both TCP and UDP on every address")
	return 0
}

func TestLocalUnicastAddressesAreBindable(t *testing.T) {
	addresses := localUnicastAddresses()
	hasLoopback := false
	seen := map[string]bool{}
	for _, address := range addresses {
		if address.IsUnspecified() || address.IsMulticast() || address.IsLinkLocalUnicast() && address.To4() == nil {
			t.Fatalf("%v is not an address a client can send to", address)
		}
		if seen[address.String()] {
			t.Fatalf("%v is listed twice", address)
		}
		seen[address.String()] = true
		if address.Equal(net.IPv4(127, 0, 0, 1)) {
			hasLoopback = true
		}
	}
	if !hasLoopback {
		t.Skipf("this host has no IPv4 loopback address: %v", addresses)
	}
}

func TestRelayListensOnEveryLocalAddress(t *testing.T) {
	cfg := testConfig(t, 4)
	cfg.TURNServerPort = freeTURNPort(t)
	server, err := start(cfg, quietLogger(), "")
	if err != nil {
		t.Fatalf("start relay on every address: %v", err)
	}
	defer server.Close()

	bound := map[string]bool{}
	for _, conn := range server.udp {
		address := conn.LocalAddr().(*net.UDPAddr)
		if address.IP.IsUnspecified() {
			t.Fatalf("UDP is bound to the wildcard address %v; replies could leave from the wrong address", address)
		}
		if address.Port != cfg.TURNServerPort {
			t.Fatalf("UDP socket %v is not on TURN port %d", address, cfg.TURNServerPort)
		}
		bound[address.IP.String()] = true
	}
	for _, address := range localUnicastAddresses() {
		if address.To4() != nil && !bound[address.String()] {
			t.Fatalf("no UDP socket for local address %v (bound: %v)", address, bound)
		}
	}
	if got := server.tcp.Addr().(*net.TCPAddr); !got.IP.IsUnspecified() || got.Port != cfg.TURNServerPort {
		t.Fatalf("TCP listens on %v, want every address on port %d", got, cfg.TURNServerPort)
	}
}

func TestRelayAnswersFromTheAddressAClientSentTo(t *testing.T) {
	// A client whose socket is bound to one local address sends to another
	// one: a browser on this machine reaching the relay through 127.0.0.1, or
	// any client of a host with several addresses. The answer must come from
	// the address that was asked, or the client drops it.
	var local net.IP
	for _, address := range localUnicastAddresses() {
		if address.To4() != nil && !address.IsLoopback() {
			local = address
			break
		}
	}
	if local == nil {
		t.Skip("this host has only loopback addresses")
	}
	cfg := testConfig(t, 4)
	cfg.TURNServerPort = freeTURNPort(t)
	server, err := start(cfg, quietLogger(), "")
	if err != nil {
		t.Fatalf("start relay on every address: %v", err)
	}
	defer server.Close()

	socket, err := net.ListenUDP("udp4", &net.UDPAddr{IP: local})
	if err != nil {
		t.Fatalf("open client socket on %v: %v", local, err)
	}
	defer socket.Close()
	serverAddress := net.JoinHostPort("127.0.0.1", strconv.Itoa(cfg.TURNServerPort))
	username, password := browserCredentials(t, cfg)
	loggers := logging.NewDefaultLoggerFactory()
	loggers.DefaultLogLevel = logging.LogLevelDisabled
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: serverAddress,
		TURNServerAddr: serverAddress,
		Conn:           socket,
		Username:       username,
		Password:       password,
		Realm:          testRealm,
		LoggerFactory:  loggers,
	})
	if err != nil {
		t.Fatalf("create TURN client: %v", err)
	}
	defer client.Close()
	if err := client.Listen(); err != nil {
		t.Fatalf("start TURN client: %v", err)
	}

	mapped, err := client.SendBindingRequest()
	if err != nil {
		t.Fatalf("no STUN answer from 127.0.0.1 for a client on %v: %v", local, err)
	}
	if udp, ok := mapped.(*net.UDPAddr); !ok || !udp.IP.Equal(local) {
		t.Fatalf("mapped address = %v, want the client's address %v", mapped, local)
	}
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate from %v through 127.0.0.1: %v", local, err)
	}
	_ = relay.Close()
}

func TestRelayReachesTheSFUOnAPublicAddressThisHostOwns(t *testing.T) {
	// TURN_SERVER_RELAY_IP names another address of a host that owns its
	// public one. The SFU listens on the public address, so the relay must
	// send there as it is; translating it to the relay address would send
	// relayed media to a port nothing listens on.
	cfg := testConfig(t, 4)
	cfg.ICEPublicIP = "127.0.0.1"
	cfg.TURNServerRelayIP = "127.0.0.2"
	server, err := start(cfg, quietLogger(), "127.0.0.1")
	if err != nil {
		t.Skipf("this host cannot bind a second loopback address: %v", err)
	}
	defer server.Close()
	username, password := browserCredentials(t, cfg)
	relay, err := newTURNClient(t, server, "udp", username, password).Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer relay.Close()
	relayAddress := relay.LocalAddr().(*net.UDPAddr)
	if !relayAddress.IP.Equal(net.IPv4(127, 0, 0, 2)) {
		t.Fatalf("relayed address = %v, want one on the chosen relay IP", relayAddress)
	}

	sfu := sfuSocket(t, cfg) // bound to the public address, 127.0.0.1
	if _, err := relay.WriteTo([]byte("browser to sfu"), sfu.LocalAddr()); err != nil {
		t.Fatalf("send to the SFU's public address: %v", err)
	}
	payload, source := readDatagram(t, sfu)
	if payload != "browser to sfu" || source.String() != relayAddress.String() {
		t.Fatalf("SFU received %q from %v, want it from the relay socket %v", payload, source, relayAddress)
	}
	if _, err := sfu.WriteTo([]byte("sfu to browser"), source); err != nil {
		t.Fatalf("reply to the relay: %v", err)
	}
	payload, peer := readDatagram(t, relay)
	if payload != "sfu to browser" || peer.String() != sfu.LocalAddr().String() {
		t.Fatalf("browser received %q from %v, want it from %v", payload, peer, sfu.LocalAddr())
	}
}

func TestRelayForwardsOnlyToTheSFUsPorts(t *testing.T) {
	// A TURN credential must not reach other UDP services on this server's
	// own address: with ICE_UDP_PORT_MIN-MAX set, only those ports (and other
	// relay sockets) are forwarded to.
	cfg := testConfig(t, 4)
	sfu := sfuSocket(t, cfg)
	sfuPort := sfu.LocalAddr().(*net.UDPAddr).Port
	other := sfuSocket(t, cfg)
	for other.LocalAddr().(*net.UDPAddr).Port == sfuPort {
		other = sfuSocket(t, cfg)
	}
	cfg.ICEUDPPortMin, cfg.ICEUDPPortMax = sfuPort, sfuPort
	server := startRelay(t, cfg)
	username, password := browserCredentials(t, cfg)
	relay, err := newTURNClient(t, server, "udp", username, password).Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer relay.Close()

	// The address is permitted either way; the port decides.
	if _, err := relay.WriteTo([]byte("for another service"), other.LocalAddr()); err != nil {
		t.Fatalf("send indication: %v", err)
	}
	if _, err := relay.WriteTo([]byte("for the sfu"), sfu.LocalAddr()); err != nil {
		t.Fatalf("send indication: %v", err)
	}
	if payload, _ := readDatagram(t, sfu); payload != "for the sfu" {
		t.Fatalf("SFU received %q", payload)
	}
	if err := other.SetReadDeadline(time.Now().Add(300 * time.Millisecond)); err != nil {
		t.Fatal(err)
	}
	if n, _, err := other.ReadFrom(make([]byte, 64)); err == nil {
		t.Fatalf("a service outside the SFU's ports received %d bytes through the relay", n)
	}
}

// stunBinding sends a STUN binding request over a stream connection and
// reports whether a binding success response arrived within timeout.
func stunBinding(t *testing.T, conn net.Conn, timeout time.Duration) bool {
	t.Helper()
	request := []byte{
		0x00, 0x01, 0x00, 0x00, // binding request, no attributes
		0x21, 0x12, 0xa4, 0x42, // magic cookie
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, // transaction ID
	}
	if _, err := conn.Write(request); err != nil {
		t.Fatalf("send STUN request: %v", err)
	}
	if err := conn.SetReadDeadline(time.Now().Add(timeout)); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 20)
	if _, err := io.ReadFull(conn, header); err != nil {
		return false
	}
	length := int(header[2])<<8 | int(header[3])
	if _, err := io.ReadFull(conn, make([]byte, length)); err != nil {
		return false
	}
	return header[0] == 0x01 && header[1] == 0x01
}

func TestStreamListenersHoldALimitedNumberOfConnections(t *testing.T) {
	// Connections that are opened and left idle must not pile up without
	// bound in the process the SFU shares.
	cfg := testConfig(t, 4)
	server, err := startWithLimit(cfg, quietLogger(), "127.0.0.1", 2)
	if err != nil {
		t.Fatalf("start relay: %v", err)
	}
	defer server.Close()
	dial := func() net.Conn {
		conn, err := net.DialTimeout("tcp", server.tcp.Addr().String(), testTimeout)
		if err != nil {
			t.Fatalf("connect: %v", err)
		}
		t.Cleanup(func() { _ = conn.Close() })
		return conn
	}

	first, second := dial(), dial()
	for _, conn := range []net.Conn{first, second} {
		if !stunBinding(t, conn, testTimeout) {
			t.Fatal("a connection within the limit was not served")
		}
	}
	// The third connects (the kernel queues it) but is not served yet.
	third := dial()
	if stunBinding(t, third, 300*time.Millisecond) {
		t.Fatal("a connection beyond the limit was served")
	}
	// Closing one frees its slot, and the waiting connection is served,
	// including the request it already sent.
	_ = first.Close()
	if err := third.SetReadDeadline(time.Now().Add(testTimeout)); err != nil {
		t.Fatal(err)
	}
	header := make([]byte, 20)
	if _, err := io.ReadFull(third, header); err != nil || header[0] != 0x01 || header[1] != 0x01 {
		t.Fatalf("the waiting connection was not served after a slot was freed: %v", err)
	}
}

func TestListenUDPOnSkipsAnAddressThatIsGone(t *testing.T) {
	port, _ := freeRelayRange(t, 1)
	gone := net.ParseIP("203.0.113.9") // not an address of this host
	loopbackIP := net.IPv4(127, 0, 0, 1)

	conns, err := listenUDPOn([]net.IP{gone, loopbackIP}, port, quietLogger())
	if err != nil {
		t.Fatalf("an address that is gone must be skipped, not stop the relay: %v", err)
	}
	if len(conns) == 2 {
		for _, conn := range conns {
			_ = conn.Close()
		}
		t.Skip("this host binds addresses it does not own (ip_nonlocal_bind)")
	}
	if len(conns) != 1 || !conns[0].LocalAddr().(*net.UDPAddr).IP.Equal(loopbackIP) {
		t.Fatalf("bound %d sockets, want only the loopback one", len(conns))
	}

	// The port being taken on an address is still an error.
	if again, err := listenUDPOn([]net.IP{loopbackIP}, port, quietLogger()); err == nil {
		for _, conn := range again {
			_ = conn.Close()
		}
		t.Fatal("a taken port was not reported")
	}
	_ = conns[0].Close()

	// With no address left there is no relay to run.
	if none, err := listenUDPOn([]net.IP{gone}, port, quietLogger()); err == nil {
		for _, conn := range none {
			_ = conn.Close()
		}
		t.Fatal("binding no address at all was not reported")
	}
}
