// Package turnserver runs the TURN relay built into SlowMeet.
//
// It serves the same role a separate coturn process used to: browsers that
// cannot reach the SFU directly allocate a relay address here and exchange
// media with the SFU through it. The relay accepts the time-limited
// shared-secret credentials config.TURNCredentials issues and forwards only to
// this server's own SFU addresses, so a credential (handed to anyone who can
// join a meeting) cannot be used to reach other hosts.
package turnserver

import (
	"cmp"
	"crypto/tls"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/pion/turn/v5"
	"golang.org/x/net/netutil"

	"SlowMeet/internal/config"
)

// Server is a running built-in TURN relay. The zero value is a relay that was
// never started: Close, AllocationCount and Stats are safe to call on it.
type Server struct {
	turn   *turn.Server
	logger *slog.Logger
	// udp holds one socket per local address; see listenUDP.
	udp []net.PacketConn
	tcp net.Listener
	tls net.Listener
	// tcpConns and tlsConns are the connections the two stream listeners hold
	// open; tlsConns is nil without a TLS listener.
	tcpConns  *streamConns
	tlsConns  *streamConns
	addresses relayAddresses

	closeOnce sync.Once
	closeErr  error
}

// Start runs the relay described by cfg. With the relay disabled it returns an
// inert Server, so callers can start and close it unconditionally. A listener
// that cannot bind is an error: an operator who enabled the relay should learn
// at startup that it is not serving, not from calls that fail to connect.
func Start(cfg config.Config, logger *slog.Logger) (*Server, error) {
	if !cfg.TURNServerEnabled {
		return &Server{}, nil
	}
	return start(cfg, logger, "")
}

// maxStreamClients caps the connections each stream listener (TURN over TCP,
// TURN over TLS) holds open at once. The relay shares its process with the SFU
// and the HTTP server, so connections that are opened and left idle must not
// be able to take the memory the meeting needs. The cap is well above the
// largest legitimate use: 100 participants on a rotating method hold about
// nine connections each. Beyond it, new connections wait to be accepted.
const maxStreamClients = 1024

// startOptions are the parts of a relay that tests replace.
type startOptions struct {
	// listenHost is the address the listeners bind; empty for every address.
	listenHost string
	// streamClients replaces maxStreamClients when it is not zero.
	streamClients int
	// now is the clock credentials expire by; time.Now when nil.
	now func() time.Time
}

// start binds the listeners on listenHost (empty for every address) and runs
// the relay. Tests pass a loopback host and port 0.
func start(cfg config.Config, logger *slog.Logger, listenHost string) (*Server, error) {
	return startWith(cfg, logger, startOptions{listenHost: listenHost})
}

