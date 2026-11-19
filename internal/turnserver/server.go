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
	"strconv"
	"strings"
	"sync"

	"github.com/pion/turn/v5"

	"SlowMeet/internal/config"
)

// Server is a running built-in TURN relay. The zero value is a relay that was
// never started: Close and AllocationCount are safe to call on it.
type Server struct {
	turn   *turn.Server
	logger *slog.Logger
	// udp holds one socket per local address; see listenUDP.
	udp       []net.PacketConn
	tcp       net.Listener
	tls       net.Listener
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

// start binds the listeners on listenHost (empty for every address) and runs
// the relay. Tests pass a loopback host and port 0.
func start(cfg config.Config, logger *slog.Logger, listenHost string) (_ *Server, err error) {
	if logger == nil {
		logger = slog.Default()
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
	listeners := []net.Listener{server.tcp}
	if cfg.TURNServerTLSEnabled() {
		tlsAddress := net.JoinHostPort(listenHost, strconv.Itoa(cfg.TURNServerTLSPort))
		inner, listenErr := net.Listen("tcp", tlsAddress)
		if listenErr != nil {
			return nil, fmt.Errorf("listen for TURN over TLS on TCP %s: %w", tlsAddress, listenErr)
		}
		certificates := newCertReloader(cfg.TURNServerTLSCertFile, cfg.TURNServerTLSKeyFile, logger)
		server.tls = tls.NewListener(inner, &tls.Config{
			MinVersion:     tls.VersionTLS12,
			GetCertificate: certificates.GetCertificate,
		})
		listeners = append(listeners, server.tls)
	}

	generator := &relayAddressGenerator{
		addresses: addresses,
		portMin:   cfg.TURNServerRelayPortMin,
		portMax:   cfg.TURNServerRelayPortMax,
	}
	permit := func(_ net.Addr, peerIP net.IP) bool {
		if addresses.permits(peerIP) {
			return true
		}
		logger.Debug("turn_server_peer_denied", "peer", peerIP.String())
		return false
	}
	loggers := pionLoggerFactory{logger: logger}
	turnConfig := turn.ServerConfig{
		Realm:         cmp.Or(cfg.TURNServerRealm, config.DefaultTURNServerRealm),
		AuthHandler:   turn.LongTermTURNRESTAuthHandler(cfg.TURNSharedSecret, loggers.NewLogger("turn-auth")),
		LoggerFactory: loggers,
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
	logger.Info("turn_server_started",
		"udp", strings.Join(udpAddresses, ","),
		"tcp", server.tcp.Addr().String(),
		"tls", tlsAddress,
		"relay_ip", addresses.relayIP.String(),
		"relay_ports", fmt.Sprintf("%d-%d", cfg.TURNServerRelayPortMin, cfg.TURNServerRelayPortMax),
		"translates_public_ip", addresses.translates())
	if len(cfg.EffectiveTURNURLs()) == 0 {
		logger.Warn("turn_server_without_urls",
			"hint", "set TURN_URLS so browsers are told where to reach the built-in relay")
	}
	return server, nil
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
// A failure on an IPv4 address is an error. IPv6 addresses are best effort,
// as relayed media is IPv4 either way: one that cannot be bound (for example
// while still tentative) is skipped.
func listenUDP(listenHost string, port int, logger *slog.Logger) (_ []net.PacketConn, err error) {
	var conns []net.PacketConn
	defer func() {
		if err != nil {
			for _, conn := range conns {
				_ = conn.Close()
			}
		}
	}()
	listen := func(host string) error {
		address := net.JoinHostPort(host, strconv.Itoa(port))
		conn, listenErr := net.ListenPacket("udp", address)
		if listenErr != nil {
			return fmt.Errorf("listen for TURN on UDP %s: %w", address, listenErr)
		}
		conns = append(conns, conn)
		return nil
	}
	addresses := localUnicastAddresses()
	if listenHost != "" || len(addresses) == 0 {
		// A chosen host, or no interface address could be read and the
		// wildcard address is the only thing left to bind.
		if err := listen(listenHost); err != nil {
			return nil, err
		}
		return conns, nil
	}
	for _, address := range addresses {
		if listenErr := listen(address.String()); listenErr != nil {
			if address.To4() != nil {
				return nil, listenErr
			}
			logger.Warn("turn_server_ipv6_address_skipped", "address", address.String(), "error", listenErr.Error())
		}
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

// Close stops the relay, releasing its listeners and every relay socket.
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
		// each one's allocations (and their relay sockets) go with it.
		s.closeErr = s.turn.Close()
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
	return errors.Join(errs...)
}
