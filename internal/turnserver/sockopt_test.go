package turnserver

import (
	"bytes"
	"log/slog"
	"net"
	"runtime"
	"strings"
	"testing"
)

func TestUDPListenersNeverGetASmallerReadBuffer(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("the receive buffer size is read back on Linux only")
	}
	plain, err := net.ListenUDP("udp4", &net.UDPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		t.Fatal(err)
	}
	defer plain.Close()
	untuned := udpReadBufferSize(plain)
	if untuned <= 0 {
		t.Fatalf("udpReadBufferSize() = %d for a fresh socket", untuned)
	}

	var logs bytes.Buffer
	cfg := testConfig(t, 4)
	server, err := start(cfg, slog.New(slog.NewTextHandler(&logs, nil)), "127.0.0.1")
	if err != nil {
		t.Fatalf("start relay: %v", err)
	}
	defer server.Close()
	for _, conn := range server.udp {
		// How much the kernel grants depends on net.core.rmem_max, so the
		// one thing that holds on every host is that asking did no harm.
		if tuned := udpReadBufferSize(conn.(*net.UDPConn)); tuned < untuned {
			t.Fatalf("listen socket %s has a %d-byte receive buffer, smaller than the default %d",
				conn.LocalAddr(), tuned, untuned)
		}
	}
	if !strings.Contains(logs.String(), "udp_read_buffer=") {
		t.Fatalf("the startup log does not say which receive buffer the listeners got:\n%s", logs.String())
	}
}

func TestRaiseUDPReadBufferIgnoresOtherConnections(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	var notUDP net.PacketConn = pipePacketConn{server}
	if got := raiseUDPReadBuffer(notUDP); got != 0 {
		t.Fatalf("raiseUDPReadBuffer() = %d for a connection that is not a UDP socket, want 0", got)
	}
}

// pipePacketConn is a net.PacketConn that is not a *net.UDPConn.
type pipePacketConn struct{ net.Conn }

func (pipePacketConn) ReadFrom([]byte) (int, net.Addr, error) { return 0, nil, net.ErrClosed }
func (pipePacketConn) WriteTo([]byte, net.Addr) (int, error)  { return 0, net.ErrClosed }
