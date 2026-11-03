package signaling

import (
	"fmt"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/ratelimit"
	"github.com/gorilla/websocket"
)

func TestRoomBroadcastsRequireAdmission(t *testing.T) {
	h := NewHub(meeting.New(1), config.NewStore(config.Config{MeetingPassword: "secret"}), slog.Default())
	defer h.Close()
	s := httptest.NewServer(h)
	defer s.Close()
	u := "ws" + strings.TrimPrefix(s.URL, "http")
	control := dialTestSocket(t, u)
	defer control.Close()
	writeTestMessage(t, control, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "control", Password: "secret"})
	var joined Message
	readTestMessage(t, control, &joined)
	if joined.Type != TypeParticipant {
		t.Fatalf("join: %+v", joined)
	}
	for _, rejection := range []string{"unjoined", "password", "capacity"} {
		t.Run(rejection, func(t *testing.T) {
			c := dialTestSocket(t, u)
			defer c.Close()
			if rejection != "unjoined" {
				password := "secret"
				if rejection == "password" {
					password = "wrong"
				}
				writeTestMessage(t, c, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "rejected", Password: password})
				var rejected Message
				readTestMessage(t, c, &rejected)
				if rejected.Type != TypeError {
					t.Fatalf("rejection: %+v", rejected)
				}
				if rejection == "capacity" {
					var full Message
					readTestMessage(t, control, &full)
				}
			}
			for _, kind := range []string{TypeJoined, TypeLeft, TypeChat, TypeReaction, TypeMediaState, TypeHandState, TypeScreenState, TypeConfigUpdate, TypeRoomFull} {
				for _, broadcast := range []func(Message){h.broadcast, func(m Message) { h.broadcastExcept(nil, m) }, h.broadcastToRoom} {
					broadcast(Message{Version: ProtocolVersion, Type: kind})
					var event Message
					readTestMessage(t, control, &event)
					if event.Type != kind {
						t.Fatalf("control received %s, want %s", event.Type, kind)
					}
				}
			}
			writeTestMessage(t, c, Message{Version: ProtocolVersion, Type: TypeChat, ParticipantID: "fake", ChatText: "barrier"})
			var response Message
			readTestMessage(t, c, &response)
			if response.Type != TypeError {
				t.Fatalf("private event leaked: %+v", response)
			}
		})
	}
}

func TestRoomMessageDropsUnrelatedFields(t *testing.T) {
	c := &client{participant: meeting.Participant{ID: "real", Name: "author"}}
	on := true
	for _, kind := range []string{TypeChat, TypeReaction, TypeMediaState} {
		incoming := Message{Version: 999, Type: kind, ParticipantID: "spoof", Name: "spoof", Password: "secret", ReconnectToken: "token", SDP: "sdp", Candidate: "candidate", ChatText: " text ", Emoji: "👍", AudioEnabled: &on, VideoEnabled: &on, VideoPaused: &on}
		want := Message{Version: ProtocolVersion, Type: kind, ParticipantID: "real"}
		switch kind {
		case TypeChat:
			want.Name, want.ChatText = "author", "text"
		case TypeReaction:
			want.Name, want.Emoji = "author", "👍"
		case TypeMediaState:
			want.AudioEnabled, want.VideoEnabled, want.VideoPaused = &on, &on, &on
		}
		if got := roomMessage(c, incoming); !reflect.DeepEqual(got, want) {
			t.Fatalf("%s: got %+v, want %+v", kind, got, want)
		}
	}
}

