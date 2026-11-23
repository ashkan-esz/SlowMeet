package media

import (
	"log/slog"
	"strings"

	pion "github.com/pion/webrtc/v4"
)

// The router forwards RTP without transcoding, so a video publication can
// only go to receivers whose browser decodes its codec, and only while the
// server allows that codec. Browsers normally keep to a codec the whole room
// shares (the hub tells them which); the checks here are what keeps one
// browser that does not from breaking the others. In particular, starting a
// sender for a codec the receiver did not negotiate fails that receiver's
// entire next description in pion, not just the one track.

// VideoCodecName returns the configuration name ("vp8", "h264", "vp9", "av1")
// of a video codec capability. Anything else, including VP9 profiles other
// than 0, gets a name no configuration allows. An empty capability has no
// name and is never filtered.
func VideoCodecName(codec pion.RTPCodecCapability) string {
	mime := strings.ToLower(codec.MimeType)
	switch mime {
	case "video/vp8":
		return "vp8"
	case "video/h264":
		return "h264"
	case "video/av1":
		return "av1"
	case "video/vp9":
		if profile := vp9Profile(codec.SDPFmtpLine); profile != "0" {
			return "vp9-profile-" + profile
		}
		return "vp9"
	}
	return mime
}

// vp9Profile reads profile-id from a VP9 fmtp line; a missing one means 0.
func vp9Profile(fmtp string) string {
	for _, parameter := range strings.Split(fmtp, ";") {
		if value, ok := strings.CutPrefix(strings.TrimSpace(parameter), "profile-id="); ok {
			return strings.TrimSpace(value)
		}
	}
	return "0"
}

func videoCodecNameForTrack(remote *pion.TrackRemote) string {
	if remote == nil || remote.Kind() != pion.RTPCodecTypeVideo {
		return ""
	}
	return VideoCodecName(remote.Codec().RTPCodecCapability)
}

func videoCodecSet(codecs []string) map[string]struct{} {
	set := make(map[string]struct{}, len(codecs))
	for _, codec := range codecs {
		set[codec] = struct{}{}
	}
	return set
}

func sameVideoCodecSet(a, b map[string]struct{}) bool {
	if (a == nil) != (b == nil) || len(a) != len(b) {
		return false
	}
	for codec := range a {
		if _, ok := b[codec]; !ok {
			return false
		}
	}
	return true
}

// videoCodecUsableLocked reports whether pub's codec is allowed and
// receiverID's browser decodes it. r.mu must be held.
func (r *Router) videoCodecUsableLocked(pub *publication, receiverID string) bool {
	if pub.codecName == "" {
		return true
	}
	if r.allowedVideoCodecs != nil {
		if _, allowed := r.allowedVideoCodecs[pub.codecName]; !allowed {
			return false
		}
	}
	if supported, known := r.receiverVideoCodecs[receiverID]; known {
		if _, ok := supported[pub.codecName]; !ok {
			return false
		}
	}
	return true
}

func (r *Router) warnIfVideoCodecNotAllowedLocked(pub *publication) {
	if pub.codecName == "" || r.allowedVideoCodecs == nil {
		return
	}
	if _, allowed := r.allowedVideoCodecs[pub.codecName]; !allowed {
		slog.Default().Warn("media_publication_codec_not_allowed",
			"source_id", pub.sourceID, "role", pub.role, "layer", pub.layer, "codec", pub.codecName)
	}
}

// reconcileReceiverLocked brings receiverID's subscriptions in line with
// shouldSubscribeLocked: missing ones are queued, ones it should no longer
// have are removed. It reports whether the receiver needs a new offer. r.mu
// must be held.
func (r *Router) reconcileReceiverLocked(receiverID string, ops *[]pendingTrackOp) bool {
	changed := false
	for _, pub := range r.pubs {
		if pub.sourceID == receiverID {
			continue
		}
		_, subscribed := pub.tracks[receiverID]
		if r.shouldSubscribeLocked(pub, receiverID) {
			if r.queueSubscriptionLocked(pub, receiverID, ops) {
				changed = true
			}
			continue
		}
		if !subscribed {
			continue
		}
		if sender := pub.senders[receiverID]; sender != nil {
			if peer := r.peers[receiverID]; peer != nil {
				*ops = append(*ops, pendingTrackOp{peer: peer, sender: sender})
			}
		}
		r.removeTargetLocked(pub, receiverID)
		r.cancelVideoKeyFramePublisherRetryWithoutSubscribersLocked(pub)
		changed = true
	}
	return changed
}

