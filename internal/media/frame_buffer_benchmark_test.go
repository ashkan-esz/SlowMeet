package media

import (
	"fmt"
	"testing"

	"github.com/pion/rtp"
)

func BenchmarkVideoFrameBuffer(b *testing.B) {
	for _, count := range []int{4, 32, 128} {
		b.Run(fmt.Sprintf("%d_packets", count), func(b *testing.B) {
			packets := make([]rtp.Packet, count)
			for i := range packets {
				packets[i].SequenceNumber = uint16(i)
				packets[i].Marker = i == count-1
			}
			b.ReportAllocs()
			b.ResetTimer()
			for b.Loop() {
				var frame videoFrameBuffer
				for i := range packets {
					frame.add(&packets[i])
				}
			}
		})
	}
}
