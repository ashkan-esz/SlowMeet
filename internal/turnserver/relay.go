package turnserver

import (
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/turn/v5"

	"SlowMeet/internal/config"
)

var (
	errIPv4RelayOnly       = errors.New("only IPv4 UDP relay addresses are offered")
	errTCPRelayDisabled    = errors.New("relaying over TCP is disabled")
	errRelayPortOutOfRange = errors.New("requested relay port is outside the configured range")
	errRelayPortsExhausted = errors.New("no free port in the TURN relay port range")
	errRelayRangeInvalid   = errors.New("TURN relay port range is invalid")
	errPeerPortNotAllowed  = errors.New("peer port is neither an SFU media port nor a relay port")

	errGeneratorNotValidated = errors.New("relay address generator was used before Validate")
)

// relayAddresses are the two addresses the relay works with.
//
// relayIP is the local IPv4 address relay sockets bind and advertise. publicIP
// is ICE_PUBLIC_IP when it is IPv4: the address the SFU puts in the candidates
// it sends browsers, and so the peer address browsers ask the relay to reach.
//
// On a host that owns its public address the SFU's sockets are bound to it and
// the relay reaches them there. Behind a Docker or Podman bridge, or a cloud
// 1:1 NAT, the public address is not local: a packet sent to it would leave
// this network namespace and come back re-sourced (or not at all), and the
// relay's per-peer-address permission would never match. As the SFU is in
// this same process, the relay then translates instead (translate is set);
// see relayPacketConn.
type relayAddresses struct {
	relayIP  net.IP
	publicIP net.IP
	// translate is set when publicIP is not an address of this host. It is not
	// simply "the two addresses differ": with TURN_SERVER_RELAY_IP naming
	// another address of a host that owns its public one, the SFU still
	// listens on the public address and must be reached there, untranslated.
	translate bool
}

// translates reports whether peer addresses need rewriting between the public
// address browsers use and the local one the SFU's sockets are bound to.
func (a relayAddresses) translates() bool {
	return a.translate
}

// permits reports whether the relay may forward to peerIP. Only this server's
// own addresses qualify: the SFU's host candidates, and relay addresses when
// the SFU itself allocates one under a relay-only ICE policy.
func (a relayAddresses) permits(peerIP net.IP) bool {
	return peerIP.Equal(a.relayIP) || (a.publicIP != nil && peerIP.Equal(a.publicIP))
}

// selectRelayAddresses picks the relay's addresses from the configuration and
// this host's interfaces, and checks that relay sockets can bind the result.
func selectRelayAddresses(cfg config.Config) (relayAddresses, error) {
	var addresses relayAddresses
	if publicIP := net.ParseIP(cfg.ICEPublicIP); publicIP != nil {
		addresses.publicIP = publicIP.To4()
	}
	switch {
	case cfg.TURNServerRelayIP != "":
		relayIP, err := config.ParseTURNServerRelayIP(cfg.TURNServerRelayIP)
		if err != nil {
			return relayAddresses{}, err
		}
		addresses.relayIP = relayIP
	case addresses.publicIP != nil && localInterfaceHasIP(addresses.publicIP):
		addresses.relayIP = addresses.publicIP
	default:
		addresses.relayIP = routedLocalIPv4(addresses.publicIP)
	}
	if addresses.relayIP == nil {
		return relayAddresses{}, fmt.Errorf(
			"could not find a local IPv4 address for TURN relay sockets; set TURN_SERVER_RELAY_IP")
	}
	probe, err := net.ListenUDP("udp4", &net.UDPAddr{IP: addresses.relayIP})
	if err != nil {
		return relayAddresses{}, fmt.Errorf("TURN relay address %s is not usable on this host: %w",
			addresses.relayIP, err)
	}
	_ = probe.Close()
	addresses.translate = addresses.publicIP != nil && !addresses.publicIP.Equal(addresses.relayIP) &&
		!localInterfaceHasIP(addresses.publicIP)
	return addresses, nil
}

