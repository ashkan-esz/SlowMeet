package webrtc

import (
	"github.com/pion/interceptor"
	"github.com/pion/rtp"
)

// resendHeaderCloner gives the NACK responder's resends a header of their
// own. The responder serves each NACK in its own goroutine and hands on the
// header it stored, so two NACKs for one packet would have the transport-cc
// stamper write to one header at once. It sits between the responder and the
// stamper, and copies only what can be a resend: with an RTX stream those are
// the packets on its SSRC; without one a resend cannot be told from the
// packet it repeats, so every packet is copied.
type resendHeaderCloner struct {
	interceptor.NoOp
}

// NewInterceptor makes the cloner its own factory; it keeps no state.
func (c resendHeaderCloner) NewInterceptor(string) (interceptor.Interceptor, error) {
	return &c, nil
}

// BindLocalStream copies the header of each packet that may be a resend.
// Streams that negotiated no NACK have none.
func (c *resendHeaderCloner) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	resends := false
	for _, feedback := range info.RTCPFeedback {
		if feedback.Type == "nack" && feedback.Parameter == "" {
			resends = true
		}
	}
	if !resends {
		return writer
	}
	ssrc, separate := info.SSRC, info.SSRCRetransmission != 0 && info.PayloadTypeRetransmission != 0
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if !separate || header.SSRC != ssrc {
			clone := header.Clone()
			header = &clone
		}
		return writer.Write(header, payload, attributes)
	})
}
