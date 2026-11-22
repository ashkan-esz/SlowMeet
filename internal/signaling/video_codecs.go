package signaling

import (
	"slices"

	"SlowMeet/internal/config"
)

// Bounds on the video_codecs list a browser sends in join. The list is a few
// short names; anything larger is not a codec claim.
const (
	maxVideoCodecClaims     = 8
	maxVideoCodecNameLength = 16
)

// normalizeVideoCodecClaim turns the codec names a browser sent in join into
// the list the room logic uses: known names only, newest first, and always
// VP8, which every WebRTC browser decodes. A browser that sent no list is a
// cached older client; it negotiates whatever its own defaults are, so only
// the two codecs every such client has are assumed.
func normalizeVideoCodecClaim(claim []string) []string {
	if claim == nil {
		return []string{config.VideoCodecVP8, config.VideoCodecH264}
	}
	normalized := make([]string, 0, len(claim)+1)
	for _, codec := range config.SupportedVideoCodecs() {
		if codec == config.VideoCodecVP8 || slices.Contains(claim, codec) {
			normalized = append(normalized, codec)
		}
	}
	return normalized
}

func (h *Hub) allowedVideoCodecs() []string {
	if h.Config == nil {
		return config.SupportedVideoCodecs()
	}
	return h.Config.Snapshot().EffectiveVideoCodecs()
}

func (h *Hub) defaultVideoCodec() string {
	if h.Config == nil {
		return config.Config{}.EffectiveDefaultVideoCodec()
	}
	return h.Config.Snapshot().EffectiveDefaultVideoCodec()
}

// setVideoCodecClaimLocked records what a participant's browser supports. It
// replaces any earlier claim, so a resumed or taken-over session counts with
// the codecs of the browser that holds it now. h.mu must be held.
func (h *Hub) setVideoCodecClaimLocked(participantID string, claim []string) {
	if h.videoCodecClaims == nil {
		h.videoCodecClaims = make(map[string][]string)
	}
	if claim == nil {
		claim = normalizeVideoCodecClaim(nil)
	}
	h.videoCodecClaims[participantID] = claim
}

// refreshRoomVideoCodecsLocked recomputes the codecs a publisher may use now:
// the allowed ones that every participant's browser supports. The SFU does not
// transcode, so one browser without a codec takes it away from the room. When
// the list changed, the room (except excluded, which learns it another way)
// is told with video_codec_state. h.mu must be held.
func (h *Hub) refreshRoomVideoCodecsLocked(allowed []string, excluded *client) []string {
	room := make([]string, 0, len(allowed))
	for _, codec := range allowed {
		supportedByAll := true
		for _, claim := range h.videoCodecClaims {
			if !slices.Contains(claim, codec) {
				supportedByAll = false
				break
			}
		}
		if supportedByAll {
			room = append(room, codec)
		}
	}
	if h.roomVideoCodecs == nil || !slices.Equal(room, h.roomVideoCodecs) {
		h.roomVideoCodecs = room
		h.broadcastExceptLocked(excluded, Message{
			Version: ProtocolVersion, Type: TypeVideoCodecState, RoomVideoCodecs: slices.Clone(room),
		})
	}
	return slices.Clone(room)
}
