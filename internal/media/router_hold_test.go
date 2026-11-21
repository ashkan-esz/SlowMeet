package media

import (
	"testing"

	"github.com/pion/rtp"

	"SlowMeet/internal/webrtc"
)

// After a publication swap a receiver keeps its sender and SSRC, so the
// resumed publisher's audio must continue that receiver's sequence numbers
// and timestamps instead of jumping to the new source's own (B11).
func TestAudioRebaseContinuesSwappedStream(t *testing.T) {
	predecessor := &publicationTarget{}
	predecessor.lastAudio.Store(uint64(65534)<<32 | uint64(4_000_000_000))
	predecessor.hasLastAudio.Store(true)
	rebase := &audioRebase{predecessor: predecessor}

	shared := &rtp.Packet{Header: rtp.Header{SequenceNumber: 1200, Timestamp: 77}}
	first := rebase.apply(shared)
	if first.SequenceNumber != 65535 || first.Timestamp != 4_000_000_000+audioRebaseFrameTicks {
		t.Fatalf("first packet after the swap = seq %d ts %d, want seq 65535 ts %d",
			first.SequenceNumber, first.Timestamp, uint32(4_000_000_000+audioRebaseFrameTicks))
	}
	if shared.SequenceNumber != 1200 || shared.Timestamp != 77 {
		t.Fatal("the packet shared with other receivers was modified")
	}
	second := rebase.apply(&rtp.Packet{Header: rtp.Header{SequenceNumber: 1201, Timestamp: 77 + 960}})
	if second.SequenceNumber != 0 || second.Timestamp != 4_000_000_000+2*audioRebaseFrameTicks {
		t.Fatalf("second packet = seq %d ts %d, want the stream to continue across the wrap", second.SequenceNumber, second.Timestamp)
	}

	// A predecessor that never wrote audio leaves the new source untouched.
	untouched := (&audioRebase{predecessor: &publicationTarget{}}).apply(&rtp.Packet{Header: rtp.Header{SequenceNumber: 9, Timestamp: 10}})
	if untouched.SequenceNumber != 9 || untouched.Timestamp != 10 {
		t.Fatalf("packet without a predecessor stream = seq %d ts %d, want unchanged", untouched.SequenceNumber, untouched.Timestamp)
	}
}

// A publication whose media ends is kept while its publisher is in the
// reconnect grace window and after it resumed onto a new peer, so the resume
// swaps into the same receiver senders (B9); it is removed when the media
// ended on the publisher's current peer, or once the publisher is gone.
func TestKeepStoppedPublicationAcrossResume(t *testing.T) {
	router := NewRouter()
	oldPeer, newPeer := &webrtc.Peer{}, &webrtc.Peer{}
	pub := &publication{key: "p|camera", sourceID: "p", role: SourceRoleCamera, source: oldPeer}
	keep := func() bool {
		router.mu.RLock()
		defer router.mu.RUnlock()
		return router.keepStoppedPublicationLocked(pub)
	}

	router.Register("p", oldPeer, nil)
	if keep() {
		t.Fatal("media that ended on the publisher's current peer must be removed")
	}

	router.HoldPublications("p")
	if !keep() {
		t.Fatal("a publication must be kept while its publisher is in the grace window")
	}

	router.Register("p", newPeer, nil)
	router.mu.RLock()
	_, stillHeld := router.heldSources["p"]
	router.mu.RUnlock()
	if stillHeld {
		t.Fatal("registering the resumed peer must release the grace hold")
	}
	if !keep() {
		t.Fatal("the predecessor peer's publication must be kept for the resume to swap into")
	}
	resumed := &publication{key: "p|camera", sourceID: "p", role: SourceRoleCamera, source: newPeer}
	router.mu.RLock()
	keepResumed := router.keepStoppedPublicationLocked(resumed)
	router.mu.RUnlock()
	if keepResumed {
		t.Fatal("media that ended on the resumed peer itself must be removed")
	}

	router.HoldPublications("p")
	router.Unregister("p")
	if keep() {
		t.Fatal("an unregistered publisher's publications must not be kept")
	}
}
