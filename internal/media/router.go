package media

import (
	"fmt"
	"sync"

	"SlowMeet/internal/webrtc"
	pion "github.com/pion/webrtc/v4"
)

type Offerer func() error

type publication struct {
	key      string
	sourceID string
	trackID  string
	codec    pion.RTPCodecCapability
	remote   *pion.TrackRemote
	source   *webrtc.Peer
	tracks   map[string]*pion.TrackLocalStaticRTP
}

type Router struct {
	mu       sync.RWMutex
	peers    map[string]*webrtc.Peer
	offerers map[string]Offerer
	pubs     map[string]*publication
}

func NewRouter() *Router {
	return &Router{
		peers:    make(map[string]*webrtc.Peer),
		offerers: make(map[string]Offerer),
		pubs:     make(map[string]*publication),
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
	}

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

func (r *Router) removePublication(pub *publication) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if current, exists := r.pubs[pub.key]; exists && current == pub {
		delete(r.pubs, pub.key)
	}
}
