package media

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"SlowMeet/internal/metrics"
	"SlowMeet/internal/webrtc"
	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

type Offerer func() error

type SourceRole string

const (
	SourceRoleAudio  SourceRole = "audio"
	SourceRoleCamera SourceRole = "camera"
	SourceRoleScreen SourceRole = "screen"
)

// Limits are hard server-side caps for published RTP streams. A zero value
// disables shaping for that media kind.
type Limits struct {
	MaxAudioBitrate int
	MaxVideoBitrate int
	MaxVideoFPS     int
}

type publication struct {
	// videoDrops counts video this publication could not pass on. Nil in
	// tests that build a publication by hand.
	videoDrops *metrics.VideoDrops

	key      string
	sourceID string
	role     SourceRole
	layer    string
	trackID  string
	streamID string
	codec    pion.RTPCodecCapability
	// codecName is the configuration name of a video publication's codec
	// (video_codecs.go), empty for audio. payloadType is the ingress payload
	// type that codec was read from; it changes when the publisher's browser
	// switches codec on the same track.
	codecName    string
	payloadType  uint8
	remote       *pion.TrackRemote
	source       *webrtc.Peer
	tracks       map[string]*publicationTarget
	senders      map[string]*pion.RTPSender
	limiter      *bitrateLimiter
	lastPacketAt atomic.Int64
	paused       atomic.Bool
	// lastKeyFrameRequest is when (Unix nanoseconds) a keyframe request last
	// reached this publication's publisher; see allowKeyFrameRequest.
	lastKeyFrameRequest atomic.Int64
	// keyFrameAfterDrop is set when the SFU dropped one of this publication's
	// frames whole: no receiver can continue the picture until a keyframe.
	// lastDropKeyFrameRequest is when the SFU last asked for one for that
	// reason; see keyFrameAfterDropDue.
	keyFrameAfterDrop       atomic.Bool
	lastDropKeyFrameRequest atomic.Int64
	// lastKeyFrameStart is when the first packet of this publication's latest
	// keyframe arrived (startsVideoKeyFrame), in Unix nanoseconds.
	lastKeyFrameStart atomic.Int64
	// keyFrameTimestamp is that keyframe's RTP timestamp (keyFrameStamp).
	keyFrameTimestamp atomic.Uint64
	// lastKeyFrameForward is when the pacer last took a keyframe to pass on
	// to this publication's receivers, in Unix nanoseconds.
	lastKeyFrameForward atomic.Int64
	// lastKeyFrameSent is when the pacer finished passing a keyframe on.
	lastKeyFrameSent atomic.Int64
	// forwardLoss measures the publisher's packets the SFU did not forward
	// (forward_loss.go).
	forwardLoss forwardLoss
	// forwardJitter measures the jitter of what the SFU forwards
	// (forward_jitter.go).
	forwardJitter forwardJitter

	// layerKeys caches the publication key of every camera simulcast quality
	// for this source so the per-packet layer selection never builds strings.
	// It is only populated for camera publications.
	layerKeys [len(cameraLayersByQuality)]string
	// readBuf is the ingress read buffer reused by the publication's single
	// forwarding goroutine; packets must copy their payload out of it before
	// escaping the read loop.
	readBuf []byte
	// targetScratch reuses a single fan-out buffer per publication;
	// forwardPacket for a publication always runs on its single forwarding
	// goroutine (the read loop for audio, the pacer for video).
	targetScratch []*publicationTarget

	// stopped is closed when the publication is torn down while its publisher
	// stays connected; forwardDone is closed by the forwarding goroutine when
	// it has exited for any reason.
	stopped     chan struct{}
	stopOnce    sync.Once
	forwardDone chan struct{}
}

// publicationTarget is one receiver's negotiated egress track for a
// publication. Forwarded packets are handed to the target's writer goroutine
// through a depth-bounded mailbox, so a slow receiver's egress can never
// block the publisher's read loop or delay the other receivers; overflowing
// drops the packet and the receiver recovers via RTCP feedback.
type publicationTarget struct {
	track *pion.TrackLocalStaticRTP
	// egress rewrites the publisher's header extensions for this receiver
	// (egress_extensions.go); nil for targets built without a peer (tests).
	egress      *egressHeaderExtensions
	pending     chan *rtp.Packet
	audio       *audioMailbox
	done        chan struct{}
	videoLosses atomic.Pointer[targetVideoLosses]
	// lastSentLayer tracks the camera layer most recently forwarded to this
	// receiver by the owning publication, so a receiver that starts receiving
	// the layer mid-GOP triggers a keyframe request. Written only by the
	// publication's single forwarding goroutine.
	lastSentLayer string
	stopOnce      sync.Once
	// lastAudio is the sequence number (high 32 bits) and timestamp (low 32
	// bits) of the last audio packet written, valid once hasLastAudio is set.
	// A publication swap reads it to continue the receiver's stream.
	lastAudio    atomic.Uint64
	hasLastAudio atomic.Bool
	// audioRebase is set on a target that took over a receiver's sender in a
	// publication swap; written only by the target's writer goroutine.
	audioRebase *audioRebase
}

// audioRebase keeps one receiver's audio stream continuous across a
// publication swap. The receiver's sender (and its SSRC) stays the same while
// the source becomes the resumed publisher, whose RTP sequence numbers and
// timestamps start somewhere unrelated; on an unchanged SSRC a browser's audio
// receiver can read that jump as old or duplicate packets and drop them, so
// the resumed participant goes silent for the room (B11 in
// docs/network-testing.md). Video is not rebased: receivers' NACKs name source
// sequence numbers (target_video_loss.go), and a keyframe resynchronizes it.
type audioRebase struct {
	// predecessor is the target this one replaced. Its last packet is read
	// when the first packet of the new source arrives, after the swap stopped
	// the predecessor's writer, so a packet it was still flushing is counted.
	predecessor     *publicationTarget
	started         bool
	sequenceOffset  uint16
	timestampOffset uint32
}

// audioRebaseFrameTicks is the timestamp step assumed between the last packet
// before a swap and the first one after it: one 20 ms Opus frame at 48 kHz.
const audioRebaseFrameTicks = 960

func (rebase *audioRebase) apply(packet *rtp.Packet) *rtp.Packet {
	if !rebase.started {
		rebase.started = true
		if rebase.predecessor.hasLastAudio.Load() {
			last := rebase.predecessor.lastAudio.Load()
			rebase.sequenceOffset = uint16(last>>32) + 1 - packet.SequenceNumber
			rebase.timestampOffset = uint32(last) + audioRebaseFrameTicks - packet.Timestamp
		}
		rebase.predecessor = nil
	}
	// The packet is shared by every target of the publication: rewrite a copy.
	rewritten := *packet
	rewritten.SequenceNumber += rebase.sequenceOffset
	rewritten.Timestamp += rebase.timestampOffset
	return &rewritten
}

// writeAudio writes one audio packet to the receiver, continuing its stream
// across a publication swap, and records what was sent for the next swap.
func (t *publicationTarget) writeAudio(packet *rtp.Packet) error {
	if t.audioRebase != nil {
		packet = t.audioRebase.apply(packet)
	}
	packet = t.egress.packet(packet)
	if err := t.track.WriteRTP(packet); err != nil {
		return err
	}
	t.lastAudio.Store(uint64(packet.SequenceNumber)<<32 | uint64(packet.Timestamp))
	t.hasLastAudio.Store(true)
	return nil
}

// continueAudioFrom makes t continue predecessor's audio stream to the same
// receiver. Called in a publication swap before t's writer starts.
func (t *publicationTarget) continueAudioFrom(predecessor *publicationTarget) {
	if t.audio == nil || predecessor == nil {
		return
	}
	t.audioRebase = &audioRebase{predecessor: predecessor}
}

const (
	targetAudioQueueDepth = 4 // ~80ms of 20ms Opus frames
	// targetVideoQueueDepth is a receiver's video mailbox. The pacer hands a
	// frame's packets over back to back while its token bucket allows (31
	// full packets at the 3 Mbps default), far faster than the receiver's
	// writer can encrypt and send them, so the mailbox must hold a whole
	// frame. At 24 packets every frame above about 28 KB lost its tail for
	// every receiver: a 720p or 1080p keyframe never arrived complete, the
	// receiver asked for another, and the stream stayed dark.
	targetVideoQueueDepth = maxFramePackets
	// receiveMTU matches pion's default receive MTU; every ingress packet is
	// read into a per-publication buffer of this size.
	receiveMTU = 1500
)

func targetQueueDepth(remote *pion.TrackRemote) int {
	if remote != nil && remote.Kind() == pion.RTPCodecTypeAudio {
		return targetAudioQueueDepth
	}
	return targetVideoQueueDepth
}

func newPublicationTarget(track *pion.TrackLocalStaticRTP, queueDepth int) *publicationTarget {
	return &publicationTarget{
		track:   track,
		pending: make(chan *rtp.Packet, queueDepth),
		done:    make(chan struct{}),
	}
}

// enqueue hands a packet to the target's writer without ever blocking. The
// packet is shared between all target writers on purpose: pion v4
// (track_local_static.go WriteRTP) copies the whole packet into pooled
// storage before rewriting its SSRC and payload type, so concurrent writers
// never mutate the caller's packet. If the pinned pion version is upgraded,
// re-verify that behavior before removing the copy-once note below.
func (t *publicationTarget) enqueue(packet *rtp.Packet) bool {
	if t.audio != nil {
		return t.audio.enqueue(packet)
	}
	if len(t.pending) >= cap(t.pending) {
		// The receiver's mailbox is full because its egress is slow; drop the
		// packet. RTP receivers recover loss through NACK and PLI feedback.
		return false
	}
	select {
	case t.pending <- packet:
		return true
	default:
		return false
	}
}

