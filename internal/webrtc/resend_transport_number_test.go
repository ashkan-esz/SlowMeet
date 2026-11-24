package webrtc

import (
	"sync"
	"testing"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
	pion "github.com/pion/webrtc/v4"
)

const resendTestExtension = 5

// resendChain is the peer's own interceptor chain bound to one video stream,
// with what it puts on the wire captured.
type resendChain struct {
	meter  *downlinkMeter
	write  interceptor.RTPWriter
	rtcp   chan []byte
	mu     sync.Mutex
	wire   []rtp.Header
	report []*rtcp.SenderReport
}

func newResendChain(t *testing.T, ssrc, rtxSSRC uint32) *resendChain {
	t.Helper()
	_, registry, meter, err := newMediaEngineAndRegistry(&pion.SettingEngine{})
	if err != nil {
		t.Fatal(err)
	}
	built, err := registry.Build("")
	if err != nil {
		t.Fatal(err)
	}
	chain := &resendChain{meter: meter, rtcp: make(chan []byte, 64)}
	t.Cleanup(func() {
		close(chain.rtcp)
		_ = built.Close()
	})
	info := &interceptor.StreamInfo{
		SSRC: ssrc, ClockRate: 90000, MimeType: pion.MimeTypeVP8, PayloadType: 96,
		RTPHeaderExtensions: []interceptor.RTPHeaderExtension{{URI: sdp.TransportCCURI, ID: resendTestExtension}},
		RTCPFeedback:        []interceptor.RTCPFeedback{{Type: "nack"}},
	}
	if rtxSSRC != 0 {
		info.SSRCRetransmission, info.PayloadTypeRetransmission = rtxSSRC, 97
	}
	built.BindRTCPWriter(interceptor.RTCPWriterFunc(func(packets []rtcp.Packet, _ interceptor.Attributes) (int, error) {
		chain.mu.Lock()
		defer chain.mu.Unlock()
		for _, packet := range packets {
			if report, ok := packet.(*rtcp.SenderReport); ok {
				chain.report = append(chain.report, report)
			}
		}
		return 0, nil
	}))
	chain.write = built.BindLocalStream(info, interceptor.RTPWriterFunc(
		func(header *rtp.Header, payload []byte, _ interceptor.Attributes) (int, error) {
			chain.mu.Lock()
			defer chain.mu.Unlock()
			chain.wire = append(chain.wire, header.Clone())
			return len(payload), nil
		}))
	reader := built.BindRTCPReader(interceptor.RTCPReaderFunc(
		func(buf []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
			return copy(buf, <-chain.rtcp), attributes, nil
		}))
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, err := reader.Read(buf, nil)
			if err != nil || n == 0 {
				return
			}
		}
	}()
	return chain
}

func (c *resendChain) send(t *testing.T, ssrc uint32, sequence uint16) {
	t.Helper()
	header := &rtp.Header{Version: 2, PayloadType: 96, SSRC: ssrc, SequenceNumber: sequence, Timestamp: uint32(sequence) * 3000}
	if _, err := c.write.Write(header, []byte{0x10, 1, 2, 3}, interceptor.Attributes{}); err != nil {
		t.Fatal(err)
	}
}

func (c *resendChain) requestResend(t *testing.T, ssrc uint32, sequence uint16) {
	t.Helper()
	c.receive(t, &rtcp.TransportLayerNack{MediaSSRC: ssrc, Nacks: []rtcp.NackPair{{PacketID: sequence}}})
}

// receive hands the chain an RTCP packet from the participant.
func (c *resendChain) receive(t *testing.T, packet rtcp.Packet) {
	t.Helper()
	raw, err := packet.Marshal()
	if err != nil {
		t.Fatal(err)
	}
	c.rtcp <- raw
}

// waitWire returns the first count headers the chain wrote.
func (c *resendChain) waitWire(t *testing.T, count int) []rtp.Header {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		c.mu.Lock()
		wire := append([]rtp.Header(nil), c.wire...)
		c.mu.Unlock()
		if len(wire) >= count {
			return wire
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d packets reached the wire, want %d", len(wire), count)
		}
		time.Sleep(time.Millisecond)
	}
}

func transportNumber(t *testing.T, header rtp.Header) uint16 {
	t.Helper()
	var extension rtp.TransportCCExtension
	if err := extension.Unmarshal(header.GetExtension(resendTestExtension)); err != nil {
		t.Fatalf("packet %d of SSRC %d carries no transport number: %v", header.SequenceNumber, header.SSRC, err)
	}
	return extension.TransportSequence
}

