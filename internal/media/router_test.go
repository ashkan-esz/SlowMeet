package media

import (
	"testing"
	"time"

	"SlowMeet/internal/webrtc"
	"github.com/pion/rtcp"
	pion "github.com/pion/webrtc/v4"
)

func TestRouteRTCPFeedbackTargetsSourceTrack(t *testing.T) {
	const sourceSSRC = 1234
	pli := &rtcp.PictureLossIndication{SenderSSRC: 10, MediaSSRC: 20}
	fir := &rtcp.FullIntraRequest{
		SenderSSRC: 11,
		MediaSSRC:  21,
		FIR:        []rtcp.FIREntry{{SSRC: 22, SequenceNumber: 3}},
	}
	routed := routeRTCPFeedback([]rtcp.Packet{pli, fir}, sourceSSRC)
	if len(routed) != 2 {
		t.Fatalf("routed packet count = %d, want 2", len(routed))
	}
	routedPLI, ok := routed[0].(*rtcp.PictureLossIndication)
	if !ok || routedPLI.MediaSSRC != sourceSSRC || routedPLI.SenderSSRC != pli.SenderSSRC {
		t.Fatalf("routed PLI = %+v, want source SSRC %d", routed[0], sourceSSRC)
	}
	routedFIR, ok := routed[1].(*rtcp.FullIntraRequest)
	if !ok || routedFIR.MediaSSRC != sourceSSRC || len(routedFIR.FIR) != 1 || routedFIR.FIR[0].SSRC != sourceSSRC {
		t.Fatalf("routed FIR = %+v, want source SSRC %d", routed[1], sourceSSRC)
	}
	if pli.MediaSSRC != 20 || fir.MediaSSRC != 21 || fir.FIR[0].SSRC != 22 {
		t.Fatal("routing feedback mutated the receiver's RTCP packets")
	}
}

func TestBitrateLimiterDropsWithoutQueueingAndRefills(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(100_000, func() time.Time { return now })

	if !limiter.allow(10_000) {
		t.Fatal("initial burst should be allowed")
	}
	if limiter.allow(1) {
		t.Fatal("packet should be dropped when the bucket is empty")
	}

	now = now.Add(10 * time.Millisecond)
	if !limiter.allow(100) {
		t.Fatal("packet should be allowed after the bucket refills")
	}
}

func TestBitrateLimiterZeroRateDoesNotShape(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(0, func() time.Time { return now })

	if !limiter.allow(1_000_000) {
		t.Fatal("zero rate should disable shaping")
	}
}

func TestBitrateLimiterSetRateAppliesImmediately(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newBitrateLimiterAt(0, func() time.Time { return now })
	limiter.setRate(100_000)

	if !limiter.allow(10_000) {
		t.Fatal("new rate should allow an initial burst")
	}
	if limiter.allow(1) {
		t.Fatal("new rate should be enforced immediately")
	}
}

func TestBitrateLimiterCapsVideoFramesWithoutQueueing(t *testing.T) {
	limiter := newBitrateLimiterAt(0, time.Now)
	limiter.setFPS(10)

	if !limiter.allowFrame(0) {
		t.Fatal("first frame should be allowed")
	}
	if limiter.allowFrame(4_500) {
		t.Fatal("frame inside the FPS interval should be dropped")
	}
	if !limiter.allowFrame(9_000) {
		t.Fatal("frame at the FPS interval should be allowed")
	}
	if !limiter.allowFrame(9_000) {
		t.Fatal("packets from an allowed frame should remain allowed")
	}
}

func TestRouterSetLimitsUpdatesExistingPublication(t *testing.T) {
	router := NewRouter(Limits{MaxAudioBitrate: 64_000, MaxVideoBitrate: 500_000, MaxVideoFPS: 30})
	router.SetLimits(Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 180_000, MaxVideoFPS: 10})

	if router.limits != (Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 180_000, MaxVideoFPS: 10}) {
		t.Fatalf("router limits = %+v, want audio=32000 video=180000 fps=10", router.limits)
	}
}

func TestUnregisterRemovesSourcePublicationsAndSubscriptions(t *testing.T) {
	router := NewRouter()
	sourcePeer := &webrtc.Peer{}
	targetPeer := &webrtc.Peer{}
	router.peers["source"] = sourcePeer
	router.peers["target"] = targetPeer
	router.offerers["source"] = func() error { return nil }
	router.offerers["target"] = func() error { return nil }
	router.pubs["source/audio"] = &publication{
		sourceID: "source",
		tracks:   map[string]*pion.TrackLocalStaticRTP{"target": nil},
	}
	router.pubs["other/audio"] = &publication{
		sourceID: "other",
		tracks:   map[string]*pion.TrackLocalStaticRTP{"source": nil, "target": nil},
	}
	router.SetVideoSubscriptions("source", []string{"other"})

	router.Unregister("source")

	if _, exists := router.peers["source"]; exists {
		t.Fatal("source peer was not removed")
	}
	if _, exists := router.offerers["source"]; exists {
		t.Fatal("source offerer was not removed")
	}
	if _, exists := router.videoSubscriptionsSet["source"]; exists {
		t.Fatal("source video subscription preference was not removed")
	}
	if _, exists := router.pubs["source/audio"]; exists {
		t.Fatal("source publication was not removed")
	}
	if _, exists := router.pubs["other/audio"].tracks["source"]; exists {
		t.Fatal("source subscription was not removed")
	}
	if _, exists := router.pubs["other/audio"].tracks["target"]; !exists {
		t.Fatal("unrelated subscription was removed")
	}
}

