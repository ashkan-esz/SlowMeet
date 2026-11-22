package signaling

import (
	"log/slog"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"SlowMeet/internal/config"
	"SlowMeet/internal/meeting"
)

func TestNormalizeVideoCodecClaim(t *testing.T) {
	tests := []struct {
		name  string
		claim []string
		want  []string
	}{
		{name: "older client sends none", claim: nil, want: []string{"vp8", "h264"}},
		{name: "empty list still has vp8", claim: []string{}, want: []string{"vp8"}},
		{name: "canonical order, unknown dropped", claim: []string{"h264", "bogus", "av1"}, want: []string{"av1", "vp8", "h264"}},
		{name: "everything", claim: []string{"vp8", "vp9", "av1", "h264"}, want: []string{"av1", "vp9", "vp8", "h264"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := normalizeVideoCodecClaim(test.claim); !slices.Equal(got, test.want) {
				t.Fatalf("normalizeVideoCodecClaim(%v) = %v, want %v", test.claim, got, test.want)
			}
		})
	}
}

func TestJoinRejectsOversizedVideoCodecClaim(t *testing.T) {
	join := Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"}
	join.VideoCodecs = []string{"av1", "vp9", "vp8", "h264"}
	if err := join.Validate(); err != nil {
		t.Fatalf("ordinary claim rejected: %v", err)
	}
	join.VideoCodecs = slices.Repeat([]string{"vp8"}, maxVideoCodecClaims+1)
	if err := join.Validate(); err == nil {
		t.Fatal("a claim with too many entries must be rejected")
	}
	join.VideoCodecs = []string{strings.Repeat("x", maxVideoCodecNameLength+1)}
	if err := join.Validate(); err == nil {
		t.Fatal("a claim with an overlong name must be rejected")
	}
}

func TestRoomVideoCodecsAreWhatEveryParticipantSupports(t *testing.T) {
	hub := &Hub{}
	all := config.SupportedVideoCodecs()
	if got := hub.refreshRoomVideoCodecsLocked(all, nil); !slices.Equal(got, all) {
		t.Fatalf("empty room = %v, want %v", got, all)
	}
	hub.setVideoCodecClaimLocked("modern", normalizeVideoCodecClaim(all))
	hub.setVideoCodecClaimLocked("phone", normalizeVideoCodecClaim([]string{"vp9", "vp8"}))
	if got := hub.refreshRoomVideoCodecsLocked(all, nil); !slices.Equal(got, []string{"vp9", "vp8"}) {
		t.Fatalf("mixed room = %v, want [vp9 vp8]", got)
	}
	// A client that sent no claim is counted with the legacy pair.
	hub.setVideoCodecClaimLocked("cached", nil)
	if got := hub.refreshRoomVideoCodecsLocked(all, nil); !slices.Equal(got, []string{"vp8"}) {
		t.Fatalf("room with a legacy client = %v, want [vp8]", got)
	}
	// The administrator's list bounds the room list too.
	delete(hub.videoCodecClaims, "cached")
	if got := hub.refreshRoomVideoCodecsLocked([]string{"vp8", "h264"}, nil); !slices.Equal(got, []string{"vp8"}) {
		t.Fatalf("restricted room = %v, want [vp8]", got)
	}
}

// readUntilTestMessageType skips unrelated room traffic and returns the next
// message of the wanted type.
func readUntilTestMessageType(t *testing.T, conn *websocket.Conn, wanted string) Message {
	t.Helper()
	for range 8 {
		var msg Message
		readTestMessage(t, conn, &msg)
		if msg.Type == wanted {
			return msg
		}
	}
	t.Fatalf("no %s message arrived", wanted)
	return Message{}
}

func TestRoomVideoCodecStateFollowsJoinLeaveAndAdminChange(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
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

	modern := dialTestSocket(t, socketURL)
	defer modern.Close()
	writeTestMessage(t, modern, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Modern",
		VideoCodecs: []string{"av1", "vp9", "vp8", "h264"}})
	var modernJoined Message
	readTestMessage(t, modern, &modernJoined)
	if modernJoined.Type != TypeParticipant ||
		!slices.Equal(modernJoined.RoomVideoCodecs, []string{"av1", "vp9", "vp8", "h264"}) ||
		modernJoined.DefaultVideoCodec != "av1" {
		t.Fatalf("first join response = %+v", modernJoined)
	}

	// A browser without AV1 takes AV1 away from the whole room: the joiner
	// learns the list in its response, the others in video_codec_state.
	phone := dialTestSocket(t, socketURL)
	defer phone.Close()
	writeTestMessage(t, phone, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Phone",
		VideoCodecs: []string{"vp9", "vp8"}})
	var phoneJoined Message
	readTestMessage(t, phone, &phoneJoined)
	if phoneJoined.Type != TypeParticipant || !slices.Equal(phoneJoined.RoomVideoCodecs, []string{"vp9", "vp8"}) {
		t.Fatalf("second join response = %+v", phoneJoined)
	}
	if state := readUntilTestMessageType(t, modern, TypeVideoCodecState); !slices.Equal(state.RoomVideoCodecs, []string{"vp9", "vp8"}) {
		t.Fatalf("room codecs after the phone joined = %v", state.RoomVideoCodecs)
	}

	// A second browser with the same limits changes nothing, so nobody is told.
	twin := dialTestSocket(t, socketURL)
	writeTestMessage(t, twin, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Twin",
		VideoCodecs: []string{"vp8", "vp9"}})
	var twinJoined Message
	readTestMessage(t, twin, &twinJoined)
	if joined := readUntilTestMessageType(t, phone, TypeJoined); joined.Participant == nil || joined.Participant.Name != "Modern" {
		t.Fatalf("phone roster replay = %+v", joined)
	}
	if joined := readUntilTestMessageType(t, phone, TypeJoined); joined.Participant == nil || joined.Participant.Name != "Twin" {
		t.Fatalf("phone did not see the twin join: %+v", joined)
	}
	assertNoTestMessage(t, phone)
	_ = twin.Close()
	readUntilTestMessageType(t, modern, TypeLeft)

	// When the limiting browser leaves, the room gets its codecs back.
	_ = phone.Close()
	if state := readUntilTestMessageType(t, modern, TypeVideoCodecState); !slices.Equal(state.RoomVideoCodecs, []string{"av1", "vp9", "vp8", "h264"}) {
		t.Fatalf("room codecs after the phone left = %v", state.RoomVideoCodecs)
	}

	// An administrator change reaches the room as the new room list and as the
	// allowed list with its default.
	cfg.VideoCodecs = []string{"vp8", "vp9"}
	cfg.DefaultVideoCodec = "vp9"
	hub.BroadcastConfig(cfg)
	if state := readUntilTestMessageType(t, modern, TypeVideoCodecState); !slices.Equal(state.RoomVideoCodecs, []string{"vp9", "vp8"}) {
		t.Fatalf("room codecs after the admin change = %v", state.RoomVideoCodecs)
	}
	update := readUntilTestMessageType(t, modern, TypeConfigUpdate)
	if !slices.Equal(update.VideoCodecs, []string{"vp9", "vp8"}) || update.DefaultVideoCodec != "vp9" {
		t.Fatalf("config_update codecs = %v default = %q", update.VideoCodecs, update.DefaultVideoCodec)
	}
}
