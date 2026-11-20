package signaling

import (
	"fmt"
	"log/slog"
	"net"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	pion "github.com/pion/webrtc/v4"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
)

// knownFailing skips the calling (sub)test unless SLOWMEET_KNOWN_FAILING=1.
// It marks an assertion that pins a documented defect (see "Known issues
// pinned by tests" in docs/network-testing.md): the test stays in the tree,
// make check stays green, and the defect is re-checked on demand. Delete the
// call once the defect is fixed.
func knownFailing(t *testing.T, reason string) {
	t.Helper()
	if os.Getenv("SLOWMEET_KNOWN_FAILING") != "1" {
		t.Skipf("known failing (SLOWMEET_KNOWN_FAILING=1 to run): %s", reason)
	}
}

// newFourSeatHub serves a hub sized for a four-person meeting. configure runs
// before the server starts, so it may shorten the hub's timings.
func newFourSeatHub(t *testing.T, reconnectTimeout time.Duration, configure ...func(*Hub)) (*Hub, string) {
	t.Helper()
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 4, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: reconnectTimeout, RetainChatHistory: true,
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	for _, apply := range configure {
		apply(hub)
	}
	server := httptest.NewServer(hub)
	t.Cleanup(func() {
		hub.Close()
		server.Close()
	})
	return hub, "ws" + server.URL[len("http"):]
}

// testParticipant is one browser stand-in. After pump starts, a goroutine
// reads every message into events; reading is also what makes gorilla answer
// the hub's pings, so an unpumped socket is a silent one.
type testParticipant struct {
	name   string
	conn   *websocket.Conn
	id     string
	token  string
	mu     sync.Mutex
	events []Message
	closed chan struct{}
}

// dialAndJoin joins name (resuming token when set) and reads the join
// response. It returns errors instead of failing so goroutines may call it.
func dialAndJoin(socketURL, name, token string) (*testParticipant, Message, error) {
	conn, _, err := websocket.DefaultDialer.Dial(socketURL, nil)
	if err != nil {
		return nil, Message{}, err
	}
	if err := conn.WriteJSON(Message{Version: ProtocolVersion, Type: TypeJoin, Name: name, ReconnectToken: token}); err != nil {
		conn.Close()
		return nil, Message{}, err
	}
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		conn.Close()
		return nil, Message{}, err
	}
	var response Message
	if err := conn.ReadJSON(&response); err != nil {
		conn.Close()
		return nil, Message{}, err
	}
	p := &testParticipant{name: name, conn: conn, closed: make(chan struct{})}
	if response.Type == TypeParticipant && response.Participant != nil {
		p.id = response.Participant.ID
		p.token = response.ReconnectToken
	}
	return p, response, nil
}

func (p *testParticipant) pump() {
	_ = p.conn.SetReadDeadline(time.Time{})
	go func() {
		defer close(p.closed)
		for {
			var msg Message
			if err := p.conn.ReadJSON(&msg); err != nil {
				return
			}
			p.mu.Lock()
			p.events = append(p.events, msg)
			p.mu.Unlock()
		}
	}()
}

// joinTestParticipant joins, starts the pump and closes the socket when the
// test ends.
func joinTestParticipant(t *testing.T, socketURL, name, token string) *testParticipant {
	t.Helper()
	p, response, err := dialAndJoin(socketURL, name, token)
	if err != nil {
		t.Fatalf("join %s: %v", name, err)
	}
	if response.Type != TypeParticipant || p.id == "" || p.token == "" {
		p.conn.Close()
		t.Fatalf("join %s response = %+v", name, response)
	}
	p.pump()
	t.Cleanup(func() {
		p.conn.Close()
		<-p.closed
	})
	return p
}

// joinSilentParticipant joins but never reads again, so it never answers a
// ping: its TCP connection stays open while it goes quiet.
func joinSilentParticipant(t *testing.T, socketURL, name string) *testParticipant {
	t.Helper()
	p, response, err := dialAndJoin(socketURL, name, "")
	if err != nil {
		t.Fatalf("join %s: %v", name, err)
	}
	if response.Type != TypeParticipant || p.id == "" || p.token == "" {
		p.conn.Close()
		t.Fatalf("join %s response = %+v", name, response)
	}
	close(p.closed)
	t.Cleanup(func() { p.conn.Close() })
	return p
}

