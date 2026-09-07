package metrics

import "testing"

func TestSnapshotAggregatesNetworkObservations(t *testing.T) {
	var metrics Metrics
	if snapshot := metrics.Snapshot(); snapshot.HasNetworkSample {
		t.Fatal("empty metrics should not report a network sample")
	}
	metrics.PeerJoined()
	metrics.ObserveNetwork(120, 15, 8, 240, 32)
	metrics.ObserveNetwork(180, 25, 12, 300, 40)
	metrics.Reconnected()
	metrics.ConnectionFailed()

	snapshot := metrics.Snapshot()
	if snapshot.PeerConnections != 1 || snapshot.Reconnects != 1 || snapshot.ConnectionFailures != 1 {
		t.Fatalf("unexpected counters: %+v", snapshot)
	}
	if snapshot.NetworkSamples != 2 || !snapshot.HasNetworkSample || snapshot.LastNetworkSample <= 0 || snapshot.AverageRTTMs != 150 {
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

func TestMissingNetworkValuesDoNotCreateSamplesOrDefaults(t *testing.T) {
	var metrics Metrics
	metrics.ObserveNetwork(-1, -1, -1, -1, -1)
	if snapshot := metrics.Snapshot(); snapshot.HasNetworkSample || snapshot.LastNetworkSample != 0 {
		t.Fatal("an observation with no measured values should not create a sample")
	}

	metrics.ObserveNetwork(84, -1, -1, -1, -1)
	snapshot := metrics.Snapshot()
	if snapshot.NetworkSamples != 1 || snapshot.LastNetworkSample <= 0 || !snapshot.HasRTT || snapshot.HasPacketLoss ||
		snapshot.HasJitter || snapshot.HasVideo || snapshot.HasAudio {
		t.Fatalf("missing metric fields were reported as available: %+v", snapshot)
	}
	if snapshot.LastRTTMs != 84 || snapshot.LastPacketLoss10 != 0 || snapshot.LastVideoKbps != 0 {
		t.Fatalf("missing metric fields received invented values: %+v", snapshot)
	}
}
