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
