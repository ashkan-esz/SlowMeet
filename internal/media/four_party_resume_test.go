package media

import (
	"testing"
	"time"

	"github.com/pion/rtcp"
	pion "github.com/pion/webrtc/v4"
)

// newFourPartyMesh brings up the four-person room of
// TestRouterForwardsFourPartyFullMesh: everyone publishes audio and a camera
// and receives everyone else's.
func newFourPartyMesh(t *testing.T) (*fourPartyRoom, []string) {
	t.Helper()
	room := newFourPartyRoom(t)
	ids := []string{"p1", "p2", "p3", "p4"}
	for _, id := range ids {
		room.join(t, id)
	}
	for _, id := range ids {
		room.subscribeCameras(id, fourPartyOthers(ids, id))
	}
	for _, id := range ids {
		room.connectUplink(t, id)
	}
	for _, id := range ids {
		room.members[id].startMedia(t)
	}
	room.awaitMesh(t, ids...)
	room.awaitOffers(t, nil, ids...)
	for _, id := range ids {
		room.renegotiateDownlink(t, id)
	}
	for _, id := range ids {
		room.members[id].awaitMedia(t, nil, fourPartyOthers(ids, id)...)
	}
	return room, ids
}

// resume replaces a member the way a signaling resume does: the old browser
// is gone (its media stops) but its SFU peer stays open for the superseded
// close delay, and a brand-new client and SFU peer register under the same ID.
func (room *fourPartyRoom) resume(t *testing.T, id string) *fourPartyMember {
	t.Helper()
	old := room.members[id]
	old.stopMedia()
	t.Cleanup(func() {
		_ = old.client.Close()
		_ = old.sfu.Close()
	})
	return room.join(t, id)
}

func (room *fourPartyRoom) awaitPublishedFrom(t *testing.T, member *fourPartyMember) {
	t.Helper()
	deadline := time.Now().Add(routerIntegrationTimeout)
	for time.Now().Before(deadline) {
		if room.router.PublicationSource(member.id, SourceRoleAudio) == member.sfu &&
			room.router.PublicationSource(member.id, SourceRoleCamera) == member.sfu {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s's publications never moved to its resumed peer", member.id)
}

func cameraSender(t *testing.T, member *fourPartyMember) *pion.RTPSender {
	t.Helper()
	for _, sender := range member.client.GetSenders() {
		if track := sender.Track(); track != nil && track.ID() == member.camera.ID() {
			return sender
		}
	}
	t.Fatalf("%s has no camera sender", member.id)
	return nil
}

// remoteSSRC is the SSRC a member receives a remote track on.
func remoteSSRC(t *testing.T, member *fourPartyMember, trackID string) uint32 {
	t.Helper()
	for _, receiver := range member.client.GetReceivers() {
		if track := receiver.Track(); track != nil && track.ID() == trackID {
			return uint32(track.SSRC())
		}
	}
	t.Fatalf("%s does not receive %s", member.id, trackID)
	return 0
}

// keyFrameRequestReaches sends a PLI from receiver for the source's camera
// every 100 ms and reports whether one reached the source's camera sender
// within the timeout. Router-originated PLIs already in flight are drained
// first so they cannot pass for the relayed one.
func keyFrameRequestReaches(t *testing.T, receiver, source *fourPartyMember, timeout time.Duration) bool {
	t.Helper()
	feedback := rtcpFanInReadFeedback(cameraSender(t, source))
	drainUntil := time.After(1500 * time.Millisecond)
drain:
	for {
		select {
		case <-feedback.plis:
		case <-drainUntil:
			break drain
		}
	}
	ssrc := remoteSSRC(t, receiver, fourPartyTrackID(source.id, SourceRoleCamera))
	deadline := time.After(timeout)
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err := receiver.client.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: ssrc}}); err != nil {
			t.Fatalf("%s write PLI: %v", receiver.id, err)
		}
		select {
		case <-feedback.plis:
			return true
		case <-deadline:
			return false
		case <-ticker.C:
		}
	}
}

// One publisher of a four-person room resumes on a new peer connection (a
// reconnect-grace resume). The three receivers keep their existing p2 tracks:
// the router swaps the publications onto the new peer without asking any of
// them to renegotiate, media resumes on the same tracks with nothing
// misrouted, and the resumed member gets the other three back.
func TestRouterResumedCameraPublisherRebindsThreeReceivers(t *testing.T) {
	room, ids := newFourPartyMesh(t)
	receivers := fourPartyOthers(ids, "p2")

	// Control: before the resume a receiver's keyframe request reaches the
	// publisher, so the relay path itself works in this harness.
	if !keyFrameRequestReaches(t, room.members["p1"], room.members["p2"], 3*time.Second) {
		t.Fatal("control: p1's PLI for p2's camera never reached p2 before any resume")
	}

	offers := room.offerCounts()
	before := make(map[string]map[string]fourPartyStream, len(receivers))
	for _, id := range receivers {
		before[id] = room.members[id].snapshot()
	}
	fresh := room.resume(t, "p2")
	room.subscribeCameras("p2", receivers)
	room.connectUplink(t, "p2")
	fresh.startMedia(t)
	room.awaitPublishedFrom(t, fresh)

	for _, id := range receivers {
		room.members[id].awaitMedia(t, before[id], "p2")
	}
	for _, id := range receivers {
		if got := room.members[id].offers.Load(); got != offers[id] {
			t.Errorf("%s was asked to renegotiate %d times by p2's resume, want 0", id, got-offers[id])
		}
		room.members[id].assertStreams(t, fourPartyOthers(ids, id)...)
	}
	room.awaitOffers(t, map[string]int64{"p2": 0}, "p2")
	room.renegotiateDownlink(t, "p2")
	fresh.awaitMedia(t, nil, receivers...)
	fresh.assertStreams(t, receivers...)
	if t.Failed() {
		return
	}

	t.Run("receiver keyframe requests reach the resumed publisher", func(t *testing.T) {
		knownFailing(t, "B7: after a publisher resume, receivers' RTCP feedback is still relayed to the superseded "+
			"peer: relayRTCP keeps the source peer captured at subscription and migrateTargetsLocked only "+
			"updates the SSRC holder")
		if !keyFrameRequestReaches(t, room.members["p1"], fresh, 3*time.Second) {
			t.Fatal("p1's PLI for p2's camera never reached p2's resumed peer")
		}
	})
}

// All four members resume at once onto new peer connections. The room must
// converge back to a full mesh with every stream flowing and none misrouted.
func TestRouterSimultaneousResumeRebindsFourWayMesh(t *testing.T) {
	skipUnlessExtended(t)
	room, ids := newFourPartyMesh(t)
	fresh := make(map[string]*fourPartyMember, len(ids))
	for _, id := range ids {
		fresh[id] = room.resume(t, id)
	}
	for _, id := range ids {
		room.subscribeCameras(id, fourPartyOthers(ids, id))
	}
	for _, id := range ids {
		room.connectUplink(t, id)
	}
	for _, id := range ids {
		fresh[id].startMedia(t)
	}
	for _, id := range ids {
		room.awaitPublishedFrom(t, fresh[id])
	}
	room.awaitMesh(t, ids...)
	room.awaitOffers(t, map[string]int64{}, ids...)
	for _, id := range ids {
		room.renegotiateDownlink(t, id)
	}
	for _, id := range ids {
		others := fourPartyOthers(ids, id)
		fresh[id].awaitMedia(t, nil, others...)
		fresh[id].assertStreams(t, others...)
	}
}
