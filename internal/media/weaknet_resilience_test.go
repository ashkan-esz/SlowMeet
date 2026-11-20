//go:build weaknet

package media

import (
	"fmt"
	"os/exec"
	"strings"
	"testing"
	"time"
)

// weakNetNetemStats is what one netem qdisc on lo has carried and dropped.
type weakNetNetemStats struct {
	sentPackets, dropped int
}

// weakNetNetemCounters reads every netem qdisc on lo, keyed by its handle
// ("101:"). A test uses it to prove its impairment actually reached traffic:
// a fault that never matched a packet would leave the counters at zero.
func weakNetNetemCounters(t *testing.T) map[string]weakNetNetemStats {
	t.Helper()
	out, err := exec.Command("tc", "-s", "qdisc", "show", "dev", "lo").CombinedOutput()
	if err != nil {
		t.Fatalf("read netem counters: %v: %s", err, strings.TrimSpace(string(out)))
	}
	return parseWeakNetNetemCounters(string(out))
}

func parseWeakNetNetemCounters(out string) map[string]weakNetNetemStats {
	stats := make(map[string]weakNetNetemStats)
	handle := ""
	for _, line := range strings.Split(out, "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && fields[0] == "qdisc" {
			handle = ""
			if fields[1] == "netem" {
				handle = fields[2]
			}
			continue
		}
		if handle == "" || len(fields) < 5 || fields[0] != "Sent" {
			continue
		}
		var sent, dropped int
		fmt.Sscanf(fields[3], "%d", &sent)
		if i := strings.Index(line, "dropped "); i >= 0 {
			fmt.Sscanf(line[i+len("dropped "):], "%d", &dropped)
		}
		stats[handle] = weakNetNetemStats{sentPackets: sent, dropped: dropped}
		handle = ""
	}
	return stats
}

// weakNetMeshHandle is the netem handle installWeakNetMeshQdisc gives a
// member's uplink (direction 0) or downlink (direction 1).
func weakNetMeshHandle(members []*weakNetMeshMember, member *weakNetMeshMember, direction int) string {
	for i, candidate := range members {
		if candidate == member {
			return fmt.Sprintf("%x:", 0x100+i*2+direction)
		}
	}
	return ""
}

func logWeakNetMesh(t *testing.T, members []*weakNetMeshMember, before, after map[string]weakNetMeshFlow) {
	t.Helper()
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher == receiver {
				continue
			}
			key := weakNetMeshFlowKey(publisher, receiver)
			got := weakNetMeshDelta(after[key], before[key])
			t.Logf("%s -> %s: audio=%d video=%d gaps=%d", publisher.id, receiver.id, got.audio, got.video, got.gaps)
		}
	}
}

func TestParseWeakNetNetemCounters(t *testing.T) {
	out := `qdisc htb 1: root refcnt 2 r2q 10 default 0x10 direct_packets_stat 0 direct_qlen 1000
 Sent 905188 bytes 1735 pkt (dropped 0, overlimits 12 requeues 0)
qdisc netem 101: parent 1:101 limit 1000 delay 50ms loss 8%
 Sent 330720 bytes 412 pkt (dropped 37, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
qdisc netem 103: parent 1:103 limit 20 delay 50ms
 Sent 12 bytes 1 pkt (dropped 0, overlimits 0 requeues 0)
`
	got := parseWeakNetNetemCounters(out)
	if len(got) != 2 || got["101:"] != (weakNetNetemStats{sentPackets: 412, dropped: 37}) ||
		got["103:"] != (weakNetNetemStats{sentPackets: 1}) {
		t.Fatalf("parsed netem counters = %+v", got)
	}
}

