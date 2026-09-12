package signaling

import (
	"fmt"
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
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeChat,
		ParticipantID: firstJoined.Participant.ID, ChatText: "Hello room",
	})
	var secondSeesChat Message
	readTestMessage(t, second, &secondSeesChat)
	if secondSeesChat.Type != TypeChat || secondSeesChat.ParticipantID != firstJoined.Participant.ID ||
		secondSeesChat.Name != "Ashkan" || secondSeesChat.ChatText != "Hello room" {
		t.Fatalf("chat broadcast = %+v", secondSeesChat)
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

func TestChatHistoryRetentionIsRoomScopedCappedAndExpiring(t *testing.T) {
	oldExpiry := chatHistoryExpiry
	chatHistoryExpiry = 20 * time.Millisecond
	t.Cleanup(func() { chatHistoryExpiry = oldExpiry })

	cfg := config.Config{RetainChatHistory: true, MaxParticipants: 2}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	t.Cleanup(hub.Close)

	for index := 0; index < 105; index++ {
		hub.recordChatMessage("room-a", ChatHistoryEntry{
			ID: fmt.Sprintf("message-%d", index), Author: "Ashkan", Text: "hello",
			Timestamp: time.Unix(int64(index), 0).UTC(),
		})
	}
	if got := hub.chatHistorySnapshot("room-a"); len(got) != chatHistoryLimit || got[0].ID != "message-5" {
		t.Fatalf("room-a history = %d messages starting with %q, want 100 starting with message-5", len(got), got[0].ID)
	}
	if got := hub.chatHistorySnapshot("room-b"); got != nil {
		t.Fatalf("room-b history = %#v, want nil", got)
	}

	hub.scheduleChatHistoryExpiry("room-a")
	time.Sleep(50 * time.Millisecond)
	if got := hub.chatHistorySnapshot("room-a"); got != nil {
		t.Fatalf("expired room history = %#v, want nil", got)
	}
}

func TestChatHistoryIsReplayedToNewRoomMembers(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		RetainChatHistory:   true,
		MaxParticipants:     3,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(3), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant.ID != firstJoined.Participant.ID {
		t.Fatalf("second existing participant = %+v", secondSeesFirst)
	}
	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)
	if firstSeesSecond.Type != TypeJoined || firstSeesSecond.Participant.ID != secondJoined.Participant.ID {
		t.Fatalf("first new participant = %+v", firstSeesSecond)
	}
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeChat,
		ParticipantID: firstJoined.Participant.ID, ChatText: "Retained hello",
	})
	var secondSeesChat Message
	readTestMessage(t, second, &secondSeesChat)

	third := dialTestSocket(t, socketURL)
	defer third.Close()
	writeTestMessage(t, third, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Sara"})
	var thirdJoined Message
	readTestMessage(t, third, &thirdJoined)
	if len(thirdJoined.ChatHistory) != 1 || thirdJoined.ChatHistory[0].Text != "Retained hello" ||
		thirdJoined.ChatHistory[0].Author != "Ashkan" {
		t.Fatalf("replayed chat history = %#v", thirdJoined.ChatHistory)
	}
}

func TestDisablingChatHistoryClearsExistingMessages(t *testing.T) {
	retain := true
	store := config.NewStore(config.Config{
		HTTPAddr:            ":8080",
		RetainChatHistory:   true,
		MaxParticipants:     2,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	})
	hub := NewHub(meeting.New(2), store, slog.Default())
	t.Cleanup(hub.Close)
	hub.recordChatMessage("default", ChatHistoryEntry{ID: "message-1", Author: "Ashkan", Text: "hello"})
	if got := hub.chatHistorySnapshot("default"); len(got) != 1 {
		t.Fatalf("initial history length = %d, want 1", len(got))
	}
	retain = false
	if err := store.Update(config.AdminUpdate{RetainChatHistory: &retain}); err != nil {
		t.Fatalf("disabling retention failed: %v", err)
	}
	hub.clearChatHistory()
	if got := hub.chatHistorySnapshot("default"); got != nil {
		t.Fatalf("cleared history = %#v, want nil", got)
	}
}