func TestPendingConnectionCapAndFixedJoinDeadline(t *testing.T) {
	h := NewHub(meeting.New(2), config.NewStore(config.Config{}), slog.Default())
	h.maxPendingConnections = 1
	h.joinTimeout = 100 * time.Millisecond
	defer h.Close()
	s := httptest.NewServer(h)
	defer s.Close()
	u := "ws" + strings.TrimPrefix(s.URL, "http")
	c := dialTestSocket(t, u)
	defer c.Close()
	_, response, err := websocket.DefaultDialer.Dial(u, nil)
	if err == nil || response == nil || response.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("cap: response=%v err=%v", response, err)
	}
	// Frequent pongs must not extend the absolute admission deadline.
	stop := make(chan struct{})
	defer close(stop)
	go func() {
		ticker := time.NewTicker(10 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				_ = c.WriteControl(10, nil, time.Now().Add(time.Second))
			}
		}
	}()
	_ = c.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := c.ReadMessage(); err == nil {
		t.Fatal("pending connection survived deadline")
	}
	deadline := time.Now().Add(time.Second)
	for {
		h.mu.RLock()
		n := h.pendingConnections
		h.mu.RUnlock()
		if n == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("pending slot leaked")
		}
		time.Sleep(time.Millisecond)
	}
	admitted := dialTestSocket(t, u)
	defer admitted.Close()
	writeTestMessage(t, admitted, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "admitted"})
	var msg Message
	readTestMessage(t, admitted, &msg)
	if msg.Type != TypeParticipant {
		t.Fatalf("admission: %+v", msg)
	}
	if !h.ValidateActiveReconnectToken(msg.ReconnectToken) {
		t.Fatal("admitted token rejected")
	}
	time.Sleep(2 * h.joinTimeout)
	writeTestMessage(t, admitted, Message{Version: ProtocolVersion, Type: "invalid"})
	var stillConnected Message
	readTestMessage(t, admitted, &stillConnected)
	if stillConnected.Type != TypeError {
		t.Fatalf("admitted socket closed by join deadline: %+v", stillConnected)
	}
	// Admission frees the separate pending connection budget.
	next := dialTestSocket(t, u)
	defer next.Close()
}

func TestHubBoundsSignalingMessageSize(t *testing.T) {
	h := NewHub(meeting.New(2), config.NewStore(config.Config{}), slog.Default())
	defer h.Close()
	s := httptest.NewServer(h)
	defer s.Close()
	u := "ws" + strings.TrimPrefix(s.URL, "http")
	c := dialTestSocket(t, u)
	defer c.Close()

	// Four-person screen-share renegotiation produced a 20,450-byte browser
	// offer, which exceeded the old 16 KiB websocket read limit.
	writeTestMessage(t, c, Message{
		Version: ProtocolVersion,
		Type:    TypeOffer,
		SDP:     strings.Repeat("x", 20*1024),
	})

	var response Message
	readTestMessage(t, c, &response)
	if response.Type != TypeError {
		t.Fatalf("unjoined offer response = %+v, want an admission error after decoding the full message", response)
	}

	writeTestMessage(t, c, Message{
		Version: ProtocolVersion,
		Type:    TypeOffer,
		SDP:     strings.Repeat("x", maxSignalingMessageSize),
	})
	if _, _, err := c.ReadMessage(); !websocket.IsCloseError(err, websocket.CloseMessageTooBig) {
		t.Fatalf("oversized signaling message error = %v, want websocket close code %d", err, websocket.CloseMessageTooBig)
	}
}

func TestActiveAdmissionTokenLifecycle(t *testing.T) {
	h := NewHub(meeting.New(1), config.NewStore(config.Config{}), slog.Default())
	defer h.Close()
	c, replacement := &client{}, &client{}
	h.activeTokens["token"] = c
	if h.ValidateActiveReconnectToken("") || h.ValidateActiveReconnectToken("unknown") || h.ValidateActiveReconnectToken("token") {
		t.Fatal("unadmitted token accepted")
	}
	h.roomMembers[c] = struct{}{}
	if !h.ValidateActiveReconnectToken("token") {
		t.Fatal("admitted token rejected")
	}
	h.activeTokens["token"] = replacement
	if h.ValidateActiveReconnectToken("token") {
		t.Fatal("takeover accepted before admission")
	}
	delete(h.roomMembers, c)
	h.roomMembers[replacement] = struct{}{}
	if !h.ValidateActiveReconnectToken("token") {
		t.Fatal("admitted replacement rejected")
	}
	delete(h.roomMembers, replacement)
	if h.ValidateActiveReconnectToken("token") {
		t.Fatal("disconnected token accepted")
	}
	h.roomMembers[replacement] = struct{}{}
	h.closed = true
	if h.ValidateActiveReconnectToken("token") {
		t.Fatal("closed hub authorized token")
	}
}

