package media

import (
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/pion/rtp"
)

// A four-person room where one participant is on a very good link and the
// others are not: one publication fans out to receivers whose egress ranges
// from healthy to saturated. These tests pin that saturated receivers never
// delay or degrade the healthy ones, for every healthy/saturated split, and
// that NACK-driven repairs for several lossy receivers stay off the healthy
// receiver.

// mixedRoomPublication builds a video publication with healthyCount healthy
// targets (full mailbox depth) and saturatedCount targets whose depth-1
// mailbox is already full, plus an audio publication serving the same
// receivers.
func mixedRoomPublication(healthyCount, saturatedCount, limiterRate int) (
	router *Router, video, audio *publication, healthy, saturated []*publicationTarget, audioTargets []*publicationTarget,
) {
	router = NewRouter()
	video = &publication{tracks: map[string]*publicationTarget{}, limiter: newBitrateLimiter(limiterRate)}
	audio = &publication{tracks: map[string]*publicationTarget{}}
	audioClock := time.Now()
	for i := 0; i < healthyCount+saturatedCount; i++ {
		name := fmt.Sprintf("receiver-%d", i)
		var target *publicationTarget
		if i < healthyCount {
			target = newPublicationTarget(nil, targetVideoQueueDepth)
			healthy = append(healthy, target)
		} else {
			target = newPublicationTarget(nil, 1)
			target.enqueue(&rtp.Packet{})
			saturated = append(saturated, target)
		}
		video.tracks[name] = target
		// Audio targets get the same mailbox Router.newTarget gives a real
		// audio publication's receivers. Its clock is frozen so a descheduled
		// test goroutine cannot age the packet past maxAudioMailboxAge before
		// the test reads it back.
		audioTarget := newPublicationTarget(nil, targetAudioQueueDepth)
		audioTarget.audio = newAudioMailbox(&router.audioDrops, func() time.Time { return audioClock })
		audio.tracks[name] = audioTarget
		audioTargets = append(audioTargets, audioTarget)
	}
	return router, video, audio, healthy, saturated, audioTargets
}

// mixedRoomStartPacer runs the publication's video pacer until the returned
// stop function is called. Stop waits for the pacer to exit, so every packet
// it already took from the frame queue has been offered to every target.
func mixedRoomStartPacer(t *testing.T, router *Router, pub *publication, frames chan videoFrame) func() {
	t.Helper()
	stop, finished := make(chan struct{}), make(chan struct{})
	go func() { defer close(finished); router.forwardVideoFrames(pub, frames, stop) }()
	var once sync.Once
	stopPacer := func() { once.Do(func() { close(stop); <-finished }) }
	t.Cleanup(stopPacer)
	return stopPacer
}

func mixedRoomReceive(t *testing.T, target *publicationTarget, name string) *rtp.Packet {
	t.Helper()
	select {
	case packet := <-target.pending:
		return packet
	case <-time.After(3 * time.Second):
		t.Fatalf("%s did not receive a packet", name)
		return nil
	}
}

// mixedRoomIngest is the per-packet tail of Router.forwardVideo: an ingress
// packet goes through the frame buffer, and a retransmitted packet becomes
// one single-packet repair frame carrying every target that lost it. It
// returns that repair frame's targets, or nil when the packet was not a repair.
func mixedRoomIngest(router *Router, pub *publication, buffer *videoFrameBuffer, history *videoFrameHistory,
	frames chan videoFrame, packet *rtp.Packet,
) []*publicationTarget {
	if !queueVideoPacket(pub, buffer, history, frames, packet) {
		return nil
	}
	targets := router.videoLossTargets(pub, packet)
	if len(targets) > 0 {
		enqueueVideoFrame(frames, videoFrame{packets: []*rtp.Packet{packet}, repairTargets: targets})
	}
	return targets
}

