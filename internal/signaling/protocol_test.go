package signaling

import "testing"

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
