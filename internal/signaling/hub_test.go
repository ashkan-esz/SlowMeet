package signaling

import (
	"log/slog"
	"net/http/httptest"
	"testing"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
	"github.com/gorilla/websocket"
)

func TestHubJoinLeaveLifecycle(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		MaxParticipants:     2,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})

	var firstJoined Message
	readTestMessage(t, first, &firstJoined)
	if firstJoined.Type != TypeParticipant || firstJoined.Participant == nil {
		t.Fatalf("first join response = %+v", firstJoined)
	}
	if firstJoined.ReconnectToken == "" {
		t.Fatal("first join response did not include reconnect token")
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})

	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	if secondJoined.Type != TypeParticipant {
		t.Fatalf("second join response = %+v", secondJoined)
	}
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant.Name != "Ashkan" {
		t.Fatalf("existing participant broadcast = %+v", secondSeesFirst)
	}
	if secondSeesFirst.ReconnectToken != "" {
		t.Fatal("reconnect token leaked in participant broadcast")
	}

	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)
	if firstSeesSecond.Type != TypeJoined || firstSeesSecond.Participant.Name != "Ali" {
		t.Fatalf("participant broadcast = %+v", firstSeesSecond)
	}

	hub.BroadcastConfig(config.Config{
		MaxVideoBitrate:   250000,
		MaxVideoFPS:       10,
		MaxAudioBitrate:   32000,
		EnableScreenShare: false,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var update Message
		readTestMessage(t, conn, &update)
		if update.Type != TypeConfigUpdate || update.MaxVideoBitrate != 250000 ||
			update.MaxVideoFPS != 10 || update.MaxAudioBitrate != 32000 ||
			update.ScreenShareEnabled == nil || *update.ScreenShareEnabled {
			t.Fatalf("configuration update = %+v", update)
		}
	}
	writeTestMessage(t, first, Message{
		Version:       ProtocolVersion,
		Type:          TypeLeave,
		ParticipantID: firstJoined.Participant.ID,
	})
	var left Message
	readTestMessage(t, second, &left)
	if left.Type != TypeLeft || left.Participant.Name != "Ashkan" {
		t.Fatalf("leave broadcast = %+v", left)
	}
}

func TestWebSocketLivenessConfiguration(t *testing.T) {
	if websocketPongWait <= websocketPingPeriod {
		t.Fatalf("pong wait %s must exceed ping period %s", websocketPongWait, websocketPingPeriod)
	}
	if websocketWriteWait <= 0 || websocketWriteWait >= websocketPongWait {
		t.Fatalf("write wait %s must be positive and below pong wait %s", websocketWriteWait, websocketPongWait)
	}
}

func TestHubRejectsWrongPasswordAndFullMeeting(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		MeetingPassword:     "secret",
		MaxParticipants:     1,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(1), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	wrong := dialTestSocket(t, socketURL)
	defer wrong.Close()
	writeTestMessage(t, wrong, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Wrong", Password: "nope",
	})
	var passwordError Message
	readTestMessage(t, wrong, &passwordError)
	if passwordError.Type != TypeError || passwordError.Error != "invalid meeting password" {
		t.Fatalf("wrong password response = %+v", passwordError)
	}

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", Password: "secret",
	})
	var joined Message
	readTestMessage(t, first, &joined)
	if joined.Type != TypeParticipant {
		t.Fatalf("valid join response = %+v", joined)
	}

	full := dialTestSocket(t, socketURL)
	defer full.Close()
	writeTestMessage(t, full, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ali", Password: "secret",
	})
	var fullError Message
	readTestMessage(t, full, &fullError)
	if fullError.Type != TypeError || fullError.Error != "meeting is full" {
		t.Fatalf("full meeting response = %+v", fullError)
	}
}

func TestHubRejectsMessagesBeforeJoin(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	conn := dialTestSocket(t, socketURL)
	defer conn.Close()
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeICERestart})

	var response Message
	readTestMessage(t, conn, &response)
	if response.Type != TypeError || response.Error != "join is required before this message" {
		t.Fatalf("pre-join response = %+v", response)
	}
}

func TestHubAllowsOnlyOneScreenShare(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, EnableScreenShare: true,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	active := true
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: firstJoined.Participant.ID, ScreenShareActive: &active,
	})
	var granted Message
	readTestMessage(t, first, &granted)
	if granted.Type != TypeScreenState || granted.ScreenShareOwner != firstJoined.Participant.ID ||
		granted.ScreenShareActive == nil || !*granted.ScreenShareActive {
		t.Fatalf("screen-share grant = %+v", granted)
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var existing Message
	readTestMessage(t, second, &existing)
	var state Message
	readTestMessage(t, second, &state)
	if state.Type != TypeScreenState || state.ScreenShareOwner != firstJoined.Participant.ID {
		t.Fatalf("late-join screen state = %+v", state)
	}

	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: secondJoined.Participant.ID, ScreenShareActive: &active,
	})
	var denied Message
	readTestMessage(t, second, &denied)
	if denied.Type != TypeError || denied.Error != "screen sharing is already active" {
		t.Fatalf("second screen-share request = %+v", denied)
	}
}