func TestThreeSaturatedTargetsDoNotDelayHealthyTarget(t *testing.T) {
	tests := []struct {
		healthy   int
		saturated int
	}{
		{healthy: 1, saturated: 3},
		{healthy: 2, saturated: 2},
		{healthy: 3, saturated: 1},
	}
	for _, test := range tests {
		t.Run(fmt.Sprintf("%d healthy %d saturated", test.healthy, test.saturated), func(t *testing.T) {
			// 1 Mbps: a 24-packet (28.8 KB) frame paces for ~130ms past the
			// 12.5 KB burst, so the pacer is still busy when audio fires.
			router, video, audio, healthy, saturated, audioTargets := mixedRoomPublication(test.healthy, test.saturated, 125_000)
			frames := make(chan videoFrame, maxQueuedVideoFrames)
			mixedRoomStartPacer(t, router, video, frames)

			packets := fastLinkFramePackets(9_000, 4_000, targetVideoQueueDepth)
			frames <- videoFrame{packets: packets}

			audioPacket := &rtp.Packet{Header: rtp.Header{SequenceNumber: 77}}
			audioStart := time.Now()
			router.forwardAudioPacket(audio, audioPacket)
			// forwardAudioPacket hands the packet to every receiver's mailbox
			// before it returns; nothing on the audio path waits for the video
			// pacer or for the saturated receivers' video mailboxes.
			if elapsed := time.Since(audioStart); elapsed > 250*time.Millisecond {
				t.Fatalf("audio fan-out took %s while video was paced", elapsed)
			}
			for i, target := range audioTargets {
				if got := target.audio.next(); got != audioPacket {
					t.Fatalf("audio target %d mailbox holds %v, want the forwarded audio packet", i, got)
				}
			}
			if drops := router.AudioDrops(); drops.QueueOverflow != 0 || drops.QueueExpired != 0 {
				t.Fatalf("audio fan-out dropped packets while video was paced: %+v", drops)
			}

			for index, target := range healthy {
				name := fmt.Sprintf("healthy target %d", index)
				for i, want := range packets {
					if got := mixedRoomReceive(t, target, name); got != want {
						t.Fatalf("%s packet %d = seq %d, want seq %d (every original, in order)",
							name, i, got.SequenceNumber, want.SequenceNumber)
					}
				}
			}
			// A barrier frame reaching every healthy target proves the pacer has
			// offered the whole previous frame to every target.
			barrier := fastLinkFramePackets(12_000, 4_000+targetVideoQueueDepth, 1)[0]
			frames <- videoFrame{packets: []*rtp.Packet{barrier}}
			for index, target := range healthy {
				if got := mixedRoomReceive(t, target, fmt.Sprintf("healthy target %d", index)); got != barrier {
					t.Fatalf("healthy target %d got seq %d after the frame, want the barrier", index, got.SequenceNumber)
				}
			}

			for index, target := range healthy {
				if target.videoLosses.Load() != nil {
					t.Fatalf("healthy target %d recorded a loss caused by saturated receivers", index)
				}
			}
			for index, target := range saturated {
				for _, packet := range packets {
					if !target.hasVideoLoss(packet) {
						t.Fatalf("saturated target %d did not record the loss of seq %d", index, packet.SequenceNumber)
					}
				}
				if len(target.pending) != 1 {
					t.Fatalf("saturated target %d mailbox holds %d packets, want only its stalled one", index, len(target.pending))
				}
			}
		})
	}
}

