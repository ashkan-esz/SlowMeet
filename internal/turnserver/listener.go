package turnserver

import (
	"bufio"
	"context"
	"crypto/tls"
	"encoding/binary"
	"errors"
	"io"
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

// streamConns are the connections one stream listener (TURN over TCP or TURN
// over TLS) holds open: everything it accepted and has not closed yet, which
// for TLS includes connections still in their handshake. These are the
// connections the listener's limit counts, so the set shows how close the
// listener is to it, and it is what Server.Close closes: the TURN library
// closes only its listeners and would keep serving connected clients.
//
// A nil *streamConns is a listener that does not run.
type streamConns struct {
	transport string
	limit     int
	logger    *slog.Logger
	// atLimit keeps the warning about a full listener from repeating with
	// every connection accepted while it stays full.
	atLimit warningGate

	mu     sync.Mutex
	open   map[*streamConn]struct{}
	closed bool
}

func newStreamConns(transport string, limit int, logger *slog.Logger) *streamConns {
	return &streamConns{
		transport: transport,
		limit:     limit,
		logger:    logger,
		open:      map[*streamConn]struct{}{},
	}
}

// add registers an accepted connection and returns it wrapped, so that closing
// it takes it off the set. After closeAll it closes the connection instead and
// reports false.
func (s *streamConns) add(conn net.Conn) (net.Conn, bool) {
	tracked := &streamConn{Conn: conn, conns: s}
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		_ = conn.Close()
		return nil, false
	}
	s.open[tracked] = struct{}{}
	count := len(s.open)
	s.mu.Unlock()
	if count >= s.limit && s.atLimit.open(time.Now()) {
		s.logger.Warn("turn_server_connection_limit_reached",
			"transport", s.transport, "limit", s.limit,
			"hint", "new TURN connections over this transport wait until one closes")
	}
	return tracked, true
}

func (s *streamConns) remove(conn *streamConn) {
	s.mu.Lock()
	delete(s.open, conn)
	s.mu.Unlock()
}

// count returns the number of open connections.
func (s *streamConns) count() int {
	if s == nil {
		return 0
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.open)
}

// closeAll closes every open connection and makes add refuse later ones.
func (s *streamConns) closeAll() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.closed = true
	open := make([]*streamConn, 0, len(s.open))
	for conn := range s.open {
		open = append(open, conn)
	}
	s.mu.Unlock()
	for _, conn := range open {
		_ = conn.Close()
	}
}

// streamConn is a connection registered in a streamConns until it is closed.
type streamConn struct {
	net.Conn
	conns *streamConns
}

func (c *streamConn) Close() error {
	c.conns.remove(c)
	return c.Conn.Close()
}

// streamListener registers every connection it accepts in conns. With framed
// set it also returns them as framedConn: that is TURN over TCP, where TURN
// frames start with the first byte. Under TLS the frames are inside the TLS
// stream, so tlsListener frames those connections after the handshake.
type streamListener struct {
	net.Listener
	conns  *streamConns
	framed bool
}

func (l *streamListener) Accept() (net.Conn, error) {
	conn, err := l.Listener.Accept()
	if err != nil {
		return nil, err
	}
	tracked, ok := l.conns.add(conn)
	if !ok {
		// The relay is closing; add closed the connection.
		return nil, net.ErrClosed
	}
	if l.framed {
		return newFramedConn(tracked), nil
	}
	return tracked, nil
}

const (
	// turnFrameLimit is the frame size from which the TURN library drops a
	// frame instead of handling it (its inbound MTU).
	turnFrameLimit = 1600
	// turnFrameHeaderSize is what both kinds of frame start with: two bytes of
	// message type or channel number, then a two-byte length.
	turnFrameHeaderSize = 4
	stunHeaderSize      = 20
	// stunMagicCookie follows the first four bytes of every STUN message.
	stunMagicCookie = 0x2112A442
	stunCookieEnd   = turnFrameHeaderSize + 4
	// framedReadSize is how much a framedConn reads from its connection at a
	// time: enough for a frame of any size it passes on.
	framedReadSize = 2048
)

var errNotATURNFrame = errors.New("stream data is neither a STUN message nor TURN ChannelData")