// A resend that repeats the lost packet's transport-wide number makes the
// receiver report that number as arrived, so the loss it repaired disappears
// from the download measurement. Each resend must be a packet of its own.
func TestResentPacketsGetTheirOwnTransportNumber(t *testing.T) {
	for _, test := range []struct {
		name    string
		rtxSSRC uint32
	}{{"on the RTX stream", 2222}, {"on the media stream", 0}} {
		t.Run(test.name, func(t *testing.T) {
			const ssrc = 1111
			chain := newResendChain(t, ssrc, test.rtxSSRC)
			chain.send(t, ssrc, 10)
			chain.send(t, ssrc, 11)
			chain.requestResend(t, ssrc, 10)
			wire := chain.waitWire(t, 3)
			chain.requestResend(t, ssrc, 10)
			wire = chain.waitWire(t, 4)
			if test.rtxSSRC != 0 && (wire[2].SSRC != test.rtxSSRC || wire[2].PayloadType != 97) {
				t.Fatalf("resent as SSRC %d payload type %d", wire[2].SSRC, wire[2].PayloadType)
			}
			seen := map[uint16]int{}
			for index, header := range wire {
				number := transportNumber(t, header)
				if earlier, repeated := seen[number]; repeated {
					t.Fatalf("wire packet %d repeats transport number %d of packet %d", index, number, earlier)
				}
				seen[number] = index
				if _, known := chain.meter.sentAt(number); !known {
					t.Fatalf("the meter did not record wire packet %d (transport number %d)", index, number)
				}
			}
		})
	}
}

// The measurement on a video download that loses 12 % and has every loss
// resent at once: the repairs must not hide the losses, nor count as jitter.
func TestDownlinkMeterSeesLossThatResendsRepair(t *testing.T) {
	const ssrc, rtxSSRC, packets = 1111, 2222, 500
	chain := newResendChain(t, ssrc, rtxSSRC)
	recorder := twcc.NewRecorder(1)
	// The participant's side: 3 of every 25 packets never arrive and are
	// NACKed at once, their resends arrive, and feedback goes out every 50 ms.
	taken := 0
	arrive := func() {
		chain.mu.Lock()
		wire := append([]rtp.Header(nil), chain.wire[taken:]...)
		chain.mu.Unlock()
		taken += len(wire)
		for _, header := range wire {
			place := header.SequenceNumber % 25
			if header.SSRC == ssrc && (place == 3 || place == 11 || place == 19) {
				chain.requestResend(t, ssrc, header.SequenceNumber)
				continue
			}
			recorder.Record(ssrc, transportNumber(t, header), time.Since(chain.meter.start).Microseconds()+1_000_000)
		}
	}
	for sequence := uint16(0); sequence < packets; sequence++ {
		chain.send(t, ssrc, sequence)
		time.Sleep(4 * time.Millisecond)
		arrive()
		if sequence%12 == 11 {
			for _, feedback := range recorder.BuildFeedbackPacket() {
				chain.receive(t, feedback)
			}
		}
	}
	loss10, jitterMs, counted, ok := chain.meter.quality(time.Now())
	if !ok || counted < downlinkMinPackets {
		t.Fatalf("no measurement (%d packets, ok %v)", counted, ok)
	}
	// 3 of 25 media packets lost, and the resends count as packets too: 3 of
	// 28, 10.7 %.
	if loss10 < 90 || loss10 > 130 {
		t.Fatalf("measured %d tenths of loss on a download losing 107", loss10)
	}
	if jitterMs > 20 {
		t.Fatalf("measured %d ms of jitter on a download with none", jitterMs)
	}
}

// Every NACK is served in its own goroutine from one stored packet, so
// stamping a resend must not write to that packet's header; run with -race.
func TestConcurrentResendsOfOnePacketDoNotShareItsHeader(t *testing.T) {
	for _, rtxSSRC := range []uint32{2222, 0} {
		const ssrc, resends = 1111, 50
		chain := newResendChain(t, ssrc, rtxSSRC)
		chain.send(t, ssrc, 10)
		for range resends {
			chain.requestResend(t, ssrc, 10)
		}
		seen := map[uint16]bool{}
		for _, header := range chain.waitWire(t, 1+resends) {
			number := transportNumber(t, header)
			if seen[number] {
				t.Fatalf("transport number %d used twice", number)
			}
			seen[number] = true
		}
	}
}

// Resends stay out of the sender reports: those describe the media stream,
// and a resend's older timestamp and extra octets are not part of it.
func TestResendsStayOutOfSenderReports(t *testing.T) {
	const ssrc = 1111
	chain := newResendChain(t, ssrc, 2222)
	chain.send(t, ssrc, 10)
	chain.send(t, ssrc, 11)
	for range 5 {
		chain.requestResend(t, ssrc, 10)
	}
	chain.waitWire(t, 7)
	deadline := time.Now().Add(5 * time.Second)
	for {
		chain.mu.Lock()
		reports := append([]*rtcp.SenderReport(nil), chain.report...)
		chain.mu.Unlock()
		if len(reports) > 0 {
			for _, report := range reports {
				if report.SSRC != ssrc || report.PacketCount != 2 || report.OctetCount != 8 {
					t.Fatalf("sender report for SSRC %d: %d packets, %d octets; want 2 and 8", report.SSRC, report.PacketCount, report.OctetCount)
				}
			}
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("no sender report")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
