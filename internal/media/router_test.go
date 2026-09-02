package media

import (
	"testing"

	"SlowMeet/internal/webrtc"
	pion "github.com/pion/webrtc/v4"
)

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

	router.Unregister("source")

	if _, exists := router.peers["source"]; exists {
		t.Fatal("source peer was not removed")
	}
	if _, exists := router.offerers["source"]; exists {
		t.Fatal("source offerer was not removed")
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
