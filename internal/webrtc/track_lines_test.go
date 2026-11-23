package webrtc

import (
	"testing"

	pion "github.com/pion/webrtc/v4"
)

func negotiateTestLines(t *testing.T, offerer, answerer *pion.PeerConnection) {
	t.Helper()
	offer, err := offerer.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create offer: %v", err)
	}
	if err := offerer.SetLocalDescription(offer); err != nil {
		t.Fatalf("set local offer: %v", err)
	}
	if err := answerer.SetRemoteDescription(offer); err != nil {
		t.Fatalf("set remote offer: %v", err)
	}
	answer, err := answerer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create answer: %v", err)
	}
	if err := answerer.SetLocalDescription(answer); err != nil {
		t.Fatalf("set local answer: %v", err)
	}
	if err := offerer.SetRemoteDescription(answer); err != nil {
		t.Fatalf("set remote answer: %v", err)
	}
}

// AddTrack reuses a media line whose track was removed; AddTrackOnNewLine does
// not, and its line is the last one, which is what a receiver's browser needs
// when the same offer removes a track with the same IDs from an earlier line.
func TestAddTrackOnNewLineAppendsALine(t *testing.T) {
	server, err := NewPeer(nil)
	if err != nil {
		t.Fatal(err)
	}
	browser, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = server.Close()
		_ = browser.Close()
	})
	if _, err := browser.AddTransceiverFromKind(pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly}); err != nil {
		t.Fatal(err)
	}
	negotiateTestLines(t, browser, server.Connection())

	newTrack := func(id string) *pion.TrackLocalStaticRTP {
		track, err := pion.NewTrackLocalStaticRTP(
			pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000}, id, "stream")
		if err != nil {
			t.Fatal(err)
		}
		return track
	}
	lines := func() []*pion.RTPTransceiver { return server.Connection().GetTransceivers() }
	remove := func(sender *pion.RTPSender) {
		if err := server.RemoveTrack(sender); err != nil {
			t.Fatalf("remove track: %v", err)
		}
		negotiateTestLines(t, server.Connection(), browser)
	}

	first, err := server.AddTrack(newTrack("first"))
	if err != nil {
		t.Fatal(err)
	}
	negotiateTestLines(t, server.Connection(), browser)
	if got := len(lines()); got != 1 {
		t.Fatalf("media lines after the first track = %d, want 1", got)
	}
	remove(first)

	second, err := server.AddTrack(newTrack("second"))
	if err != nil {
		t.Fatal(err)
	}
	negotiateTestLines(t, server.Connection(), browser)
	if got := len(lines()); got != 1 {
		t.Fatalf("media lines after AddTrack on a freed line = %d, want the line reused", got)
	}
	remove(second)

	third, err := server.AddTrackOnNewLine(newTrack("third"))
	if err != nil {
		t.Fatal(err)
	}
	current := lines()
	if len(current) != 2 {
		t.Fatalf("media lines after AddTrackOnNewLine = %d, want 2", len(current))
	}
	if current[len(current)-1].Sender() != third {
		t.Fatal("the new track is not on the last media line")
	}
	if got := current[len(current)-1].Direction(); got != pion.RTPTransceiverDirectionSendonly {
		t.Fatalf("new line direction = %s, want sendonly", got)
	}
	negotiateTestLines(t, server.Connection(), browser)
}