func startWith(cfg config.Config, logger *slog.Logger, options startOptions) (_ *Server, err error) {
	if logger == nil {
		logger = slog.Default()
	}
	listenHost := options.listenHost
	streamClients := cmp.Or(options.streamClients, maxStreamClients)
	now := options.now
	if now == nil {
		now = time.Now
	}
	addresses, err := selectRelayAddresses(cfg)
	if err != nil {
		return nil, err
	}
	server := &Server{logger: logger, addresses: addresses}
	defer func() {
		if err != nil {
			server.closeListeners()
		}
	}()

	plainAddress := net.JoinHostPort(listenHost, strconv.Itoa(cfg.TURNServerPort))
	if server.udp, err = listenUDP(listenHost, cfg.TURNServerPort, logger); err != nil {
		return nil, err
	}
	if server.tcp, err = net.Listen("tcp", plainAddress); err != nil {
		return nil, fmt.Errorf("listen for TURN on TCP %s: %w", plainAddress, err)
	}
	server.tcpConns = newStreamConns("tcp", streamClients, logger)
	server.tcp = &streamListener{
		Listener: &retryListener{Listener: netutil.LimitListener(server.tcp, streamClients), name: "tcp", logger: logger},
		conns:    server.tcpConns,
		framed:   true,
	}
	listeners := []net.Listener{server.tcp}
	if cfg.TURNServerTLSEnabled() {
		tlsAddress := net.JoinHostPort(listenHost, strconv.Itoa(cfg.TURNServerTLSPort))
		inner, listenErr := net.Listen("tcp", tlsAddress)
		if listenErr != nil {
			return nil, fmt.Errorf("listen for TURN over TLS on TCP %s: %w", tlsAddress, listenErr)
		}
		certificates := newCertReloader(cfg.TURNServerTLSCertFile, cfg.TURNServerTLSKeyFile, logger)
		certificates.prime()
		// The cap sits under TLS, and tlsListener closes a connection whose
		// handshake fails, which is what gives its slot back.
		server.tlsConns = newStreamConns("tls", streamClients, logger)
		capped := &streamListener{
			Listener: &retryListener{Listener: netutil.LimitListener(inner, streamClients), name: "tls", logger: logger},
			conns:    server.tlsConns,
		}
		server.tls = newTLSListener(capped, &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: certificates.GetCertificate,
		}, tlsHandshakeTimeout, logger)
		listeners = append(listeners, server.tls)
	}

	generator := &relayAddressGenerator{
		addresses:  addresses,
		portMin:    cfg.TURNServerRelayPortMin,
		portMax:    cfg.TURNServerRelayPortMax,
		sfuPortMin: cfg.ICEUDPPortMin,
		sfuPortMax: cfg.ICEUDPPortMax,
		// Every UDP socket of the relay is on the same port.
		listenPort: localPort(server.udp[0].LocalAddr()),
		// The same rule internal/signaling uses to give the SFU's own peer
		// connections TURN servers.
		relayToRelay: len(cfg.ServerTURNURLs()) > 0,
		logger:       logger,
	}
	permit := func(_ net.Addr, peerIP net.IP) bool {
		if addresses.permits(peerIP) {
			return true
		}
		logger.Debug("turn_server_peer_denied", "peer", peerIP.String())
		return false
	}
	turnConfig := turn.ServerConfig{
		Realm:         cmp.Or(cfg.TURNServerRealm, config.DefaultTURNServerRealm),
		AuthHandler:   newAuthHandler(cfg.TURNSharedSecret, now, logger),
		LoggerFactory: pionLoggerFactory{logger: logger},
		EventHandler:  turn.EventHandler{OnAllocationError: logRequestFailure(logger)},
		// Relays are IPv4 whatever address family the client reached the
		// listener over, as the SFU's media ports are.
		StrictAddressFamily: true,
	}
	for _, conn := range server.udp {
		turnConfig.PacketConnConfigs = append(turnConfig.PacketConnConfigs, turn.PacketConnConfig{
			PacketConn:            conn,
			RelayAddressGenerator: generator,
			PermissionHandler:     permit,
		})
	}
	for _, listener := range listeners {
		turnConfig.ListenerConfigs = append(turnConfig.ListenerConfigs, turn.ListenerConfig{
			Listener:              listener,
			RelayAddressGenerator: generator,
			PermissionHandler:     permit,
		})
	}
	if server.turn, err = turn.NewServer(turnConfig); err != nil {
		return nil, fmt.Errorf("start TURN relay: %w", err)
	}

	tlsAddress := ""
	if server.tls != nil {
		tlsAddress = server.tls.Addr().String()
	}
	udpAddresses := make([]string, 0, len(server.udp))
	for _, conn := range server.udp {
		udpAddresses = append(udpAddresses, conn.LocalAddr().String())
	}
	// The peer ports the relay forwards to besides its own relay ports.
	sfuPorts := "any"
	if cfg.ICEUDPPortMin != 0 {
		sfuPorts = fmt.Sprintf("%d-%d", cfg.ICEUDPPortMin, cfg.ICEUDPPortMax)
	}
	logger.Info("turn_server_started",
		"udp", strings.Join(udpAddresses, ","),
		"tcp", server.tcp.Addr().String(),
		"tls", tlsAddress,
		"relay_ip", addresses.relayIP.String(),
		"relay_ports", fmt.Sprintf("%d-%d", cfg.TURNServerRelayPortMin, cfg.TURNServerRelayPortMax),
		"sfu_ports", sfuPorts,
		"translates_public_ip", addresses.translates())
	if cfg.ICEUDPPortMin == 0 {
		// Only a media port range tells the SFU's sockets from other UDP
		// services on this server's address.
		logger.Warn("turn_server_any_peer_port",
			"hint", "set ICE_UDP_PORT_MIN and ICE_UDP_PORT_MAX: without a media port range the relay "+
				"forwards to any UDP port on this server's own address")
	}
	warnAboutRelayRange(logger, cfg)
	if loopbackRelayCannotReachSFU(cfg, addresses.relayIP) {
		logger.Warn("turn_server_loopback_relay_address",
			"relay_ip", addresses.relayIP.String(), "ice_public_ip", cfg.ICEPublicIP,
			"hint", "no other local IPv4 address was found for relay sockets, and the SFU does not listen "+
				"on loopback: restart once the network is up, or set TURN_SERVER_RELAY_IP")
	}
	tlsPort := 0
	if server.tls != nil {
		tlsPort = localPort(server.tls.Addr())
	}
	warnAboutTURNURLs(logger, cfg.EffectiveTURNURLs(), localPort(server.tcp.Addr()), tlsPort)
	return server, nil
}

