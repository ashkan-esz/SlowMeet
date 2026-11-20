package turnserver

import (
	"bytes"
	"crypto/tls"
	"errors"
	"io"
	"log/slog"
	"net"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"SlowMeet/internal/config"
)

// flakyListener fails Accept a number of times before handing out
// connections, the way a host briefly out of file descriptors does.
type flakyListener struct {
	net.Listener
	mu       sync.Mutex
	failures int
}

func (l *flakyListener) Accept() (net.Conn, error) {
	l.mu.Lock()
	fail := l.failures > 0
	if fail {
		l.failures--
	}
	l.mu.Unlock()
	if fail {
		return nil, &net.OpError{Op: "accept", Net: "tcp", Err: syscall.EMFILE}
	}
	return l.Listener.Accept()
}

func TestRetryListenerKeepsAcceptingAfterATransientError(t *testing.T) {
	inner, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	var logs bytes.Buffer
	listener := &retryListener{
		Listener: &flakyListener{Listener: inner, failures: 3},
		name:     "tcp",
		logger:   slog.New(slog.NewTextHandler(&logs, nil)),
	}
	defer listener.Close()

	client, err := net.DialTimeout("tcp4", inner.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	accepted := make(chan error, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			_ = conn.Close()
		}
		accepted <- err
	}()
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatalf("Accept() returned %v after transient failures, want a connection", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Accept() did not recover from transient failures")
	}
	if got := strings.Count(logs.String(), "turn_server_accept_failed"); got != 3 {
		t.Fatalf("logged %d accept failures, want 3:\n%s", got, logs.String())
	}

	// Closing is the one error Accept reports.
	closed := make(chan error, 1)
	go func() {
		_, err := listener.Accept()
		closed <- err
	}()
	time.Sleep(50 * time.Millisecond)
	_ = listener.Close()
	select {
	case err := <-closed:
		if !errors.Is(err, net.ErrClosed) {
			t.Fatalf("Accept() after Close = %v, want net.ErrClosed", err)
		}
	case <-time.After(testTimeout):
		t.Fatal("Accept() did not return after Close")
	}
}

