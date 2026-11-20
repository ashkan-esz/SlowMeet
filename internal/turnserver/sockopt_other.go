//go:build !linux

package turnserver

import (
	"net"
	"time"
)

// udpReadBufferSize is not read on this platform; SlowMeet is deployed on
// Linux and built elsewhere only for development.
func udpReadBufferSize(*net.UDPConn) int { return 0 }

// setStreamUserTimeout does nothing on this platform, for the same reason.
func setStreamUserTimeout(net.Conn, time.Duration) error { return nil }