func TestRetransmitRepairsForThreeLossyTargetsKeepHealthyOriginals(t *testing.T) {
	router := NewRouter()
	healthy := newPublicationTarget(nil, targetVideoQueueDepth)
	// Three lossy receivers drop different parts of the same frame: lossyAll
	// is stalled with a full mailbox, lossyTail has room for three of the six
	// packets and lossyLast for five.
	lossyAll := newPublicationTarget(nil, 4)
	lossyTail := newPublicationTarget(nil, 4)
	lossyLast := newPublicationTarget(nil, 5)
	var fillers []*rtp.Packet
	for i := 0; i < 4; i++ {
		filler := &rtp.Packet{}
		fillers = append(fillers, filler)
		lossyAll.enqueue(filler)
	}
	tailFiller := &rtp.Packet{}
	lossyTail.enqueue(tailFiller)
	pub := &publication{
		tracks: map[string]*publicationTarget{
			"healthy":    healthy,
			"lossy-all":  lossyAll,
			"lossy-tail": lossyTail,
			"lossy-last": lossyLast,
		},
		limiter: newBitrateLimiter(3_000_000 / 8),
	}
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	var buffer videoFrameBuffer
	var history videoFrameHistory

	// Phase 1: the original frame reaches the healthy receiver whole while each
	// lossy receiver's mailbox records its own drops.
	stopOriginals := mixedRoomStartPacer(t, router, pub, frames)
	originals := fastLinkFramePackets(3_000, 1_000, 6)
	for _, packet := range originals {
		if targets := mixedRoomIngest(router, pub, &buffer, &history, frames, packet); targets != nil {
			t.Fatalf("original seq %d was treated as a repair", packet.SequenceNumber)
		}
	}
	for i, want := range originals {
		if got := mixedRoomReceive(t, healthy, "healthy"); got != want {
			t.Fatalf("healthy original %d = seq %d, want seq %d", i, got.SequenceNumber, want.SequenceNumber)
		}
	}
	stopOriginals()

	wantLost := map[*publicationTarget][]int{
		healthy:   nil,
		lossyAll:  {0, 1, 2, 3, 4, 5},
		lossyTail: {3, 4, 5},
		lossyLast: {5},
	}
	names := map[*publicationTarget]string{healthy: "healthy", lossyAll: "lossy-all", lossyTail: "lossy-tail", lossyLast: "lossy-last"}
	assertLosses := func(phase string, want map[*publicationTarget][]int) {
		t.Helper()
		for target, lostIndexes := range want {
			lost := make(map[int]bool, len(lostIndexes))
			for _, index := range lostIndexes {
				lost[index] = true
			}
			for index, packet := range originals {
				if got := target.hasVideoLoss(packet); got != lost[index] {
					t.Fatalf("%s: %s loss of original %d = %t, want %t", phase, names[target], index, got, lost[index])
				}
			}
		}
	}
	assertLosses("after originals", wantLost)

	// The lossy receivers' writers catch up and drain what they accepted.
	for i, filler := range fillers {
		if got := mixedRoomReceive(t, lossyAll, "lossy-all"); got != filler {
			t.Fatalf("lossy-all drained packet %d is not its stalled filler", i)
		}
	}
	if got := mixedRoomReceive(t, lossyTail, "lossy-tail"); got != tailFiller {
		t.Fatal("lossy-tail first drained packet is not its stalled filler")
	}
	for _, check := range []struct {
		target *publicationTarget
		count  int
	}{{lossyTail, 3}, {lossyLast, 5}} {
		for i := 0; i < check.count; i++ {
			if got := mixedRoomReceive(t, check.target, names[check.target]); got != originals[i] {
				t.Fatalf("%s accepted original %d = seq %d, want seq %d",
					names[check.target], i, got.SequenceNumber, originals[i].SequenceNumber)
			}
		}
	}

	// Phase 2: the publisher answers NACKs for originals 0, 3 and 5. Each
	// retransmitted ingress packet becomes one repair frame carrying every
	// target that lost it.
	stopRepairs := mixedRoomStartPacer(t, router, pub, frames)
	retransmit := func(index int) *rtp.Packet {
		original := originals[index]
		copied := *original
		copied.Payload = append([]byte(nil), original.Payload...)
		return &copied
	}
	repairs := map[int]*rtp.Packet{0: retransmit(0), 3: retransmit(3), 5: retransmit(5)}
	wantRepairTargets := map[int][]*publicationTarget{
		0: {lossyAll},
		3: {lossyAll, lossyTail},
		5: {lossyAll, lossyTail, lossyLast},
	}
	for _, index := range []int{0, 3, 5} {
		targets := mixedRoomIngest(router, pub, &buffer, &history, frames, repairs[index])
		if !sameMixedRoomTargets(targets, wantRepairTargets[index]) {
			t.Fatalf("repair frame for original %d carries %d targets, want %d (one frame for every lossy target)",
				index, len(targets), len(wantRepairTargets[index]))
		}
	}
	barrier := fastLinkFramePackets(6_000, 1_006, 1)[0]
	if targets := mixedRoomIngest(router, pub, &buffer, &history, frames, barrier); targets != nil {
		t.Fatal("the next original frame was treated as a repair")
	}

	wantDelivered := []struct {
		target  *publicationTarget
		packets []*rtp.Packet
	}{
		{healthy, []*rtp.Packet{barrier}},
		{lossyAll, []*rtp.Packet{repairs[0], repairs[3], repairs[5], barrier}},
		{lossyTail, []*rtp.Packet{repairs[3], repairs[5], barrier}},
		{lossyLast, []*rtp.Packet{repairs[5], barrier}},
	}
	for _, want := range wantDelivered {
		for i, packet := range want.packets {
			if got := mixedRoomReceive(t, want.target, names[want.target]); got != packet {
				t.Fatalf("%s delivery %d = seq %d (ts %d), want seq %d (ts %d)",
					names[want.target], i, got.SequenceNumber, got.Timestamp, packet.SequenceNumber, packet.Timestamp)
			}
		}
	}
	stopRepairs()
	for target, name := range names {
		if queued := len(target.pending); queued != 0 {
			t.Fatalf("%s holds %d extra packets after the barrier", name, queued)
		}
	}

	// Repaired losses are cleared; the ones nobody retransmitted stay pending.
	assertLosses("after repairs", map[*publicationTarget][]int{
		healthy:   nil,
		lossyAll:  {1, 2, 4},
		lossyTail: {4},
		lossyLast: nil,
	})
}

func sameMixedRoomTargets(got, want []*publicationTarget) bool {
	if len(got) != len(want) {
		return false
	}
	for _, target := range want {
		found := false
		for _, candidate := range got {
			if candidate == target {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