func (t *publicationTarget) stop() {
	t.stopOnce.Do(func() {
		if t.done == nil {
			t.done = make(chan struct{})
		}
		close(t.done)
	})
}

// writePackets drains the mailbox until the target or its publication is
// removed. WriteRTP failures (receiver left, track removed) are dropped.
func (t *publicationTarget) writePackets(stopped <-chan struct{}) {
	if t.audio != nil {
		t.audio.writePackets(t.writeAudio, t.done, stopped)
		return
	}
	for {
		select {
		case <-t.done:
			return
		case <-stopped:
			return
		case packet := <-t.pending:
			_ = t.track.WriteRTP(t.egress.packet(packet))
		}
	}
}

// stoppedChannel returns the publication's stop channel for target writers.
// Publications built outside Publish (tests) may have none, in which case
// target.stop remains the only exit path.
func (pub *publication) stoppedChannel() <-chan struct{} {
	if pub.stopped == nil {
		return nil
	}
	return pub.stopped
}

// removeTargetLocked deletes one receiver's sender and egress target and
// stops its writer goroutine. The caller must hold r.mu.
func (r *Router) removeTargetLocked(pub *publication, targetID string) {
	target := pub.tracks[targetID]
	sender := pub.senders[targetID]
	delete(pub.tracks, targetID)
	delete(pub.senders, targetID)
	if sender != nil {
		delete(r.senderFeedback, sender)
	}
	if target != nil {
		target.stop()
	}
}

// stop tears down a publication that is being removed. Setting a read
// deadline unblocks the forwarding goroutine if it is parked in ReadRTP on a
// publisher whose peer connection is still open.
func (pub *publication) stop() {
	pub.stopOnce.Do(func() {
		if pub.stopped == nil {
			// Publications constructed outside Publish (tests) have no stop
			// channel; closing a fresh one keeps stop idempotent and safe.
			pub.stopped = make(chan struct{})
		}
		close(pub.stopped)
		if pub.remote != nil {
			_ = pub.remote.SetReadDeadline(time.Now())
		}
	})
}

type videoKeyFrameRequestKey struct {
	receiverID     string
	publicationKey string
}

type videoKeyFrameRetry struct {
	publication *publication
	remaining   int
	startedAt   int64
	timer       *time.Timer
	onError     func(error)
}

const (
	videoKeyFrameRetryDelay   = 250 * time.Millisecond
	videoKeyFrameRequestCount = 3
	maxVideoFrameBufferBytes  = 16 << 20
	// maxQueuedVideoFrames is how many complete frames wait for the pacer.
	// The queue fills only while the pacer is busy with a frame larger than
	// its burst: a 150 KB keyframe at the 3 Mbps default takes about 300 ms,
	// and the frames the publisher sends right behind it arrive meanwhile.
	// With room for 4, those were dropped, the picture could not continue
	// from its own keyframe, and the receiver froze until it asked for the
	// next one (B19 in docs/network-testing.md). 64 is one second at 60 fps.
	maxQueuedVideoFrames      = 64
	cameraLayerActivityWindow = 3 * time.Second
	// maxFramePackets bounds a buffered frame; a frame with more packets is
	// dropped whole. It must hold a keyframe at the highest bitrate cap: a
	// 1080p keyframe at the 3 Mbps default reaches ~150 KB, about 130 full
	// packets, and the old limit of 128 dropped exactly those, so receivers
	// kept asking for keyframes that never arrived (B3 in
	// docs/network-testing.md). 512 packets (~600 KB) leaves room for larger
	// keyframes while keeping the per-frame dedupe scan, insertion sort and
	// repair bitmaps (videoRepairFrame.seen) small.
	maxFramePackets            = 512
	initialFramePacketCapacity = 2
)

type Router struct {
	mu                    sync.RWMutex
	peers                 map[string]*webrtc.Peer
	offerers              map[string]Offerer
	pubs                  map[string]*publication
	videoSubscriptions    map[string]map[string]struct{}
	videoSubscriptionsSet map[string]bool
	cameraLayers          map[string]string
	videoKeyFrameRetries  map[videoKeyFrameRequestKey]*videoKeyFrameRetry
	// senderFeedback holds where each relay goroutine sends a receiver's RTCP
	// feedback: the publisher peer and its ingress SSRC. Publication swaps
	// reuse the receiver's sender and replace the route in place, so the
	// long-lived relay goroutine always targets the current source — the
	// resumed publisher, not the peer it superseded (B7).
	senderFeedback map[*pion.RTPSender]*atomic.Pointer[feedbackRoute]
	// heldSources are publishers inside their reconnect grace window: their
	// publications outlive the end of their media (see keepStoppedPublication).
	heldSources map[string]struct{}
	// receiverVideoCodecs is the video codecs each receiver's browser supports
	// and allowedVideoCodecs the ones the server allows (video_codecs.go). A
	// receiver without an entry, or a nil allowed set, is not filtered.
	receiverVideoCodecs map[string]map[string]struct{}
	allowedVideoCodecs  map[string]struct{}
	limits              Limits
	audioDrops          metrics.AudioDrops
	rtcpRelay           metrics.RTCPRelay
	// videoCodecSwitches counts publications replaced because their publisher
	// changed codec (VideoCodecs).
	videoCodecSwitches atomic.Uint64
	videoDrops         metrics.VideoDrops
}

func NewRouter(config ...Limits) *Router {
	var limits Limits
	if len(config) > 0 {
		limits = config[0]
	}
	return &Router{
		peers:                 make(map[string]*webrtc.Peer),
		offerers:              make(map[string]Offerer),
		pubs:                  make(map[string]*publication),
		videoSubscriptions:    make(map[string]map[string]struct{}),
		videoSubscriptionsSet: make(map[string]bool),
		cameraLayers:          make(map[string]string),
		videoKeyFrameRetries:  make(map[videoKeyFrameRequestKey]*videoKeyFrameRetry),
		senderFeedback:        make(map[*pion.RTPSender]*atomic.Pointer[feedbackRoute]),
		heldSources:           make(map[string]struct{}),
		limits:                limits,
	}
}

// HoldPublications keeps sourceID's publications registered when their media
// ends, until sourceID registers a new peer (a resume) or is unregistered (it
// left, or its grace window lapsed). The hub calls it when a participant
// enters its reconnect grace window.
func (r *Router) HoldPublications(sourceID string) {
	r.mu.Lock()
	r.heldSources[sourceID] = struct{}{}
	r.mu.Unlock()
}

// keepStoppedPublication reports whether a publication whose media ended must
// stay registered instead of being removed. It does while its publisher is in
// the reconnect grace window, and once the publisher has resumed onto a new
// peer. A browser closes its old peer connection when it reconnects, so every
// publication's media ends within seconds of the drop; removing them would
// detach every receiver's sender, and the resume would republish onto
// whichever free transceivers pion's AddTrack picks — a camera landing on the
// old screen's transceiver keeps the receiver's "|screen" track ID, and the
// browser client shows nothing (B9). Kept, each publication is replaced by
// the resumed one through migrateTargetsLocked: the same senders and
// transceivers, the same track IDs, and no renegotiation for the room. A
// publication whose publisher is still on the same peer ended for real and is
// removed. The caller must hold r.mu.
func (r *Router) keepStoppedPublicationLocked(pub *publication) bool {
	if _, held := r.heldSources[pub.sourceID]; held {
		return true
	}
	current := r.peers[pub.sourceID]
	return current != nil && pub.source != nil && current != pub.source
}

func (r *Router) AudioDrops() metrics.AudioDropSnapshot {
	return r.audioDrops.Snapshot()
}

// RTCPRelay reports the subscriber RTCP forwarded to publishers by type.
func (r *Router) RTCPRelay() metrics.RTCPRelaySnapshot {
	return r.rtcpRelay.Snapshot()
}

// VideoDrops reports the video the router did not pass on, by cause.
func (r *Router) VideoDrops() metrics.VideoDropSnapshot {
	return r.videoDrops.Snapshot()
}

func (r *Router) newTarget(track *pion.TrackLocalStaticRTP, pub *publication) *publicationTarget {
	target := newPublicationTarget(track, targetQueueDepth(pub.remote))
	if pub.remote != nil && pub.remote.Kind() == pion.RTPCodecTypeAudio {
		target.audio = newAudioMailbox(&r.audioDrops, time.Now)
	}
	return target
}

// SetLimits updates the hard server-side caps. Existing publications use the
// new limits immediately; new publications inherit them.
func (r *Router) SetLimits(limits Limits) {
	r.mu.Lock()
	r.limits = limits
	type limiterUpdate struct {
		limiter *bitrateLimiter
		kind    pion.RTPCodecType
	}
	updates := make([]limiterUpdate, 0, len(r.pubs))
	for _, pub := range r.pubs {
		if pub.limiter != nil && pub.remote != nil {
			updates = append(updates, limiterUpdate{limiter: pub.limiter, kind: pub.remote.Kind()})
		}
	}
	r.mu.Unlock()
	for _, update := range updates {
		// Existing publications are updated outside the router lock so the
		// forwarding path cannot deadlock while taking its limiter lock.
		update.limiter.setRate(rateForKind(update.kind, limits))
		if update.kind == pion.RTPCodecTypeVideo {
			update.limiter.setFPS(limits.MaxVideoFPS)
		}
	}
}

// pendingTrackOp is one pion egress operation decided under the router lock
// and applied after it is released: AddTrack allocates transceivers and takes
// pion-internal locks, and running it under r.mu stalls every media forward
// on the server for the duration of a join or leave.
type pendingTrackOp struct {
	subscribe bool
	pub       *publication
	targetID  string
	peer      *webrtc.Peer
	sender    *pion.RTPSender
}