// reset drops the socket the way a crashed client or a dead radio does: a
// TCP reset, no WebSocket close handshake.
func (p *testParticipant) reset() {
	if tcp, ok := p.conn.UnderlyingConn().(*net.TCPConn); ok {
		_ = tcp.SetLinger(0)
	}
	p.conn.Close()
}

func (p *testParticipant) mark() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return len(p.events)
}

// participantEvents returns the participant IDs of every msgType event
// received after mark.
func (p *testParticipant) participantEvents(msgType string, mark int) []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var ids []string
	for _, msg := range p.events[mark:] {
		if msg.Type == msgType && msg.Participant != nil {
			ids = append(ids, msg.Participant.ID)
		}
	}
	return ids
}

func countOf(ids []string, id string) int {
	n := 0
	for _, candidate := range ids {
		if candidate == id {
			n++
		}
	}
	return n
}

func waitWithin(t *testing.T, timeout time.Duration, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s within %s", description, timeout)
}

func pendingCount(hub *Hub) int {
	hub.mu.RLock()
	defer hub.mu.RUnlock()
	return len(hub.pending)
}

var fourNames = []string{"Avery", "Blake", "Casey", "Drew"}

// waitForRoster waits until every participant has seen each later joiner
// announced exactly once.
func waitForRoster(t *testing.T, room []*testParticipant) {
	t.Helper()
	for i, p := range room {
		if p.mark() < 0 {
			continue
		}
		for _, later := range room[i+1:] {
			waitWithin(t, 3*time.Second, fmt.Sprintf("%s sees %s join", p.name, later.name), func() bool {
				return countOf(p.participantEvents(TypeJoined, 0), later.id) == 1
			})
		}
	}
}

func joinFour(t *testing.T, socketURL string) []*testParticipant {
	t.Helper()
	room := make([]*testParticipant, 0, len(fourNames))
	for _, name := range fourNames {
		room = append(room, joinTestParticipant(t, socketURL, name, ""))
	}
	waitForRoster(t, room)
	return room
}

// expectRoomFull checks that a fifth browser is turned away, which proves the
// hub still holds every seat (including those in a reconnect grace window).
func expectRoomFull(t *testing.T, socketURL string) {
	t.Helper()
	extra, response, err := dialAndJoin(socketURL, "Eve", "")
	if err != nil {
		t.Fatalf("fifth join: %v", err)
	}
	extra.conn.Close()
	if response.Type != TypeError {
		t.Fatalf("fifth join response = %+v, want a room-full error", response)
	}
}