// SetReceiverVideoCodecs records which video codecs receiverID's browser
// supports. Call it before Register so the receiver's first subscriptions
// already leave out video it cannot decode.
func (r *Router) SetReceiverVideoCodecs(receiverID string, codecs []string) {
	var offer Offerer
	var ops []pendingTrackOp
	r.mu.Lock()
	if r.receiverVideoCodecs == nil {
		r.receiverVideoCodecs = make(map[string]map[string]struct{})
	}
	r.receiverVideoCodecs[receiverID] = videoCodecSet(codecs)
	if r.peers[receiverID] != nil && r.reconcileReceiverLocked(receiverID, &ops) {
		offer = r.offerers[receiverID]
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	if offer != nil {
		_ = offer()
	}
}

// SetAllowedVideoCodecs sets the video codecs the server forwards. A
// publication in any other codec stays registered but reaches no receiver, so
// it resumes by itself when its publisher switches to an allowed one.
func (r *Router) SetAllowedVideoCodecs(codecs []string) {
	allowed := videoCodecSet(codecs)
	offers := make(map[string]Offerer)
	var ops []pendingTrackOp
	r.mu.Lock()
	if sameVideoCodecSet(allowed, r.allowedVideoCodecs) {
		r.mu.Unlock()
		return
	}
	r.allowedVideoCodecs = allowed
	for _, pub := range r.pubs {
		r.warnIfVideoCodecNotAllowedLocked(pub)
	}
	for id := range r.peers {
		if r.reconcileReceiverLocked(id, &ops) {
			if offerer := r.offerers[id]; offerer != nil {
				offers[id] = offerer
			}
		}
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	dispatchOffers(offers)
}

// senderNegotiatedCodec reports whether a sender just added to a receiver's
// peer connection can carry codec. Before the connection's first negotiation
// pion lists every registered codec, so nothing is ruled out early.
func senderNegotiatedCodec(sender *pion.RTPSender, codec pion.RTPCodecCapability) bool {
	if sender == nil || codec.MimeType == "" {
		return true
	}
	negotiated := sender.GetParameters().Codecs
	if len(negotiated) == 0 {
		return true
	}
	for _, candidate := range negotiated {
		if strings.EqualFold(candidate.MimeType, codec.MimeType) {
			return true
		}
	}
	return false
}

// handleIngressCodecChange is called by a video publication's forwarding loop
// when a packet arrives with a payload type other than the publication's. A
// browser that changes its send codec keeps the transceiver and SSRC, so pion
// updates the same TrackRemote in place and fires no new track event. It
// reports whether the publication was replaced, in which case the caller's
// loop must end: the replacement has its own.
func (r *Router) handleIngressCodecChange(pub *publication, payloadType uint8) bool {
	codec := pub.remote.Codec()
	if ingressCodecActionFor(pub.payloadType, payloadType, uint8(codec.PayloadType)) != ingressRepublish {
		return false
	}
	r.republishForCodecChange(pub, codec.RTPCodecCapability, payloadType)
	return true
}

// ingressCodecAction is what the forwarding loop does with an ingress packet,
// judged by payload type alone.
type ingressCodecAction int

const (
	// ingressForward: the packet is in the publication's codec.
	ingressForward ingressCodecAction = iota
	// ingressDrop: another payload type that the track itself has not moved
	// to, such as a retransmission queued before a codec switch. Forwarding it
	// would hand receivers a payload under the wrong codec's payload type.
	ingressDrop
	// ingressRepublish: the track moved to the packet's payload type, so the
	// publication is replaced by one in the new codec.
	ingressRepublish
)

// ingressCodecActionFor compares the payload type a publication was created
// with, the packet's, and the one pion currently reports for the track. A
// publication without a recorded payload type (zero) is not checked.
func ingressCodecActionFor(publicationPayloadType, packetPayloadType, trackPayloadType uint8) ingressCodecAction {
	switch {
	case publicationPayloadType == 0 || packetPayloadType == publicationPayloadType:
		return ingressForward
	case trackPayloadType != packetPayloadType:
		return ingressDrop
	default:
		return ingressRepublish
	}
}

// republishForCodecChange replaces old with a publication of the same track in
// its new codec. Receivers get new egress tracks through a renegotiation
// rather than ReplaceTrack: pion keeps the stream's retransmission payload
// type from when the sender started, so a sender moved to another codec would
// answer NACKs with the old codec's RTX payload type.
func (r *Router) republishForCodecChange(old *publication, codec pion.RTPCodecCapability, payloadType uint8) {
	next := &publication{
		key:         old.key,
		sourceID:    old.sourceID,
		role:        old.role,
		layer:       old.layer,
		trackID:     old.trackID,
		streamID:    old.streamID,
		codec:       codec,
		codecName:   VideoCodecName(codec),
		payloadType: payloadType,
		remote:      old.remote,
		source:      old.source,
		tracks:      make(map[string]*publicationTarget),
		senders:     make(map[string]*pion.RTPSender),
		limiter:     old.limiter,
		layerKeys:   old.layerKeys,
		readBuf:     make([]byte, receiveMTU),
		stopped:     make(chan struct{}),
		forwardDone: make(chan struct{}),
	}
	next.paused.Store(old.paused.Load())
	next.lastPacketAt.Store(old.lastPacketAt.Load())

	offers := make(map[string]Offerer)
	var ops []pendingTrackOp
	r.mu.Lock()
	if r.pubs[old.key] != old {
		// Already replaced or removed; nothing is left to move.
		r.mu.Unlock()
		return
	}
	slog.Default().Info("media_publication_codec_changed",
		"source_id", old.sourceID, "role", old.role, "layer", old.layer,
		"from", old.codecName, "to", next.codecName)
	// Stopping old sets an immediate read deadline on the shared track; the
	// replacement's loop starts below, after it, and sets its own.
	r.removePublicationLocked(old, offers, &ops)
	r.pubs[next.key] = next
	r.warnIfVideoCodecNotAllowedLocked(next)
	for id := range r.peers {
		if r.shouldSubscribeLocked(next, id) && r.queueSubscriptionLocked(next, id, &ops) {
			// The same offer removes this receiver's track of the old codec,
			// so the new one must not land on an earlier line.
			ops[len(ops)-1].freshLine = true
			if offerer := r.offerers[id]; offerer != nil {
				offers[id] = offerer
			}
		}
	}
	r.mu.Unlock()
	r.applyTrackOps(ops)
	dispatchOffers(offers)
	go r.forward(next)
}
