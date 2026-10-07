package media

import (
	"fmt"
	"sync"
	"time"

	"SlowMeet/internal/webrtc"
	"github.com/pion/rtcp"
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
	key      string
	sourceID string
	role     SourceRole
	layer    string
	trackID  string
	streamID string
	codec    pion.RTPCodecCapability
	remote   *pion.TrackRemote
	source   *webrtc.Peer
	tracks   map[string]*pion.TrackLocalStaticRTP
	senders  map[string]*pion.RTPSender
	limiter  *bitrateLimiter
}

type Router struct {
	mu                    sync.RWMutex
	peers                 map[string]*webrtc.Peer
	offerers              map[string]Offerer
	pubs                  map[string]*publication
	videoSubscriptions    map[string]map[string]struct{}
	videoSubscriptionsSet map[string]bool
	cameraLayers          map[string]string
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
	if _, exists := r.pubs[key]; exists {
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

func (r *Router) currentLimits() Limits {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.limits
}

func rateForKind(kind pion.RTPCodecType, limits Limits) int {
	if kind == pion.RTPCodecTypeAudio {
		return limits.MaxAudioBitrate
	}
	return limits.MaxVideoBitrate
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
		default:
			routed = append(routed, packet)
		}
	}
	return routed
}

func (r *Router) forward(pub *publication) {
	for {
		packet, _, err := pub.remote.ReadRTP()
		if err != nil {
			r.removePublication(pub)
			return
		}
		if pub.remote.Kind() == pion.RTPCodecTypeVideo && !pub.limiter.allowFrame(packet.Timestamp) {
			continue
		}
		if !pub.limiter.allow(packet.MarshalSize()) {
			continue
		}
		r.mu.RLock()
		targetTracks := make(map[string]*pion.TrackLocalStaticRTP, len(pub.tracks))
		for targetID, track := range pub.tracks {
			selectedLayer := r.cameraLayers[targetID]
			if selectedLayer == "" {
				selectedLayer = "medium"
			}
			if pub.layer == "" || selectedLayer == pub.layer {
				targetTracks[targetID] = track
			}
		}
		r.mu.RUnlock()
		for _, track := range targetTracks {
			_ = track.WriteRTP(packet)
		}
	}
}

// bitrateLimiter is a non-queuing token bucket. Dropping when the bucket is
// empty preserves latency and lets WebRTC's normal loss recovery handle the
// resulting loss; packets are never delayed in the SFU.
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