// warnAboutRelayRange warns when the relay port range cannot hold a full room
// on a rotating TURN method, where each participant holds several allocations
// at a time. A range that fills refuses new allocations, which a participant
// sees as a rotation that does not complete. Nothing is refused here: a room
// rarely has everyone relayed, so the smaller range often works.
func warnAboutRelayRange(logger *slog.Logger, cfg config.Config) {
	ports := cfg.TURNServerRelayPortMax - cfg.TURNServerRelayPortMin + 1
	perParticipant := config.TURNAllocationsPerParticipant(cfg.TURNTCPRotateInterval)
	if needed := cfg.MaxParticipants * perParticipant; needed > ports {
		logger.Warn("turn_server_relay_range_small",
			"relay_ports", ports, "max_participants", cfg.MaxParticipants,
			"allocations_per_participant", perParticipant, "needed", needed,
			"hint", "a full room on a rotating TURN method needs more relay ports than "+
				"TURN_SERVER_RELAY_PORT_MIN-MAX holds; widen the range, keeping it clear of the ICE UDP range")
	}
}

// warnAboutTURNURLs compares TURN_URLS, which is where browsers are sent, with
// what the relay serves: plainPort for TURN over UDP and TCP, and tlsPort for
// TURN over TLS, zero when that listener does not run. A mismatch is only
// warned about. A port mapping or an SNI router in front of the relay makes
// URLs right that name neither port.
func warnAboutTURNURLs(logger *slog.Logger, urls []string, plainPort, tlsPort int) {
	if len(urls) == 0 {
		logger.Warn("turn_server_without_urls",
			"hint", "set TURN_URLS so browsers are told where to reach the built-in relay")
		return
	}
	namesListenPort := false
	for _, raw := range urls {
		scheme, port, ok := turnURLPort(raw)
		if !ok {
			continue
		}
		if scheme == "turns" && tlsPort == 0 {
			logger.Warn("turn_server_tls_url_without_listener", "url", raw,
				"hint", "TURN_URLS offers TURN over TLS, which the built-in relay serves only with "+
					"TURN_SERVER_TLS_PORT, TURN_SERVER_TLS_CERT_FILE and TURN_SERVER_TLS_KEY_FILE set")
		}
		if port == plainPort || (tlsPort != 0 && port == tlsPort) {
			namesListenPort = true
		}
	}
	if !namesListenPort {
		listenPorts := strconv.Itoa(plainPort)
		if tlsPort != 0 {
			listenPorts += "," + strconv.Itoa(tlsPort)
		}
		logger.Warn("turn_server_urls_miss_listen_ports", "listen_ports", listenPorts,
			"hint", "no URL in TURN_URLS names a port the built-in relay listens on; "+
				"browsers reach it only if something in front forwards those URLs to it")
	}
}

// turnURLPort returns the scheme of a turn: or turns: URL and the port it
// names, which is the scheme's registered port when the URL has none.
func turnURLPort(raw string) (scheme string, port int, ok bool) {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil {
		return "", 0, false
	}
	switch parsed.Scheme {
	case "turn":
		port = config.DefaultTURNServerPort
	case "turns":
		port = config.DefaultTURNServerTLSPort
	default:
		return "", 0, false
	}
	// "turn:host:3478?transport=udp" has no "//", so the URL parser keeps
	// host and port as opaque text.
	if _, portText, splitErr := net.SplitHostPort(cmp.Or(parsed.Opaque, parsed.Host)); splitErr == nil {
		if port, err = strconv.Atoi(portText); err != nil {
			return "", 0, false
		}
	}
	return parsed.Scheme, port, true
}

// localPort returns the port of a listener's or socket's local address.
func localPort(address net.Addr) int {
	switch address := address.(type) {
	case *net.UDPAddr:
		return address.Port
	case *net.TCPAddr:
		return address.Port
	}
	return 0
}

// listenUDP binds the TURN port for UDP. With no listenHost it binds every
// local address separately instead of the wildcard address: a wildcard socket
// answers from whichever address the kernel routes with, which on a host with
// several addresses is not always the one the client sent to, and a client
// drops a reply from an address it did not ask. A socket per address always
// answers from its own. (TCP has no such problem; its listeners use the
// wildcard address.) Addresses added after startup are served once the
// process restarts.
//
// A port that is taken on an IPv4 address is an error. An address that is no
// longer there when it is bound (an interface that went away since the list
// was read) is skipped, and IPv6 addresses are best effort altogether, as
// relayed media is IPv4 either way: one that cannot be bound (for example
// while still tentative) is skipped.
func listenUDP(listenHost string, port int, logger *slog.Logger) ([]net.PacketConn, error) {
	addresses := localUnicastAddresses()
	if listenHost != "" || len(addresses) == 0 {
		// A chosen host, or no interface address could be read and the
		// wildcard address is the only thing left to bind.
		address := net.JoinHostPort(listenHost, strconv.Itoa(port))
		conn, err := net.ListenPacket("udp", address)
		if err != nil {
			return nil, fmt.Errorf("listen for TURN on UDP %s: %w", address, err)
		}
		return []net.PacketConn{conn}, nil
	}
	return listenUDPOn(addresses, port, logger)
}

