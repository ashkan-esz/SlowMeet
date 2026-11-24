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

// A media line whose track was removed carries the next track, so a viewer's
// session description does not grow with every publisher that comes and goes
// or changes codec. (Browsers find the stream on the reused line through the
// mid the router writes on forwarded packets.)
func TestAddTrackReusesAFreedMediaLine(t *testing.T) {
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

	third, err := server.AddTrack(newTrack("third"))
	if err != nil {
		t.Fatal(err)
	}
	negotiateTestLines(t, server.Connection(), browser)
	if got := len(lines()); got != 1 {
		t.Fatalf("media lines after a third track = %d, want still 1", got)
	}
	remove(third)
}
