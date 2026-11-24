package webrtc

import (
	"encoding/binary"
	"math"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/sdp/v3"
)

// downlinkMeter measures the SFU-to-participant leg of one peer connection:
// the share of the SFU's packets that never reached the participant and the
// RFC 3550 jitter of those that did. Every packet this peer sends carries the
// SFU's own transport-wide sequence number (the transport-cc header
// extension interceptor stamps it), and the participant's browser answers
// with transport-cc feedback saying which of those numbers arrived and when.
//
// That is the participant's own download, with nothing of any sender's
// uplink in it: the send time is taken as the SFU writes the packet, after
// forwarding and pacing. Browsers can only estimate it from their inbound
// streams, discounting what each sender's uplink lost, which fails when every
// sender is near an outage or over-reports its loss (B1, B14 in
// docs/network-testing.md).
//
// The meter must be registered before the header extension interceptor: the
// last interceptor added wraps the others, so the stamper writes the sequence
// number before this meter's writer reads it. Both must be registered before
// the NACK responder, so a resend gets a number and a record of its own (see
// newMediaEngineAndRegistry) and the loss it repairs stays counted.
type downlinkMeter struct {
	interceptor.NoOp

	start time.Time
	// sent holds, per sequence number modulo the ring, the sequence number
	// in its top 16 bits and the send time in microseconds since start (plus
	// one, so zero means empty) below. One writer per slot: the stamper hands
	// out each sequence number once.
	sent [downlinkRingSize]atomic.Uint64

	mu sync.Mutex
	// fate is what feedback said about each slot's packet: 0 nothing yet,
	// downlinkLost, or downlinkReceived; fateSeq is the sequence number it is
	// about and fateWindow the window that counted it.
	fate       [downlinkRingSize]uint8
	fateSeq    [downlinkRingSize]uint16
	fateWindow [downlinkRingSize]uint32
	// The last feedback, to skip one compound packet delivered to several
	// senders' RTCP readers.
	seenFeedback   bool
	lastFbCount    uint8
	lastFbBase     uint16
	jitterStarted  bool
	lastTransitUs  int64
	jitterUs       float64
	window         uint32
	windowStart    time.Time
	windowLost     int
	windowReceived int
	windowJitterUs float64
	partialAt      time.Time
	lastFeedback   time.Time

	// result and partial are the last complete window and the window in
	// progress, packed by packDownlink; 0 when there is none.
	result  atomic.Uint64
	partial atomic.Uint64
}

const (
	downlinkRingSize = 8192
	downlinkLost     = 1
	downlinkReceived = 2
	// downlinkWindow, downlinkPartialInterval and downlinkPartialMinPackets
	// mirror media's forwardLoss windows, so the downlink and the senders'
	// source quality describe the same stretch of time.
	downlinkWindow            = time.Second
	downlinkPartialInterval   = 250 * time.Millisecond
	downlinkPartialMinPackets = 10
	// downlinkMinPackets is the fewest reported packets a measurement needs.
	downlinkMinPackets = 20
	// downlinkMaxTransitStepUs ends the jitter chain on a jump no queue
	// explains (a reference-time wrap, a gap of seconds): it restarts.
	downlinkMaxTransitStepUs = 2_000_000
)

func newDownlinkMeter() *downlinkMeter {
	now := time.Now()
	return &downlinkMeter{start: now, windowStart: now, partialAt: now}
}

// NewInterceptor makes the meter its own factory: the registry is built for
// one peer connection, so it is built once.
func (m *downlinkMeter) NewInterceptor(string) (interceptor.Interceptor, error) {
	return m, nil
}

func transportCCExtensionID(info *interceptor.StreamInfo) uint8 {
	for _, extension := range info.RTPHeaderExtensions {
		if extension.URI == sdp.TransportCCURI {
			return uint8(extension.ID)
		}
	}
	return 0
}

// BindLocalStream records the send time of every packet that carries a
// transport-wide sequence number.
func (m *downlinkMeter) BindLocalStream(info *interceptor.StreamInfo, writer interceptor.RTPWriter) interceptor.RTPWriter {
	id := transportCCExtensionID(info)
	if id == 0 {
		return writer
	}
	return interceptor.RTPWriterFunc(func(header *rtp.Header, payload []byte, attributes interceptor.Attributes) (int, error) {
		if extension := header.GetExtension(id); len(extension) >= 2 {
			m.recordSent(binary.BigEndian.Uint16(extension), time.Now())
		}
		return writer.Write(header, payload, attributes)
	})
}

