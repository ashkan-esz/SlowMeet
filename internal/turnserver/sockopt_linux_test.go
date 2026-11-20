//go:build linux

package turnserver

import (
	"net"
	"reflect"
	"syscall"
	"testing"
	"time"
)

// userTimeout reads TCP_USER_TIMEOUT from a TCP connection.
func userTimeout(t *testing.T, conn net.Conn) time.Duration {
	t.Helper()
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		t.Fatalf("connection is %T, want *net.TCPConn", conn)
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		t.Fatal(err)
	}
	var (
		milliseconds int
		optionErr    error
	)
	if err := raw.Control(func(fd uintptr) {
		milliseconds, optionErr = syscall.GetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout)
	}); err != nil {
		t.Fatal(err)
	}
	if optionErr != nil {
		t.Fatalf("read TCP_USER_TIMEOUT: %v", optionErr)
	}
	return time.Duration(milliseconds) * time.Millisecond
}

// tcpConnUnder returns the TCP connection inside the wrappers a listener put
// around it. The connection limit's wrapper is an unexported struct that
// embeds the net.Conn it counts, which is what this follows.
func tcpConnUnder(t *testing.T, conn net.Conn) *net.TCPConn {
	t.Helper()
	for range 8 {
		if tcp, ok := conn.(*net.TCPConn); ok {
			return tcp
		}
		value := reflect.ValueOf(conn)
		if value.Kind() == reflect.Pointer {
			value = value.Elem()
		}
		if value.Kind() != reflect.Struct {
			break
		}
		field := value.FieldByName("Conn")
		if !field.IsValid() || !field.CanInterface() {
			break
		}
		inner, ok := field.Interface().(net.Conn)
		if !ok {
			break
		}
		conn = inner
	}
	t.Fatalf("no TCP connection found under %T", conn)
	return nil
}

func TestAcceptedStreamConnectionsGiveUpOnAVanishedClient(t *testing.T) {
	listener, err := listenStream("127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialTimeout("tcp", listener.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	accepted, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer accepted.Close()
	if got := userTimeout(t, accepted); got != streamUserTimeout {
		t.Fatalf("an accepted connection gives up on unacknowledged data after %s, want %s", got, streamUserTimeout)
	}
	// The dialing side has the kernel's default, which is no limit: the
	// option comes from the listener and nowhere else.
	if got := userTimeout(t, client); got != 0 {
		t.Fatalf("a plain connection has a user timeout of %s, want none", got)
	}
}

func TestRelayStreamConnectionsCarryTheUserTimeout(t *testing.T) {
	// The same, for the connections a running relay holds: under the
	// connection limit, the registry and, for TLS, the handshake.
	cfg := withTLSListener(t, testConfig(t, 4))
	server := startRelay(t, cfg)
	for transport, conns := range map[string]*streamConns{"tcp": server.tcpConns, "tls": server.tlsConns} {
		dialStream(t, server, transport)
		eventually(t, "the "+transport+" connection is registered", func() bool { return conns.count() == 1 })
		conns.mu.Lock()
		var tracked *streamConn
		for conn := range conns.open {
			tracked = conn
		}
		conns.mu.Unlock()
		if got := userTimeout(t, tcpConnUnder(t, tracked.Conn)); got != streamUserTimeout {
			t.Errorf("a TURN-over-%s connection has a user timeout of %s, want %s", transport, got, streamUserTimeout)
		}
	}
}

func TestSetStreamUserTimeoutLeavesOtherConnectionsAlone(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	if err := setStreamUserTimeout(server, streamUserTimeout); err != nil {
		t.Fatalf("setStreamUserTimeout() error = %v for a connection that is not a TCP socket", err)
	}
}
