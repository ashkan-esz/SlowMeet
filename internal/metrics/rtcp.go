package metrics

import (
	"sync/atomic"

	"github.com/pion/rtcp"
)

// RTCPRelay counts the RTCP subscribers send the SFU about its tracks, by
// packet type, and how many of those batches the SFU forwards to the
// publisher. Only keyframe requests, NACKs, and REMB are forwarded (see
// routeRTCPFeedback in internal/media); the per-type counters cover everything
// received so the dropped share stays visible.
type RTCPRelay struct {
	Batches atomic.Uint64
	// ForwardedBatches counts the batches that carried something for the
	// publisher and were encrypted and sent to it.
	ForwardedBatches atomic.Uint64
	PLI              atomic.Uint64
	FIR              atomic.Uint64
	NACK             atomic.Uint64
	ReceiverReport   atomic.Uint64
	SenderReport     atomic.Uint64
	TransportCC      atomic.Uint64
	REMB             atomic.Uint64
	Other            atomic.Uint64
	// ReportOnlyBatches counts batches with no PLI, FIR, or NACK.
	ReportOnlyBatches atomic.Uint64
}

type RTCPRelaySnapshot struct {
	Batches, ForwardedBatches, PLI, FIR, NACK, ReceiverReport, SenderReport, TransportCC, REMB, Other, ReportOnlyBatches uint64
}

// Observe counts one batch received from a subscriber.
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
		Batches: m.Batches.Load(), ForwardedBatches: m.ForwardedBatches.Load(), PLI: m.PLI.Load(), FIR: m.FIR.Load(), NACK: m.NACK.Load(),
		ReceiverReport: m.ReceiverReport.Load(), SenderReport: m.SenderReport.Load(),
		TransportCC: m.TransportCC.Load(), REMB: m.REMB.Load(), Other: m.Other.Load(),
		ReportOnlyBatches: m.ReportOnlyBatches.Load(),
	}
}
