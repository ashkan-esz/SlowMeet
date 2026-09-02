package media

import (
	"fmt"
	"sync"
	"time"

	"SlowMeet/internal/webrtc"
	pion "github.com/pion/webrtc/v4"
)

type Offerer func() error

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
	trackID  string
	codec    pion.RTPCodecCapability
	remote   *pion.TrackRemote
	source   *webrtc.Peer
	tracks   map[string]*pion.TrackLocalStaticRTP
	limiter  *bitrateLimiter
}

type Router struct {
	mu       sync.RWMutex
	peers    map[string]*webrtc.Peer
	offerers map[string]Offerer
	pubs     map[string]*publication
	limits   Limits
}

func NewRouter(config ...Limits) *Router {
	var limits Limits
	if len(config) > 0 {
		limits = config[0]
	}
	return &Router{
		peers:    make(map[string]*webrtc.Peer),
		offerers: make(map[string]Offerer),
		pubs:     make(map[string]*publication),
		limits:   limits,
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
		if pub.sourceID != id && r.addSubscriptionLocked(pub, id) && offerer != nil {
			offers = append(offers, offerer)
		}
	}
	r.mu.Unlock()
	for _, offer := range offers {
		_ = offer()
	}
}

func (r *Router) Unregister(id string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.peers, id)
	delete(r.offerers, id)
	for key, pub := range r.pubs {
		if pub.sourceID == id {
			delete(r.pubs, key)
			continue
		}
		delete(pub.tracks, id)
	}
}

func (r *Router) Publish(sourceID string, source *webrtc.Peer, remote *pion.TrackRemote) {
	key := sourceID + "/" + remote.Kind().String()
	pub := &publication{
		key:      key,
		sourceID: sourceID,
		trackID:  fmt.Sprintf("%s|%s", sourceID, remote.Kind().String()),
		codec:    remote.Codec().RTPCodecCapability,
		remote:   remote,
		source:   source,
		tracks:   make(map[string]*pion.TrackLocalStaticRTP),
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
		if id != sourceID && r.addSubscriptionLocked(pub, id) {
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
	local, err := pion.NewTrackLocalStaticRTP(pub.codec, pub.trackID, "lowmeet-"+pub.sourceID)
	if err != nil {
		return false
	}
	sender, err := peer.AddTrack(local)
	if err != nil {
		return false
	}
	pub.tracks[targetID] = local
	if pub.source != nil {
		go relayRTCP(sender, pub.source)
	}
	return true
}

func relayRTCP(sender *pion.RTPSender, source *webrtc.Peer) {
	for {
		packets, _, err := sender.ReadRTCP()
		if err != nil {
			return
		}
		if err := source.WriteRTCP(packets); err != nil {
			return
		}
	}
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
		tracks := make([]*pion.TrackLocalStaticRTP, 0, len(pub.tracks))
		for _, track := range pub.tracks {
			tracks = append(tracks, track)
		}
		r.mu.RUnlock()
		for _, track := range tracks {
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
	r.mu.Lock()
	defer r.mu.Unlock()
	if current, exists := r.pubs[pub.key]; exists && current == pub {
		delete(r.pubs, pub.key)
	}
}
