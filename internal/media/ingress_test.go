package media

import (
	"bytes"
	"testing"

	"github.com/pion/rtp"
)

func TestDecodeIngressPacketPreservesWireVariants(t *testing.T) {
	plain := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 17, CSRC: []uint32{1, 2}}, Payload: []byte{1, 2, 3}}
	extended := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 18, Padding: true, PaddingSize: 4}, Payload: []byte{4, 5, 6}}
	if err := extended.SetExtension(1, []byte{0xaa, 0xbb}); err != nil {
		t.Fatal(err)
	}
	if err := extended.SetExtension(2, []byte{0xcc}); err != nil {
		t.Fatal(err)
	}
	twoByte := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 19}, Payload: []byte{7, 8, 9}}
	if err := twoByte.SetExtension(20, bytes.Repeat([]byte{0xdd}, 17)); err != nil {
		t.Fatal(err)
	}
	for name, packet := range map[string]*rtp.Packet{"csrc": plain, "extensions-and-padding": extended, "two-byte-extension": twoByte} {
		t.Run(name, func(t *testing.T) {
			wire, err := packet.Marshal()
			if err != nil {
				t.Fatal(err)
			}
			want := bytes.Clone(wire)
			got, err := decodeIngressPacket(wire)
			if err != nil {
				t.Fatal(err)
			}
			clear(wire)
			remarshaled, err := got.Marshal()
			if err != nil || !bytes.Equal(remarshaled, want) {
				t.Fatalf("packet after buffer reuse = %x, error = %v; want %x", remarshaled, err, want)
			}
		})
	}
	if _, err := decodeIngressPacket([]byte{0x80}); err == nil {
		t.Fatal("malformed packets must be rejected")
	}
}