// One member of a four-person room has a thin or lossy upload and a clean
// download (ADSL, a phone on a busy cell). The other three must still hear
// it, its camera must still reach them, and its own view of the room must
// stay as good as everyone else's: the uplink impairment must not leak into
// its downlink.
func TestWeakNetImpairedPublisherUplinkReachesEverySubscriber(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	skipUnlessExtended(t)
	for _, tc := range []struct {
		name string
		tier weakNetTier
		// minAudio is the audio packets each receiver must get from the
		// impaired publisher over the window (calibrated; see the log).
		minAudio int
		// knownIssue gates the audio floor behind SLOWMEET_KNOWN_FAILING.
		knownIssue string
	}{
		{name: "lossy uplink", tier: weakNetTier{rate: "1mbit", delay: "50ms", loss: "8%", direction: weakNetUplinkOnly}, minAudio: 200,
			knownIssue: "B8: the SFU relays receivers' NACKs for the video packets it dropped on purpose (FPS gate, " +
				"bitrate limiter) to the publisher, whose retransmissions then fill a 1 Mbit uplink and starve its audio " +
				"to about a third"},
		{name: "slow uplink", tier: weakNetTier{rate: "300kbit", delay: "50ms", loss: "0%", limit: "20", direction: weakNetUplinkOnly}, minAudio: 145},
	} {
		t.Run(tc.name, func(t *testing.T) {
			limits := Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30}
			members := newWeakNetMeshFixture(t, limits, tc.tier, weakNetTierClean, weakNetTierClean, weakNetTierClean)
			impaired, clean := members[0], members[1:]

			const window = 8 * time.Second
			installWeakNetMeshQdisc(t, members)
			before := weakNetMeshSnapshot(members)
			nacksBefore := impaired.nacks.count()
			time.Sleep(window)
			after := weakNetMeshSnapshot(members)
			logWeakNetMesh(t, members, before, after)
			t.Logf("NACKs reaching %s's camera sender over the window: %d", impaired.id, impaired.nacks.count()-nacksBefore)
			flow := func(publisher, receiver *weakNetMeshMember) weakNetMeshFlow {
				key := weakNetMeshFlowKey(publisher, receiver)
				return weakNetMeshDelta(after[key], before[key])
			}

			counters := weakNetNetemCounters(t)
			uplink := counters[weakNetMeshHandle(members, impaired, 0)]
			t.Logf("impaired uplink netem: sent=%d dropped=%d", uplink.sentPackets, uplink.dropped)
			if uplink.sentPackets < 100 {
				t.Fatalf("the uplink tier carried %d packets: it never matched %s's traffic", uplink.sentPackets, impaired.id)
			}
			if _, shaped := counters[weakNetMeshHandle(members, impaired, 1)]; shaped {
				t.Fatalf("an uplink-only tier installed a downlink class for %s", impaired.id)
			}
			if tc.tier.loss != "0%" && uplink.dropped == 0 {
				t.Fatalf("the lossy uplink dropped nothing over %s", window)
			}

			for _, receiver := range clean {
				if got := flow(impaired, receiver); got.video == 0 {
					t.Errorf("%s's camera never reached %s across its impaired uplink", impaired.id, receiver.id)
				}
			}
			t.Run("audio crosses the impaired uplink", func(t *testing.T) {
				if tc.knownIssue != "" {
					knownFailing(t, tc.knownIssue)
				}
				for _, receiver := range clean {
					if got := flow(impaired, receiver); got.audio < tc.minAudio {
						t.Errorf("%s received %d audio packets from %s's impaired uplink, want >= %d", receiver.id, got.audio, impaired.id, tc.minAudio)
					}
				}
			})
			// The impaired member's downlink is clean: what it receives from
			// each clean publisher matches what the other clean members do.
			for _, publisher := range clean {
				mine := flow(publisher, impaired)
				for _, other := range clean {
					if other == publisher {
						continue
					}
					theirs := flow(publisher, other)
					if mine.audio*10 < theirs.audio*8 || mine.video*10 < theirs.video*8 {
						t.Errorf("%s received %s's media at audio=%d video=%d, below 80%% of %s's audio=%d video=%d: the uplink impairment leaked into its downlink",
							impaired.id, publisher.id, mine.audio, mine.video, other.id, theirs.audio, theirs.video)
					}
				}
			}
			if t.Failed() {
				return
			}
			removeWeakNetProfile(t)
			time.Sleep(3 * time.Second)
			for _, member := range members {
				waitWeakNetConnected(t, member.client, member.id+" client")
			}
		})
	}
}

// Nobody in the room has a good link: four members on four impaired links
// (moderate, severe, moderate, capped), so every flow crosses two impaired
// hops. Audio must still reach every member from every other one, every
// member must get video from someone, and the room recovers once the links
// clear.
func TestWeakNetEveryParticipantImpaired(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	skipUnlessExtended(t)
	limits := Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30}
	members := newWeakNetMeshFixture(t, limits,
		weakNetTierModerate, weakNetTierSevere, weakNetTierModerate, weakNetTierCapped)

	const window = 10 * time.Second
	// minAudio is the audio every flow must carry over the window
	// (calibrated; see the log): two impaired hops, the severe and capped
	// downlinks shared by three publishers.
	const minAudio = 33
	installWeakNetMeshQdisc(t, members)
	before := weakNetMeshSnapshot(members)
	time.Sleep(window)
	impaired := weakNetMeshSnapshot(members)
	logWeakNetMesh(t, members, before, impaired)

	counters := weakNetNetemCounters(t)
	for _, member := range members {
		for direction := 0; direction < 2; direction++ {
			stats := counters[weakNetMeshHandle(members, member, direction)]
			t.Logf("%s %s netem: sent=%d dropped=%d", member.id, []string{"uplink", "downlink"}[direction], stats.sentPackets, stats.dropped)
			if stats.sentPackets < 50 {
				t.Fatalf("%s's %s tier carried %d packets: it never matched the member's traffic",
					member.id, []string{"uplink", "downlink"}[direction], stats.sentPackets)
			}
		}
	}
	for _, receiver := range members {
		videoFromAnyone := false
		for _, publisher := range members {
			if publisher == receiver {
				continue
			}
			key := weakNetMeshFlowKey(publisher, receiver)
			got := weakNetMeshDelta(impaired[key], before[key])
			if got.audio < minAudio {
				t.Errorf("%s audio carried %d packets with every link impaired, want >= %d", key, got.audio, minAudio)
			}
			if got.video > 0 {
				videoFromAnyone = true
			}
		}
		if !videoFromAnyone {
			t.Errorf("%s received no video from anyone with every link impaired", receiver.id)
		}
	}
	if t.Failed() {
		return
	}

	removeWeakNetProfile(t)
	time.Sleep(3 * time.Second)
	lifted := weakNetMeshSnapshot(members)
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher == receiver {
				continue
			}
			key := weakNetMeshFlowKey(publisher, receiver)
			if got := weakNetMeshDelta(lifted[key], impaired[key]); got.audio == 0 || got.video == 0 {
				t.Errorf("%s did not recover after the links cleared: audio=%d video=%d", key, got.audio, got.video)
			}
		}
	}
	for _, member := range members {
		waitWeakNetConnected(t, member.client, member.id+" client")
	}
}

