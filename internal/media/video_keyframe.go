package media

import (
	"strings"

	"github.com/pion/rtp/codecs"
	pion "github.com/pion/webrtc/v4"
)

// startsVideoKeyFrame reports whether an RTP payload is the first packet of a
// keyframe in the given codec. The SFU never decodes video; this reads only
// the few header bits each payload format puts in front of the picture, and
// answers false for anything it does not recognise. It exists so a keyframe
// request stops being repeated once the keyframe is on its way.
func startsVideoKeyFrame(mimeType string, payload []byte) bool {
	if len(payload) == 0 {
		return false
	}
	switch {
	case strings.EqualFold(mimeType, pion.MimeTypeVP8):
		// RFC 7741: the first packet of the first partition (reserved bits
		// clear), a payload header whose P bit is clear, and the start code
		// every VP8 keyframe carries after its three-byte frame tag.
		var packet codecs.VP8Packet
		picture, err := packet.Unmarshal(payload)
		return err == nil && payload[0]&0x48 == 0 && packet.S == 1 && packet.PID == 0 &&
			len(picture) >= 6 && picture[0]&0x01 == 0 &&
			picture[3] == 0x9d && picture[4] == 0x01 && picture[5] == 0x2a
	case strings.EqualFold(mimeType, pion.MimeTypeVP9):
		// RFC 9628: the beginning of a frame that is not predicted from
		// another picture, in the lowest spatial layer.
		var packet codecs.VP9Packet
		if _, err := packet.Unmarshal(payload); err != nil {
			return false
		}
		return packet.B && !packet.P && packet.SID == 0
	case strings.EqualFold(mimeType, pion.MimeTypeAV1):
		// AV1 RTP: the aggregation header's N bit marks the first packet of a
		// new coded video sequence; Z set would make it a continuation.
		return payload[0]&0x80 == 0 && payload[0]&0x08 != 0
	case strings.EqualFold(mimeType, pion.MimeTypeH264):
		return startsH264KeyFrame(payload)
	}
	return false
}

// startsH264KeyFrame recognises an IDR slice or the parameter set a browser
// sends in front of one, alone, aggregated (STAP-A) or as the first fragment
// of a fragmented unit (FU-A), per RFC 6184.
func startsH264KeyFrame(payload []byte) bool {
	const (
		nalIDR   = 5
		nalSPS   = 7
		nalSTAPA = 24
		nalFUA   = 28
	)
	switch payload[0] & 0x1F {
	case nalIDR, nalSPS:
		return true
	case nalSTAPA:
		for rest := payload[1:]; len(rest) > 2; {
			size := int(rest[0])<<8 | int(rest[1])
			if kind := rest[2] & 0x1F; kind == nalIDR || kind == nalSPS {
				return true
			}
			if size+2 > len(rest) {
				return false
			}
			rest = rest[size+2:]
		}
	case nalFUA:
		return len(payload) > 1 && payload[1]&0x80 != 0 && payload[1]&0x1F == nalIDR
	}
	return false
}