// loopbackRelayCannotReachSFU reports whether the relay address was chosen
// automatically and came out as loopback although the SFU is advertised at
// another address. That happens when the host had no other IPv4 address at
// startup (routedLocalIPv4's last resort). The SFU does not listen on
// loopback then, so relayed media would arrive nowhere.
func loopbackRelayCannotReachSFU(cfg config.Config, relayIP net.IP) bool {
	if cfg.TURNServerRelayIP != "" || !relayIP.IsLoopback() {
		return false
	}
	publicIP := net.ParseIP(cfg.ICEPublicIP)
	return publicIP != nil && !publicIP.IsLoopback()
}

// routedLocalIPv4 returns the local address the kernel would send from to
// reach target (any public address when target is nil). Connecting a UDP
// socket only consults the routing table; nothing is sent. Without a route it
// falls back to the first non-loopback interface address, then to loopback.
func routedLocalIPv4(target net.IP) net.IP {
	if target == nil {
		target = net.IPv4(192, 0, 2, 1) // TEST-NET-1: routed like any public address
	}
	if conn, err := net.DialUDP("udp4", nil, &net.UDPAddr{IP: target, Port: 9}); err == nil {
		local, ok := conn.LocalAddr().(*net.UDPAddr)
		_ = conn.Close()
		if ok && local.IP.To4() != nil && !local.IP.IsUnspecified() {
			return local.IP.To4()
		}
	}
	interfaceAddresses, err := net.InterfaceAddrs()
	if err != nil {
		return nil
	}
	var loopback net.IP
	for _, address := range interfaceAddresses {
		network, ok := address.(*net.IPNet)
		if !ok || network.IP.To4() == nil {
			continue
		}
		if network.IP.IsLoopback() {
			loopback = network.IP.To4()
			continue
		}
		return network.IP.To4()
	}
	return loopback
}

// localInterfaceHasIP reports whether ip is assigned to a local interface. It
// matches the rule the SFU uses to gather only on its public interface.
func localInterfaceHasIP(ip net.IP) bool {
	interfaceAddresses, err := net.InterfaceAddrs()
	if err != nil {
		return false
	}
	for _, address := range interfaceAddresses {
		if network, ok := address.(*net.IPNet); ok && network.IP.Equal(ip) {
			return true
		}
	}
	return false
}

// relayAddressGenerator hands the TURN server a UDP socket for each
// allocation, bound to the relay address inside the configured port range.
type relayAddressGenerator struct {
	addresses relayAddresses
	portMin   int
	portMax   int
	// sfuPortMin and sfuPortMax are the SFU's media port range
	// (ICE_UDP_PORT_MIN-MAX); zero when the SFU is not held to a range. See
	// relayPacketConn for what they restrict.
	sfuPortMin int
	sfuPortMax int
	// listenPort is the UDP port the relay itself serves TURN on, which no
	// relay socket may send to.
	listenPort int
	// relayToRelay is set when the SFU itself allocates on this relay (a
	// relay-only ICE policy), so one relay socket must be able to reach
	// another.
	relayToRelay bool
	// logger receives the warning about a full port range; Validate falls
	// back to the default logger.
	logger    *slog.Logger
	exhausted warningGate
	// openPorts records which relay ports are bound; Validate creates it.
	openPorts *relayPortSet
}

// relayPortSet records which ports of the relay range are bound by relay
// sockets right now. Every relay socket is in it from the moment it is bound
// until it is closed. Relay sockets consult it on every datagram, so it is
// lock-free: one flag per port.
//
// It serves two purposes. A port number alone does not say what a socket is:
// with no ICE port range configured the SFU binds any port, including ones
// inside the relay range, and "inside the range" would then take the SFU for
// a relay socket. And an allocation does not have to try binding ports the
// relay already holds, which matters once the range is full.
type relayPortSet struct {
	min  int
	open []atomic.Bool
}

func newRelayPortSet(portMin, portMax int) *relayPortSet {
	return &relayPortSet{min: portMin, open: make([]atomic.Bool, portMax-portMin+1)}
}

