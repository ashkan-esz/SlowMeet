package media

import (
	"fmt"
	"testing"

	"github.com/pion/rtp"
)

var benchmarkIngressPacket *rtp.Packet

func BenchmarkDecodeIngressPacket(b *testing.B) {
	for _, payloadSize := range []int{160, 1200} {
		packet := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 123, Timestamp: 456}, Payload: make([]byte, payloadSize)}
		if err := packet.SetExtension(1, []byte{1, 2, 3}); err != nil {
			b.Fatal(err)
		}
		if err := packet.SetExtension(2, []byte{4, 5}); err != nil {
			b.Fatal(err)
		}
		wire, err := packet.Marshal()
		if err != nil {
			b.Fatal(err)
		}
		for _, method := range []string{"clone", "owned"} {
			b.Run(fmt.Sprintf("%d_bytes/%s", payloadSize, method), func(b *testing.B) {
				b.ReportAllocs()
				b.SetBytes(int64(len(wire)))
				var decoded *rtp.Packet
				for b.Loop() {
					if method == "clone" {
						var parsed rtp.Packet
						if err := parsed.Unmarshal(wire); err != nil {
							b.Fatal(err)
						}
						decoded = parsed.Clone()
					} else {
						var err error
						decoded, err = decodeIngressPacket(wire)
						if err != nil {
							b.Fatal(err)
						}
					}
				}
				benchmarkIngressPacket = decoded
			})
		}
	}
}