func TestSendOfferWaitsForInitialBrowserOffer(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{}), slog.Default())
	client := &client{}

	if err := hub.sendOffer(client, false); err != nil {
		t.Fatalf("sendOffer() before negotiation ready returned error: %v", err)
	}
	client.negotiationMu.Lock()
	ready, pending := client.negotiationReady, client.pendingOffer
	client.negotiationMu.Unlock()
	if ready || !pending {
		t.Fatalf("unexpected negotiation state: ready=%t pending=%t", ready, pending)
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

func TestHubLimitsJoinAttemptsPerConnection(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MeetingPassword: "secret", MaxParticipants: 1,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(1), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	conn := dialTestSocket(t, socketURL)
	defer conn.Close()
	for attempt := 0; attempt < maxJoinAttempts; attempt++ {
		writeTestMessage(t, conn, Message{
			Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", Password: "wrong",
		})
		var response Message
		readTestMessage(t, conn, &response)
		if response.Type != TypeError || response.Error != "invalid meeting password" {
			t.Fatalf("attempt %d response = %+v", attempt+1, response)
		}
	}

	writeTestMessage(t, conn, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", Password: "wrong",
	})
	var response Message
	readTestMessage(t, conn, &response)
	if response.Type != TypeError || response.Error != "too many join attempts" {
		t.Fatalf("limit response = %+v", response)
	}
	if _, _, err := conn.NextReader(); err == nil {
		t.Fatal("connection remained open after join-attempt limit")
	}
}

func TestHubRaisedHandQueueBroadcastsAndRejectsSpoofing(t *testing.T) {
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

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant.ID != firstJoined.Participant.ID {
		t.Fatalf("second existing participant = %+v", secondSeesFirst)
	}
	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)
	if firstSeesSecond.Type != TypeJoined || firstSeesSecond.Participant.ID != secondJoined.Participant.ID {
		t.Fatalf("first new participant = %+v", firstSeesSecond)
	}

	firstRaised := true
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: firstJoined.Participant.ID, HandRaised: &firstRaised,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var update Message
		readTestMessage(t, conn, &update)
		if update.Type != TypeHandState || update.ParticipantID != firstJoined.Participant.ID ||
			update.HandRaised == nil || !*update.HandRaised || update.HandOrder != 1 {
			t.Fatalf("first raised-hand update = %+v", update)
		}
	}

	secondRaised := true
	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: secondJoined.Participant.ID, HandRaised: &secondRaised,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var update Message
		readTestMessage(t, conn, &update)
		if update.Type != TypeHandState || update.ParticipantID != secondJoined.Participant.ID ||
			update.HandRaised == nil || !*update.HandRaised || update.HandOrder != 2 {
			t.Fatalf("second raised-hand update = %+v", update)
		}
	}

	firstLowered := false
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: firstJoined.Participant.ID, HandRaised: &firstLowered,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var lowered Message
		readTestMessage(t, conn, &lowered)
		var compacted Message
		readTestMessage(t, conn, &compacted)
		if lowered.ParticipantID != firstJoined.Participant.ID || lowered.HandRaised == nil ||
			*lowered.HandRaised || lowered.HandOrder != 0 ||
			compacted.ParticipantID != secondJoined.Participant.ID || compacted.HandRaised == nil ||
			!*compacted.HandRaised || compacted.HandOrder != 1 {
			t.Fatalf("lowered queue updates = %+v, %+v", lowered, compacted)
		}
	}

	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: secondJoined.Participant.ID, HandRaised: &secondRaised,
	})
	var spoofed Message
	readTestMessage(t, first, &spoofed)
	if spoofed.Type != TypeError || spoofed.Error != "participant_id does not belong to this connection" {
		t.Fatalf("spoofed hand-state response = %+v", spoofed)
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
