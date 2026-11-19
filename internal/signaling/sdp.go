package signaling

import "strings"

// enableOpusDTX adds usedtx=1 to the Opus format parameters of an SDP the
// server sends to a browser. A browser applies the remote description's Opus
// parameters to its own encoder, so this makes every participant send
// discontinuous audio: about one small comfort-noise packet every 400 ms while
// silent or muted instead of 50 full packets per second.
//
// In a meeting most participants are silent most of the time, and every audio
// packet is forwarded to every other participant, so audio is most of the
// packets the SFU (and a TURN relay in front of it) handles and a large share
// of what a slow downlink has to carry.
//
// Only Opus carries useinbandfec, which is how its fmtp line is recognised
// without tracking payload types.
func enableOpusDTX(sdp string) string {
	if !strings.Contains(sdp, "useinbandfec=1") {
		return sdp
	}
	var out strings.Builder
	out.Grow(len(sdp) + 64)
	for len(sdp) > 0 {
		line := sdp
		if end := strings.IndexByte(sdp, '\n'); end >= 0 {
			line = sdp[:end+1]
		}
		sdp = sdp[len(line):]
		body := strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(body, "a=fmtp:") && strings.Contains(body, "useinbandfec=1") &&
			!strings.Contains(body, "usedtx=") {
			out.WriteString(body)
			out.WriteString(";usedtx=1")
			out.WriteString(line[len(body):])
			continue
		}
		out.WriteString(line)
	}
	return out.String()
}

// outboundSDP applies the client's SDP adjustments to a description the
// server is about to send. The server's own local description is unchanged.
func (c *client) outboundSDP(sdp string) string {
	if c.opusDTX {
		return enableOpusDTX(sdp)
	}
	return sdp
}