func TestUnregisterRemovesPublisherLayerSendersFromReceivers(t *testing.T) {
	router := NewRouter()
	receiver, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create receiver peer: %v", err)
	}
	t.Cleanup(func() { _ = receiver.Close() })
	offers := 0
	router.Register("receiver", receiver, func() error {
		offers++
		return nil
	})
	track, err := pion.NewTrackLocalStaticRTP(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
		"publisher|camera|low", "slowmeet-publisher-camera",
	)
	if err != nil {
		t.Fatalf("create layer track: %v", err)
	}
	sender, err := receiver.AddTrack(track)
	if err != nil {
		t.Fatalf("add layer sender: %v", err)
	}
	key := publicationKey("publisher", SourceRoleCamera, "low")
	router.pubs[key] = &publication{
		key: key, sourceID: "publisher", role: SourceRoleCamera, layer: "low",
		tracks:  map[string]*pion.TrackLocalStaticRTP{"receiver": track},
		senders: map[string]*pion.RTPSender{"receiver": sender},
	}

	router.Unregister("publisher")

	if _, exists := router.pubs[key]; exists {
		t.Fatal("publisher layer remained after unregister")
	}
	if got := len(receiver.Connection().GetSenders()); got != 0 {
		t.Fatalf("receiver retained %d sender(s), want 0", got)
	}
	if offers != 1 {
		t.Fatalf("receiver offers = %d, want one renegotiation", offers)
	}
}

func TestVideoSubscriptionPolicyPreservesLegacyAudioAndScreen(t *testing.T) {
	router := NewRouter()
	visibleCamera := &publication{sourceID: "visible", role: SourceRoleCamera}
	hiddenCamera := &publication{sourceID: "hidden", role: SourceRoleCamera}
	audio := &publication{sourceID: "hidden", role: SourceRoleAudio}
	screen := &publication{sourceID: "hidden", role: SourceRoleScreen}

	if !router.shouldSubscribeLocked(hiddenCamera, "receiver") {
		t.Fatal("receivers without preferences should keep legacy all-camera behavior")
	}
	router.SetVideoSubscriptions("receiver", []string{"visible"})
	if !router.shouldSubscribeLocked(visibleCamera, "receiver") {
		t.Fatal("visible camera was not allowed")
	}
	if router.shouldSubscribeLocked(hiddenCamera, "receiver") {
		t.Fatal("off-page camera was allowed")
	}
	if !router.shouldSubscribeLocked(audio, "receiver") {
		t.Fatal("audio subscription must remain unconditional")
	}
	if !router.shouldSubscribeLocked(screen, "receiver") {
		t.Fatal("screen share subscription must remain unconditional")
	}
	router.SetVideoSubscriptions("receiver", nil)
	if router.shouldSubscribeLocked(visibleCamera, "receiver") {
		t.Fatal("an empty subscription list should disable all camera tracks")
	}
}

func TestSetVideoSubscriptionsAddsAndRemovesCameraTracks(t *testing.T) {
	router := NewRouter()
	peer, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create receiver peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	offers := 0
	router.Register("receiver", peer, func() error {
		offers++
		return nil
	})
	publication := &publication{
		key: "camera/camera", sourceID: "camera", role: SourceRoleCamera,
		trackID: "camera|camera", streamID: "slowmeet-camera-camera",
		codec:   pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
		tracks:  make(map[string]*pion.TrackLocalStaticRTP),
		senders: make(map[string]*pion.RTPSender),
	}
	router.pubs[publication.key] = publication

	router.SetVideoSubscriptions("receiver", []string{"camera"})
	if publication.tracks["receiver"] == nil || offers != 1 {
		t.Fatalf("camera was not added and renegotiated: tracks=%v offers=%d", publication.tracks, offers)
	}
	router.SetVideoSubscriptions("receiver", nil)
	if _, exists := publication.tracks["receiver"]; exists || offers != 2 {
		t.Fatalf("camera was not removed and renegotiated: tracks=%v offers=%d", publication.tracks, offers)
	}
}

