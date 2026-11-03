package media

import (
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"SlowMeet/internal/webrtc"
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
	key          string
	sourceID     string
	role         SourceRole
	layer        string
	trackID      string
	streamID     string
	codec        pion.RTPCodecCapability
	remote       *pion.TrackRemote
	source       *webrtc.Peer
	tracks       map[string]*publicationTarget
	senders      map[string]*pion.RTPSender
	limiter      *bitrateLimiter
	lastPacketAt atomic.Int64
	paused       atomic.Bool

	// layerKeys caches the publication key of every camera simulcast quality
	// for this source so the per-packet layer selection never builds strings.
	// It is only populated for camera publications.
	layerKeys [len(cameraLayersByQuality)]string
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
	track   *pion.TrackLocalStaticRTP
	pending chan *rtp.Packet
	done    chan struct{}
	// lastSentLayer tracks the camera layer most recently forwarded to this
	// receiver by the owning publication, so a receiver that starts receiving
	// the layer mid-GOP triggers a keyframe request. Written only by the
	// publication's single forwarding goroutine.
	lastSentLayer string
	stopOnce      sync.Once
}

const (
	targetAudioQueueDepth = 4  // ~80ms of 20ms Opus frames
	targetVideoQueueDepth = 24 // absorbs multi-packet frame bursts
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
func (t *publicationTarget) enqueue(packet *rtp.Packet) {
	if len(t.pending) >= cap(t.pending) {
		// The receiver's mailbox is full because its egress is slow; drop the
		// packet. RTP receivers recover loss through NACK and PLI feedback.
		return
	}
	select {
	case t.pending <- packet:
	default:
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
	for {
		select {
		case <-t.done:
			return
		case <-stopped:
			return
		case packet := <-t.pending:
			_ = t.track.WriteRTP(packet)
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
		delete(r.senderSourceSSRC, sender)
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
	timer       *time.Timer
	onError     func(error)
}

const (
	videoKeyFrameRetryDelay   = 250 * time.Millisecond
	videoKeyFrameRequestCount = 3
	maxVideoFrameBufferBytes  = 16 << 20
	maxQueuedVideoFrames      = 4
	cameraLayerActivityWindow = 3 * time.Second
	// maxFramePackets bounds a buffered frame well above any real codec frame
	// size, which keeps the per-frame dedupe scan and insertion sort trivial.
	maxFramePackets = 128
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
	// senderSourceSSRC keeps the publisher ingress SSRC each relay goroutine
	// rewrites RTCP feedback with. Publication swaps reuse the receiver's
	// sender and update the holder in place, so the long-lived relay goroutine
	// always targets the current source track.
	senderSourceSSRC map[*pion.RTPSender]*atomic.Uint32
	limits           Limits
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
		senderSourceSSRC:      make(map[*pion.RTPSender]*atomic.Uint32),
		limits:                limits,
	}
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

func (r *Router) Register(id string, peer *webrtc.Peer, offerer Offerer) {
	var offers []Offerer
	r.mu.Lock()
	r.peers[id] = peer
	r.offerers[id] = offerer
	for _, pub := range r.pubs {
		if r.shouldSubscribeLocked(pub, id) && r.addSubscriptionLocked(pub, id) && offerer != nil {
			offers = append(offers, offerer)
		}
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}
}

func (r *Router) Unregister(id string) {
	offers := make(map[string]Offerer)
	r.mu.Lock()
	r.cancelVideoKeyFrameRetriesForReceiverLocked(id)
	delete(r.peers, id)
	delete(r.offerers, id)
	delete(r.videoSubscriptions, id)
	delete(r.videoSubscriptionsSet, id)
	delete(r.cameraLayers, id)
	for _, subscriptions := range r.videoSubscriptions {
		delete(subscriptions, id)
	}
	for key, pub := range r.pubs {
		if pub.sourceID == id {
			r.removePublicationLocked(pub, offers)
			delete(r.pubs, key)
			continue
		}
		r.removeTargetLocked(pub, id)
		r.cancelVideoKeyFramePublisherRetryWithoutSubscribersLocked(pub)
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}
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
		remote:      remote,
		source:      source,
		tracks:      make(map[string]*publicationTarget),
		senders:     make(map[string]*pion.RTPSender),
		limiter:     newBitrateLimiter(rateForKind(remote.Kind(), r.currentLimits())),
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
		r.removePublicationLocked(existing, offers)
	}
	r.pubs[key] = pub
	for id := range r.peers {
		if r.shouldSubscribeLocked(pub, id) && r.addSubscriptionLocked(pub, id) {
			if offerer := r.offerers[id]; offerer != nil {
				offers[id] = offerer
			}
		}
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}

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
	changed := false
	r.mu.Lock()
	if !validCameraLayer(cameraLayer) {
		cameraLayer = "medium"
	}
	r.videoSubscriptions[receiverID] = desired
	r.videoSubscriptionsSet[receiverID] = true
	r.cameraLayers[receiverID] = cameraLayer
	for _, pub := range r.pubs {
		if pub.sourceID == receiverID {
			continue
		}
		_, subscribed := pub.tracks[receiverID]
		if r.shouldSubscribeLocked(pub, receiverID) {
			if r.addSubscriptionLocked(pub, receiverID) {
				changed = true
			}
			continue
		}
		if !subscribed {
			continue
		}
		if peer := r.peers[receiverID]; peer != nil {
			_ = peer.RemoveTrack(pub.senders[receiverID])
		}
		r.removeTargetLocked(pub, receiverID)
		r.cancelVideoKeyFramePublisherRetryWithoutSubscribersLocked(pub)
		changed = true
	}
	if changed {
		offer = r.offerers[receiverID]
	}
	r.mu.Unlock()
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
	r.mu.Lock()
	for key, pub := range r.pubs {
		if pub.sourceID != sourceID || pub.role != role {
			continue
		}
		r.removePublicationLocked(pub, offers)
		delete(r.pubs, key)
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}
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
		r.writeVideoKeyFrame(request.publication, request.onError)
	}
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
		r.writeVideoKeyFrame(request.publication, request.onError)
	}
}

func (r *Router) scheduleVideoKeyFrameRetryLocked(pub *publication, receiverID string, onError func(error)) *videoKeyFrameRetry {
	key := videoKeyFrameRequestKey{receiverID: receiverID, publicationKey: pub.key}
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
	if r.pubs[request.publication.key] != request.publication || !hasSubscriber {
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
// back to the remove-and-add path for them. The caller must hold r.mu.
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
		target := newPublicationTarget(local, targetQueueDepth(replacement.remote))
		replacement.tracks[targetID] = target
		replacement.senders[targetID] = sender
		if holder := r.senderSourceSSRC[sender]; holder != nil {
			holder.Store(uint32(replacement.remote.SSRC()))
		}
		go target.writePackets(replacement.stoppedChannel())
		// The old target's writer exits through stop; any packets still in its
		// mailbox belong to the retired track and are dropped with it.
		oldTarget.stop()
		delete(existing.tracks, targetID)
		delete(existing.senders, targetID)
	}
}

func (r *Router) addSubscriptionLocked(pub *publication, targetID string) bool {
	if _, exists := pub.tracks[targetID]; exists {
		return false
	}
	peer := r.peers[targetID]
	if peer == nil {
		return false
	}
	local, err := pion.NewTrackLocalStaticRTP(pub.codec, pub.trackID, pub.streamID)
	if err != nil {
		return false
	}
	sender, err := peer.AddTrack(local)
	if err != nil {
		return false
	}
	target := newPublicationTarget(local, targetQueueDepth(pub.remote))
	pub.tracks[targetID] = target
	pub.senders[targetID] = sender
	go target.writePackets(pub.stoppedChannel())
	if pub.source != nil {
		sourceSSRC := &atomic.Uint32{}
		sourceSSRC.Store(uint32(pub.remote.SSRC()))
		r.senderSourceSSRC[sender] = sourceSSRC
		go relayRTCP(sender, pub.source, sourceSSRC)
	}
	return true
}

// relayRTCP forwards receiver feedback to the publication's source. The SSRC
// holder is read per batch so a publication swap that reuses this sender
// retargets the feedback to the new source track without restarting the
// goroutine (the sender keeps one RTCP reader for its whole lifetime).
func relayRTCP(sender *pion.RTPSender, source *webrtc.Peer, sourceSSRC *atomic.Uint32) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		if err := source.WriteRTCP(routeRTCPFeedback(packets, sourceSSRC.Load())); err != nil {
			return
		}
	}
}