func (m *downlinkMeter) recordSent(sequence uint16, now time.Time) {
	micros := uint64(now.Sub(m.start).Microseconds()) + 1
	m.sent[int(sequence)%downlinkRingSize].Store(uint64(sequence)<<48 | micros&(1<<48-1))
}

// sentAt returns the send time of sequence in microseconds since start, or
// false when the ring no longer (or never) held it.
func (m *downlinkMeter) sentAt(sequence uint16) (int64, bool) {
	slot := m.sent[int(sequence)%downlinkRingSize].Load()
	if slot == 0 || uint16(slot>>48) != sequence {
		return 0, false
	}
	return int64(slot&(1<<48-1)) - 1, true
}

// BindRTCPReader reads the participant's transport-cc feedback. The packets
// are parsed through the attributes, which cache them for the NACK
// interceptor and the router's relay.
func (m *downlinkMeter) BindRTCPReader(reader interceptor.RTCPReader) interceptor.RTCPReader {
	return interceptor.RTCPReaderFunc(func(buf []byte, attributes interceptor.Attributes) (int, interceptor.Attributes, error) {
		n, attributes, err := reader.Read(buf, attributes)
		if err != nil {
			return n, attributes, err
		}
		if attributes == nil {
			attributes = make(interceptor.Attributes)
		}
		packets, parseErr := attributes.GetRTCPPackets(buf[:n])
		if parseErr != nil {
			return n, attributes, nil
		}
		now := time.Now()
		for _, packet := range packets {
			if feedback, ok := packet.(*rtcp.TransportLayerCC); ok {
				m.onFeedback(feedback, now)
			}
		}
		return n, attributes, nil
	})
}

// onFeedback accounts one transport-cc feedback packet.
func (m *downlinkMeter) onFeedback(feedback *rtcp.TransportLayerCC, now time.Time) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.seenFeedback && feedback.FbPktCount == m.lastFbCount && feedback.BaseSequenceNumber == m.lastFbBase {
		return
	}
	m.seenFeedback, m.lastFbCount, m.lastFbBase = true, feedback.FbPktCount, feedback.BaseSequenceNumber
	m.lastFeedback = now
	if now.Sub(m.windowStart) >= downlinkWindow {
		m.closeWindowLocked(now)
	}

	// The reference time counts 64 ms steps; deltas are in microseconds.
	arrivalUs := int64(feedback.ReferenceTime) * 64_000
	sequence := feedback.BaseSequenceNumber
	remaining := int(feedback.PacketStatusCount)
	deltaIndex := 0
	status := func(symbol uint16) {
		if remaining <= 0 {
			return
		}
		remaining--
		current := sequence
		sequence++
		switch symbol {
		case rtcp.TypeTCCPacketReceivedSmallDelta, rtcp.TypeTCCPacketReceivedLargeDelta:
			if deltaIndex >= len(feedback.RecvDeltas) {
				return
			}
			arrivalUs += feedback.RecvDeltas[deltaIndex].Delta
			deltaIndex++
			m.noteReceivedLocked(current, arrivalUs)
		case rtcp.TypeTCCPacketNotReceived:
			m.noteLostLocked(current)
		}
	}
	for _, chunk := range feedback.PacketChunks {
		switch chunk := chunk.(type) {
		case *rtcp.RunLengthChunk:
			for index := uint16(0); index < chunk.RunLength && remaining > 0; index++ {
				status(chunk.PacketStatusSymbol)
			}
		case *rtcp.StatusVectorChunk:
			for _, symbol := range chunk.SymbolList {
				if chunk.SymbolSize == rtcp.TypeTCCSymbolSizeOneBit && symbol == 1 {
					// A one-bit vector marks a received packet with 1; it
					// carries a small delta.
					symbol = rtcp.TypeTCCPacketReceivedSmallDelta
				}
				status(symbol)
			}
		}
	}
	m.publishPartialLocked(now)
}