// framedConn splits a TURN stream connection (TURN over TCP or TLS) into
// frames, so that the TURN library reads whole frames of a bounded size only.
//
// The library frames a stream itself, in a way any client can turn against
// the process, without credentials. It adds a frame's length to the header
// size in 16 bits, so a length near 65535 wraps around to a frame of no bytes
// that is never consumed, and the connection's read loop spins for good. And
// it reads a frame recursively, once more for every chunk that arrives, so a
// large frame sent a byte at a time costs megabytes of stack per connection.
// Handed one whole frame per Read, each smaller than what it would drop
// anyway, it does neither.
//
// A frame is a STUN message (first byte 0x00-0x3F; a 20-byte header whose
// bytes 2-3 give the length of what follows it, and the magic cookie in bytes
// 4-7) or ChannelData (first byte 0x40-0x7F; a 4-byte header whose bytes 2-3
// give the length of the data, which is padded to a multiple of four).
// Anything else is an error, on which the library closes the connection. So
// is ChannelData whose data starts with the magic cookie: the library tells
// the two kinds apart by the cookie alone, would measure such a frame as a
// STUN message and lose track of where frames begin. Nothing a browser sends
// through a relay starts with those bytes.
//
// A frame of turnFrameLimit bytes or more is read past without being stored,
// and Read goes on with the frame after it.
type framedConn struct {
	net.Conn
	reader *bufio.Reader
	// frame is where every frame is assembled. pending is the part of the
	// current one Read has not returned yet.
	frame   [turnFrameLimit]byte
	pending []byte
}

func newFramedConn(conn net.Conn) *framedConn {
	return &framedConn{Conn: conn, reader: bufio.NewReaderSize(conn, framedReadSize)}
}

// Read returns one whole frame, or as much of it as buffer holds; the rest
// then comes with the next calls.
func (c *framedConn) Read(buffer []byte) (int, error) {
	if len(buffer) == 0 {
		return 0, nil
	}
	if len(c.pending) == 0 {
		if err := c.readFrame(); err != nil {
			return 0, err
		}
	}
	n := copy(buffer, c.pending)
	c.pending = c.pending[n:]
	return n, nil
}

// readFrame reads the next frame the TURN library can handle into c.pending.
func (c *framedConn) readFrame() error {
	for {
		header := c.frame[:turnFrameHeaderSize]
		if _, err := io.ReadFull(c.reader, header); err != nil {
			return err
		}
		length := int(binary.BigEndian.Uint16(header[2:]))
		stunMessage := header[0] < 0x40
		var size int
		switch {
		case stunMessage:
			size = stunHeaderSize + length
		case header[0] < 0x80:
			size = turnFrameHeaderSize + (length+3)&^3
		default:
			return errNotATURNFrame
		}
		read := turnFrameHeaderSize
		if size >= stunCookieEnd {
			// The cookie decides before the rest of the frame is waited for.
			cookie := c.frame[turnFrameHeaderSize:stunCookieEnd]
			if _, err := io.ReadFull(c.reader, cookie); err != nil {
				return err
			}
			read = stunCookieEnd
			if hasCookie := binary.BigEndian.Uint32(cookie) == stunMagicCookie; hasCookie != stunMessage {
				return errNotATURNFrame
			}
		}
		if size >= turnFrameLimit {
			if _, err := io.CopyN(io.Discard, c.reader, int64(size-read)); err != nil {
				return err
			}
			continue
		}
		if _, err := io.ReadFull(c.reader, c.frame[read:size]); err != nil {
			return err
		}
		c.pending = c.frame[:size]
		return nil
	}
}

// tlsListener accepts TURN-over-TLS connections and returns them with the
// handshake already done, as framedConn.
//
// The TURN library performs the handshake itself, but when it fails it returns
// without closing the connection. The connection limit under this listener
// frees a slot only when a connection is closed, so every failed handshake
// (scanners on the port, aborted clients, any attempt while the certificate is
// missing) would hold one for good, until none are left and TURN over TLS
// stops accepting. Handshakes therefore run here, each in its own goroutine so
// a slow client cannot hold up the others, and a failed one closes its
// connection. The library does not handshake again: what it receives is not a
// *tls.Conn, and it would only have done so to read a client certificate,
// which the relay does not ask for.
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
	case l.ready <- newFramedConn(secured):
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