func (s *relayPortSet) mark(port int, open bool) {
	if index := port - s.min; index >= 0 && index < len(s.open) {
		s.open[index].Store(open)
	}
}

func (s *relayPortSet) has(port int) bool {
	index := port - s.min
	return index >= 0 && index < len(s.open) && s.open[index].Load()
}

// Validate checks the generator and prepares it for use. The TURN library
// calls it once per listener, before any allocation.
func (g *relayAddressGenerator) Validate() error {
	if g.addresses.relayIP == nil || g.addresses.relayIP.To4() == nil {
		return errIPv4RelayOnly
	}
	if g.portMin < 1 || g.portMax > 65535 || g.portMin > g.portMax {
		return errRelayRangeInvalid
	}
	if g.openPorts == nil {
		g.openPorts = newRelayPortSet(g.portMin, g.portMax)
	}
	if g.logger == nil {
		g.logger = slog.Default()
	}
	return nil
}

// AllocatePacketConn binds a relay socket. It starts at a random port and
// walks the whole range, so an allocation fails only when every port is taken.
//
// The TURN library calls it from the loop that reads a listener, so it must
// not be slow when it fails: any participant can keep asking for allocations
// once the range is full. Ports the relay holds itself are therefore passed
// over without a bind attempt, which leaves nothing to try when it holds all
// of them.
func (g *relayAddressGenerator) AllocatePacketConn(conf turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	if conf.Network != "udp4" {
		return nil, nil, errIPv4RelayOnly
	}
	if g.openPorts == nil {
		return nil, nil, errGeneratorNotValidated
	}
	if conf.RequestedPort != 0 {
		if conf.RequestedPort < g.portMin || conf.RequestedPort > g.portMax {
			return nil, nil, errRelayPortOutOfRange
		}
		return g.listen(conf.RequestedPort)
	}
	span := g.portMax - g.portMin + 1
	first := rand.IntN(span)
	// lastErr stays nil when every port is a relay socket already; otherwise it
	// is why the last port something else holds could not be bound.
	var lastErr error
	for offset := range span {
		port := g.portMin + (first+offset)%span
		if g.openPorts.has(port) {
			continue
		}
		conn, address, err := g.listen(port)
		if err == nil {
			return conn, address, nil
		}
		lastErr = err
	}
	if g.exhausted.open(time.Now()) {
		g.logger.Warn("turn_server_relay_ports_exhausted",
			"relay_ports", fmt.Sprintf("%d-%d", g.portMin, g.portMax),
			"bind_error", errorText(lastErr),
			"hint", "every relay port is in use, so new relay allocations are refused; "+
				"widen TURN_SERVER_RELAY_PORT_MIN-MAX if this is ordinary load")
	}
	if lastErr == nil {
		return nil, nil, errRelayPortsExhausted
	}
	return nil, nil, fmt.Errorf("%w: %w", errRelayPortsExhausted, lastErr)
}

// AllocateListener refuses TCP relay addresses (RFC 6062): the SFU's media
// ports are UDP only.
func (g *relayAddressGenerator) AllocateListener(turn.AllocateListenerConfig) (net.Listener, net.Addr, error) {
	return nil, nil, errTCPRelayDisabled
}

// AllocateConn refuses outgoing TCP relay connections for the same reason.
func (g *relayAddressGenerator) AllocateConn(turn.AllocateConnConfig) (net.Conn, error) {
	return nil, errTCPRelayDisabled
}

func (g *relayAddressGenerator) listen(port int) (net.PacketConn, net.Addr, error) {
	conn, err := net.ListenUDP("udp4", &net.UDPAddr{IP: g.addresses.relayIP, Port: port})
	if err != nil {
		return nil, nil, err
	}
	g.openPorts.mark(port, true)
	return &relayPacketConn{
		PacketConn:   conn,
		addresses:    g.addresses,
		port:         port,
		openPorts:    g.openPorts,
		sfuPortMin:   g.sfuPortMin,
		sfuPortMax:   g.sfuPortMax,
		listenPort:   g.listenPort,
		relayToRelay: g.relayToRelay,
	}, &net.UDPAddr{IP: g.addresses.relayIP, Port: port}, nil
}