func (m *downlinkMeter) noteLostLocked(sequence uint16) {
	if _, known := m.sentAt(sequence); !known {
		return
	}
	slot := int(sequence) % downlinkRingSize
	if m.fateSeq[slot] == sequence && m.fate[slot] != 0 {
		return
	}
	m.fate[slot], m.fateSeq[slot], m.fateWindow[slot] = downlinkLost, sequence, m.window
	m.windowLost++
}

func (m *downlinkMeter) noteReceivedLocked(sequence uint16, arrivalUs int64) {
	sentUs, known := m.sentAt(sequence)
	if !known {
		return
	}
	slot := int(sequence) % downlinkRingSize
	if m.fateSeq[slot] == sequence {
		switch m.fate[slot] {
		case downlinkReceived:
			return
		case downlinkLost:
			// Reported missing, then late: it did arrive. Correct the
			// window that counted it while that window is still open.
			if m.fateWindow[slot] == m.window {
				m.windowLost--
				m.windowReceived++
			}
			m.fate[slot] = downlinkReceived
			return
		}
	}
	m.fate[slot], m.fateSeq[slot], m.fateWindow[slot] = downlinkReceived, sequence, m.window
	m.windowReceived++

	transitUs := arrivalUs - sentUs
	if m.jitterStarted {
		difference := math.Abs(float64(transitUs - m.lastTransitUs))
		if difference > downlinkMaxTransitStepUs {
			m.jitterUs = 0
		} else {
			m.jitterUs += (difference - m.jitterUs) / 16
		}
	}
	m.jitterStarted, m.lastTransitUs = true, transitUs
	if m.jitterUs > m.windowJitterUs {
		m.windowJitterUs = m.jitterUs
	}
}

func (m *downlinkMeter) closeWindowLocked(now time.Time) {
	m.result.Store(packDownlink(m.windowLost, m.windowReceived, m.windowJitterUs))
	m.partial.Store(0)
	m.window++
	m.windowStart, m.partialAt = now, now
	m.windowLost, m.windowReceived = 0, 0
	m.windowJitterUs = m.jitterUs
}

func (m *downlinkMeter) publishPartialLocked(now time.Time) {
	if now.Sub(m.partialAt) < downlinkPartialInterval || m.windowLost+m.windowReceived < downlinkPartialMinPackets {
		return
	}
	m.partialAt = now
	m.partial.Store(packDownlink(m.windowLost, m.windowReceived, m.windowJitterUs))
}

// packDownlink packs a window's loss tenths (11 bits), jitter in
// milliseconds (21 bits) and packet count (31 bits) under a set top bit, so a
// stored window is never 0.
func packDownlink(lost, received int, jitterUs float64) uint64 {
	packets := lost + received
	if packets <= 0 {
		return 0
	}
	loss10 := uint64(math.Round(float64(lost) * 1000 / float64(packets)))
	jitterMs := uint64(math.Min(math.Round(jitterUs/1000), 1<<21-1))
	return 1<<63 | loss10<<52 | jitterMs<<31 | uint64(min(packets, 1<<31-1))
}

func unpackDownlink(value uint64) (loss10, jitterMs, packets int) {
	return int(value >> 52 & (1<<11 - 1)), int(value >> 31 & (1<<21 - 1)), int(value & (1<<31 - 1))
}

// quality reports the worse of the window in progress and the last complete
// window, each measure on its own: loss in tenths of a percent, jitter in
// milliseconds, and the most packets either window counted. A window with no
// loss but a queue must not be hidden by one with a little loss and none. ok
// is false when neither window counted downlinkMinPackets packets, or no
// feedback arrived for two windows (the participant stopped sending it, or
// nothing was sent to it).
func (m *downlinkMeter) quality(now time.Time) (loss10, jitterMs, packets int, ok bool) {
	m.mu.Lock()
	stale := m.lastFeedback.IsZero() || now.Sub(m.lastFeedback) >= 2*downlinkWindow
	m.mu.Unlock()
	if stale {
		return 0, 0, 0, false
	}
	for _, value := range []uint64{m.result.Load(), m.partial.Load()} {
		if value == 0 {
			continue
		}
		windowLoss, windowJitter, windowPackets := unpackDownlink(value)
		if windowPackets < downlinkMinPackets {
			continue
		}
		loss10, jitterMs, packets = max(loss10, windowLoss), max(jitterMs, windowJitter), max(packets, windowPackets)
		ok = true
	}
	return loss10, jitterMs, packets, ok
}
