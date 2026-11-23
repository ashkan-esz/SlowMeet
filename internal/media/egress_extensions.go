package media

import (
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	pion "github.com/pion/webrtc/v4"

	"SlowMeet/internal/webrtc"
)

// egressHeaderExtensions gives one receiver's forwarded packets the header
// extensions that receiver's connection expects. A publisher's packet
// arrives with its own connection's extensions: its transceiver's mid, its
// simulcast rid, its transport-wide sequence. Forwarded unchanged they named
// the publisher's mid ("4", "5") to a receiver whose transceiver for that
// track had another (1, 6, 8, ...); Chrome routes an incoming packet by its
// mid before its SSRC, so a forwarded camera layer was delivered to
// whichever of the receiver's transceivers happened to have that mid, and
// the sender's top layer decoded at 0 px (B17 in docs/network-testing.md).
// Their IDs are the publisher's too, which a receiver reads with its own
// map (a Firefox publisher numbers them differently). So every publisher
// extension is dropped, the receiver's own transceiver mid is set, and the
// transport-cc header extension interceptor adds the SFU's transport-wide
// sequence.
//
// A target's packets are written by its single writer goroutine, the only
// user of this value.
type egressHeaderExtensions struct {
	peer   *webrtc.Peer
	sender *pion.RTPSender

	resolved bool
	midID    uint8
	mid      []byte
}

func newEgressHeaderExtensions(peer *webrtc.Peer, sender *pion.RTPSender) *egressHeaderExtensions {
	if peer == nil || sender == nil {
		return nil
	}
	return &egressHeaderExtensions{peer: peer, sender: sender}
}

// resolve finds the receiver transceiver's mid and the mid extension's ID on
// the receiver's connection, once both are negotiated.
func (e *egressHeaderExtensions) resolve() {
	if e == nil || e.resolved {
		return
	}
	mid := ""
	for _, transceiver := range e.peer.Connection().GetTransceivers() {
		if transceiver.Sender() == e.sender {
			mid = transceiver.Mid()
			break
		}
	}
	if mid == "" {
		return
	}
	for _, extension := range e.sender.GetParameters().HeaderExtensions {
		if extension.URI == sdp.SDESMidURI {
			e.midID = uint8(extension.ID)
		}
	}
	e.mid = []byte(mid)
	e.resolved = true
}

// packet returns what this receiver is sent for packet: a copy without the
// publisher's header extensions and with the receiver's own mid when its
// connection negotiated the mid extension. packet itself, shared with every
// other receiver's writer, is not modified; the copy has its own extension
// array, which the transport-cc interceptor then extends in place.
func (e *egressHeaderExtensions) packet(packet *rtp.Packet) *rtp.Packet {
	e.resolve()
	setMid := e != nil && e.resolved && e.midID != 0
	if !setMid && !packet.Header.Extension && len(packet.Header.Extensions) == 0 {
		return packet
	}
	out := *packet
	out.Header.Extension = false
	out.Header.ExtensionProfile = 0
	out.Header.Extensions = nil
	if setMid {
		// One-byte extensions carry up to 16 bytes; a longer mid would need
		// the two-byte form, and pion's mids are short decimal strings.
		_ = out.Header.SetExtension(e.midID, e.mid)
	}
	return &out
}