// errorText is err's message, or "" when there is none.
func errorText(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

// relayPacketConn is a relay socket with the two rules the TURN library cannot
// express, because its permissions name a peer by IP address only. Every relay
// socket is one, also where neither rule has anything to do, so that the set
// of open relay ports is complete.
//
// Ports. The permitted peer address is this server's own, and other UDP
// services may listen on it. A TURN credential, which every meeting
// participant receives, must not be a way to send them datagrams from this
// host, past its firewall. So a datagram is forwarded only to a port the SFU
// can be on: its media port range, and another relay socket only when the SFU
// itself allocates on this relay (relayToRelay). Otherwise relay sockets
// belong to participants alone, and one participant has no business sending
// to another's. Without a configured media port range the SFU may be on any
// port, relay range included, and only one port is refused: the relay's own
// TURN port, which is never a peer. A relay socket that could send there
// would be a TURN client of the server it belongs to, and the allocation it
// made a way to have the relay forward to itself in a loop.
//
// Addresses. On a host whose public address is not local (addresses.translate)
// browsers address the SFU by that public address, while the SFU's sockets
// are bound to the local one. The peer address is rewritten in both
// directions, so the relay-to-SFU leg stays inside this network namespace:
//
//   - a datagram for publicIP:port is sent to relayIP:port;
//   - a datagram from relayIP:port is reported as coming from publicIP:port,
//     the address the browser created its TURN permission for.
//
// Datagrams from another relay socket keep their address: those peers are
// advertised by relayIP already. Which ports are relay sockets is looked up in
// the set of open ones, not judged by the range (see relayPortSet).
type relayPacketConn struct {
	net.PacketConn
	addresses    relayAddresses
	port         int
	openPorts    *relayPortSet
	sfuPortMin   int
	sfuPortMax   int
	listenPort   int
	relayToRelay bool
	closeOnce    sync.Once
}

// isRelayPort reports whether port is a relay socket that is open now.
func (c *relayPacketConn) isRelayPort(port int) bool {
	return c.openPorts.has(port)
}

// Close releases the relay socket. Its port is taken off the open set first,
// and only by the first Close: once the socket is closed another allocation
// may bind the same port, and that one's mark must stand.
func (c *relayPacketConn) Close() error {
	c.closeOnce.Do(func() { c.openPorts.mark(c.port, false) })
	return c.PacketConn.Close()
}

// permitsPort reports whether a peer on port can be the SFU: on one of its
// media ports, or behind a relay socket of its own.
func (c *relayPacketConn) permitsPort(port int) bool {
	if port == c.listenPort {
		return false
	}
	if c.sfuPortMin == 0 {
		return true
	}
	if port >= c.sfuPortMin && port <= c.sfuPortMax {
		return true
	}
	return c.relayToRelay && c.isRelayPort(port)
}

func (c *relayPacketConn) ReadFrom(buffer []byte) (int, net.Addr, error) {
	n, source, err := c.PacketConn.ReadFrom(buffer)
	if err != nil || !c.addresses.translate {
		return n, source, err
	}
	// The address is allocated per read by the net package, so it is ours to
	// rewrite in place.
	if udp, ok := source.(*net.UDPAddr); ok && udp.IP.Equal(c.addresses.relayIP) && !c.isRelayPort(udp.Port) {
		udp.IP = c.addresses.publicIP
	}
	return n, source, nil
}

func (c *relayPacketConn) WriteTo(payload []byte, destination net.Addr) (int, error) {
	if udp, ok := destination.(*net.UDPAddr); ok {
		if !c.permitsPort(udp.Port) {
			return 0, errPeerPortNotAllowed
		}
		if c.addresses.translate && udp.IP.Equal(c.addresses.publicIP) {
			destination = &net.UDPAddr{IP: c.addresses.relayIP, Port: udp.Port}
		}
	}
	return c.PacketConn.WriteTo(payload, destination)
}
