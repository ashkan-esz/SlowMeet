package media

import (
	"context"
	"errors"
	"fmt"
	"io"
	"maps"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	internalwebrtc "SlowMeet/internal/webrtc"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

const (
	// fourPartyPumpInterval paces every member's audio and camera source.
	fourPartyPumpInterval = 10 * time.Millisecond
	// fourPartyMinPackets is how many correctly attributed packets a stream
	// must gain before it counts as flowing.
	fourPartyMinPackets = 10
)

var fourPartyRoles = [...]SourceRole{SourceRoleAudio, SourceRoleCamera}

// fourPartyStream counts what one member received on one remote track.
type fourPartyStream struct {
	kind pion.RTPCodecType
	// packets carried the label of the track they arrived on; misrouted
	// packets were published by some other source or role.
	packets   int
	misrouted int
}

// fourPartyMember is one participant: a browser-side peer connection that
// publishes audio and a camera, and the SFU-side peer it is connected to. A
// single peer connection carries both directions, as in the browser client.
type fourPartyMember struct {
	id     string
	client *pion.PeerConnection
	sfu    *internalwebrtc.Peer
	audio  *pion.TrackLocalStaticRTP
	camera *pion.TrackLocalStaticRTP
	// offers counts the renegotiations the router asked this member for.
	offers atomic.Int64

	pumping  bool
	stopPump chan struct{}
	pumpDone chan struct{}
	stopOnce sync.Once

	mu      sync.Mutex
	streams map[string]*fourPartyStream
}

type fourPartyRoom struct {
	router  *Router
	members map[string]*fourPartyMember
	joined  []string
}

func newFourPartyRoom(t *testing.T) *fourPartyRoom {
	t.Helper()
	room := &fourPartyRoom{router: NewRouter(), members: make(map[string]*fourPartyMember)}
	t.Cleanup(func() {
		for _, id := range room.joined {
			room.leave(id)
		}
	})
	return room
}

// fourPartyTrackID is the egress track ID the router gives a source's role.
// Every published packet carries it as its payload, so a receiver can tell a
// packet that was forwarded onto somebody else's track.
func fourPartyTrackID(sourceID string, role SourceRole) string {
	return sourceID + "|" + string(role)
}

func fourPartyOthers(ids []string, self string) []string {
	others := make([]string, 0, len(ids))
	for _, id := range ids {
		if id != self {
			others = append(others, id)
		}
	}
	return others
}

// join creates the member's two peers, registers the SFU side with the router
// and wires publishing, without negotiating anything yet.
func (room *fourPartyRoom) join(t *testing.T, id string) *fourPartyMember {
	t.Helper()
	member := &fourPartyMember{
		id:     id,
		client: newIntegrationPeer(t),
		sfu:    newIntegrationWrapperPeer(t),
		audio: newIntegrationTrack(pion.RTPCodecCapability{
			MimeType: pion.MimeTypeOpus, ClockRate: 48_000, Channels: 2,
		}, id+"-microphone"),
		camera: newIntegrationTrack(pion.RTPCodecCapability{
			MimeType: pion.MimeTypeVP8, ClockRate: 90_000,
		}, id+"-camera"),
		stopPump: make(chan struct{}),
		pumpDone: make(chan struct{}),
		streams:  make(map[string]*fourPartyStream),
	}
	room.members[id] = member
	room.joined = append(room.joined, id)

	member.client.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		trackID := track.ID()
		member.mu.Lock()
		if member.streams[trackID] == nil {
			member.streams[trackID] = &fourPartyStream{kind: track.Kind()}
		}
		member.mu.Unlock()
		go func() {
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				member.mu.Lock()
				if string(packet.Payload) == trackID {
					member.streams[trackID].packets++
				} else {
					member.streams[trackID].misrouted++
				}
				member.mu.Unlock()
			}
		}()
	})
	for _, track := range []*pion.TrackLocalStaticRTP{member.audio, member.camera} {
		if _, err := member.client.AddTrack(track); err != nil {
			t.Fatalf("add %s track %s: %v", id, track.ID(), err)
		}
	}

	room.router.Register(id, member.sfu, func() error {
		member.offers.Add(1)
		return nil
	})
	member.sfu.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		role := SourceRoleCamera
		if track.Kind() == pion.RTPCodecTypeAudio {
			role = SourceRoleAudio
		}
		room.router.Publish(id, role, member.sfu, track)
	})
	return member
}