func (r *Router) Register(id string, peer *webrtc.Peer, offerer Offerer) {
	var ops []pendingTrackOp
	offers := make(map[string]Offerer)
	r.mu.Lock()
	r.peers[id] = peer
	r.offerers[id] = offerer
	// From here on a stopped publication of the predecessor peer is kept by
	// the peer comparison in keepStoppedPublicationLocked.
	delete(r.heldSources, id)
	// A resumed client reclaims its participant ID with a brand-new peer
	// while the reconnect-grace path deliberately skips the superseded
	// client's teardown (publications are kept alive for the publication-swap
	// re-bind). Any target still registered under this ID therefore belongs
	// to the dead predecessor: left in place, queueSubscriptionLocked would
	// treat it as an existing subscription and suppress every re-subscription
	// for the rebuilt peer. Camera publications self-heal because the resume
	// churn replaces them; long-lived audio publications never swap, so the
	// rebuilt peer would otherwise receive zero audio for the rest of the
	// meeting while ICE stays connected.
	for _, pub := range r.pubs {
		if pub.tracks[id] != nil {
			r.removeTargetLocked(pub, id)
		}
	}
	for _, pub := range r.pubs {
		if r.shouldSubscribeLocked(pub, id) && r.queueSubscriptionLocked(pub, id, &ops) && offerer != nil {
			offers[id] = offerer
		}
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	dispatchOffers(offers)
}

func (r *Router) Unregister(id string) {
	offers := make(map[string]Offerer)
	var ops []pendingTrackOp
	r.mu.Lock()
	r.cancelVideoKeyFrameRetriesForReceiverLocked(id)
	delete(r.peers, id)
	delete(r.offerers, id)
	delete(r.heldSources, id)
	delete(r.videoSubscriptions, id)
	delete(r.videoSubscriptionsSet, id)
	delete(r.receiverVideoCodecs, id)
	delete(r.cameraLayers, id)
	for _, subscriptions := range r.videoSubscriptions {
		delete(subscriptions, id)
	}
	for key, pub := range r.pubs {
		if pub.sourceID == id {
			r.removePublicationLocked(pub, offers, &ops)
			delete(r.pubs, key)
			continue
		}
		r.removeTargetLocked(pub, id)
		r.cancelVideoKeyFramePublisherRetryWithoutSubscribersLocked(pub)
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	dispatchOffers(offers)
}

// Publish accepts the role-aware form (sourceID, role, source, remote[, layer]).
// The legacy (sourceID, source, remote) form remains supported for older callers.
func (r *Router) Publish(sourceID string, roleOrSource interface{}, args ...interface{}) {
	var role SourceRole
	var source *webrtc.Peer
	var remote *pion.TrackRemote
	switch value := roleOrSource.(type) {
	case SourceRole:
		role = value
		if len(args) >= 2 {
			source, _ = args[0].(*webrtc.Peer)
			remote, _ = args[1].(*pion.TrackRemote)
		}
	case string:
		role = SourceRole(value)
		if len(args) >= 2 {
			source, _ = args[0].(*webrtc.Peer)
			remote, _ = args[1].(*pion.TrackRemote)
		}
	case *webrtc.Peer:
		source = value
		if len(args) >= 1 {
			remote, _ = args[0].(*pion.TrackRemote)
		}
		if remote != nil {
			role = roleForKind(remote.Kind())
		}
	}
	if source == nil || remote == nil {
		return
	}
	if role == "" {
		role = roleForKind(remote.Kind())
	}
	layer := ""
	if role == SourceRoleCamera && len(args) >= 3 {
		layer, _ = args[2].(string)
	}
	if role != SourceRoleCamera {
		layer = ""
	}
	key := publicationKey(sourceID, role, layer)
	trackID := fmt.Sprintf("%s|%s", sourceID, role)
	if layer != "" {
		trackID += "|" + layer
	}
	streamID := fmt.Sprintf("slowmeet-%s-%s", sourceID, role)
	pub := &publication{
		key:         key,
		sourceID:    sourceID,
		role:        role,
		layer:       layer,
		trackID:     trackID,
		streamID:    streamID,
		codec:       remote.Codec().RTPCodecCapability,
		codecName:   videoCodecNameForTrack(remote),
		payloadType: uint8(remote.PayloadType()),
		remote:      remote,
		source:      source,
		tracks:      make(map[string]*publicationTarget),
		senders:     make(map[string]*pion.RTPSender),
		readBuf:     make([]byte, receiveMTU),
		limiter:     newPublicationBitrateLimiter(remote.Kind(), rateForKind(remote.Kind(), r.currentLimits())),
		videoDrops:  &r.videoDrops,
		stopped:     make(chan struct{}),
		forwardDone: make(chan struct{}),
	}
	limits := r.currentLimits()
	pub.limiter.setFPS(limits.MaxVideoFPS)
	if role == SourceRoleCamera {
		for rank, layer := range cameraLayersByQuality {
			pub.layerKeys[rank] = publicationKey(sourceID, SourceRoleCamera, layer)
		}
	}

	offers := make(map[string]Offerer)
	var ops []pendingTrackOp
	r.mu.Lock()
	if existing, exists := r.pubs[key]; exists && existing != pub {
		if existing.remote == remote {
			// The identical track re-fired; there is nothing to replace.
			r.mu.Unlock()
			return
		}
		// A fresh track arrived for an existing publication key (device swap,
		// screen re-share, or pion re-firing onTrack for a new SSRC). Replace
		// the stale publication so receivers stay on live media instead of a
		// track that may never produce packets again.
		slog.Default().Warn("media_publication_replaced_track",
			"source_id", sourceID,
			"role", role,
			"layer", layer,
			"track_id", trackID,
			"existing_ssrc", existing.remote.SSRC(),
			"new_ssrc", remote.SSRC(),
		)
		if sameCodecCapability(existing.codec, pub.codec) {
			// Reuse each receiver's already-negotiated sender with ReplaceTrack:
			// removing and re-adding tracks would leak one orphaned transceiver
			// per receiver per swap and force a full renegotiation each time.
			r.migrateTargetsLocked(existing, pub)
		}
		r.removePublicationLocked(existing, offers, &ops)
	}
	r.pubs[key] = pub
	r.warnIfVideoCodecNotAllowedLocked(pub)
	for id := range r.peers {
		if r.shouldSubscribeLocked(pub, id) && r.queueSubscriptionLocked(pub, id, &ops) {
			if offerer := r.offerers[id]; offerer != nil {
				offers[id] = offerer
			}
		}
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	dispatchOffers(offers)

	go r.forward(pub)
}

// SetVideoSubscriptionsWithLayer replaces the visible camera sources and the
// receiver's preferred simulcast layer. Layer changes only affect packet
// forwarding; subscribed layer tracks are negotiated when the camera appears.
func (r *Router) SetVideoSubscriptionsWithLayer(receiverID string, cameraParticipantIDs []string, cameraLayer string) {
	desired := make(map[string]struct{}, len(cameraParticipantIDs))
	for _, participantID := range cameraParticipantIDs {
		if participantID != "" && participantID != receiverID {
			desired[participantID] = struct{}{}
		}
	}

	var offer Offerer
	var ops []pendingTrackOp
	changed := false
	r.mu.Lock()
	if !validCameraLayer(cameraLayer) {
		cameraLayer = "medium"
	}
	r.videoSubscriptions[receiverID] = desired
	r.videoSubscriptionsSet[receiverID] = true
	r.cameraLayers[receiverID] = cameraLayer
	changed = r.reconcileReceiverLocked(receiverID, &ops)
	if changed {
		offer = r.offerers[receiverID]
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	if offer != nil {
		_ = offer()
	}
}

func CameraLayerFromRID(rid string) string {
	if validCameraLayer(rid) {
		return rid
	}
	switch rid {
	case "q":
		return "low"
	case "h":
		return "medium"
	case "f":
		return "high"
	default:
		return ""
	}
}

func validCameraLayer(layer string) bool {
	return layer == "low" || layer == "medium" || layer == "high"
}

func publicationKey(sourceID string, role SourceRole, layer string) string {
	key := sourceID + "/" + string(role)
	if role == SourceRoleCamera && layer != "" {
		key += "/" + layer
	}
	return key
}

func (r *Router) shouldSubscribeLocked(pub *publication, receiverID string) bool {
	if pub.sourceID == receiverID {
		return false
	}
	if !r.videoCodecUsableLocked(pub, receiverID) {
		return false
	}
	if pub.role != SourceRoleCamera || !r.videoSubscriptionsSet[receiverID] {
		return true
	}
	_, subscribed := r.videoSubscriptions[receiverID][pub.sourceID]
	return subscribed
}

func roleForKind(kind pion.RTPCodecType) SourceRole {
	if kind == pion.RTPCodecTypeAudio {
		return SourceRoleAudio
	}
	return SourceRoleCamera
}

func (r *Router) Unpublish(sourceID string, role SourceRole) {
	offers := make(map[string]Offerer)
	var ops []pendingTrackOp
	r.mu.Lock()
	for key, pub := range r.pubs {
		if pub.sourceID != sourceID || pub.role != role {
			continue
		}
		r.removePublicationLocked(pub, offers, &ops)
		delete(r.pubs, key)
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	dispatchOffers(offers)
}

// SetPublicationActive pauses or resumes forwarding for an existing source
// without removing its negotiated receiver tracks. Screen-share senders may
// replace their local track with nil while stopped, then reuse the same sender
// and remote track when sharing resumes.
func (r *Router) SetPublicationActive(sourceID string, role SourceRole, active bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, pub := range r.pubs {
		if pub.sourceID == sourceID && pub.role == role {
			pub.paused.Store(!active)
		}
	}
}

// RequestVideoKeyFrame asks active camera and screen publishers with a
// track sent to receiverID to send a fresh frame after negotiation signaling.
// retries a bounded number of times and cancels retries when either peer or
// the publication is removed. onError is optional and reports RTCP write
// failures from the initial request or a retry.
func (r *Router) RequestVideoKeyFrame(receiverID string, onError ...func(error)) {
	var reportError func(error)
	if len(onError) > 0 {
		reportError = onError[0]
	}
	r.requestVideoKeyFrame(receiverID, reportError)
}

// RequestVideoKeyFrameForPublisher asks each active camera or screen
// publication from sourceID to produce a fresh keyframe for its subscribers.
func (r *Router) RequestVideoKeyFrameForPublisher(sourceID string, onError ...func(error)) {
	var reportError func(error)
	if len(onError) > 0 {
		reportError = onError[0]
	}
	if sourceID == "" {
		return
	}

	var requests []*videoKeyFrameRetry
	r.mu.Lock()
	for _, pub := range r.pubs {
		if pub.sourceID != sourceID || (pub.role != SourceRoleCamera && pub.role != SourceRoleScreen) ||
			pub.source == nil || pub.remote == nil || pub.paused.Load() {
			continue
		}
		if !hasVideoKeyFrameSubscriber(pub) {
			continue
		}
		if request := r.scheduleVideoKeyFrameRetryLocked(pub, "", reportError); request != nil {
			requests = append(requests, request)
		}
	}
	r.mu.Unlock()

	for _, request := range requests {
		r.writeFirstVideoKeyFrame(request.publication, request.onError)
	}
}

// writeFirstVideoKeyFrame sends the first request of a series, unless a
// keyframe is already on its way to the receivers (keyFrameComing). The
// repeats still follow and ask if that keyframe never goes out.
func (r *Router) writeFirstVideoKeyFrame(pub *publication, onError func(error)) {
	if now := time.Now(); pub.keyFrameComing(now, now.UnixNano()) {
		return
	}
	r.writeVideoKeyFrame(pub, onError)
}

func (r *Router) requestVideoKeyFrame(receiverID string, onError func(error)) {
	var requests []*videoKeyFrameRetry
	r.mu.Lock()
	for _, pub := range r.pubs {
		if (pub.role != SourceRoleCamera && pub.role != SourceRoleScreen) || pub.source == nil || pub.remote == nil || pub.paused.Load() {
			continue
		}
		if pub.senders[receiverID] == nil {
			continue
		}
		if request := r.scheduleVideoKeyFrameRetryLocked(pub, receiverID, onError); request != nil {
			requests = append(requests, request)
		}
	}
	r.mu.Unlock()

	for _, request := range requests {
		r.writeFirstVideoKeyFrame(request.publication, request.onError)
	}
}

// scheduleVideoKeyFrameRetryLocked starts a keyframe retry series for pub, or
// returns nil if one is already running. There is one series per publication,
// not per receiver: one keyframe from the publisher's encoder reaches every
// receiver of it, and receivers that switch to the same layer in one frame
// used to start one series each against that single encoder (B2 in
// docs/network-testing.md). receiverID only names who asked.
func (r *Router) scheduleVideoKeyFrameRetryLocked(pub *publication, receiverID string, onError func(error)) *videoKeyFrameRetry {
	_ = receiverID
	key := videoKeyFrameRequestKey{publicationKey: pub.key}
	if existing := r.videoKeyFrameRetries[key]; existing != nil {
		if existing.publication == pub {
			return nil
		}
		existing.timer.Stop()
		delete(r.videoKeyFrameRetries, key)
	}
	request := &videoKeyFrameRetry{
		publication: pub,
		remaining:   videoKeyFrameRequestCount - 1,
		startedAt:   time.Now().UnixNano(),
		onError:     onError,
	}
	request.timer = time.AfterFunc(videoKeyFrameRetryDelay, func() {
		r.retryVideoKeyFrame(key, request)
	})
	r.videoKeyFrameRetries[key] = request
	return request
}

func (r *Router) retryVideoKeyFrame(key videoKeyFrameRequestKey, request *videoKeyFrameRetry) {
	r.mu.Lock()
	if r.videoKeyFrameRetries[key] != request {
		r.mu.Unlock()
		return
	}
	hasSubscriber := request.publication.senders[key.receiverID] != nil
	if key.receiverID == "" {
		hasSubscriber = hasVideoKeyFrameSubscriber(request.publication)
	}
	// The repeats cover a request lost on the way. Once a keyframe has started
	// to arrive, the request was answered, and every further one makes the
	// encoder produce another: measured with a shared screen at a 300 kbps
	// limit, one series of three cost three extra keyframes of about 250 KB,
	// 20 s of the stream's bitrate (B23 in docs/network-testing.md).
	answered := request.publication.keyFrameComing(time.Now(), request.startedAt)
	if r.pubs[request.publication.key] != request.publication || !hasSubscriber || answered {
		delete(r.videoKeyFrameRetries, key)
		r.mu.Unlock()
		return
	}
	request.remaining--
	if request.remaining == 0 {
		delete(r.videoKeyFrameRetries, key)
	} else {
		request.timer = time.AfterFunc(videoKeyFrameRetryDelay, func() {
			r.retryVideoKeyFrame(key, request)
		})
	}
	r.mu.Unlock()

	r.writeVideoKeyFrame(request.publication, request.onError)
}

func (r *Router) writeVideoKeyFrame(pub *publication, onError func(error)) {
	// The SFU's own requests are already bounded to one series per
	// publication and are always sent: a completed negotiation needs its
	// keyframe now. They do mark the publication's budget, so receivers'
	// PLIs that follow within the interval are not relayed on top.
	pub.lastKeyFrameRequest.Store(time.Now().UnixNano())
	err := pub.source.WriteRTCP([]rtcp.Packet{
		&rtcp.PictureLossIndication{MediaSSRC: uint32(pub.remote.SSRC())},
	})
	if err != nil && onError != nil {
		onError(err)
	}
}

func (r *Router) cancelVideoKeyFrameRetriesForReceiverLocked(receiverID string) {
	for key, request := range r.videoKeyFrameRetries {
		if key.receiverID != receiverID {
			continue
		}
		request.timer.Stop()
		delete(r.videoKeyFrameRetries, key)
	}
}

func (r *Router) cancelVideoKeyFrameRetriesForPublicationLocked(pub *publication) {
	for key, request := range r.videoKeyFrameRetries {
		if request.publication != pub {
			continue
		}
		request.timer.Stop()
		delete(r.videoKeyFrameRetries, key)
	}
}

func (r *Router) cancelVideoKeyFramePublisherRetryWithoutSubscribersLocked(pub *publication) {
	if hasVideoKeyFrameSubscriber(pub) {
		return
	}
	key := videoKeyFrameRequestKey{publicationKey: pub.key}
	if request := r.videoKeyFrameRetries[key]; request != nil {
		request.timer.Stop()
		delete(r.videoKeyFrameRetries, key)
	}
}

func hasVideoKeyFrameSubscriber(pub *publication) bool {
	for _, sender := range pub.senders {
		if sender != nil {
			return true
		}
	}
	return false
}

func (r *Router) currentLimits() Limits {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.limits
}

func rateForKind(kind pion.RTPCodecType, limits Limits) int {
	bitrate := limits.MaxVideoBitrate
	if kind == pion.RTPCodecTypeAudio {
		bitrate = limits.MaxAudioBitrate
	}
	if bitrate <= 0 {
		return 0
	}
	bytesPerSecond := bitrate / 8
	if bytesPerSecond == 0 {
		return 1
	}
	return bytesPerSecond
}

// sameCodecCapability reports whether a publication swap can reuse the
// existing senders: ReplaceTrack across different codecs would leave the
// receiver's negotiated m-line inconsistent.
func sameCodecCapability(a, b pion.RTPCodecCapability) bool {
	return a.MimeType == b.MimeType && a.ClockRate == b.ClockRate &&
		a.Channels == b.Channels && a.SDPFmtpLine == b.SDPFmtpLine
}

// migrateTargetsLocked moves an existing publication's receiver senders onto
// its replacement, retargeting every sender with ReplaceTrack so the already
// negotiated m-lines keep working without renegotiation. Senders whose
// ReplaceTrack fails stay behind for removePublicationLocked, which falls
// back to the remove-and-add path for them. The caller must hold r.mu. This
// path stays under the lock: swaps are rare (device changes), unlike the
// bulk join/leave subscription flows.
func (r *Router) migrateTargetsLocked(existing, replacement *publication) {
	for targetID, oldTarget := range existing.tracks {
		sender := existing.senders[targetID]
		if sender == nil || replacement.remote == nil {
			continue
		}
		local, err := pion.NewTrackLocalStaticRTP(
			replacement.codec, replacement.trackID, replacement.streamID)
		if err != nil {
			continue
		}
		if err := sender.ReplaceTrack(local); err != nil {
			continue
		}
		target := r.newTarget(local, replacement)
		target.egress = newEgressHeaderExtensions(r.peers[targetID], sender)
		target.continueAudioFrom(oldTarget)
		replacement.tracks[targetID] = target
		replacement.senders[targetID] = sender
		if route := r.senderFeedback[sender]; route != nil {
			route.Store(newFeedbackRoute(replacement, target))
		}
		go target.writePackets(replacement.stoppedChannel())
		// The old target's writer exits through stop; any packets still in its
		// mailbox belong to the retired track and are dropped with it.
		oldTarget.stop()
		delete(existing.tracks, targetID)
		delete(existing.senders, targetID)
	}
}

// queueSubscriptionLocked records a subscription decision for application
// after the router lock is released. It reports whether the subscription was
// queued, so callers can count it as a renegotiation trigger. The caller
// must hold r.mu and pass its own operation slice.
func (r *Router) queueSubscriptionLocked(pub *publication, targetID string, ops *[]pendingTrackOp) bool {
	if _, exists := pub.tracks[targetID]; exists {
		return false
	}
	peer := r.peers[targetID]
	if peer == nil {
		return false
	}
	*ops = append(*ops, pendingTrackOp{
		subscribe: true, pub: pub, targetID: targetID, peer: peer,
	})
	return true
}

// applyTrackOps performs the queued pion operations in decision order. Each
// operation revalidates its decision against the current router state before
// touching pion: a mutation that ran while the lock was released may have
// superseded it. A superseded subscription removes the just-added sender; a
// superseded removal skips the RemoveTrack when a publication swap migrated
// that sender into a live replacement publication — removing it there would
// silently kill the receiver's media.
func (r *Router) applyTrackOps(ops []pendingTrackOp) {
	for _, op := range ops {
		if !op.subscribe {
			if r.senderMigrated(op) {
				continue
			}
			_ = op.peer.RemoveTrack(op.sender)
			continue
		}
		local, err := pion.NewTrackLocalStaticRTP(op.pub.codec, op.pub.trackID, op.pub.streamID)
		if err != nil {
			continue
		}
		sender, err := op.peer.AddTrack(local)
		if err != nil {
			continue
		}
		if !senderNegotiatedCodec(sender, op.pub.codec) {
			// Starting a sender for a codec the receiver never negotiated
			// fails its whole next description, not just this track.
			slog.Default().Warn("media_subscription_codec_not_negotiated",
				"source_id", op.pub.sourceID, "role", op.pub.role,
				"receiver_id", op.targetID, "codec", op.pub.codec.MimeType)
			_ = op.peer.RemoveTrack(sender)
			continue
		}
		r.mu.Lock()
		valid := r.pubs[op.pub.key] == op.pub &&
			r.peers[op.targetID] == op.peer &&
			op.pub.tracks[op.targetID] == nil &&
			r.shouldSubscribeLocked(op.pub, op.targetID)
		if valid {
			target := r.newTarget(local, op.pub)
			target.egress = newEgressHeaderExtensions(op.peer, sender)
			op.pub.tracks[op.targetID] = target
			op.pub.senders[op.targetID] = sender
			if op.pub.source != nil && op.pub.remote != nil {
				route := &atomic.Pointer[feedbackRoute]{}
				route.Store(newFeedbackRoute(op.pub, target))
				r.senderFeedback[sender] = route
				go target.writePackets(op.pub.stoppedChannel())
				go relayRTCP(sender, route, &r.rtcpRelay)
			}
		}
		r.mu.Unlock()
		if !valid {
			_ = op.peer.RemoveTrack(sender)
		}
	}
}

// senderMigrated is cheap defense for queued RemoveTrack operations: the
// decide phase deletes the sender from its publication's maps in the same
// exclusive-lock hold that queues the op, and migration also runs under the
// lock — so at apply time no registered publication can still hold a
// queued-for-removal sender, and this scan never fires today. It guards
// against a future decide-phase reordering where a swap could relocate a
// sender between the queueing and the application of its removal; in that
// state, removing the sender would silently kill a live publication's media.
func (r *Router) senderMigrated(op pendingTrackOp) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, pub := range r.pubs {
		if pub.senders[op.targetID] == op.sender {
			return true
		}
	}
	return false
}

// dispatchOffers runs renegotiation callbacks concurrently: each offer
// generates SDP for a different peer under that peer's own negotiation lock,
// so a large room's join or leave fan-out takes as long as the slowest single
// offer instead of the sum of all of them.
func dispatchOffers(offers map[string]Offerer) {
	if len(offers) <= 1 {
		for _, offer := range offers {
			_ = offer()
		}
		return
	}
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for _, offer := range offers {
		wg.Add(1)
		go func(offer Offerer) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			_ = offer()
		}(offer)
	}
	wg.Wait()
}

// feedbackRoute is where one receiver's RTCP feedback goes: the publisher's
// peer and the ingress SSRC to rewrite the feedback with. It is replaced as a
// whole on a publication swap, never mutated.
type feedbackRoute struct {
	source *webrtc.Peer
	ssrc   uint32
	// pub is the publication the feedback is about; its keyframe-request
	// budget is shared by every receiver (allowKeyFrameRequest).
	pub *publication
	// videoTarget is the receiver's egress target for a video publication,
	// whose mailbox-loss record decides which NACKed packets only the
	// publisher can resend; nil for audio, whose NACKs relay unfiltered.
	videoTarget *publicationTarget
}

// keyFrameRequestInterval is the shortest gap between two keyframe requests
// that reach one publisher. It is below videoKeyFrameRetryDelay so a retry
// series still runs, and long enough that subscribers asking in the same
// moment — they all lost the picture to the same cause — share one keyframe.
const keyFrameRequestInterval = 200 * time.Millisecond

// allowKeyFrameRequest reports whether a keyframe request (a receiver's PLI or
// FIR, or the SFU's own) may reach this publication's publisher now. The
// keyframe a request produces is forwarded to every receiver, so requests in
// the same interval are redundant: relaying each subscriber's and running a
// retry series per subscriber made N lossy receivers cost N times the
// keyframes on one encoder (B2 in docs/network-testing.md).
func (pub *publication) allowKeyFrameRequest(now time.Time) bool {
	last := pub.lastKeyFrameRequest.Load()
	if last != 0 && now.UnixNano()-last < int64(keyFrameRequestInterval) {
		return false
	}
	return pub.lastKeyFrameRequest.CompareAndSwap(last, now.UnixNano())
}

func newFeedbackRoute(pub *publication, target *publicationTarget) *feedbackRoute {
	route := &feedbackRoute{source: pub.source, ssrc: uint32(pub.remote.SSRC()), pub: pub}
	if pub.remote.Kind() == pion.RTPCodecTypeVideo {
		route.videoTarget = target
	}
	return route
}

// publisherResendable reports, for a receiver's NACK, the packets only the
// publisher can resend: those this receiver's mailbox dropped, which the
// SFU never wrote to the receiver and repairs from the publisher's
// retransmission (target_video_loss.go). Every other NACKed packet is
// already handled at the SFU — its NACK responder resends what it wrote and
// lost on the downlink, its NACK generator requests what the publisher's
// uplink lost, and frames the FPS gate or a full pacer queue dropped are
// meant to stay dropped — so relaying it would only multiply the
// publisher's retransmissions by the number of receivers. On a thin lossy
// uplink that multiplication filled the link and starved the publisher's
// own audio (B8 in docs/network-testing.md).
func (route *feedbackRoute) publisherResendable(now time.Time) func(uint16) bool {
	if route.videoTarget == nil {
		return nil
	}
	return func(sequence uint16) bool { return route.videoTarget.hasVideoLossSequence(sequence, now) }
}

// relayRTCP forwards receiver feedback to the publication's source. The route
// is read per batch so a publication swap that reuses this sender retargets
// the feedback to the new source peer and track without restarting the
// goroutine (the sender keeps one RTCP reader for its whole lifetime). A
// failed write does not end the relay: it can be the superseded peer closing
// just before a swap moves the route, and the goroutine still exits when the
// sender itself stops.
func relayRTCP(sender *pion.RTPSender, route *atomic.Pointer[feedbackRoute], relayed *metrics.RTCPRelay) {
	buf := make([]byte, receiveMTU)
	for {
		packets, err := readSenderRTCP(sender, buf)
		if err != nil {
			return
		}
		current := route.Load()
		now := time.Now()
		var keyFrameAllowed func() bool
		if current.pub != nil {
			keyFrameAllowed = func() bool {
				return !current.pub.keyFrameInTransit(now) && current.pub.allowKeyFrameRequest(now)
			}
		}
		routed := routeFilteredRTCPFeedback(packets, current.ssrc, current.publisherResendable(now), keyFrameAllowed)
		relayed.Observe(packets)
		if len(routed) == 0 || current.source == nil {
			// Nothing in the batch concerns the publisher; skip the
			// encrypt-and-send entirely.
			continue
		}
		relayed.ForwardedBatches.Add(1)
		_ = current.source.WriteRTCP(routed)
	}
}

func readSenderRTCP(sender interface {
	Read([]byte) (int, interceptor.Attributes, error)
}, buf []byte) ([]rtcp.Packet, error) {
	n, attrs, err := sender.Read(buf)
	if err != nil {
		return nil, err
	}
	// The NACK interceptor has usually parsed this batch already. Reuse it
	// instead of unmarshalling the same RTCP a second time.
	return attrs.GetRTCPPackets(buf[:n])
}

// routeRTCPFeedback keeps only the subscriber feedback a publisher can act on
// and retargets it at the publisher's own track: keyframe requests (PLI, FIR),
// retransmission requests (NACK), and REMB.
//
// Everything else describes the SFU-to-subscriber leg and is dropped. Receiver
// reports and transport-wide congestion feedback name the subscriber-side SSRC
// and sequence space, which the publisher does not know, and the SFU already
// sends the publisher its own reports and transport-cc feedback for the
// publisher-to-SFU leg (internal/webrtc/peer.go). On a relayed two-person call
// 99.9% of the forwarded batches were of this kind (see
// docs/vps-regression-diagnostics.md), each one an SRTCP encrypt, a send, and
// bytes on the publisher's downlink.
func routeRTCPFeedback(packets []rtcp.Packet, sourceSSRC uint32) []rtcp.Packet {
	return routeFilteredRTCPFeedback(packets, sourceSSRC, nil, nil)
}

// routeFilteredRTCPFeedback is routeRTCPFeedback that keeps, in each NACK,
// only the sequence numbers resendable accepts (a NACK left with nothing is
// not relayed at all), and relays a keyframe request (PLI or FIR) only when
// keyFrameAllowed grants it. Nil filters keep everything.
func routeFilteredRTCPFeedback(packets []rtcp.Packet, sourceSSRC uint32, resendable func(uint16) bool,
	keyFrameAllowed func() bool,
) []rtcp.Packet {
	var routed []rtcp.Packet
	for _, packet := range packets {
		switch feedback := packet.(type) {
		case *rtcp.PictureLossIndication:
			if keyFrameAllowed != nil && !keyFrameAllowed() {
				continue
			}
			copy := *feedback
			copy.MediaSSRC = sourceSSRC
			routed = append(routed, &copy)
		case *rtcp.FullIntraRequest:
			if keyFrameAllowed != nil && !keyFrameAllowed() {
				continue
			}
			copy := *feedback
			copy.MediaSSRC = sourceSSRC
			copy.FIR = append([]rtcp.FIREntry(nil), feedback.FIR...)
			for index := range copy.FIR {
				copy.FIR[index].SSRC = sourceSSRC
			}
			routed = append(routed, &copy)
		case *rtcp.TransportLayerNack:
			copy := *feedback
			copy.MediaSSRC = sourceSSRC
			if resendable != nil {
				copy.Nacks = filterNackPairs(feedback.Nacks, resendable)
				if len(copy.Nacks) == 0 {
					continue
				}
			} else {
				copy.Nacks = append([]rtcp.NackPair(nil), feedback.Nacks...)
			}
			routed = append(routed, &copy)
		case *rtcp.ReceiverEstimatedMaximumBitrate:
			// Sent only by receivers without transport-cc; a publisher's
			// browser applies it as a send-rate cap, so it stays forwarded.
			routed = append(routed, packet)
		}
	}
	return routed
}

// filterNackPairs rebuilds NACK pairs from the sequence numbers keep accepts,
// returning nil when none is left. The receiver's pairs are never modified.
func filterNackPairs(pairs []rtcp.NackPair, keep func(uint16) bool) []rtcp.NackPair {
	var kept []uint16
	for _, pair := range pairs {
		for _, sequence := range pair.PacketList() {
			if keep(sequence) {
				kept = append(kept, sequence)
			}
		}
	}
	if len(kept) == 0 {
		return nil
	}
	return rtcp.NackPairsFromSequenceNumbers(kept)
}

func (r *Router) forward(pub *publication) {
	// Audio publications never enter the pacer path; spawning its goroutine
	// and channel for them would park both forever.
	defer close(pub.forwardDone)
	if pub.remote.Kind() == pion.RTPCodecTypeVideo {
		r.forwardVideo(pub)
		return
	}
	r.forwardAudio(pub)
}

func (r *Router) forwardVideo(pub *publication) {
	var frame videoFrameBuffer
	var history videoFrameHistory
	var wasPaused bool
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stopPacer := make(chan struct{})
	go r.forwardVideoFrames(pub, frames, stopPacer)
	defer close(stopPacer)
	// TrackRemote checks Pion's separate RTX queue before waiting for primary
	// RTP. Wake periodically so a quiet screen share can deliver a queued
	// retransmission even if no more primary packets arrive.
	if err := pub.remote.SetReadDeadline(time.Now().Add(videoRTXReadPollInterval)); err != nil {
		r.reportPublicationReadStop(pub, err)
		return
	}
	select {
	case <-pub.stoppedChannel():
		return
	default:
	}
	for {
		packet, err := readIngressPacket(pub)
		if err != nil {
			select {
			case <-pub.stoppedChannel():
				return
			default:
			}
			// A packet whose payload type the media engine does not know is
			// dropped by pion after it was read; it says nothing about the
			// transport, so the publication stays.
			if errors.Is(err, pion.ErrCodecNotFound) {
				continue
			}
			// The poll deadline expiring is the loop's wake-up signal, not a
			// transport failure. Pion returns two distinct timeout values with
			// the same "i/o timeout" message: os.ErrDeadlineExceeded from the
			// SRTP read stream and packetio.ErrTimeout from transport
			// buffers — recognize both, or one lost-mid-gap read under delay
			// tears down a live publication.
			var netErr net.Error
			if errors.As(err, &netErr) && netErr.Timeout() {
				if err = pub.remote.SetReadDeadline(time.Now().Add(videoRTXReadPollInterval)); err == nil {
					select {
					case <-pub.stoppedChannel():
						return
					default:
					}
					continue
				}
			}
			r.reportPublicationReadStop(pub, err)
			return
		}
		if payloadType := uint8(packet.PayloadType); payloadType != pub.payloadType {
			if r.handleIngressCodecChange(pub, payloadType) {
				return
			}
			if payloadType != pub.payloadType {
				// Neither the publication's codec nor one the track moved to.
				continue
			}
		}
		pub.lastPacketAt.Store(time.Now().UnixNano())
		if pub.paused.Load() {
			if !wasPaused {
				history = videoFrameHistory{}
				wasPaused = true
			}
			continue
		}
		wasPaused = false
		if queueVideoPacket(pub, &frame, &history, frames, packet) {
			if targets := r.videoLossTargets(pub, packet); len(targets) > 0 {
				enqueueVideoFrame(frames, videoFrame{packets: []*rtp.Packet{packet}, repairTargets: targets})
			}
		}
		if pub.keyFrameAfterDrop.Load() && pub.keyFrameAfterDropDue(time.Now()) {
			r.writeVideoKeyFrame(pub, nil)
		}
	}
}

const videoRTXReadPollInterval = 100 * time.Millisecond

func (r *Router) forwardAudio(pub *publication) {
	for {
		packet, err := readIngressPacket(pub)
		if err != nil {
			r.reportPublicationReadStop(pub, err)
			return
		}
		pub.lastPacketAt.Store(time.Now().UnixNano())
		if pub.paused.Load() {
			continue
		}
		if !pub.limiter.allow(packet.MarshalSize()) {
			r.audioDrops.Admission.Add(1)
			continue
		}
		r.forwardAudioPacket(pub, packet)
	}
}

// readIngressPacket reads one RTP packet into the publication's reusable
// buffer instead of the fresh 1500-byte allocation pion's ReadRTP makes per
// packet — at meeting scale that buffer is the single largest source of GC
// churn. Unmarshal aliases the reused buffer for both the payload and the
// header extension payloads (pion rtp's Header.Unmarshal slices extension
// payloads straight out of the input), and the next read overwrites them
// while the frame buffer and mailboxes hold packets asynchronously. The
// decoder copies the bytes into owned storage before parsing. An unparseable
// packet is fatal for the publication, matching ReadRTP's behavior exactly.
func readIngressPacket(pub *publication) (*rtp.Packet, error) {
	n, _, err := pub.remote.Read(pub.readBuf)
	if err != nil {
		return nil, err
	}
	return decodeIngressPacket(pub.readBuf[:n])
}

// decodeIngressPacket copies the wire bytes before parsing because Unmarshal
// aliases its input for the payload and header extensions. The returned packet
// remains valid when the next read overwrites the publication's buffer.
func decodeIngressPacket(wire []byte) (*rtp.Packet, error) {
	packet := &rtp.Packet{}
	owned := append([]byte(nil), wire...)
	if err := packet.Unmarshal(owned); err != nil {
		return nil, err
	}
	return packet, nil
}

func (r *Router) reportPublicationReadStop(pub *publication, err error) {
	r.mu.RLock()
	stillRegistered := r.pubs[pub.key] == pub
	keep := stillRegistered && r.keepStoppedPublicationLocked(pub)
	r.mu.RUnlock()
	if keep {
		slog.Default().Info("media_publication_kept_for_resume",
			"source_id", pub.sourceID, "role", pub.role, "layer", pub.layer, "error", err)
		return
	}
	if stillRegistered {
		slog.Default().Warn("media_publication_read_stopped",
			"source_id", pub.sourceID,
			"role", pub.role,
			"layer", pub.layer,
			"track_id", pub.trackID,
			"ssrc", pub.remote.SSRC(),
			"error", err,
		)
	}
	r.removePublication(pub)
}

func (r *Router) forwardVideoFrames(pub *publication, frames <-chan videoFrame, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case frame := <-frames:
			if frame.repairTargets == nil && !frame.queuedAt.IsZero() {
				pub.videoDrops.ObserveFrameQueue(len(frames)+1, time.Since(frame.queuedAt))
			}
			// The camera-layer selection can only change per frame, not per
			// packet; resolve the target list and any layer transitions once.
			targets, layerStarts := r.resolveFrameTargets(pub)
			if frame.repairTargets != nil {
				// A duplicate source packet is useful only to receivers whose
				// mailbox dropped it. Recheck current subscriptions and losses:
				// a prior queued repair may already have reached the mailbox.
				eligible := targets[:0]
				for _, target := range targets {
					for _, repairTarget := range frame.repairTargets {
						if target == repairTarget && target.hasVideoLoss(frame.packets[0]) {
							eligible = append(eligible, target)
							break
						}
					}
				}
				targets = eligible
			}
			if len(targets) == 0 {
				for _, receiverID := range layerStarts {
					r.requestVideoKeyFrameForPublication(pub, receiverID)
				}
				continue
			}
			if frame.keyFrame && frame.repairTargets == nil {
				pub.lastKeyFrameForward.Store(time.Now().UnixNano())
			}
			for _, packet := range frame.packets {
				if pub.paused.Load() {
					break
				}
				select {
				case <-stop:
					return
				default:
				}
				if !pub.limiter.waitForBytes(pacedVideoBytes(packet.MarshalSize(), frame.queuedAt), stop) {
					return
				}
				if frame.repairTargets == nil {
					// Repairs go to the few receivers whose mailbox dropped the
					// packet; only the main forward path describes the stream
					// every receiver gets.
					now := time.Now()
					pub.forwardLoss.observe(packet.SequenceNumber, now)
					pub.forwardJitter.observe(packet.Timestamp, pub.codec.ClockRate, now)
				}
				for _, target := range targets {
					if frame.repairTargets == nil || target.hasVideoLoss(packet) {
						if !target.enqueueVideo(packet) {
							pub.videoDrops.MailboxDrop()
						}
						pub.videoDrops.ObserveMailbox(len(target.pending))
					}
				}
			}
			if frame.keyFrame && frame.repairTargets == nil {
				pub.lastKeyFrameSent.Store(time.Now().UnixNano())
			}
			// A receiver just started receiving this publication's layer
			// mid-GOP; ask its publisher for a keyframe so the tile recovers
			// immediately instead of waiting for the next natural keyframe.
			for _, receiverID := range layerStarts {
				r.requestVideoKeyFrameForPublication(pub, receiverID)
			}
		}
	}
}

// A frame that has waited this long for the pacer is late for a live call, and
// the pacer sends it faster to catch up: at one and a half times the rate
// after videoCatchUpAfter, at twice the rate after videoCatchUpFastAfter.
//
// Without this the queue only ever drains at the rate it fills. A sender that
// encodes at exactly the server's limit is a few percent over it once packet
// headers are counted, so the queue grew until it was full and stayed there:
// measured with a browser sharing a moving screen at a 300 kbps limit, every
// frame reached the viewers 12 s late (B22 in docs/network-testing.md). The
// limit still holds for a sender's average; only a backlog, such as the one a
// keyframe leaves behind, is sent above it, and never above twice.
const (
	videoCatchUpAfter     = 250 * time.Millisecond
	videoCatchUpFastAfter = time.Second
)

// pacedVideoBytes is what the pacer charges for a packet of size bytes that
// belongs to a frame queued at queuedAt: less than its size once the frame is
// late, which is what sends it faster.
func pacedVideoBytes(size int, queuedAt time.Time) int {
	if queuedAt.IsZero() {
		return size
	}
	switch waited := time.Since(queuedAt); {
	case waited >= videoCatchUpFastAfter:
		return (size + 1) / 2
	case waited >= videoCatchUpAfter:
		return (size*2 + 2) / 3
	}
	return size
}

func enqueueVideoFrame(queue chan<- videoFrame, frame videoFrame) bool {
	frame.queuedAt = time.Now()
	select {
	case queue <- frame:
		return true
	default:
		return false
	}
}

// forwardAudioPacket fans one audio packet out to every subscriber. Audio
// publications carry no simulcast layer, so no per-receiver selection applies.
func (r *Router) forwardAudioPacket(pub *publication, packet *rtp.Packet) {
	r.mu.RLock()
	if pub.paused.Load() || len(pub.tracks) == 0 {
		r.mu.RUnlock()
		return
	}
	targets := pub.targetScratch[:0]
	for _, target := range pub.tracks {
		targets = append(targets, target)
	}
	pub.targetScratch = targets
	r.mu.RUnlock()
	now := time.Now()
	pub.forwardLoss.observe(packet.SequenceNumber, now)
	pub.forwardJitter.observe(packet.Timestamp, pub.codec.ClockRate, now)
	for _, target := range targets {
		target.enqueue(packet)
	}
}

// resolveFrameTargets selects the receivers that should currently receive the
// publication's layer and reports the receivers whose layer just changed, so
// their publisher can be asked for a keyframe. The caller is the
// publication's single video pacer goroutine.
func (r *Router) resolveFrameTargets(pub *publication) ([]*publicationTarget, []string) {
	var layerStarts []string
	r.mu.RLock()
	if pub.paused.Load() || len(pub.tracks) == 0 {
		r.mu.RUnlock()
		return nil, nil
	}
	targets := pub.targetScratch[:0]
	if pub.layer == "" {
		for _, target := range pub.tracks {
			targets = append(targets, target)
		}
	} else {
		now := time.Now()
		for targetID, target := range pub.tracks {
			if r.selectedCameraLayerLocked(pub, targetID, now) != pub.layer {
				// The receiver is receiving another layer right now; clear the
				// marker so returning to this layer requests a fresh keyframe.
				if target.lastSentLayer == pub.layer {
					target.lastSentLayer = ""
				}
				continue
			}
			if target.lastSentLayer != pub.layer {
				target.lastSentLayer = pub.layer
				layerStarts = append(layerStarts, targetID)
			}
			targets = append(targets, target)
		}
	}
	pub.targetScratch = targets
	r.mu.RUnlock()
	return targets, layerStarts
}

// requestVideoKeyFrameForPublication asks one publication's publisher for a
// fresh keyframe for one receiver, with bounded retries.
func (r *Router) requestVideoKeyFrameForPublication(pub *publication, receiverID string) {
	r.mu.Lock()
	request := r.scheduleVideoKeyFrameRetryLocked(pub, receiverID, nil)
	r.mu.Unlock()
	if request == nil || pub.source == nil || pub.remote == nil {
		return
	}
	r.writeFirstVideoKeyFrame(pub, nil)
}

func (r *Router) selectedCameraLayerLocked(pub *publication, receiverID string, now time.Time) string {
	preferred := r.cameraLayers[receiverID]
	if !validCameraLayer(preferred) {
		preferred = "medium"
	}
	preferredRank := cameraLayerRank(preferred)
	selected := ""
	selectedDistance := len(cameraLayersByQuality)
	selectedRank := len(cameraLayersByQuality)
	for rank, layer := range cameraLayersByQuality {
		candidate := r.pubs[pub.layerKeys[rank]]
		if candidate == nil || candidate.tracks[receiverID] == nil || !candidate.hasRecentPacket(now) {
			continue
		}
		distance := rank - preferredRank
		if distance < 0 {
			distance = -distance
		}
		if distance < selectedDistance || (distance == selectedDistance && rank < selectedRank) {
			selected = layer
			selectedDistance = distance
			selectedRank = rank
		}
	}
	return selected
}

var cameraLayersByQuality = [...]string{"low", "medium", "high"}

func cameraLayerRank(layer string) int {
	for rank, candidate := range cameraLayersByQuality {
		if candidate == layer {
			return rank
		}
	}
	return len(cameraLayersByQuality)
}

func (pub *publication) hasRecentPacket(now time.Time) bool {
	lastPacketAt := pub.lastPacketAt.Load()
	return lastPacketAt != 0 && now.Sub(time.Unix(0, lastPacketAt)) <= cameraLayerActivityWindow
}

type videoFrameBuffer struct {
	timestamp        uint32
	lastTimestamp    uint32
	packets          []*rtp.Packet
	bytes            int
	lastSequence     uint16
	consecutive      bool
	active           bool
	dropping         bool
	hasLastTimestamp bool
	// oversized counts frames given up for exceeding the buffer limits; it
	// survives the resets between frames.
	oversized uint32
}

type videoFrame struct {
	packets       []*rtp.Packet
	repairTargets []*publicationTarget
	// queuedAt is when the frame entered the pacing queue (enqueueVideoFrame).
	queuedAt time.Time
	// keyFrame marks a frame whose first packet starts a keyframe.
	keyFrame bool
}

// add returns a complete video frame only after its marker packet arrives.
// A timestamp change before the marker discards the previous incomplete frame.
func (f *videoFrameBuffer) add(packet *rtp.Packet) ([]*rtp.Packet, int, bool) {
	if !f.active {
		if f.hasLastTimestamp && !rtpTimestampAfter(packet.Timestamp, f.lastTimestamp) {
			return nil, 0, false
		}
		f.start(packet.Timestamp)
	} else if f.timestamp != packet.Timestamp {
		if !rtpTimestampAfter(packet.Timestamp, f.timestamp) {
			return nil, 0, false
		}
		f.start(packet.Timestamp)
	}

	if !f.dropping {
		if len(f.packets) > 0 {
			// The common in-order case cannot contain a duplicate: a frame is
			// limited to maxFramePackets, far fewer than a sequence number cycle.
			if !f.consecutive || packet.SequenceNumber != f.lastSequence+1 {
				f.consecutive = false
				if framePacketDuplicate(f.packets, packet.SequenceNumber) {
					return nil, 0, false
				}
			}
		}
		packetBytes := packet.MarshalSize()
		if packetBytes > maxVideoFrameBufferBytes-f.bytes || len(f.packets) >= maxFramePackets {
			f.packets = nil
			f.bytes = 0
			f.dropping = true
			f.oversized++
		} else {
			if f.packets == nil {
				f.packets = make([]*rtp.Packet, 0, initialFramePacketCapacity)
			}
			f.packets = append(f.packets, packet)
			f.bytes += packetBytes
			f.lastSequence = packet.SequenceNumber
		}
	}
	if !packet.Marker {
		return nil, 0, false
	}

	packets, frameBytes, complete := f.packets, f.bytes, !f.dropping
	frameTimestamp := f.timestamp
	lastTimestamp, hasLastTimestamp := frameTimestamp, true
	*f = videoFrameBuffer{lastTimestamp: lastTimestamp, hasLastTimestamp: hasLastTimestamp, oversized: f.oversized}
	if !complete {
		return nil, 0, false
	}
	if len(packets) > 1 {
		sortFramePackets(packets)
	}
	return packets, frameBytes, true
}

// framePacketDuplicate reports whether the sequence was already buffered for
// the current frame (a retransmission). Frames are capped at maxFramePackets
// packets, so the linear scan stays trivially cheap.
func framePacketDuplicate(packets []*rtp.Packet, sequence uint16) bool {
	for _, packet := range packets {
		if packet.SequenceNumber == sequence {
			return true
		}
	}
	return false
}

// sortFramePackets orders a frame's packets by sequence number with wraparound
// using an insertion sort; frames are bounded to maxFramePackets packets.
func sortFramePackets(packets []*rtp.Packet) {
	for i := 1; i < len(packets); i++ {
		packet := packets[i]
		j := i - 1
		for j >= 0 && int16(packets[j].SequenceNumber-packet.SequenceNumber) > 0 {
			packets[j+1] = packets[j]
			j--
		}
		packets[j+1] = packet
	}
}

func (f *videoFrameBuffer) start(timestamp uint32) {
	lastTimestamp, hasLastTimestamp := f.lastTimestamp, f.hasLastTimestamp
	*f = videoFrameBuffer{
		oversized:        f.oversized,
		timestamp:        timestamp,
		lastTimestamp:    lastTimestamp,
		consecutive:      true,
		active:           true,
		hasLastTimestamp: hasLastTimestamp,
	}
}

func rtpTimestampAfter(timestamp, previous uint32) bool {
	return int32(timestamp-previous) > 0
}

// bitrateLimiter meters bytes per second with a short burst allowance.
type bitrateLimiter struct {
	mu     sync.Mutex
	rate   float64
	tokens float64
	last   time.Time
	now    func() time.Time
	// Audio retains bounded catch-up credit while video keeps its short burst.
	burstWindow time.Duration
	initialized bool
	// pacerTimer is owned by the publication's single pacer goroutine and
	// reused across waitForBytes calls instead of allocating one per packet.
	pacerTimer *time.Timer
	maxFPS     int
	haveFrame  bool
	// nextFrameDue is the RTP timestamp at which the FPS gate's schedule
	// expects the next frame; see allowFrame.
	nextFrameDue        uint32
	currentFrame        uint32
	currentFrameAllowed bool
}

func newBitrateLimiter(rate int) *bitrateLimiter {
	return newBitrateLimiterAt(rate, time.Now)
}

func newBitrateLimiterAt(rate int, now func() time.Time) *bitrateLimiter {
	current := now()
	limiter := &bitrateLimiter{now: now, last: current}
	limiter.setRate(rate)
	return limiter
}

func (l *bitrateLimiter) burstLocked() float64 {
	if l.burstWindow > 0 {
		return l.rate * l.burstWindow.Seconds()
	}
	return max(l.rate/10, 1200)
}

func (l *bitrateLimiter) setRate(rate int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refillLocked()
	if rate <= 0 {
		l.rate = 0
		l.tokens = 0
		l.initialized = true
		return
	}
	l.rate = float64(rate)
	burst := l.burstLocked()
	if l.tokens > burst {
		l.tokens = burst
	}
	if !l.initialized || (l.burstWindow == 0 && l.tokens == 0) {
		l.tokens = burst
	}
	l.initialized = true
}

func (l *bitrateLimiter) allow(bytes int) bool {
	if bytes <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refillLocked()
	if l.rate <= 0 {
		return true
	}
	if float64(bytes) > l.tokens {
		return false
	}
	l.tokens -= float64(bytes)
	return true
}

// waitForBytes paces a packet until the configured byte budget can admit it.
// The timer is reused across waits: it belongs to the publication's single
// pacer goroutine (setRate/setFPS touch no timer state), so a fresh
// time.NewTimer per paced packet — tens of thousands per second under load —
// is pure garbage.
func (l *bitrateLimiter) waitForBytes(bytes int, stop <-chan struct{}) bool {
	if bytes <= 0 {
		return true
	}
	for {
		l.mu.Lock()
		l.refillLocked()
		if l.rate <= 0 || l.tokens >= float64(bytes) {
			if l.rate > 0 {
				l.tokens -= float64(bytes)
			}
			l.mu.Unlock()
			return true
		}
		deficit := float64(bytes) - l.tokens
		rate := l.rate
		burst := rate / 10
		if burst < 1200 {
			burst = 1200
		}
		oversizedPacket := float64(bytes) > burst
		if oversizedPacket {
			deficit = burst - l.tokens
		}
		wait := time.Duration(deficit / rate * float64(time.Second))
		if wait < time.Millisecond {
			wait = time.Millisecond
		}
		l.mu.Unlock()

		if l.pacerTimer == nil {
			l.pacerTimer = time.NewTimer(wait)
		} else {
			l.pacerTimer.Reset(wait)
		}
		select {
		case <-stop:
			if !l.pacerTimer.Stop() {
				select {
				case <-l.pacerTimer.C:
				default:
				}
			}
			return false
		case <-l.pacerTimer.C:
		}
		if oversizedPacket {
			l.mu.Lock()
			l.refillLocked()
			l.tokens -= float64(bytes)
			l.mu.Unlock()
			return true
		}
	}
}

func (l *bitrateLimiter) setFPS(fps int) {
	l.mu.Lock()
	l.maxFPS = fps
	l.haveFrame = false
	l.mu.Unlock()
}

func (l *bitrateLimiter) allowFrame(timestamp uint32) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.maxFPS <= 0 {
		return true
	}
	if l.haveFrame && l.currentFrame == timestamp {
		return l.currentFrameAllowed
	}

	// The gate keeps a schedule rather than a minimum gap. Each passed frame
	// books the next slot one frame interval later, and a frame passes when it
	// reaches its slot within a quarter of an interval. Capture jitter around
	// the cap then moves frames within the slack instead of failing every
	// short gap (B4 in docs/network-testing.md: a source at exactly the cap
	// with ±1 ms jitter lost half its frames), while a faster source still
	// cannot pass more than one frame per interval on average.
	allowed := true
	minTicks := uint32(90000 / l.maxFPS)
	slack := minTicks / 4
	if l.haveFrame && minTicks > 0 {
		early := int32(l.nextFrameDue - timestamp)
		switch {
		case early > int32(90000):
			// More than a second behind its slot: the source restarted its
			// timestamps. Start a new schedule rather than block it.
			l.nextFrameDue = timestamp + minTicks
		case early > int32(slack):
			allowed = false
		default:
			due := l.nextFrameDue
			if int32(timestamp-slack-due) > 0 {
				// Late (a gap in the source): never bank the missed slots.
				due = timestamp - slack
			}
			l.nextFrameDue = due + minTicks
		}
	} else {
		l.nextFrameDue = timestamp + minTicks
	}
	l.haveFrame = true
	l.currentFrame = timestamp
	l.currentFrameAllowed = allowed
	return allowed
}

