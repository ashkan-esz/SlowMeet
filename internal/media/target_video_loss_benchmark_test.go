package media

import (
	"testing"

	"github.com/pion/rtp"
)

// Include the same mailbox operations in each case to isolate the bookkeeping
// added before and after a target has experienced a queue overflow.
func BenchmarkTargetVideoEnqueue(b *testing.B) {
	packet := &rtp.Packet{Header: rtp.Header{Timestamp: 1, SequenceNumber: 1}}
	for _, scenario := range []struct {
		name      string
		video     bool
		priorLoss bool
	}{
		{name: "mailbox"},
		{name: "video_no_loss", video: true},
		{name: "video_after_loss", video: true, priorLoss: true},
	} {
		b.Run(scenario.name, func(b *testing.B) {
			target := newPublicationTarget(nil, 1)
			if scenario.priorLoss {
				target.enqueue(packet)
				target.enqueueVideo(packet)
				<-target.pending
			}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				if scenario.video {
					target.enqueueVideo(packet)
				} else {
					target.enqueue(packet)
				}
				<-target.pending
			}
		})
	}
}
