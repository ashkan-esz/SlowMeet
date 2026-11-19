package metrics

import (
	"sync/atomic"

	"github.com/pion/rtcp"
)

// RTCPRelay counts the subscriber RTCP the SFU forwards to publishers, by
// packet type. Forwarding is the largest known CPU cost of the media path
// (every batch is an encrypt-and-send to the publisher), so the mix decides
// whether any of it can be dropped; these counters only observe.
type RTCPRelay struct {
	Batches        atomic.Uint64
	PLI            atomic.Uint64
	FIR            atomic.Uint64
	NACK           atomic.Uint64
	ReceiverReport atomic.Uint64
	SenderReport   atomic.Uint64
	TransportCC    atomic.Uint64
	REMB           atomic.Uint64
	Other          atomic.Uint64
	// ReportOnlyBatches counts batches with no PLI, FIR, or NACK: the ones
	// a keyframe/retransmission-only relay would not have to send at all.
	ReportOnlyBatches atomic.Uint64
}

type RTCPRelaySnapshot struct {
	Batches, PLI, FIR, NACK, ReceiverReport, SenderReport, TransportCC, REMB, Other, ReportOnlyBatches uint64
}

// Observe counts one forwarded batch.
func (m *RTCPRelay) Observe(packets []rtcp.Packet) {
	m.Batches.Add(1)
	repair := false
	for _, packet := range packets {
		switch packet.(type) {
		case *rtcp.PictureLossIndication:
			m.PLI.Add(1)
			repair = true
		case *rtcp.FullIntraRequest:
			m.FIR.Add(1)
			repair = true
		case *rtcp.TransportLayerNack:
			m.NACK.Add(1)
			repair = true
		case *rtcp.ReceiverReport:
			m.ReceiverReport.Add(1)
		case *rtcp.SenderReport:
			m.SenderReport.Add(1)
		case *rtcp.TransportLayerCC:
			m.TransportCC.Add(1)
		case *rtcp.ReceiverEstimatedMaximumBitrate:
			m.REMB.Add(1)
		default:
			m.Other.Add(1)
		}
	}
	if !repair {
		m.ReportOnlyBatches.Add(1)
	}
}

func (m *RTCPRelay) Snapshot() RTCPRelaySnapshot {
	return RTCPRelaySnapshot{
		Batches: m.Batches.Load(), PLI: m.PLI.Load(), FIR: m.FIR.Load(), NACK: m.NACK.Load(),
		ReceiverReport: m.ReceiverReport.Load(), SenderReport: m.SenderReport.Load(),
		TransportCC: m.TransportCC.Load(), REMB: m.REMB.Load(), Other: m.Other.Load(),
		ReportOnlyBatches: m.ReportOnlyBatches.Load(),
	}
}
