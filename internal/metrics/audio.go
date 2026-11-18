package metrics

import "sync/atomic"

// AudioDrops separates transport-induced catch-up loss from SFU admission,
// bounded receiver queues, and failed egress writes without participant labels.
type AudioDrops struct {
	Admission     atomic.Uint64
	QueueOverflow atomic.Uint64
	QueueExpired  atomic.Uint64
	WriteFailures atomic.Uint64
}

type AudioDropSnapshot struct {
	Admission     uint64
	QueueOverflow uint64
	QueueExpired  uint64
	WriteFailures uint64
}

func (m *AudioDrops) Snapshot() AudioDropSnapshot {
	return AudioDropSnapshot{
		Admission:     m.Admission.Load(),
		QueueOverflow: m.QueueOverflow.Load(),
		QueueExpired:  m.QueueExpired.Load(),
		WriteFailures: m.WriteFailures.Load(),
	}
}