// subscribeCameras sends the member's visible-camera list, as the browser
// does once it has processed the roster.
func (room *fourPartyRoom) subscribeCameras(id string, cameraIDs []string) {
	room.router.SetVideoSubscriptionsWithLayer(id, cameraIDs, "medium")
}

// connectUplink runs the browser's offer, which carries its own audio and
// camera to the SFU.
func (room *fourPartyRoom) connectUplink(t *testing.T, id string) {
	t.Helper()
	member := room.members[id]
	negotiateIntegrationPeers(t, member.client, member.sfu.Connection())
	waitIntegrationPeerConnected(t, member.client, id+" client")
	waitIntegrationPeerConnected(t, member.sfu.Connection(), id+" SFU peer")
}

// renegotiateDownlink answers the router's offer for the member: the SFU
// peer's tracks have changed and the browser has to learn about them.
func (room *fourPartyRoom) renegotiateDownlink(t *testing.T, id string) {
	t.Helper()
	member := room.members[id]
	negotiateIntegrationPeers(t, member.sfu.Connection(), member.client)
}

// leave stops the member's media, removes it from the router and closes its
// peers. It is idempotent so cleanup can run it for members that already left.
func (room *fourPartyRoom) leave(id string) {
	member := room.members[id]
	member.stopMedia()
	room.router.Unregister(id)
	_ = member.client.Close()
	_ = member.sfu.Close()
}

// startMedia publishes audio and camera packets until stopMedia. Sequence
// numbers and timestamps only ever increase, and each packet is a complete
// single-packet frame labelled with the egress track ID it belongs on.
func (member *fourPartyMember) startMedia(t *testing.T) {
	t.Helper()
	member.pumping = true
	sources := []struct {
		track       *pion.TrackLocalStaticRTP
		role        SourceRole
		payloadType uint8
		ticks       uint32
	}{
		{track: member.audio, role: SourceRoleAudio, payloadType: 111, ticks: 960},
		{track: member.camera, role: SourceRoleCamera, payloadType: 96, ticks: 3000},
	}
	go func() {
		defer close(member.pumpDone)
		ticker := time.NewTicker(fourPartyPumpInterval)
		defer ticker.Stop()
		for sequence := uint16(1); ; sequence++ {
			select {
			case <-member.stopPump:
				return
			case <-ticker.C:
			}
			for _, source := range sources {
				err := source.track.WriteRTP(&rtp.Packet{
					Header: rtp.Header{
						Version:        2,
						Marker:         source.role == SourceRoleCamera,
						PayloadType:    source.payloadType,
						SequenceNumber: sequence,
						Timestamp:      uint32(sequence) * source.ticks,
					},
					Payload: []byte(fourPartyTrackID(member.id, source.role)),
				})
				if err != nil && !errors.Is(err, io.ErrClosedPipe) {
					t.Errorf("write %s %s RTP: %v", member.id, source.role, err)
					return
				}
			}
		}
	}()
}

func (member *fourPartyMember) stopMedia() {
	member.stopOnce.Do(func() {
		close(member.stopPump)
		if member.pumping {
			<-member.pumpDone
		}
	})
}

func (member *fourPartyMember) snapshot() map[string]fourPartyStream {
	member.mu.Lock()
	defer member.mu.Unlock()
	streams := make(map[string]fourPartyStream, len(member.streams))
	for id, stream := range member.streams {
		streams[id] = *stream
	}
	return streams
}