func TestSetVideoSubscriptionsLayerSwitchDoesNotRenegotiate(t *testing.T) {
	router := NewRouter()
	peer, err := webrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create receiver peer: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })
	offers := 0
	router.Register("receiver", peer, func() error {
		offers++
		return nil
	})
	for _, layer := range []string{"low", "medium", "high"} {
		key := publicationKey("camera", SourceRoleCamera, layer)
		router.pubs[key] = &publication{
			key: key, sourceID: "camera", role: SourceRoleCamera, layer: layer,
			trackID: "camera|camera|" + layer, streamID: "slowmeet-camera-camera",
			codec:  pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90000},
			tracks: make(map[string]*pion.TrackLocalStaticRTP), senders: make(map[string]*pion.RTPSender),
		}
	}

	router.SetVideoSubscriptionsWithLayer("receiver", []string{"camera"}, "medium")
	if offers != 1 {
		t.Fatalf("offers after pre-negotiating 3 layer tracks = %d, want 1", offers)
	}
	for _, layer := range []string{"low", "medium", "high"} {
		if router.pubs[publicationKey("camera", SourceRoleCamera, layer)].tracks["receiver"] == nil {
			t.Errorf("camera %s layer was not pre-negotiated", layer)
		}
	}
	router.SetVideoSubscriptionsWithLayer("receiver", []string{"camera"}, "low")
	if offers != 1 {
		t.Fatalf("layer switch caused renegotiation: offers = %d, want 1", offers)
	}
	if got := router.cameraLayers["receiver"]; got != "low" {
		t.Fatalf("selected camera layer = %q, want low", got)
	}
}

func TestRemovePublicationDoesNotDeleteReplacement(t *testing.T) {
	router := NewRouter()
	old := &publication{
		key:      "source/audio",
		sourceID: "source",
	}
	replacement := &publication{
		key:      "source/audio",
		sourceID: "source",
	}
	router.pubs["source/audio"] = replacement

	router.removePublication(old)

	if got := router.pubs["source/audio"]; got != replacement {
		t.Fatal("replacement publication was deleted by stale forwarder")
	}
}

func TestRolePublicationIdentity(t *testing.T) {
	for _, test := range []struct {
		role     SourceRole
		key      string
		trackID  string
		streamID string
	}{
		{SourceRoleAudio, "p1/audio", "p1|audio", "slowmeet-p1-audio"},
		{SourceRoleCamera, "p1/camera", "p1|camera", "slowmeet-p1-camera"},
		{SourceRoleScreen, "p1/screen", "p1|screen", "slowmeet-p1-screen"},
	} {
		pub := &publication{
			key: test.key, sourceID: "p1", role: test.role,
			trackID: test.trackID, streamID: test.streamID,
		}
		if pub.key != test.key || pub.trackID != test.trackID || pub.streamID != test.streamID {
			t.Fatalf("publication identity = %+v, want key=%q track=%q stream=%q", pub, test.key, test.trackID, test.streamID)
		}
	}
}

func TestUnpublishRemovesOnlySelectedRole(t *testing.T) {
	router := NewRouter()
	router.pubs["p1/audio"] = &publication{key: "p1/audio", sourceID: "p1", role: SourceRoleAudio}
	router.pubs["p1/camera"] = &publication{key: "p1/camera", sourceID: "p1", role: SourceRoleCamera}
	router.pubs["p1/screen"] = &publication{key: "p1/screen", sourceID: "p1", role: SourceRoleScreen}

	router.Unpublish("p1", SourceRoleScreen)

	if _, exists := router.pubs["p1/screen"]; exists {
		t.Fatal("screen publication was not removed")
	}
	if _, exists := router.pubs["p1/audio"]; !exists {
		t.Fatal("audio publication was removed with screen")
	}
	if _, exists := router.pubs["p1/camera"]; !exists {
		t.Fatal("camera publication was removed with screen")
	}
}

func TestUnpublishRemovesEveryCameraLayer(t *testing.T) {
	router := NewRouter()
	for _, layer := range []string{"low", "medium", "high"} {
		key := publicationKey("p1", SourceRoleCamera, layer)
		router.pubs[key] = &publication{key: key, sourceID: "p1", role: SourceRoleCamera, layer: layer}
	}
	router.pubs["p1/audio"] = &publication{key: "p1/audio", sourceID: "p1", role: SourceRoleAudio}

	router.Unpublish("p1", SourceRoleCamera)

	for _, layer := range []string{"low", "medium", "high"} {
		if _, exists := router.pubs[publicationKey("p1", SourceRoleCamera, layer)]; exists {
			t.Errorf("camera %s publication remains after unpublish", layer)
		}
	}
	if _, exists := router.pubs["p1/audio"]; !exists {
		t.Fatal("audio publication was removed with camera layers")
	}
}

func TestCameraLayerFromRID(t *testing.T) {
	for _, test := range []struct{ rid, want string }{
		{"low", "low"}, {"medium", "medium"}, {"high", "high"},
		{"q", "low"}, {"h", "medium"}, {"f", "high"}, {"", ""}, {"unknown", ""},
	} {
		if got := CameraLayerFromRID(test.rid); got != test.want {
			t.Errorf("CameraLayerFromRID(%q) = %q, want %q", test.rid, got, test.want)
		}
	}
}