func TestNewHubLivenessDefaults(t *testing.T) {
	cfg := config.Config{HTTPAddr: ":8080", MaxParticipants: 4, DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultVideoQuality: "low", DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	defer hub.Close()
	if hub.pongWait != websocketPongWait || hub.pingPeriod != websocketPingPeriod ||
		hub.writeWait != websocketWriteWait || hub.supersededCloseDelay != supersededPeerCloseDelay {
		t.Fatalf("NewHub timings = pong %s ping %s write %s superseded %s, want the package constants",
			hub.pongWait, hub.pingPeriod, hub.writeWait, hub.supersededCloseDelay)
	}
	if hub.pingPeriod >= hub.pongWait {
		t.Fatalf("ping period %s must be shorter than the pong wait %s", hub.pingPeriod, hub.pongWait)
	}
}

// A participant whose link goes silent (no FIN, no RST, no pongs) is noticed
// by the pong deadline alone: the other three see it leave, its seat is held
// for the grace window, and its token reclaims the same identity. With a
// short grace the seat is released instead.
func TestHubSilentPeerIsEvictedAfterPongTimeout(t *testing.T) {
	const pongWait = 600 * time.Millisecond
	for _, tc := range []struct {
		name  string
		grace time.Duration
	}{
		{name: "inside grace window", grace: 5 * time.Second},
		{name: "after grace expiry", grace: 300 * time.Millisecond},
	} {
		t.Run(tc.name, func(t *testing.T) {
			hub, socketURL := newFourSeatHub(t, tc.grace, func(h *Hub) {
				h.pongWait = pongWait
				h.pingPeriod = 100 * time.Millisecond
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
			// Drew reads only its join response; from then on it neither reads
			// nor answers pings, but its TCP connection stays open.
			silentSince := time.Now()
			silent := joinSilentParticipant(t, socketURL, fourNames[3])
			for i, p := range healthy {
				waitWithin(t, 3*time.Second, p.name+" sees the silent peer join", func() bool {
					return countOf(p.participantEvents(TypeJoined, marks[i]), silent.id) == 1
				})
			}
			for i, p := range healthy {
				waitWithin(t, 3*time.Second, p.name+" sees the silent peer leave", func() bool {
					return countOf(p.participantEvents(TypeLeft, marks[i]), silent.id) == 1
				})
			}
			if elapsed := time.Since(silentSince); elapsed < pongWait-200*time.Millisecond {
				t.Fatalf("silent peer evicted after %s, before the %s pong wait", elapsed, pongWait)
			}
			for i, p := range healthy {
				for _, other := range healthy {
					if left := countOf(p.participantEvents(TypeLeft, marks[i]), other.id); left != 0 {
						t.Fatalf("%s saw healthy %s leave %d times", p.name, other.name, left)
					}
				}
			}
			silent.conn.Close()

			if tc.grace > time.Second {
				if got := pendingCount(hub); got != 1 {
					t.Fatalf("pending reconnects = %d, want the silent seat held", got)
				}
				expectRoomFull(t, socketURL)
				for i, p := range healthy {
					marks[i] = p.mark()
				}
				back := joinTestParticipant(t, socketURL, silent.name, silent.token)
				if back.id != silent.id {
					t.Fatalf("reclaimed id = %q, want %q", back.id, silent.id)
				}
				for i, p := range healthy {
					waitWithin(t, 3*time.Second, p.name+" sees the silent peer return", func() bool {
						return countOf(p.participantEvents(TypeJoined, marks[i]), silent.id) == 1
					})
				}
				return
			}
			waitWithin(t, 3*time.Second, "grace expiry frees the seat", func() bool {
				return pendingCount(hub) == 0 && hub.ActiveParticipants() == 3
			})
			fresh := joinTestParticipant(t, socketURL, silent.name, silent.token)
			if fresh.id == silent.id {
				t.Fatalf("an expired token reclaimed identity %q", fresh.id)
			}
		})
	}
}

// Two, three or all four participants lose their sockets in the same instant
// and come back together, either after a TCP reset (grace window) or by
// dialing again while the old socket still looks alive (takeover).
func TestHubSimultaneousReconnect(t *testing.T) {
	for _, drop := range []int{2, 3, 4} {
		for _, mode := range []string{"grace", "takeover"} {
			t.Run(fmt.Sprintf("%d %s", drop, mode), func(t *testing.T) {
				hub, socketURL := newFourSeatHub(t, 5*time.Second)
				room := joinFour(t, socketURL)
				dropped, survivors := room[len(room)-drop:], room[:len(room)-drop]
				marks := make(map[*testParticipant]int, len(survivors))
				for _, p := range survivors {
					marks[p] = p.mark()
				}

				if mode == "grace" {
					for _, p := range dropped {
						p.reset()
					}
					waitWithin(t, 3*time.Second, fmt.Sprintf("%d grace entries", drop), func() bool {
						return pendingCount(hub) == drop
					})
					for _, p := range survivors {
						for _, gone := range dropped {
							waitWithin(t, 3*time.Second, p.name+" sees "+gone.name+" leave", func() bool {
								return countOf(p.participantEvents(TypeLeft, marks[p]), gone.id) == 1
							})
						}
					}
					expectRoomFull(t, socketURL)
				}

				// Every dropped participant redials at the same moment.
				start := make(chan struct{})
				type result struct {
					p        *testParticipant
					response Message
					err      error
				}
				results := make([]result, len(dropped))
				var wg sync.WaitGroup
				for i, old := range dropped {
					wg.Add(1)
					go func(i int, old *testParticipant) {
						defer wg.Done()
						<-start
						p, response, err := dialAndJoin(socketURL, old.name, old.token)
						if err == nil {
							p.pump()
						}
						results[i] = result{p, response, err}
					}(i, old)
				}
				close(start)
				wg.Wait()
				resumed := make([]*testParticipant, len(dropped))
				for i, r := range results {
					if r.err != nil {
						t.Fatalf("%s resume: %v", dropped[i].name, r.err)
					}
					p := r.p
					t.Cleanup(func() {
						p.conn.Close()
						<-p.closed
					})
					if r.response.Type != TypeParticipant || p.id != dropped[i].id {
						t.Fatalf("%s resume response = %+v, want identity %q", dropped[i].name, r.response, dropped[i].id)
					}
					resumed[i] = p
				}
				waitWithin(t, 3*time.Second, "all four seats active and no grace entry left", func() bool {
					return hub.ActiveParticipants() == 4 && pendingCount(hub) == 0
				})
				if mode == "takeover" {
					for _, old := range dropped {
						select {
						case <-old.closed:
						case <-time.After(3 * time.Second):
							t.Fatalf("superseded socket of %s was not closed", old.name)
						}
					}
				}

				everyone := append(append([]*testParticipant{}, survivors...), resumed...)
				othersOf := func(p *testParticipant) []*testParticipant {
					var others []*testParticipant
					for _, other := range everyone {
						if other.id != p.id {
							others = append(others, other)
						}
					}
					return others
				}
				// Each returning participant learns about the other three.
				for _, p := range resumed {
					for _, other := range othersOf(p) {
						waitWithin(t, 5*time.Second, p.name+" learns about "+other.name, func() bool {
							return countOf(p.participantEvents(TypeJoined, 0), other.id) >= 1
						})
					}
				}
				// Survivors see each returning participant come back after a
				// grace drop, and see no departure at all for a takeover.
				for _, p := range survivors {
					for _, back := range resumed {
						if mode == "grace" {
							waitWithin(t, 5*time.Second, p.name+" sees "+back.name+" return", func() bool {
								return countOf(p.participantEvents(TypeJoined, marks[p]), back.id) >= 1
							})
						} else if left := countOf(p.participantEvents(TypeLeft, marks[p]), back.id); left != 0 {
							t.Fatalf("%s saw %s leave %d times during a takeover", p.name, back.name, left)
						}
					}
				}

				t.Run("announces each peer exactly once", func(t *testing.T) {
					if drop > 1 && mode == "grace" {
						knownFailing(t, "B5: concurrent admissions announce a peer twice: admit replays every "+
							"member no longer in h.pending, and that member's own resume also broadcasts participant_joined")
					}
					time.Sleep(300 * time.Millisecond)
					for _, p := range resumed {
						for _, other := range othersOf(p) {
							if n := countOf(p.participantEvents(TypeJoined, 0), other.id); n != 1 {
								t.Errorf("%s received participant_joined for %s %d times, want 1", p.name, other.name, n)
							}
						}
					}
					want := 0
					if mode == "grace" {
						want = 1
					}
					for _, p := range survivors {
						for _, back := range resumed {
							if n := countOf(p.participantEvents(TypeJoined, marks[p]), back.id); n != want {
								t.Errorf("%s received participant_joined for %s %d times, want %d", p.name, back.name, n, want)
							}
						}
					}
				})
			})
		}
	}
}

// A server restart (deploy, crash) forgets every reconnect token. All four
// browsers redial at once with tokens the new process has never seen: each is
// admitted as a fresh participant, the room fills exactly, and a fifth is
// still turned away.
func TestHubRestartRejoinWithStaleTokensFillsExactlyFourSeats(t *testing.T) {
	_, oldURL := newFourSeatHub(t, 5*time.Second)
	before := joinFour(t, oldURL)

	hub, socketURL := newFourSeatHub(t, 5*time.Second)
	start := make(chan struct{})
	rejoined := make([]*testParticipant, len(before))
	errs := make([]error, len(before))
	var wg sync.WaitGroup
	for i, old := range before {
		wg.Add(1)
		go func(i int, old *testParticipant) {
			defer wg.Done()
			<-start
			p, response, err := dialAndJoin(socketURL, old.name, old.token)
			if err == nil && response.Type != TypeParticipant {
				p.conn.Close()
				err = fmt.Errorf("response %+v", response)
			}
			if err == nil {
				p.pump()
			}
			rejoined[i], errs[i] = p, err
		}(i, old)
	}
	close(start)
	wg.Wait()
	for i, p := range rejoined {
		if errs[i] != nil {
			t.Fatalf("%s rejoin after restart: %v", before[i].name, errs[i])
		}
		t.Cleanup(func() {
			p.conn.Close()
			<-p.closed
		})
		if p.id == before[i].id {
			t.Fatalf("%s kept identity %q across a restart that forgot every token", p.name, p.id)
		}
	}
	waitWithin(t, 3*time.Second, "four active participants after the restart", func() bool {
		return hub.ActiveParticipants() == 4 && pendingCount(hub) == 0
	})
	expectRoomFull(t, socketURL)
	for _, p := range rejoined {
		for _, other := range rejoined {
			if other == p {
				continue
			}
			waitWithin(t, 5*time.Second, p.name+" learns about "+other.name, func() bool {
				return countOf(p.participantEvents(TypeJoined, 0), other.id) >= 1
			})
		}
	}
	t.Run("announces each peer exactly once", func(t *testing.T) {
		knownFailing(t, "B5: concurrent admissions announce a peer twice: admit replays every meeting member, and "+
			"that member's own join also broadcasts participant_joined to the newcomer")
		time.Sleep(300 * time.Millisecond)
		for _, p := range rejoined {
			for _, other := range rejoined {
				if other == p {
					continue
				}
				if n := countOf(p.participantEvents(TypeJoined, 0), other.id); n != 1 {
					t.Errorf("%s received participant_joined for %s %d times, want 1", p.name, other.name, n)
				}
			}
		}
	})
}

// On resume the superseded session's peer connection stays open for the
// superseded-close delay (so the resume can re-bind its publications), then
// closes. This holds both for a resume inside the grace window and for a
// takeover of a socket that still looks alive.
func TestResumeSupersededPeerCloseDelay(t *testing.T) {
	const delay = 600 * time.Millisecond
	for _, mode := range []string{"grace", "takeover"} {
		t.Run(mode, func(t *testing.T) {
			hub, socketURL := newFourSeatHub(t, 5*time.Second, func(h *Hub) {
				h.supersededCloseDelay = delay
			})
			p := joinTestParticipant(t, socketURL, "Avery", "")
			hub.mu.RLock()
			oldClient := hub.activeTokens[p.token]
			var oldPeer *pion.PeerConnection
			if oldClient != nil && oldClient.peer != nil {
				oldPeer = oldClient.peer.Connection()
			}
			hub.mu.RUnlock()
			if oldPeer == nil {
				t.Fatal("joined participant has no peer connection")
			}
			if mode == "grace" {
				p.reset()
				waitWithin(t, 3*time.Second, "grace entry", func() bool { return pendingCount(hub) == 1 })
			}
			if mode == "takeover" {
				knownFailing(t, "B6: a takeover closes the superseded peer at once: disconnect sees the old client as "+
					"superseded, so it is not grace-eligible and teardownClientMedia closes its peer, bypassing "+
					"the supersededCloseDelay that reclaim scheduled")
			}
			resumedAt := time.Now()
			back := joinTestParticipant(t, socketURL, "Avery", p.token)
			if back.id != p.id {
				t.Fatalf("resumed id = %q, want %q", back.id, p.id)
			}
			if state := oldPeer.ConnectionState(); state == pion.PeerConnectionStateClosed {
				t.Fatalf("superseded peer closed %s after the resume, before the %s delay", time.Since(resumedAt), delay)
			}
			waitWithin(t, delay+2*time.Second, "superseded peer closes", func() bool {
				return oldPeer.ConnectionState() == pion.PeerConnectionStateClosed
			})
			if closedAfter := time.Since(resumedAt); closedAfter < delay-100*time.Millisecond {
				t.Fatalf("superseded peer closed after %s, before the %s delay", closedAfter, delay)
			}
		})
	}
}
