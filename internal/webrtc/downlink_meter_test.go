package webrtc

import (
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
)

// downlinkRun sends count packets from first, 5 ms apart, and feeds the meter
// the transport-cc feedback pion's own generator builds for those that
// arrive, every 100 ms of send time. arrive returns a packet's one-way delay,
// or false when the downlink drops it. It returns the meter's clock at the
// last feedback.
func downlinkRun(t *testing.T, meter *downlinkMeter, first uint16, count int, arrive func(index int) (time.Duration, bool)) time.Time {
	t.Helper()
	recorder := twcc.NewRecorder(1)
	const spacing = 5 * time.Millisecond
	var now time.Time
	flush := func(at time.Time) {
		for _, packet := range recorder.BuildFeedbackPacket() {
			meter.onFeedback(packet.(*rtcp.TransportLayerCC), at)
		}
		now = at
	}
	for index := 0; index < count; index++ {
		sequence := first + uint16(index)
		sentAt := meter.start.Add(time.Duration(index) * spacing)
		meter.recordSent(sequence, sentAt)
		if delay, ok := arrive(index); ok {
			recorder.Record(2, sequence, sentAt.Add(delay).Sub(meter.start).Microseconds()+1_000_000)
		}
		if (index+1)%20 == 0 {
			flush(sentAt.Add(30 * time.Millisecond))
		}
	}
	flush(meter.start.Add(time.Duration(count)*spacing + 30*time.Millisecond))
	return now
}

func TestDownlinkMeterMeasuresLossAndJitterFromFeedback(t *testing.T) {
	cases := []struct {
		name                 string
		first                uint16
		arrive               func(int) (time.Duration, bool)
		minLoss10, maxLoss10 int
		minJitter, maxJitter int
	}{
		{name: "clean link", arrive: func(int) (time.Duration, bool) { return 20 * time.Millisecond, true }},
		{name: "12 percent loss", arrive: func(index int) (time.Duration, bool) {
			// 3 of every 25 packets, spread out: 12 %.
			return 20 * time.Millisecond, index%25 != 3 && index%25 != 11 && index%25 != 19
		}, minLoss10: 110, maxLoss10: 130},
		{name: "10 ms of alternating queueing", arrive: func(index int) (time.Duration, bool) {
			return 20*time.Millisecond + time.Duration(index%2)*10*time.Millisecond, true
		}, minJitter: 8, maxJitter: 10},
		{name: "sequence wrap", first: 65500, arrive: func(index int) (time.Duration, bool) {
			return 20 * time.Millisecond, index%10 != 0
		}, minLoss10: 100, maxLoss10: 100},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			meter := newDownlinkMeter()
			now := downlinkRun(t, meter, test.first, 600, test.arrive)
			loss10, jitterMs, packets, ok := meter.quality(now)
			if !ok {
				t.Fatal("no measurement after 3 s of feedback")
			}
			if packets < downlinkMinPackets {
				t.Fatalf("measured %d packets", packets)
			}
			if loss10 < test.minLoss10 || loss10 > test.maxLoss10 {
				t.Fatalf("loss %d tenths, want %d-%d", loss10, test.minLoss10, test.maxLoss10)
			}
			if jitterMs < test.minJitter || jitterMs > test.maxJitter {
				t.Fatalf("jitter %d ms, want %d-%d", jitterMs, test.minJitter, test.maxJitter)
			}
			if _, _, _, ok := meter.quality(now.Add(3 * time.Second)); ok {
				t.Fatal("a measurement without feedback for 3 s is still reported")
			}
		})
	}
}

// Feedback about sequence numbers the meter never sent (another transport's,
// or older than the ring) is not a measurement.
func TestDownlinkMeterIgnoresUnknownSequenceNumbers(t *testing.T) {
	meter := newDownlinkMeter()
	recorder := twcc.NewRecorder(1)
	for sequence := uint16(0); sequence < 100; sequence += 2 {
		recorder.Record(2, sequence, int64(sequence)*5000)
	}
	now := meter.start.Add(time.Second)
	for _, packet := range recorder.BuildFeedbackPacket() {
		meter.onFeedback(packet.(*rtcp.TransportLayerCC), now)
	}
	later := now.Add(1100 * time.Millisecond)
	meter.onFeedback(&rtcp.TransportLayerCC{BaseSequenceNumber: 500, PacketStatusCount: 1, FbPktCount: 9,
		PacketChunks: []rtcp.PacketStatusChunk{&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketNotReceived, RunLength: 1}}},
		later)
	if loss10, _, packets, ok := meter.quality(later); ok {
		t.Fatalf("measured %d tenths over %d packets that were never sent", loss10, packets)
	}
}

