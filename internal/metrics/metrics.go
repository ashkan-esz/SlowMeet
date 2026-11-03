package metrics

import (
	"math"
	"sync/atomic"
	"time"
)

// rttEwmaAlpha weights each new reported RTT into the windowed average; a
// lifetime mean becomes meaningless after days of uptime.
const rttEwmaAlpha = 0.1

type Metrics struct {
	peerConnections    atomic.Int64
	connectionFailures atomic.Uint64
	reconnects         atomic.Uint64
	networkSamples     atomic.Uint64
	rttSamples         atomic.Uint64
	// rttEwmaMilli holds math.Float64bits of the windowed RTT average; a
	// plain atomic float would lose updates under concurrent reporters.
	rttEwmaMilli      atomic.Uint64
	lastRTTMs         atomic.Int64
	lastPacketLoss10  atomic.Int64
	lastJitterMs      atomic.Int64
	lastVideoKbps     atomic.Int64
	lastAudioKbps     atomic.Int64
	lastNetworkSample atomic.Int64
	hasRTT            atomic.Bool
	hasPacketLoss     atomic.Bool
	hasJitter         atomic.Bool
	hasVideo          atomic.Bool
	hasAudio          atomic.Bool
}

type Snapshot struct {
	PeerConnections    int64
	ConnectionFailures uint64
	Reconnects         uint64
	NetworkSamples     uint64
	HasNetworkSample   bool
	HasRTT             bool
	HasPacketLoss      bool
	HasJitter          bool
	HasVideo           bool
	HasAudio           bool
	LastNetworkSample  int64
	// AverageRTTMs is an exponentially weighted window over reported RTT
	// samples, not a lifetime mean.
	AverageRTTMs     float64
	LastRTTMs        int64
	LastPacketLoss10 int64
	LastJitterMs     int64
	LastVideoKbps    int64
	LastAudioKbps    int64
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
	observed := false
	if rttMs >= 0 {
		m.recordRTT(float64(rttMs))
		m.lastRTTMs.Store(int64(rttMs))
		m.rttSamples.Add(1)
		m.hasRTT.Store(true)
		observed = true
	}
	if packetLoss10 >= 0 {
		m.lastPacketLoss10.Store(int64(packetLoss10))
		m.hasPacketLoss.Store(true)
		observed = true
	}
	if jitterMs >= 0 {
		m.lastJitterMs.Store(int64(jitterMs))
		m.hasJitter.Store(true)
		observed = true
	}
	if videoKbps >= 0 {
		m.lastVideoKbps.Store(int64(videoKbps))
		m.hasVideo.Store(true)
		observed = true
	}
	if audioKbps >= 0 {
		m.lastAudioKbps.Store(int64(audioKbps))
		m.hasAudio.Store(true)
		observed = true
	}
	if observed {
		m.networkSamples.Add(1)
		m.lastNetworkSample.Store(time.Now().Unix())
	}
}

// recordRTT folds one reported RTT into the exponentially weighted window.
func (m *Metrics) recordRTT(rttMs float64) {
	for {
		previous := m.rttEwmaMilli.Load()
		next := rttMs
		if previous != 0 {
			next = math.Float64frombits(previous)*(1-rttEwmaAlpha) + rttMs*rttEwmaAlpha
		}
		if m.rttEwmaMilli.CompareAndSwap(previous, math.Float64bits(next)) {
			return
		}
	}
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
		LastNetworkSample:  m.lastNetworkSample.Load(),
		HasRTT:             m.hasRTT.Load(),
		HasPacketLoss:      m.hasPacketLoss.Load(),
		HasJitter:          m.hasJitter.Load(),
		HasVideo:           m.hasVideo.Load(),
		HasAudio:           m.hasAudio.Load(),
	}
	snapshot.HasNetworkSample = snapshot.NetworkSamples > 0
	if bits := m.rttEwmaMilli.Load(); bits != 0 {
		snapshot.AverageRTTMs = math.Float64frombits(bits)
	}
	return snapshot
}