func TestHubReleasesScreenShareWhenOwnerDisconnects(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, EnableScreenShare: true,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: time.Second,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	observer := dialTestSocket(t, socketURL)
	defer observer.Close()
	writeTestMessage(t, observer, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Observer"})
	var observerJoined Message
	readTestMessage(t, observer, &observerJoined)

	owner := dialTestSocket(t, socketURL)
	writeTestMessage(t, owner, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var ownerJoined Message
	readTestMessage(t, owner, &ownerJoined)
	var ownerSeesObserver Message
	readTestMessage(t, owner, &ownerSeesObserver)
	var observerSeesOwner Message
	readTestMessage(t, observer, &observerSeesOwner)
	active := true
	writeTestMessage(t, owner, Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: ownerJoined.Participant.ID, ScreenShareActive: &active,
	})
	var ownerState Message
	readTestMessage(t, owner, &ownerState)
	var observerState Message
	readTestMessage(t, observer, &observerState)
	owner.Close()

	var released Message
	readTestMessage(t, observer, &released)
	if released.Type != TypeScreenState || released.ScreenShareActive == nil || *released.ScreenShareActive {
		t.Fatalf("disconnect release state = %+v", released)
	}
}

func TestHubScreenShareLeaseBindsToConnection(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{
		HTTPAddr: ":8080", EnableScreenShare: true,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}), slog.Default())
	old := &client{participant: meeting.Participant{ID: "old"}}
	replacement := &client{participant: meeting.Participant{ID: "same-participant"}}
	hub.mu.Lock()
	hub.screenSharer = old
	hub.mu.Unlock()

	hub.releaseScreenShare(replacement)
	hub.mu.RLock()
	current := hub.screenSharer
	hub.mu.RUnlock()
	if current != old {
		t.Fatal("stale replacement cleared the active screen-share lease")
	}
	hub.releaseScreenShare(old)
	hub.mu.RLock()
	current = hub.screenSharer
	hub.mu.RUnlock()
	if current != nil {
		t.Fatal("owner did not release the screen-share lease")
	}
}

func TestHubAllowsScreenShareReleaseWhenDisabled(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{
		HTTPAddr: ":8080", EnableScreenShare: false,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}), slog.Default())
	owner := &client{participant: meeting.Participant{ID: "owner"}}
	hub.mu.Lock()
	hub.screenSharer = owner
	hub.mu.Unlock()

	if err := hub.requestScreenShare(owner, false); err != nil {
		t.Fatalf("release with screen sharing disabled: %v", err)
	}
	hub.mu.RLock()
	current := hub.screenSharer
	hub.mu.RUnlock()
	if current != nil {
		t.Fatal("disabled screen sharing release did not clear the lease")
	}
	if err := hub.requestScreenShare(owner, true); err == nil {
		t.Fatal("acquisition with screen sharing disabled succeeded")
	}
}

func TestHubCloseCleansUpJoinedParticipants(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	conn := dialTestSocket(t, socketURL)
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, conn, &joined)
	if joined.Type != TypeParticipant {
		t.Fatalf("join response = %+v", joined)
	}

	hub.Close()
	defer conn.Close()
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		if hub.ActiveParticipants() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("active participants after Close() = %d, want 0", hub.ActiveParticipants())
}

func TestHubReconnectReclaimsParticipantDuringGracePeriod(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 1, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 200 * time.Millisecond,
	}
	hub := NewHub(meeting.New(1), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, first, &joined)
	if joined.Type != TypeParticipant || joined.ReconnectToken == "" {
		t.Fatalf("join response = %+v", joined)
	}
	first.Close()

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan",
		ReconnectToken: joined.ReconnectToken,
	})
	var rejoined Message
	readTestMessage(t, second, &rejoined)
	if rejoined.Type != TypeParticipant || rejoined.Participant.ID != joined.Participant.ID {
		t.Fatalf("reconnect response = %+v, want participant %q", rejoined, joined.Participant.ID)
	}
}

func TestHubHidesDisconnectedParticipantDuringGracePeriod(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: time.Second,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, first, &joined)
	first.Close()

	// Allow the closed handler to register the reconnect grace session.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		hub.mu.RLock()
		pending := len(hub.pending)
		hub.mu.RUnlock()
		if pending > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	hub.mu.RLock()
	pending := len(hub.pending)
	hub.mu.RUnlock()
	if pending == 0 {
		t.Fatal("disconnect did not enter reconnect grace period")
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var response Message
	readTestMessage(t, second, &response)
	if response.Type != TypeParticipant {
		t.Fatalf("join response = %+v", response)
	}
	_ = second.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	var unexpected Message
	if err := second.ReadJSON(&unexpected); err == nil {
		t.Fatalf("received disconnected participant: %+v", unexpected)
	}
}

func TestHubReconnectExpiryReleasesParticipantSlot(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 1, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 40 * time.Millisecond,
	}
	hub := NewHub(meeting.New(1), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, first, &joined)
	first.Close()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && hub.ActiveParticipants() != 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := hub.ActiveParticipants(); got != 0 {
		t.Fatalf("active participants after reconnect expiry = %d, want 0", got)
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var rejoined Message
	readTestMessage(t, second, &rejoined)
	if rejoined.Type != TypeParticipant || rejoined.Participant.Name != "Ali" {
		t.Fatalf("fresh join after expiry = %+v", rejoined)
	}
}

func dialTestSocket(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn
}

func writeTestMessage(t *testing.T, conn *websocket.Conn, msg Message) {
	t.Helper()
	if err := conn.WriteJSON(msg); err != nil {
		t.Fatalf("write message: %v", err)
	}
}

func readTestMessage(t *testing.T, conn *websocket.Conn, msg *Message) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	if err := conn.ReadJSON(msg); err != nil {
		t.Fatalf("read message: %v", err)
	}
}