func TestTLSListenerClosesAClientThatNeverHandshakes(t *testing.T) {
	inner, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	certFile, keyFile := writeCertificate(t, t.TempDir(), "relay.test")
	certificates := newCertReloader(certFile, keyFile, quietLogger())
	listener := newTLSListener(inner, &tls.Config{GetCertificate: certificates.GetCertificate},
		200*time.Millisecond, quietLogger())
	defer listener.Close()

	// Connected and silent: closed once the handshake time is up.
	silent, err := net.DialTimeout("tcp4", inner.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer silent.Close()
	if err := silent.SetReadDeadline(time.Now().Add(testTimeout)); err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if _, err := io.Copy(io.Discard, silent); err != nil {
		t.Fatalf("a client that never handshakes was not closed: %v", err)
	}
	if waited := time.Since(started); waited < 150*time.Millisecond {
		t.Fatalf("the silent client was closed after %v, before the handshake timeout", waited)
	}

	// A proper client meanwhile gets a connection whose handshake is done.
	accepted := make(chan net.Conn, 1)
	go func() {
		conn, err := listener.Accept()
		if err == nil {
			accepted <- conn
		}
	}()
	client, err := tls.DialWithDialer(&net.Dialer{Timeout: testTimeout}, "tcp4", inner.Addr().String(),
		&tls.Config{InsecureSkipVerify: true})
	if err != nil {
		t.Fatalf("TLS client: %v", err)
	}
	defer client.Close()
	select {
	case conn := <-accepted:
		defer conn.Close()
		framed, ok := conn.(*framedConn)
		if !ok {
			t.Fatalf("Accept() returned %T, want a connection that frames TURN", conn)
		}
		secured, ok := framed.Conn.(*tls.Conn)
		if !ok || !secured.ConnectionState().HandshakeComplete {
			t.Fatalf("the framed connection is %T, want a *tls.Conn with its handshake complete", framed.Conn)
		}
	case <-time.After(testTimeout):
		t.Fatal("Accept() did not return the connection whose handshake succeeded")
	}

	// After Close, Accept reports it and pending handshakes are dropped.
	_ = listener.Close()
	if _, err := listener.Accept(); !errors.Is(err, net.ErrClosed) {
		t.Fatalf("Accept() after Close = %v, want net.ErrClosed", err)
	}
}

func TestStartWarnsWhenTheSFUPortRangeIsUnknown(t *testing.T) {
	started := func(cfg config.Config) string {
		var logs bytes.Buffer
		server, err := start(cfg, slog.New(slog.NewTextHandler(&logs, nil)), "127.0.0.1")
		if err != nil {
			t.Fatalf("start relay: %v", err)
		}
		_ = server.Close()
		return logs.String()
	}

	unrestricted := testConfig(t, 4)
	unrestricted.ICEUDPPortMin, unrestricted.ICEUDPPortMax = 0, 0
	if logs := started(unrestricted); !strings.Contains(logs, "turn_server_any_peer_port") ||
		!strings.Contains(logs, "sfu_ports=any") {
		t.Fatalf("no warning that the relay forwards to any port:\n%s", logs)
	}

	restricted := testConfig(t, 4)
	restricted.ICEUDPPortMin, restricted.ICEUDPPortMax = freeRelayRange(t, 4)
	if logs := started(restricted); strings.Contains(logs, "turn_server_any_peer_port") {
		t.Fatalf("warned although the SFU's ports are known:\n%s", logs)
	}
}

func TestFailedTLSHandshakesDoNotUseUpTheConnectionLimit(t *testing.T) {
	// The TLS port faces the internet: scanners and aborted clients fail
	// handshakes all day. Each failure must give its connection slot back, or
	// TURN over TLS stops accepting once the limit's worth have failed.
	cfg := testConfig(t, 4)
	cfg.TURNServerTLSPort = freeTCPPort(t)
	cfg.TURNServerTLSCertFile, cfg.TURNServerTLSKeyFile = writeCertificate(t, t.TempDir(), "relay.test")
	server, err := startWith(cfg, quietLogger(), startOptions{listenHost: "127.0.0.1", streamClients: 2})
	if err != nil {
		t.Fatalf("start relay: %v", err)
	}
	defer server.Close()

	for attempt := range 5 {
		conn, err := net.DialTimeout("tcp", server.tls.Addr().String(), testTimeout)
		if err != nil {
			t.Fatalf("attempt %d: connect: %v", attempt, err)
		}
		if _, err := conn.Write([]byte("GET / HTTP/1.0\r\n\r\n")); err != nil {
			t.Fatalf("attempt %d: write: %v", attempt, err)
		}
		// The relay answers with a TLS alert at most, then closes.
		if err := conn.SetReadDeadline(time.Now().Add(testTimeout)); err != nil {
			t.Fatal(err)
		}
		if _, err := io.Copy(io.Discard, conn); err != nil {
			t.Fatalf("attempt %d: the relay kept a connection whose handshake failed: %v", attempt, err)
		}
		_ = conn.Close()
	}

	username, password := browserCredentials(t, cfg)
	relay, err := newTURNClient(t, server, "tls", username, password).Allocate()
	if err != nil {
		t.Fatalf("allocate over TLS after failed handshakes: %v", err)
	}
	_ = relay.Close()
}

func TestCloseDisconnectsStreamClients(t *testing.T) {
	// The TURN library closes its listeners, not the connections they
	// accepted. Without the relay closing those itself, a client that never
	// allocated would stay connected to a relay that no longer serves it.
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	client, err := net.DialTimeout("tcp", server.tcp.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if !stunBinding(t, client, testTimeout) {
		t.Fatal("the client was not served")
	}
	if err := server.Close(); err != nil {
		t.Fatalf("Close() error = %v", err)
	}
	_ = client.SetReadDeadline(time.Now().Add(testTimeout))
	_, err = client.Read(make([]byte, 1))
	var timeout net.Error
	if err == nil || (errors.As(err, &timeout) && timeout.Timeout()) {
		t.Fatalf("the relay kept a TURN-over-TCP client connected after Close: %v", err)
	}
	if got := server.Stats().TCPConnections; got != 0 {
		t.Fatalf("Stats().TCPConnections = %d after Close, want 0", got)
	}
}
