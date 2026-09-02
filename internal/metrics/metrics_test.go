package metrics

import "testing"

func TestSnapshotAggregatesNetworkObservations(t *testing.T) {
	var metrics Metrics
	metrics.PeerJoined()
	metrics.ObserveNetwork(120, 15, 8, 240, 32)
	metrics.ObserveNetwork(180, 25, 12, 300, 40)
	metrics.Reconnected()
	metrics.ConnectionFailed()

	snapshot := metrics.Snapshot()
	if snapshot.PeerConnections != 1 || snapshot.Reconnects != 1 || snapshot.ConnectionFailures != 1 {
		t.Fatalf("unexpected counters: %+v", snapshot)
	}
	if snapshot.NetworkSamples != 2 || snapshot.AverageRTTMs != 150 {
		t.Fatalf("unexpected network aggregate: %+v", snapshot)
	}
	if snapshot.LastRTTMs != 180 || snapshot.LastPacketLoss10 != 25 ||
		snapshot.LastJitterMs != 12 || snapshot.LastVideoKbps != 300 ||
		snapshot.LastAudioKbps != 40 {
		t.Fatalf("unexpected latest network values: %+v", snapshot)
	}
	metrics.PeerLeft()
	if got := metrics.Snapshot().PeerConnections; got != 0 {
		t.Fatalf("peer connections after leave = %d, want 0", got)
	}
}