func routeRTCPFeedback(packets []rtcp.Packet, sourceSSRC uint32) []rtcp.Packet {
	routed := make([]rtcp.Packet, 0, len(packets))
	for _, packet := range packets {
		switch feedback := packet.(type) {
		case *rtcp.PictureLossIndication:
			copy := *feedback
			copy.MediaSSRC = sourceSSRC
			routed = append(routed, &copy)
		case *rtcp.FullIntraRequest:
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
			copy.Nacks = append([]rtcp.NackPair(nil), feedback.Nacks...)
			routed = append(routed, &copy)
		default:
			routed = append(routed, packet)
		}
	}
	return routed
}

func (r *Router) forward(pub *publication) {
	var frame videoFrameBuffer
	frames := make(chan videoFrame, maxQueuedVideoFrames)
	stopPacer := make(chan struct{})
	go r.forwardVideoFrames(pub, frames, stopPacer)
	defer func() {
		close(stopPacer)
		close(pub.forwardDone)
	}()
	for {
		packet, _, err := pub.remote.ReadRTP()
		if err != nil {
			r.mu.RLock()
			stillRegistered := r.pubs[pub.key] == pub
			r.mu.RUnlock()
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
			return
		}
		pub.lastPacketAt.Store(time.Now().UnixNano())
		if pub.paused.Load() {
			continue
		}
		if pub.remote.Kind() == pion.RTPCodecTypeVideo {
			packets, _, complete := frame.add(packet)
			if !complete || !pub.limiter.allowFrame(packets[0].Timestamp) {
				continue
			}
			if !enqueueVideoFrame(frames, videoFrame{packets: packets}) {
				// Keep the publisher read loop moving when a receiver cannot
				// drain its bounded pacing queue; never forward a partial frame.
			}
			continue
		}
		if !pub.limiter.allow(packet.MarshalSize()) {
			continue
		}
		r.forwardAudioPacket(pub, packet)
	}
}

