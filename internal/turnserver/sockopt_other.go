//go:build !linux

package turnserver

import "net"

// udpReadBufferSize is not read on this platform; SlowMeet is deployed on
// Linux and built elsewhere only for development.
func udpReadBufferSize(*net.UDPConn) int { return 0 }