// A packet first reported missing and then reported received arrived late; a
// duplicate of one feedback (delivered to two senders' readers) counts once.
func TestDownlinkMeterCorrectsLateArrivalsAndSkipsDuplicates(t *testing.T) {
	meter := newDownlinkMeter()
	for sequence := uint16(0); sequence < 40; sequence++ {
		meter.recordSent(sequence, meter.start.Add(time.Duration(sequence)*time.Millisecond))
	}
	received := func(count uint16) *rtcp.RunLengthChunk {
		return &rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketReceivedSmallDelta, RunLength: count}
	}
	deltas := func(count int) []*rtcp.RecvDelta {
		list := make([]*rtcp.RecvDelta, count)
		for index := range list {
			list[index] = &rtcp.RecvDelta{Type: rtcp.TypeTCCPacketReceivedSmallDelta, Delta: 1000}
		}
		return list
	}
	counts := func() (int, int) {
		meter.mu.Lock()
		defer meter.mu.Unlock()
		return meter.windowLost, meter.windowReceived
	}
	now := meter.start.Add(100 * time.Millisecond)
	// Sequences 0-19 arrive, 20-24 are reported missing, 25-39 arrive.
	first := &rtcp.TransportLayerCC{BaseSequenceNumber: 0, PacketStatusCount: 40, FbPktCount: 0, ReferenceTime: 10,
		PacketChunks: []rtcp.PacketStatusChunk{received(20),
			&rtcp.RunLengthChunk{PacketStatusSymbol: rtcp.TypeTCCPacketNotReceived, RunLength: 5}, received(15)},
		RecvDeltas: deltas(35)}
	meter.onFeedback(first, now)
	meter.onFeedback(first, now)
	if lost, got := counts(); lost != 5 || got != 35 {
		t.Fatalf("after a duplicated feedback: %d lost, %d received, want 5 and 35", lost, got)
	}
	// Then 20-24 are reported received after all.
	late := &rtcp.TransportLayerCC{BaseSequenceNumber: 20, PacketStatusCount: 5, FbPktCount: 1, ReferenceTime: 11,
		PacketChunks: []rtcp.PacketStatusChunk{received(5)}, RecvDeltas: deltas(5)}
	meter.onFeedback(late, now.Add(50*time.Millisecond))
	if lost, got := counts(); lost != 0 || got != 40 {
		t.Fatalf("after the late arrivals: %d lost, %d received, want 0 and 40", lost, got)
	}
}

// The two windows are compared measure by measure: a complete window that
// lost nothing but queued must not be hidden by a window in progress that
// lost a little and did not, and a window under downlinkMinPackets counts
// for nothing.
func TestDownlinkMeterReportsTheWorseOfEachMeasure(t *testing.T) {
	cases := []struct {
		name                      string
		result, partial           uint64
		loss10, jitterMs, packets int
		ok                        bool
	}{
		{name: "queue in the complete window, loss in the partial",
			result:  packDownlink(0, 200, 80_000),
			partial: packDownlink(1, 99, 5_000),
			loss10:  10, jitterMs: 80, packets: 200, ok: true},
		{name: "loss in the complete window, queue in the partial",
			result:  packDownlink(30, 170, 2_000),
			partial: packDownlink(0, 60, 40_000),
			loss10:  150, jitterMs: 40, packets: 200, ok: true},
		{name: "a partial too small to count",
			result:  packDownlink(0, 200, 3_000),
			partial: packDownlink(10, 5, 90_000),
			loss10:  0, jitterMs: 3, packets: 200, ok: true},
		{name: "neither window large enough",
			result:  packDownlink(1, 10, 3_000),
			partial: 0},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			meter := newDownlinkMeter()
			now := meter.start.Add(time.Second)
			meter.lastFeedback = now
			meter.result.Store(test.result)
			meter.partial.Store(test.partial)
			loss10, jitterMs, packets, ok := meter.quality(now)
			if ok != test.ok || loss10 != test.loss10 || jitterMs != test.jitterMs || packets != test.packets {
				t.Fatalf("quality = %d tenths, %d ms, %d packets, ok %v; want %d, %d, %d, %v",
					loss10, jitterMs, packets, ok, test.loss10, test.jitterMs, test.packets, test.ok)
			}
		})
	}
}

// Every forwarding goroutine records its own packets at once while the hub
// reads the result; run with -race.
func TestDownlinkMeterRecordsConcurrently(t *testing.T) {
	meter := newDownlinkMeter()
	var wait sync.WaitGroup
	for writer := 0; writer < 8; writer++ {
		wait.Add(1)
		go func(writer int) {
			defer wait.Done()
			for index := 0; index < 1000; index++ {
				sequence := uint16(writer*1000 + index)
				meter.recordSent(sequence, time.Now())
				if _, ok := meter.sentAt(sequence); !ok {
					t.Errorf("sequence %d not recorded", sequence)
					return
				}
			}
		}(writer)
	}
	wait.Add(1)
	go func() {
		defer wait.Done()
		for index := 0; index < 1000; index++ {
			meter.quality(time.Now())
		}
	}()
	wait.Wait()
}