// awaitMedia waits until the audio and the camera of every source have each
// delivered fourPartyMinPackets more packets to the member than in since.
func (member *fourPartyMember) awaitMedia(t *testing.T, since map[string]fourPartyStream, sourceIDs ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	for {
		current := member.snapshot()
		stalled := ""
		for _, sourceID := range sourceIDs {
			for _, role := range fourPartyRoles {
				trackID := fourPartyTrackID(sourceID, role)
				if current[trackID].packets-since[trackID].packets < fourPartyMinPackets {
					stalled = trackID
				}
			}
		}
		if stalled == "" {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s did not receive %d new packets on %s; streams before %+v, now %+v",
				member.id, fourPartyMinPackets, stalled, since, current)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

// assertStreams checks every remote track the member was ever handed: exactly
// one audio and one camera per source, each of the right media kind, none of
// them the member's own, and no packet delivered on another source's track.
func (member *fourPartyMember) assertStreams(t *testing.T, sourceIDs ...string) {
	t.Helper()
	streams := member.snapshot()
	want := make([]string, 0, len(sourceIDs)*len(fourPartyRoles))
	for _, sourceID := range sourceIDs {
		for _, role := range fourPartyRoles {
			want = append(want, fourPartyTrackID(sourceID, role))
		}
	}
	slices.Sort(want)
	got := slices.Sorted(maps.Keys(streams))
	for _, trackID := range got {
		if strings.HasPrefix(trackID, member.id+"|") {
			t.Errorf("%s received its own stream %s back from the SFU", member.id, trackID)
		}
	}
	if !slices.Equal(got, want) {
		t.Errorf("%s remote streams = %v, want %v", member.id, got, want)
	}
	for trackID, stream := range streams {
		wantKind := pion.RTPCodecTypeVideo
		if strings.HasSuffix(trackID, "|"+string(SourceRoleAudio)) {
			wantKind = pion.RTPCodecTypeAudio
		}
		if stream.kind != wantKind {
			t.Errorf("%s stream %s has kind %s, want %s", member.id, trackID, stream.kind, wantKind)
		}
		if stream.misrouted != 0 {
			t.Errorf("%s stream %s delivered %d packets published by another source or role",
				member.id, trackID, stream.misrouted)
		}
	}
}

// meshProblem describes how the router's state differs from a full mesh of
// exactly ids: audio and camera published by each, every publication fanned
// out to every other member with a negotiated sender, and to nobody else.
func (room *fourPartyRoom) meshProblem(ids []string) string {
	room.router.mu.RLock()
	defer room.router.mu.RUnlock()
	if got, want := len(room.router.pubs), len(ids)*len(fourPartyRoles); got != want {
		return fmt.Sprintf("%d publications, want %d", got, want)
	}
	for _, id := range ids {
		want := fourPartyOthers(ids, id)
		slices.Sort(want)
		for _, role := range fourPartyRoles {
			pub := room.router.pubs[publicationKey(id, role, "")]
			if pub == nil {
				return fmt.Sprintf("%s %s is not published", id, role)
			}
			if got := slices.Sorted(maps.Keys(pub.tracks)); !slices.Equal(got, want) {
				return fmt.Sprintf("%s %s targets = %v, want %v", id, role, got, want)
			}
			if got := slices.Sorted(maps.Keys(pub.senders)); !slices.Equal(got, want) {
				return fmt.Sprintf("%s %s senders = %v, want %v", id, role, got, want)
			}
		}
	}
	return ""
}

func (room *fourPartyRoom) awaitMesh(t *testing.T, ids ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	for {
		problem := room.meshProblem(ids)
		if problem == "" {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("router did not reach a full mesh of %v: %s", ids, problem)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (room *fourPartyRoom) offerCounts() map[string]int64 {
	counts := make(map[string]int64, len(room.members))
	for id, member := range room.members {
		counts[id] = member.offers.Load()
	}
	return counts
}

// awaitOffers waits until the router has asked each member to renegotiate at
// least once more than in since. Without that request the browser would never
// learn about the tracks added to or removed from its SFU peer.
func (room *fourPartyRoom) awaitOffers(t *testing.T, since map[string]int64, ids ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), routerIntegrationTimeout)
	defer cancel()
	for {
		waiting := ""
		for _, id := range ids {
			if room.members[id].offers.Load() <= since[id] {
				waiting = id
			}
		}
		if waiting == "" {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("router never asked %s to renegotiate; offers before %v, now %v",
				waiting, since, room.offerCounts())
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func (room *fourPartyRoom) sfuTransceivers(ids []string) map[string]int {
	counts := make(map[string]int, len(ids))
	for _, id := range ids {
		counts[id] = len(room.members[id].sfu.Connection().GetTransceivers())
	}
	return counts
}

// TestRouterForwardsFourPartyFullMesh runs the 4-person room on loopback with
// real peer connections: everyone publishes a microphone and a camera and
// subscribes to everyone else. The other integration tests never have more
// than two peers that both send and receive.
func TestRouterForwardsFourPartyFullMesh(t *testing.T) {
	room := newFourPartyRoom(t)
	ids := []string{"p1", "p2", "p3", "p4"}
	for _, id := range ids {
		room.join(t, id)
	}
	for _, id := range ids {
		room.subscribeCameras(id, fourPartyOthers(ids, id))
	}
	// Every uplink is established before any media flows, so all eight
	// publications appear while every receiver is already registered.
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
		others := fourPartyOthers(ids, id)
		room.members[id].awaitMedia(t, nil, others...)
		room.members[id].assertStreams(t, others...)
	}
	if t.Failed() {
		return
	}

	root := t
	t.Run("leave and seat reuse", func(t *testing.T) {
		survivors := []string{"p1", "p2", "p3"}
		transceivers := room.sfuTransceivers(survivors)
		offers := room.offerCounts()

		room.leave("p4")
		// Unregister removes the leaver's six egress tracks and asks every
		// survivor to renegotiate before it returns.
		for _, id := range survivors {
			if got := room.members[id].offers.Load(); got <= offers[id] {
				t.Fatalf("%s was not asked to renegotiate after p4 left: offers %d, before %d", id, got, offers[id])
			}
		}
		if problem := room.meshProblem(survivors); problem != "" {
			t.Fatalf("router state after p4 left: %s", problem)
		}
		afterLeave := make(map[string]map[string]fourPartyStream, len(survivors))
		for _, id := range survivors {
			room.renegotiateDownlink(t, id)
			afterLeave[id] = room.members[id].snapshot()
		}
		for _, id := range survivors {
			room.members[id].awaitMedia(t, afterLeave[id], fourPartyOthers(survivors, id)...)
		}

		// A newcomer takes the free seat. It registers into a room that
		// already has six publications, then publishes its own two.
		offers = room.offerCounts()
		seated := []string{"p1", "p2", "p3", "p5"}
		room.join(t, "p5")
		for _, id := range seated {
			room.subscribeCameras(id, fourPartyOthers(seated, id))
		}
		beforeJoin := make(map[string]map[string]fourPartyStream, len(seated))
		for _, id := range seated {
			beforeJoin[id] = room.members[id].snapshot()
		}
		room.connectUplink(t, "p5")
		// The newcomer publishes until the room is torn down, which outlives
		// this subtest, so its pump reports to the parent test.
		room.members["p5"].startMedia(root)
		room.awaitMesh(t, seated...)
		room.awaitOffers(t, offers, seated...)
		for _, id := range seated {
			room.renegotiateDownlink(t, id)
		}
		for _, id := range seated {
			others := fourPartyOthers(seated, id)
			room.members[id].awaitMedia(t, beforeJoin[id], others...)
			everSeen := others
			if id != "p5" {
				// Survivors keep the ended streams of the member that left.
				everSeen = append(slices.Clone(others), "p4")
			}
			room.members[id].assertStreams(t, everSeen...)
		}
		// The newcomer's tracks reuse the m-lines the leaver freed on each
		// survivor's SFU peer instead of growing the session description.
		if got := room.sfuTransceivers(survivors); !maps.Equal(got, transceivers) {
			t.Errorf("survivor SFU transceivers after seat reuse = %v, want the %v from before the leave", got, transceivers)
		}
	})
}
