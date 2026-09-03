package metrics

import "sync/atomic"

type Metrics struct {
	peerConnections    atomic.Int64
	connectionFailures atomic.Uint64
	reconnects         atomic.Uint64
	networkSamples     atomic.Uint64
	rttSamples         atomic.Uint64
	rttTotalMs         atomic.Uint64
	lastRTTMs          atomic.Int64
	lastPacketLoss10   atomic.Int64
	lastJitterMs       atomic.Int64
	lastVideoKbps      atomic.Int64
	lastAudioKbps      atomic.Int64
}

type Snapshot struct {
	PeerConnections    int64
	ConnectionFailures uint64
	Reconnects         uint64
	NetworkSamples     uint64
	HasNetworkSample   bool
	AverageRTTMs       float64
	LastRTTMs          int64
	LastPacketLoss10   int64
	LastJitterMs       int64
	LastVideoKbps      int64
	LastAudioKbps      int64
}

func (m *Metrics) PeerJoined() {
	m.peerConnections.Add(1)
}

func (m *Metrics) PeerLeft() {
	m.peerConnections.Add(-1)
}

func (m *Metrics) ConnectionFailed() {
	m.connectionFailures.Add(1)
}

func (m *Metrics) Reconnected() {
	m.reconnects.Add(1)
}

func (m *Metrics) ObserveNetwork(rttMs, packetLoss10, jitterMs, videoKbps, audioKbps int) {
	if rttMs >= 0 {
		m.rttTotalMs.Add(uint64(rttMs))
		m.lastRTTMs.Store(int64(rttMs))
		m.rttSamples.Add(1)
	}
	if packetLoss10 >= 0 {
		m.lastPacketLoss10.Store(int64(packetLoss10))
	}
	if jitterMs >= 0 {
		m.lastJitterMs.Store(int64(jitterMs))
	}
	if videoKbps >= 0 {
		m.lastVideoKbps.Store(int64(videoKbps))
	}
	if audioKbps >= 0 {
		m.lastAudioKbps.Store(int64(audioKbps))
	}
	m.networkSamples.Add(1)
}

func (m *Metrics) Snapshot() Snapshot {
	snapshot := Snapshot{
		PeerConnections:    m.peerConnections.Load(),
		ConnectionFailures: m.connectionFailures.Load(),
		Reconnects:         m.reconnects.Load(),
		NetworkSamples:     m.networkSamples.Load(),
		LastRTTMs:          m.lastRTTMs.Load(),
		LastPacketLoss10:   m.lastPacketLoss10.Load(),
		LastJitterMs:       m.lastJitterMs.Load(),
		LastVideoKbps:      m.lastVideoKbps.Load(),
		LastAudioKbps:      m.lastAudioKbps.Load(),
	}
	snapshot.HasNetworkSample = snapshot.NetworkSamples > 0
	if samples := m.rttSamples.Load(); samples > 0 {
		snapshot.AverageRTTMs = float64(m.rttTotalMs.Load()) / float64(samples)
	}
	return snapshot
}