// Wireless loss comes in bursts, and congested paths reorder and duplicate
// packets. With a Gilbert-Elliott burst-loss model, 25% reordering and 2%
// duplication on every link of a four-person room, audio must keep flowing
// on every flow with no multi-second hole, the receivers must see the
// reordering (proof the fault reached them), and no duplicate may reach the
// application.
func TestWeakNetBurstLossReorderAndDuplication(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	skipUnlessExtended(t)
	limits := Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30}
	members := newWeakNetMeshFixture(t, limits,
		weakNetTierClean, weakNetTierClean, weakNetTierClean, weakNetTierClean)

	const window = 8 * time.Second
	// minAudio is the audio every flow must carry over the window
	// (calibrated; see the log).
	const minAudio = 160
	const maxAudioGap = 2 * time.Second
	applyWeakNetProfile(t, "20mbit", "40ms", "",
		"loss", "gemodel", "1%", "10%", "70%", "0.1%",
		"reorder", "25%", "50%",
		"duplicate", "2%")
	before := weakNetMeshSnapshot(members)
	orderBefore := make(map[string]weakNetOrder)
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher != receiver {
				sink := receiver.weakNetMeshSinkFrom(publisher.id)
				sink.resetAudioGap()
				orderBefore[weakNetMeshFlowKey(publisher, receiver)] = sink.order()
			}
		}
	}
	time.Sleep(window)
	after := weakNetMeshSnapshot(members)
	logWeakNetMesh(t, members, before, after)

	counters := weakNetNetemCounters(t)
	dropped, sent := 0, 0
	for handle, stats := range counters {
		t.Logf("netem %s: sent=%d dropped=%d", handle, stats.sentPackets, stats.dropped)
		dropped += stats.dropped
		sent += stats.sentPackets
	}
	if sent == 0 || dropped == 0 {
		t.Fatalf("the burst-loss netem sent %d and dropped %d packets: the fault never reached the room", sent, dropped)
	}

	late := 0
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher == receiver {
				continue
			}
			key := weakNetMeshFlowKey(publisher, receiver)
			got := weakNetMeshDelta(after[key], before[key])
			order := receiver.weakNetMeshSinkFrom(publisher.id).order()
			start := orderBefore[key]
			late += order.audioLate - start.audioLate
			t.Logf("%s: audio late=%d dup=%d video dup=%d longest audio gap=%s", key,
				order.audioLate-start.audioLate, order.audioDuplicates-start.audioDuplicates,
				order.videoDuplicates-start.videoDuplicates, order.maxAudioGap)
			if got.audio < minAudio {
				t.Errorf("%s audio carried %d packets under burst loss, want >= %d", key, got.audio, minAudio)
			}
			if got.video == 0 {
				t.Errorf("%s video stopped under burst loss", key)
			}
			if order.maxAudioGap > maxAudioGap {
				t.Errorf("%s audio went silent for %s under burst loss, want <= %s", key, order.maxAudioGap, maxAudioGap)
			}
			if d := order.audioDuplicates - start.audioDuplicates; d != 0 {
				t.Errorf("%s delivered %d duplicate audio packets to the application", key, d)
			}
		}
	}
	if late == 0 {
		t.Errorf("no receiver saw a single reordered audio packet: the reorder fault never reached the room")
	}
	if t.Failed() {
		return
	}
	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	for _, member := range members {
		waitWeakNetConnected(t, member.client, member.id+" client")
	}
}