func (l *bitrateLimiter) refillLocked() {
	current := l.now()
	if current.Before(l.last) {
		if l.burstWindow == 0 {
			l.last = current
		}
		return
	}
	if l.rate > 0 {
		burst := l.burstLocked()
		l.tokens += current.Sub(l.last).Seconds() * l.rate
		if l.tokens > burst {
			l.tokens = burst
		}
	}
	l.last = current
}

func (r *Router) removePublication(pub *publication) {
	offers := make(map[string]Offerer)
	var ops []pendingTrackOp
	r.mu.Lock()
	if current, exists := r.pubs[pub.key]; exists && current == pub {
		r.removePublicationLocked(pub, offers, &ops)
		delete(r.pubs, pub.key)
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	dispatchOffers(offers)
}

// removePublicationLocked detaches a publication's outgoing tracks. The
// caller must hold r.mu; offers are collected keyed by receiver so a
// replace-and-resubscribe sequence produces one renegotiation per receiver,
// and RemoveTrack operations are queued for application after the lock is
// released. Callers must apply the queued ops via applyTrackOps.
func (r *Router) removePublicationLocked(pub *publication, offers map[string]Offerer, ops *[]pendingTrackOp) {
	pub.stop()
	r.cancelVideoKeyFrameRetriesForPublicationLocked(pub)
	for targetID, sender := range pub.senders {
		if peer := r.peers[targetID]; peer != nil {
			if sender != nil {
				*ops = append(*ops, pendingTrackOp{peer: peer, sender: sender})
			}
			if offerer := r.offerers[targetID]; offerer != nil {
				offers[targetID] = offerer
			}
		}
		r.removeTargetLocked(pub, targetID)
	}
}

// AddPublicationFixture registers an empty publication for a source and role
// without a live media path. It forwards nothing and is removed by the
// ordinary teardown paths; it exists so other packages can test teardown
// behavior end to end.
func (r *Router) AddPublicationFixture(sourceID string, role SourceRole) {
	key := publicationKey(sourceID, role, "")
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.pubs[key]; exists {
		return
	}
	r.pubs[key] = &publication{
		key:      key,
		sourceID: sourceID,
		role:     role,
		tracks:   make(map[string]*publicationTarget),
		senders:  make(map[string]*pion.RTPSender),
	}
}

// HasPublication reports whether any publication is registered for the
// source and role.
// PublicationSource returns the peer connection a source's role is currently
// published from, or nil when it is not published. Like HasPublication it
// lets other packages observe a publication swap end to end.
func (r *Router) PublicationSource(sourceID string, role SourceRole) *webrtc.Peer {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, pub := range r.pubs {
		if pub.sourceID == sourceID && pub.role == role {
			return pub.source
		}
	}
	return nil
}

func (r *Router) HasPublication(sourceID string, role SourceRole) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, pub := range r.pubs {
		if pub.sourceID == sourceID && pub.role == role {
			return true
		}
	}
	return false
}
