package media

import (
	"fmt"
	"log/slog"
	"sort"
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
	tracks       map[string]*pion.TrackLocalStaticRTP
	senders      map[string]*pion.RTPSender
	limiter      *bitrateLimiter
	lastPacketAt atomic.Int64
	paused       atomic.Bool
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
	limits                Limits
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
			r.cancelVideoKeyFrameRetriesForPublicationLocked(pub)
			for targetID, sender := range pub.senders {
				if peer := r.peers[targetID]; peer != nil && sender != nil {
					_ = peer.RemoveTrack(sender)
					if offerer := r.offerers[targetID]; offerer != nil {
						offers[targetID] = offerer
					}
				}
			}
			delete(r.pubs, key)
			continue
		}
		delete(pub.tracks, id)
		delete(pub.senders, id)
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
		key:      key,
		sourceID: sourceID,
		role:     role,
		layer:    layer,
		trackID:  trackID,
		streamID: streamID,
		codec:    remote.Codec().RTPCodecCapability,
		remote:   remote,
		source:   source,
		tracks:   make(map[string]*pion.TrackLocalStaticRTP),
		senders:  make(map[string]*pion.RTPSender),
		limiter:  newBitrateLimiter(rateForKind(remote.Kind(), r.currentLimits())),
	}
	limits := r.currentLimits()
	pub.limiter.setFPS(limits.MaxVideoFPS)

	var offers []Offerer
	r.mu.Lock()
	if existing, exists := r.pubs[key]; exists {
		if existing.remote != remote {
			slog.Default().Warn("media_publication_duplicate_track",
				"source_id", sourceID,
				"role", role,
				"layer", layer,
				"track_id", trackID,
				"existing_ssrc", existing.remote.SSRC(),
				"new_ssrc", remote.SSRC(),
			)
		}
		r.mu.Unlock()
		return
	}
	r.pubs[key] = pub
	for id := range r.peers {
		if r.shouldSubscribeLocked(pub, id) && r.addSubscriptionLocked(pub, id) {
			if offerer := r.offerers[id]; offerer != nil {
				offers = append(offers, offerer)
			}
		}
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}

	go r.forward(pub)
}

// SetVideoSubscriptions replaces the camera sources a receiver wants. Audio
// and screen publications remain subscribed for every receiver. Receivers
// that have not sent this message retain the legacy all-camera behavior.
func (r *Router) SetVideoSubscriptions(receiverID string, cameraParticipantIDs []string) {
	r.SetVideoSubscriptionsWithLayer(receiverID, cameraParticipantIDs, "medium")
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
		delete(pub.tracks, receiverID)
		delete(pub.senders, receiverID)
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
	var offers []Offerer
	r.mu.Lock()
	for key, pub := range r.pubs {
		if pub.sourceID != sourceID || pub.role != role {
			continue
		}
		offers = append(offers, r.removePublicationLocked(pub)...)
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
		for receiverID := range pub.senders {
			if request := r.scheduleVideoKeyFrameRetryLocked(pub, receiverID, reportError); request != nil {
				requests = append(requests, request)
			}
			break
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
	if r.pubs[request.publication.key] != request.publication ||
		request.publication.senders[key.receiverID] == nil {
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
	pub.tracks[targetID] = local
	pub.senders[targetID] = sender
	if pub.source != nil {
		go relayRTCP(sender, pub.source, uint32(pub.remote.SSRC()))
	}
	return true
}

func relayRTCP(sender *pion.RTPSender, source *webrtc.Peer, sourceSSRC uint32) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		if err := source.WriteRTCP(routeRTCPFeedback(packets, sourceSSRC)); err != nil {
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
	defer close(stopPacer)
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
		r.forwardPacket(pub, packet)
	}
}

func (r *Router) forwardVideoFrames(pub *publication, frames <-chan videoFrame, stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case frame := <-frames:
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
				r.forwardPacket(pub, packet)
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

func (r *Router) forwardPacket(pub *publication, packet *rtp.Packet) {
	r.mu.RLock()
	if pub.paused.Load() {
		r.mu.RUnlock()
		return
	}
	targetTracks := make(map[string]*pion.TrackLocalStaticRTP, len(pub.tracks))
	for targetID, track := range pub.tracks {
		if pub.layer == "" || r.selectedCameraLayerLocked(pub.sourceID, targetID, time.Now()) == pub.layer {
			targetTracks[targetID] = track
		}
	}
	r.mu.RUnlock()
	for _, track := range targetTracks {
		_ = track.WriteRTP(packet)
	}
}

func (r *Router) selectedCameraLayerLocked(sourceID, receiverID string, now time.Time) string {
	preferred := r.cameraLayers[receiverID]
	if !validCameraLayer(preferred) {
		preferred = "medium"
	}
	preferredRank := cameraLayerRank(preferred)
	selected := ""
	selectedDistance := len(cameraLayersByQuality)
	selectedRank := len(cameraLayersByQuality)
	for _, layer := range cameraLayersByQuality {
		pub := r.pubs[publicationKey(sourceID, SourceRoleCamera, layer)]
		if pub == nil || pub.tracks[receiverID] == nil || !pub.hasRecentPacket(now) {
			continue
		}
		rank := cameraLayerRank(layer)
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
	seenSequences    map[uint16]struct{}
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
		if _, duplicate := f.seenSequences[packet.SequenceNumber]; duplicate {
			return nil, 0, false
		}
		packetBytes := packet.MarshalSize()
		if packetBytes > maxVideoFrameBufferBytes-f.bytes {
			f.packets = nil
			f.bytes = 0
			f.dropping = true
		} else {
			f.seenSequences[packet.SequenceNumber] = struct{}{}
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
		sort.Slice(packets, func(i, j int) bool {
			return int16(packets[i].SequenceNumber-packets[j].SequenceNumber) < 0
		})
	}
	return packets, frameBytes, true
}

func (f *videoFrameBuffer) start(timestamp uint32) {
	lastTimestamp, hasLastTimestamp := f.lastTimestamp, f.hasLastTimestamp
	*f = videoFrameBuffer{
		timestamp:        timestamp,
		lastTimestamp:    lastTimestamp,
		seenSequences:    make(map[uint16]struct{}),
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
	var offers []Offerer
	r.mu.Lock()
	if current, exists := r.pubs[pub.key]; exists && current == pub {
		offers = r.removePublicationLocked(pub)
		delete(r.pubs, pub.key)
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}
}

// removePublicationLocked detaches a publication's outgoing tracks. The
// caller must hold r.mu; returned offers must run after the lock is released.
func (r *Router) removePublicationLocked(pub *publication) []Offerer {
	r.cancelVideoKeyFrameRetriesForPublicationLocked(pub)
	var offers []Offerer
	for targetID, sender := range pub.senders {
		if peer := r.peers[targetID]; peer != nil {
			_ = peer.RemoveTrack(sender)
			if offerer := r.offerers[targetID]; offerer != nil {
				offers = append(offers, offerer)
			}
		}
		delete(pub.tracks, targetID)
		delete(pub.senders, targetID)
	}
	return offers
}
