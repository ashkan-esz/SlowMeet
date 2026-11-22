package webrtc

import (
	"strings"
	"testing"

	pion "github.com/pion/webrtc/v4"
)

// A browser that first offers its camera with some simulcast layers paused
// (`a=simulcast:send low;~medium;~high`) must not have those pause marks
// echoed back: Chrome applies the remote description's marks to its
// encodings on every renegotiation, so an echoed `~medium` switched the
// medium layer off again each time the SFU renegotiated (B12).
func TestSFUDoesNotEchoSimulcastPauseMarks(t *testing.T) {
	mediaEngine := &pion.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		t.Fatalf("register codecs: %v", err)
	}
	if err := pion.ConfigureSimulcastExtensionHeaders(mediaEngine); err != nil {
		t.Fatalf("configure simulcast extensions: %v", err)
	}
	browser, err := pion.NewAPI(pion.WithMediaEngine(mediaEngine)).NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create browser peer: %v", err)
	}
	defer browser.Close()
	if _, err := browser.AddTransceiverFromKind(pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionSendonly}); err != nil {
		t.Fatalf("add video transceiver: %v", err)
	}
	offer, err := browser.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if !strings.Contains(offer.SDP, "a=sendonly\r\n") {
		t.Fatalf("offer has no sendonly video section:\n%s", offer.SDP)
	}
	offer.SDP = strings.Replace(offer.SDP, "a=sendonly\r\n",
		"a=sendonly\r\na=rid:low send\r\na=rid:medium send\r\na=rid:high send\r\na=simulcast:send low;~medium;~high\r\n", 1)

	sfu, err := newPeerWithPortRange(pion.Configuration{}, 0, 0, false, "")
	if err != nil {
		t.Fatalf("create SFU peer: %v", err)
	}
	defer sfu.Close()
	if err := sfu.Connection().SetRemoteDescription(offer); err != nil {
		t.Fatalf("set browser offer: %v", err)
	}
	answer, err := sfu.Connection().CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create answer: %v", err)
	}
	if !strings.Contains(answer.SDP, "a=simulcast:recv low;medium;high\r\n") {
		t.Fatalf("SFU answer does not receive all three layers unpaused:\n%s", answer.SDP)
	}
}