// listenUDPOn binds one UDP socket per address, with the rules listenUDP
// describes. It fails if no address at all could be bound.
func listenUDPOn(addresses []net.IP, port int, logger *slog.Logger) (_ []net.PacketConn, err error) {
	var conns []net.PacketConn
	defer func() {
		if err != nil {
			for _, conn := range conns {
				_ = conn.Close()
			}
		}
	}()
	for _, ip := range addresses {
		address := net.JoinHostPort(ip.String(), strconv.Itoa(port))
		conn, listenErr := net.ListenPacket("udp", address)
		if listenErr == nil {
			conns = append(conns, conn)
			continue
		}
		if ip.To4() != nil && !errors.Is(listenErr, syscall.EADDRNOTAVAIL) {
			return nil, fmt.Errorf("listen for TURN on UDP %s: %w", address, listenErr)
		}
		logger.Warn("turn_server_address_skipped", "address", ip.String(), "error", listenErr.Error())
	}
	if len(conns) == 0 {
		return nil, fmt.Errorf("listen for TURN on UDP port %d: no local address could be bound", port)
	}
	return conns, nil
}

// localUnicastAddresses lists the addresses of this host a client can send
// to: every IPv4 address, and IPv6 loopback and global (including unique
// local) addresses. IPv6 link-local addresses need a zone and are left out.
func localUnicastAddresses() []net.IP {
	interfaceAddresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var addresses []net.IP
	seen := map[string]bool{}
	for _, address := range interfaceAddresses {
		network, ok := address.(*net.IPNet)
		if !ok {
			continue
		}
		ip := network.IP
		if ip4 := ip.To4(); ip4 != nil {
			ip = ip4
		} else if !ip.IsLoopback() && (!ip.IsGlobalUnicast() || ip.IsLinkLocalUnicast()) {
			continue
		}
		if ip.IsUnspecified() || ip.IsMulticast() || seen[ip.String()] {
			continue
		}
		seen[ip.String()] = true
		addresses = append(addresses, ip)
	}
	return addresses
}

// AllocationCount returns the number of relay allocations currently held.
func (s *Server) AllocationCount() int {
	if s == nil || s.turn == nil {
		return 0
	}
	return s.turn.AllocationCount()
}

// Stats is what the relay holds open at one moment.
type Stats struct {
	// Allocations is the number of relay allocations.
	Allocations int
	// TCPConnections and TLSConnections are the open TURN-over-TCP and
	// TURN-over-TLS connections, TLS ones still in their handshake included.
	// Each count is limited by maxStreamClients.
	TCPConnections int
	TLSConnections int
}

// Stats returns the relay's current allocation and stream connection counts.
func (s *Server) Stats() Stats {
	if s == nil {
		return Stats{}
	}
	return Stats{
		Allocations:    s.AllocationCount(),
		TCPConnections: s.tcpConns.count(),
		TLSConnections: s.tlsConns.count(),
	}
}

// Close stops the relay, releasing its listeners, every relay socket and the
// TURN-over-TCP and TURN-over-TLS connections clients hold.
func (s *Server) Close() error {
	if s == nil {
		return nil
	}
	s.closeOnce.Do(func() {
		if s.turn == nil {
			s.closeErr = s.closeListeners()
			return
		}
		// The TURN server owns the listeners it was given and closes them;
		// each one's allocations (and their relay sockets) go with it. It
		// leaves accepted stream connections open, though, and would go on
		// serving them, new allocations included.
		s.closeErr = s.turn.Close()
		s.tcpConns.closeAll()
		s.tlsConns.closeAll()
		s.logger.Info("turn_server_stopped")
	})
	return s.closeErr
}

// closeListeners releases whatever start bound before it failed.
func (s *Server) closeListeners() error {
	var errs []error
	for _, conn := range s.udp {
		errs = append(errs, conn.Close())
	}
	if s.tcp != nil {
		errs = append(errs, s.tcp.Close())
	}
	if s.tls != nil {
		errs = append(errs, s.tls.Close())
	}
	// The TLS listener accepts as soon as it exists.
	s.tcpConns.closeAll()
	s.tlsConns.closeAll()
	return errors.Join(errs...)
}
