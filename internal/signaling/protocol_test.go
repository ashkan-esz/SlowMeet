package signaling

import "testing"

func TestValidateJoinMessage(t *testing.T) {
	msg := Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"}
	if err := msg.Validate(); err != nil {
		t.Fatalf("Validate() error = %v", err)
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