func (r *Router) forwardVideoFrames(pub *publication, frames <-chan videoFrame, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case frame := <-frames:
			// The camera-layer selection can only change per frame, not per
			// packet; resolve the target list and any layer transitions once.
			targets, layerStarts := r.resolveFrameTargets(pub)
			if len(targets) == 0 {
				continue
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
				if !pub.limiter.waitForBytes(packet.MarshalSize(), stop) {
					return
				}
				for _, target := range targets {
					target.enqueue(packet)
				}
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

func enqueueVideoFrame(queue chan<- videoFrame, frame videoFrame) bool {
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
	r.writeVideoKeyFrame(pub, nil)
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
	active           bool
	dropping         bool
	hasLastTimestamp bool
}

type videoFrame struct {
	packets []*rtp.Packet
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
		if framePacketDuplicate(f.packets, packet.SequenceNumber) {
			return nil, 0, false
		}
		packetBytes := packet.MarshalSize()
		if packetBytes > maxVideoFrameBufferBytes-f.bytes || len(f.packets) >= maxFramePackets {
			f.packets = nil
			f.bytes = 0
			f.dropping = true
		} else {
			f.packets = append(f.packets, packet)
			f.bytes += packetBytes
		}
	}
	if !packet.Marker {
		return nil, 0, false
	}

	packets, frameBytes, complete := f.packets, f.bytes, !f.dropping
	frameTimestamp := f.timestamp
	lastTimestamp, hasLastTimestamp := frameTimestamp, true
	*f = videoFrameBuffer{lastTimestamp: lastTimestamp, hasLastTimestamp: hasLastTimestamp}
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
		timestamp:        timestamp,
		lastTimestamp:    lastTimestamp,
		active:           true,
		hasLastTimestamp: hasLastTimestamp,
	}
}

func rtpTimestampAfter(timestamp, previous uint32) bool {
	return int32(timestamp-previous) > 0
}

// bitrateLimiter meters bytes per second with a short burst allowance.
type bitrateLimiter struct {
	mu                  sync.Mutex
	rate                float64
	tokens              float64
	last                time.Time
	now                 func() time.Time
	maxFPS              int
	haveFrame           bool
	lastFrameTimestamp  uint32
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

func (l *bitrateLimiter) setRate(rate int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.refillLocked()
	if rate <= 0 {
		l.rate = 0
		l.tokens = 0
		return
	}
	l.rate = float64(rate)
	burst := l.rate / 10
	if burst < 1200 {
		burst = 1200
	}
	if l.tokens > burst {
		l.tokens = burst
	}
	if l.tokens == 0 {
		l.tokens = burst
	}
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

		timer := time.NewTimer(wait)
		select {
		case <-stop:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			return false
		case <-timer.C:
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

	allowed := true
	if l.haveFrame {
		delta := timestamp - l.lastFrameTimestamp
		minTicks := uint32(90000 / l.maxFPS)
		if minTicks > 0 && delta < minTicks {
			allowed = false
		}
	}
	if allowed || !l.haveFrame {
		l.lastFrameTimestamp = timestamp
	}
	l.haveFrame = true
	l.currentFrame = timestamp
	l.currentFrameAllowed = allowed
	return allowed
}

func (l *bitrateLimiter) refillLocked() {
	current := l.now()
	if current.Before(l.last) {
		l.last = current
		return
	}
	if l.rate > 0 {
		burst := l.rate / 10
		if burst < 1200 {
			burst = 1200
		}
		l.tokens += current.Sub(l.last).Seconds() * l.rate
		if l.tokens > burst {
			l.tokens = burst
		}
	}
	l.last = current
}

func (r *Router) removePublication(pub *publication) {
	offers := make(map[string]Offerer)
	r.mu.Lock()
	if current, exists := r.pubs[pub.key]; exists && current == pub {
		r.removePublicationLocked(pub, offers)
		delete(r.pubs, pub.key)
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}
}

// removePublicationLocked detaches a publication's outgoing tracks. The
// caller must hold r.mu; offers are collected keyed by receiver so a
// replace-and-resubscribe sequence produces one renegotiation per receiver.
func (r *Router) removePublicationLocked(pub *publication, offers map[string]Offerer) {
	pub.stop()
	r.cancelVideoKeyFrameRetriesForPublicationLocked(pub)
	for targetID, sender := range pub.senders {
		if peer := r.peers[targetID]; peer != nil {
			_ = peer.RemoveTrack(sender)
			if offerer := r.offerers[targetID]; offerer != nil {
				offers[targetID] = offerer
			}
		}
		r.removeTargetLocked(pub, targetID)
	}
}
