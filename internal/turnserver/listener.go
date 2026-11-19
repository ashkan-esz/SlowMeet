package turnserver

import (
	"context"
	"crypto/tls"
	"errors"
	"log/slog"
	"net"
	"sync"
	"time"
)

// tlsHandshakeTimeout bounds a TURN-over-TLS handshake. It is the limit the
// TURN library applies itself.
const tlsHandshakeTimeout = 10 * time.Second

// retryListener keeps a stream listener accepting after a transient failure.
// The TURN library's accept loop ends on the first Accept error, which would
// leave TURN over TCP or TLS dead until the process restarts because the host
// was, say, out of file descriptors for a moment. Accept here only returns an
// error once the listener is closed.
type retryListener struct {
	net.Listener
	name   string
	logger *slog.Logger
}

func (l *retryListener) Accept() (net.Conn, error) {
	delay := 5 * time.Millisecond
	for {
		conn, err := l.Listener.Accept()
		if err == nil {
			return conn, nil
		}
		if errors.Is(err, net.ErrClosed) {
			return nil, err
		}
		l.logger.Warn("turn_server_accept_failed",
			"listener", l.name, "error", err.Error(), "retry_in", delay.String())
		time.Sleep(delay)
		delay = min(2*delay, time.Second)
	}
}

// tlsListener accepts TURN-over-TLS connections and returns them with the
// handshake already done.
//
// The TURN library performs the handshake itself, but when it fails it returns
// without closing the connection. The connection limit under this listener
// frees a slot only when a connection is closed, so every failed handshake
// (scanners on the port, aborted clients, any attempt while the certificate is
// missing) would hold one for good, until none are left and TURN over TLS
// stops accepting. Handshakes therefore run here, each in its own goroutine so
// a slow client cannot hold up the others, and a failed one closes its
// connection. The library still receives a *tls.Conn; its own handshake call
// returns at once.
type tlsListener struct {
	inner   net.Listener
	config  *tls.Config
	timeout time.Duration
	logger  *slog.Logger

	ready     chan net.Conn
	done      chan struct{}
	closeOnce sync.Once
}

// newTLSListener starts accepting from inner, which is expected to bound the
// number of open connections and so the number of handshakes in progress.
func newTLSListener(inner net.Listener, config *tls.Config, timeout time.Duration, logger *slog.Logger) *tlsListener {
	listener := &tlsListener{
		inner:   inner,
		config:  config,
		timeout: timeout,
		logger:  logger,
		ready:   make(chan net.Conn),
		done:    make(chan struct{}),
	}
	go listener.acceptLoop()
	return listener
}

func (l *tlsListener) acceptLoop() {
	for {
		conn, err := l.inner.Accept()
		if err != nil {
			l.shutdown()
			return
		}
		go l.handshake(conn)
	}
}

func (l *tlsListener) handshake(conn net.Conn) {
	secured := tls.Server(conn, l.config)
	ctx, cancel := context.WithTimeout(context.Background(), l.timeout)
	defer cancel()
	if err := secured.HandshakeContext(ctx); err != nil {
		l.logger.Debug("turn_server_tls_handshake_failed",
			"remote", conn.RemoteAddr().String(), "error", err.Error())
		_ = secured.Close()
		return
	}
	select {
	case l.ready <- secured:
	case <-l.done:
		_ = secured.Close()
	}
}

func (l *tlsListener) shutdown() {
	l.closeOnce.Do(func() { close(l.done) })
}

func (l *tlsListener) Accept() (net.Conn, error) {
	select {
	case conn := <-l.ready:
		return conn, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *tlsListener) Close() error {
	l.shutdown()
	return l.inner.Close()
}

func (l *tlsListener) Addr() net.Addr {
	return l.inner.Addr()
}