func TestExpiredAdmissionCannotCommitAfterPeerSetup(t *testing.T) {
	h := NewHub(meeting.New(1), config.NewStore(config.Config{}), slog.Default())
	defer h.Close()
	c := &client{outbound: make(chan Message, 1)}
	h.activeTokens["token"] = c
	// The deadline wins while the handler is preparing the participant/peer.
	h.expireAdmission(c)
	if err := h.admit(c, meeting.Participant{}, Message{Type: TypeParticipant, ReconnectToken: "token"}, false); err == nil {
		t.Fatal("expired admission committed")
	}
	if len(c.outbound) != 0 || h.ValidateActiveReconnectToken("token") {
		t.Fatal("expired connection received admission or authorized credentials")
	}
	h.mu.RLock()
	_, admitted := h.roomMembers[c]
	h.mu.RUnlock()
	if admitted {
		t.Fatal("expired connection became a room member")
	}
}

func TestJoinPasswordBudgetSurvivesFreshSocketsAndRefills(t *testing.T) {
	h := NewHub(meeting.New(2), config.NewStore(config.Config{MeetingPassword: "secret"}), slog.Default())
	defer h.Close()
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	h.passwordLimiter = ratelimit.NewWithClock(2, 2, func() time.Time { return time.Unix(0, clock.Load()) })
	s := httptest.NewServer(h)
	defer s.Close()
	u := "ws" + strings.TrimPrefix(s.URL, "http")
	attempt := func(password string) Message {
		c := dialTestSocket(t, u)
		defer c.Close()
		writeTestMessage(t, c, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "guest", Password: password})
		var msg Message
		readTestMessage(t, c, &msg)
		return msg
	}
	for range 2 {
		if msg := attempt("wrong"); msg.Error != "invalid meeting password" {
			t.Fatalf("wrong password: %+v", msg)
		}
	}
	if msg := attempt("secret"); msg.Error != "too many password attempts" {
		t.Fatalf("exhausted correct password: %+v", msg)
	}
	clock.Add(int64(time.Minute))
	if msg := attempt("secret"); msg.Type != TypeParticipant {
		t.Fatalf("refilled password budget: %+v", msg)
	}
}

func TestJoinPasswordBudgetUsesOnlyTrustedProxyIdentity(t *testing.T) {
	for _, trust := range []bool{false, true} {
		t.Run(fmt.Sprint(trust), func(t *testing.T) {
			cfg := config.Config{MeetingPassword: "secret"}
			if trust {
				cfg.TrustedProxyCIDRs = []string{"127.0.0.0/8", "::1/128"}
			}
			h := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
			defer h.Close()
			h.passwordLimiter = ratelimit.NewWithClock(1, 1, func() time.Time { return time.Unix(1000, 0) })
			s := httptest.NewServer(h)
			defer s.Close()
			u := "ws" + strings.TrimPrefix(s.URL, "http")
			attempt := func(ip, password string) Message {
				c, _, err := websocket.DefaultDialer.Dial(u, http.Header{"X-Forwarded-For": []string{ip}})
				if err != nil {
					t.Fatal(err)
				}
				defer c.Close()
				writeTestMessage(t, c, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "guest", Password: password})
				var msg Message
				readTestMessage(t, c, &msg)
				return msg
			}
			if msg := attempt("198.51.100.1", "wrong"); msg.Error != "invalid meeting password" {
				t.Fatalf("initial: %+v", msg)
			}
			msg := attempt("2001:db8::1", "secret")
			if trust && msg.Type != TypeParticipant {
				t.Fatalf("independent trusted proxy client: %+v", msg)
			}
			if !trust && msg.Error != "too many password attempts" {
				t.Fatalf("spoofed header bypassed budget: %+v", msg)
			}
		})
	}
}
