package turnserver

import (
	"errors"
	"fmt"
	"math/rand/v2"
	"net"

	"github.com/pion/turn/v5"

	"SlowMeet/internal/config"
)

var (
	errIPv4RelayOnly       = errors.New("only IPv4 UDP relay addresses are offered")
	errTCPRelayDisabled    = errors.New("relaying over TCP is disabled")
	errRelayPortOutOfRange = errors.New("requested relay port is outside the configured range")
	errRelayPortsExhausted = errors.New("no free port in the TURN relay port range")
	errRelayRangeInvalid   = errors.New("TURN relay port range is invalid")
)

// relayAddresses are the two addresses the relay works with.
//
// relayIP is the local IPv4 address relay sockets bind and advertise. publicIP
// is ICE_PUBLIC_IP when it is IPv4: the address the SFU puts in the candidates
// it sends browsers, and so the peer address browsers ask the relay to reach.
//
// On a host that owns its public address the two are equal. Behind a Docker or
// Podman bridge, or a cloud 1:1 NAT, the public address is not local: a packet
// sent to it would leave this network namespace and come back re-sourced (or
// not at all), and the relay's per-peer-address permission would never match.
// As the SFU is in this same process, the relay then translates instead; see
// translatingPacketConn.
type relayAddresses struct {
	relayIP  net.IP
	publicIP net.IP
}

// translates reports whether peer addresses need rewriting between the public
// address browsers use and the local one the SFU's sockets are bound to.
func (a relayAddresses) translates() bool {
	return a.publicIP != nil && !a.publicIP.Equal(a.relayIP)
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
		relayIP := net.ParseIP(cfg.TURNServerRelayIP)
		if relayIP == nil || relayIP.To4() == nil {
			return relayAddresses{}, fmt.Errorf("TURN_SERVER_RELAY_IP must be a valid IPv4 address")
		}
		addresses.relayIP = relayIP.To4()
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
	return addresses, nil
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
}

func (g *relayAddressGenerator) Validate() error {
	if g.addresses.relayIP == nil || g.addresses.relayIP.To4() == nil {
		return errIPv4RelayOnly
	}
	if g.portMin < 1 || g.portMax > 65535 || g.portMin > g.portMax {
		return errRelayRangeInvalid
	}
	return nil
}

// AllocatePacketConn binds a relay socket. It starts at a random port and
// walks the whole range, so an allocation fails only when every port is taken.
func (g *relayAddressGenerator) AllocatePacketConn(conf turn.AllocateListenerConfig) (net.PacketConn, net.Addr, error) {
	if conf.Network != "udp4" {
		return nil, nil, errIPv4RelayOnly
	}
	if conf.RequestedPort != 0 {
		if conf.RequestedPort < g.portMin || conf.RequestedPort > g.portMax {
			return nil, nil, errRelayPortOutOfRange
		}
		return g.listen(conf.RequestedPort)
	}
	span := g.portMax - g.portMin + 1
	first := rand.IntN(span)
	var lastErr error
	for offset := range span {
		conn, address, err := g.listen(g.portMin + (first+offset)%span)
		if err == nil {
			return conn, address, nil
		}
		lastErr = err
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
	relayAddress := &net.UDPAddr{IP: g.addresses.relayIP, Port: port}
	if !g.addresses.translates() {
		return conn, relayAddress, nil
	}
	return &translatingPacketConn{
		PacketConn: conn,
		addresses:  g.addresses,
		portMin:    g.portMin,
		portMax:    g.portMax,
	}, relayAddress, nil
}

// translatingPacketConn is a relay socket on a host whose public address is
// not local. Browsers address the SFU by that public address, while the SFU's
// sockets are bound to the local one, so it rewrites the peer address in both
// directions and the relay-to-SFU leg stays inside this network namespace:
//
//   - a datagram for publicIP:port is sent to relayIP:port;
//   - a datagram from relayIP:port is reported as coming from publicIP:port,
//     the address the browser created its TURN permission for.
//
// Datagrams from another relay socket (a source port inside the relay range)
// keep their address: those peers are advertised by relayIP already.
type translatingPacketConn struct {
	net.PacketConn
	addresses relayAddresses
	portMin   int
	portMax   int
}

func (c *translatingPacketConn) ReadFrom(buffer []byte) (int, net.Addr, error) {
	n, source, err := c.PacketConn.ReadFrom(buffer)
	if err != nil {
		return n, source, err
	}
	// The address is allocated per read by the net package, so it is ours to
	// rewrite in place.
	if udp, ok := source.(*net.UDPAddr); ok && udp.IP.Equal(c.addresses.relayIP) &&
		(udp.Port < c.portMin || udp.Port > c.portMax) {
		udp.IP = c.addresses.publicIP
	}
	return n, source, nil
}

func (c *translatingPacketConn) WriteTo(payload []byte, destination net.Addr) (int, error) {
	if udp, ok := destination.(*net.UDPAddr); ok && udp.IP.Equal(c.addresses.publicIP) {
		destination = &net.UDPAddr{IP: c.addresses.relayIP, Port: udp.Port}
	}
	return c.PacketConn.WriteTo(payload, destination)
}
