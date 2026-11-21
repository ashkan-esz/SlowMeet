//go:build linux

package signaling

import (
	"context"
	"net"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// stallBufferBytes is the SO_SNDBUF / SO_RCVBUF asked for on each side of the
// stalled connection (Linux doubles it and enforces a floor of about 4.5 KiB).
// Setting it also turns off buffer autotuning, which on loopback would
// otherwise grow the hub's send buffer to megabytes before a write blocks.
const stallBufferBytes = 4096

func setSocketBuffer(option int) func(network, address string, raw syscall.RawConn) error {
	return func(_, _ string, raw syscall.RawConn) error {
		var setErr error
		if err := raw.Control(func(fd uintptr) {
			setErr = syscall.SetsockoptInt(int(fd), syscall.SOL_SOCKET, option, stallBufferBytes)
		}); err != nil {
			return err
		}
		return setErr
	}
}

// A participant whose TCP connection stays open but who stops reading (a
// frozen tab, a radio that keeps ACKing nothing) must not hold its seat until
// the 60 s pong timeout. Once the kernel buffers fill, the hub's next frame
// write blocks, the per-frame write deadline fires, and the hub drops the
// socket like any other disconnect: the other three see the peer leave and
// the seat is held for a token resume.
//
// Accepted sockets inherit the listener's small SO_SNDBUF, and the stalled
// client dials with a small SO_RCVBUF, so a few dozen 2 KB chat frames
// overflow both buffers long before the 512-entry outbound queue fills: the
// eviction comes from the write deadline, not from the queue-full path.
func TestHubStalledPeerIsEvictedByWriteDeadline(t *testing.T) {
	const writeWait = time.Second
	listener, err := (&net.ListenConfig{Control: setSocketBuffer(syscall.SO_SNDBUF)}).Listen(context.Background(), "tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	hub, socketURL := serveFourSeatHub(t, 5*time.Second, listener, func(h *Hub) {
		h.writeWait = writeWait
	})
	healthy := make([]*testParticipant, 0, 3)
	for _, name := range fourNames[:3] {
		healthy = append(healthy, joinTestParticipant(t, socketURL, name, ""))
	}
	waitForRoster(t, healthy)
	marks := make([]int, len(healthy))
	for i, p := range healthy {
		marks[i] = p.mark()
	}

	// Drew reads its join response and nothing after it.
	stallDialer := &websocket.Dialer{
		HandshakeTimeout: 5 * time.Second,
		NetDialContext:   (&net.Dialer{Control: setSocketBuffer(syscall.SO_RCVBUF)}).DialContext,
	}
	stalled, response, err := dialAndJoinWith(stallDialer, socketURL, fourNames[3], "")
	if err != nil {
		t.Fatalf("join %s: %v", fourNames[3], err)
	}
	t.Cleanup(func() { stalled.conn.Close() })
	if response.Type != TypeParticipant || stalled.id == "" || stalled.token == "" {
		t.Fatalf("join %s response = %+v", fourNames[3], response)
	}
	for i, p := range healthy {
		waitWithin(t, 3*time.Second, p.name+" sees the stalled peer join", func() bool {
			return countOf(p.participantEvents(TypeJoined, marks[i]), stalled.id) == 1
		})
	}

	// Each healthy participant sends its full chat burst: 30 frames of about
	// 2 KB, far beyond the stalled connection's combined buffers.
	text := strings.Repeat("\U0001F600", 500)
	floodStart := time.Now()
	for i := 0; i < chatBurstLimit; i++ {
		for _, p := range healthy {
			if err := p.conn.WriteJSON(Message{Version: ProtocolVersion, Type: TypeChat, ParticipantID: p.id, ChatText: text}); err != nil {
				t.Fatalf("%s chat: %v", p.name, err)
			}
		}
	}
	for i, p := range healthy {
		waitWithin(t, writeWait+3*time.Second, p.name+" sees the stalled peer leave", func() bool {
			return countOf(p.participantEvents(TypeLeft, marks[i]), stalled.id) == 1
		})
	}
	evictedAfter := time.Since(floodStart)
	if evictedAfter < writeWait-100*time.Millisecond {
		t.Fatalf("stalled peer left after %s, before the %s write deadline could fire", evictedAfter, writeWait)
	}
	if evictedAfter > writeWait+2*time.Second {
		t.Fatalf("stalled peer left after %s, long after the %s write deadline", evictedAfter, writeWait)
	}
	for i, p := range healthy {
		for _, other := range healthy {
			if left := countOf(p.participantEvents(TypeLeft, marks[i]), other.id); left != 0 {
				t.Fatalf("%s saw healthy %s leave %d times", p.name, other.name, left)
			}
		}
	}

	// The seat is held for the grace window and the token still resumes it.
	if got := pendingCount(hub); got != 1 {
		t.Fatalf("pending reconnects = %d, want the stalled seat held", got)
	}
	expectRoomFull(t, socketURL)
	stalled.conn.Close()
	back := joinTestParticipant(t, socketURL, stalled.name, stalled.token)
	if back.id != stalled.id {
		t.Fatalf("resumed id = %q, want %q", back.id, stalled.id)
	}
}
