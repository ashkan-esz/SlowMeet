package signaling

import (
	"strings"
	"testing"

	"SlowMeet/internal/webrtc"
	pion "github.com/pion/webrtc/v4"
)

func TestEnableOpusDTXMarksOnlyOpus(t *testing.T) {
	sdp := "v=0\r\n" +
		"m=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\n" +
		"a=rtpmap:111 opus/48000/2\r\n" +
		"a=fmtp:111 minptime=10;useinbandfec=1\r\n" +
		"a=rtpmap:63 red/48000/2\r\n" +
		"a=fmtp:63 111/111\r\n" +
		"m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n" +
		"a=rtpmap:96 VP8/90000\r\n" +
		"a=fmtp:97 apt=96\r\n"
	got := enableOpusDTX(sdp)
	want := strings.Replace(sdp, "useinbandfec=1\r\n", "useinbandfec=1;usedtx=1\r\n", 1)
	if got != want {
		t.Fatalf("enableOpusDTX =\n%q\nwant\n%q", got, want)
	}
	if again := enableOpusDTX(got); again != got {
		t.Fatalf("enableOpusDTX is not idempotent:\n%q", again)
	}
	if untouched := "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n"; enableOpusDTX(untouched) != untouched {
		t.Fatal("an SDP without Opus must be returned unchanged")
	}
	// A final line without a terminator is still handled.
	if got := enableOpusDTX("a=fmtp:111 useinbandfec=1"); got != "a=fmtp:111 useinbandfec=1;usedtx=1" {
		t.Fatalf("unterminated line = %q", got)
	}
}

// The marker must land on the Opus line of a real server offer, once per audio
// section, and the result must still be a description a peer accepts.
func TestEnableOpusDTXOnServerOffer(t *testing.T) {
	server, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	for _, kind := range []pion.RTPCodecType{pion.RTPCodecTypeAudio, pion.RTPCodecTypeVideo} {
		if _, err := server.Connection().AddTransceiverFromKind(kind); err != nil {
			t.Fatal(err)
		}
	}
	offer, err := server.CreateOffer(false)
	if err != nil {
		t.Fatal(err)
	}
	marked := enableOpusDTX(offer)
	if count := strings.Count(marked, "usedtx=1"); count != 1 {
		t.Fatalf("usedtx=1 appears %d times, want once:\n%s", count, marked)
	}
	if !strings.Contains(marked, "useinbandfec=1;usedtx=1") {
		t.Fatalf("usedtx=1 is not on the Opus fmtp line:\n%s", marked)
	}
	browser, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatal(err)
	}
	defer browser.Close()
	if err := browser.SetRemoteOffer(marked); err != nil {
		t.Fatalf("marked offer rejected: %v", err)
	}
	if _, err := browser.CreateAnswer(); err != nil {
		t.Fatalf("answer to marked offer: %v", err)
	}

	c := &client{}
	if c.outboundSDP(offer) != offer {
		t.Fatal("outboundSDP changed the SDP with DTX disabled")
	}
	c.opusDTX = true
	if c.outboundSDP(offer) != marked {
		t.Fatal("outboundSDP did not mark the SDP with DTX enabled")
	}
}
