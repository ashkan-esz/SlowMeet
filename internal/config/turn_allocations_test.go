package config

import (
	"testing"
	"time"
)

func TestTURNAllocationsPerParticipant(t *testing.T) {
	tests := []struct {
		rotate time.Duration
		want   int
	}{
		{0, 1},
		// The default: eight rotations fit into the 90 seconds a browser
		// keeps old connections, plus the one in use.
		{12 * time.Second, 9},
		{10 * time.Second, 10},
		{90 * time.Second, 2},
		{10 * time.Minute, 2},
	}
	for _, test := range tests {
		if got := TURNAllocationsPerParticipant(test.rotate); got != test.want {
			t.Errorf("TURNAllocationsPerParticipant(%s) = %d, want %d", test.rotate, got, test.want)
		}
	}
}
