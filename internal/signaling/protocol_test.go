package signaling

import (
	"encoding/json"
	"testing"
)

func TestValidateJoinMessage(t *testing.T) {
	msg := Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"}
	if err := msg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
	}
}

func TestValidateRejectsOversizedReconnectToken(t *testing.T) {
	msg := Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan",
		ReconnectToken: string(make([]byte, 129)),
	}
	if err := msg.Validate(); err == nil {
		t.Fatal("oversized reconnect token was accepted")
	}
}

func TestValidateRejectsUnknownOrMalformedMessage(t *testing.T) {
	cases := []Message{
		{Version: 2, Type: TypeJoin, Name: "Ashkan"},
		{Version: ProtocolVersion, Type: "unknown", Name: "Ashkan"},
		{Version: ProtocolVersion, Type: TypeJoin},
	}
	for _, msg := range cases {
		if err := msg.Validate(); err == nil {
			t.Errorf("Validate(%+v) succeeded, want error", msg)
		}
	}
}

func TestValidateMediaStateRequiresParticipantAndState(t *testing.T) {
	enabled := true
	if err := (Message{
		Version: ProtocolVersion, Type: TypeMediaState,
		ParticipantID: "participant-1", AudioEnabled: &enabled,
	}).Validate(); err != nil {
		t.Fatalf("valid media state rejected: %v", err)
	}
	if err := (Message{Version: ProtocolVersion, Type: TypeMediaState}).Validate(); err == nil {
		t.Fatal("media state without participant/state was accepted")
	}
}

func TestMediaStateCarriesVideoPaused(t *testing.T) {
	videoEnabled := false
	paused := true
	original := Message{
		Version: ProtocolVersion, Type: TypeMediaState,
		ParticipantID: "participant-1", VideoEnabled: &videoEnabled, VideoPaused: &paused,
	}
	payload, err := json.Marshal(original)
	if err != nil {
		t.Fatalf("marshal media state: %v", err)
	}
	var decoded Message
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal media state: %v", err)
	}
	if decoded.VideoPaused == nil || !*decoded.VideoPaused {
		t.Fatalf("video_paused was not preserved: %+v", decoded)
	}
}

func TestMediaStreamIDIsOptionalAndBounded(t *testing.T) {
	active := true
	message := Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: "p1", ScreenShareActive: &active,
		MediaStreamID: "screen-stream-1",
	}
	payload, err := json.Marshal(message)
	if err != nil {
		t.Fatalf("marshal screen share: %v", err)
	}
	var decoded Message
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("unmarshal screen share: %v", err)
	}
	if decoded.MediaStreamID != message.MediaStreamID {
		t.Fatalf("media stream id = %q, want %q", decoded.MediaStreamID, message.MediaStreamID)
	}
	if err := (Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: "p1", ScreenShareActive: &active,
		MediaStreamID: string(make([]byte, 129)),
	}).Validate(); err == nil {
		t.Fatal("oversized media stream id was accepted")
	}
	if err := (Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: "p1", ScreenShareActive: &active,
	}).Validate(); err != nil {
		t.Fatalf("missing optional media stream id rejected: %v", err)
	}
}

func TestValidateNetworkState(t *testing.T) {
	valid := Message{
		Version: ProtocolVersion, Type: TypeNetworkState, ParticipantID: "p1",
		RTTMs: 180, PacketLoss10: 25, JitterMs: 12, VideoKbps: 300, AudioKbps: 40,
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid network state rejected: %v", err)
	}
	unknown := valid
	unknown.RTTMs = -1
	unknown.PacketLoss10 = -1
	unknown.JitterMs = -1
	unknown.VideoKbps = -1
	unknown.AudioKbps = -1
	if err := unknown.Validate(); err != nil {
		t.Fatalf("unknown network values should be accepted: %v", err)
	}
	invalid := valid
	invalid.PacketLoss10 = 1001
	if err := invalid.Validate(); err == nil {
		t.Fatal("out-of-range packet loss was accepted")
	}
}

func TestValidateScreenShareRequest(t *testing.T) {
	active := true
	if err := (Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: "p1", ScreenShareActive: &active,
	}).Validate(); err != nil {
		t.Fatalf("valid screen-share request rejected: %v", err)
	}
	if err := (Message{Version: ProtocolVersion, Type: TypeScreenShare, ParticipantID: "p1"}).Validate(); err == nil {
		t.Fatal("screen-share request without state was accepted")
	}
}

func TestValidateChatMessage(t *testing.T) {
	valid := Message{
		Version: ProtocolVersion, Type: TypeChat,
		ParticipantID: "p1", ChatText: "Hello room",
	}
	if err := valid.Validate(); err != nil {
		t.Fatalf("valid chat message rejected: %v", err)
	}
	for _, invalid := range []Message{
		{Version: ProtocolVersion, Type: TypeChat, ChatText: "Hello room"},
		{Version: ProtocolVersion, Type: TypeChat, ParticipantID: "p1", ChatText: "   "},
		{Version: ProtocolVersion, Type: TypeChat, ParticipantID: "p1", ChatText: string(make([]rune, 501))},
	} {
		if err := invalid.Validate(); err == nil {
			t.Errorf("Validate(%+v) succeeded, want error", invalid)
		}
	}
}

func TestValidateRejectsEmptySDPAndCandidate(t *testing.T) {
	for _, msg := range []Message{
		{Version: ProtocolVersion, Type: TypeOffer},
		{Version: ProtocolVersion, Type: TypeAnswer},
		{Version: ProtocolVersion, Type: TypeCandidate},
	} {
		if err := msg.Validate(); err == nil {
			t.Errorf("Validate(%+v) succeeded, want error", msg)
		}
	}
}

func TestReadMessageRejectsUnknownAndTrailingJSON(t *testing.T) {
	cases := []string{
		`{"version":1,"type":"join","name":"Ashkan","unexpected":true}`,
		`{"version":1,"type":"join","name":"Ashkan"}{"version":1,"type":"join","name":"Ali"}`,
	}
	for _, payload := range cases {
		var message Message
		if err := decodeMessage([]byte(payload), &message); err == nil {
			t.Fatalf("decodeMessage(%s) succeeded, want error", payload)
		}
	}
}
