//go:build linux

package turnserver

import (
	"net"
	"syscall"
)

// udpReadBufferSize returns the receive buffer size the kernel reports for
// conn (on Linux, twice what was granted: it counts its own bookkeeping), or
// zero if it cannot be read.
func udpReadBufferSize(conn *net.UDPConn) int {
	raw, err := conn.SyscallConn()
	if err != nil {
		return 0
	}
	size := 0
	if err := raw.Control(func(fd uintptr) {
		size, _ = syscall.GetsockoptInt(int(fd), syscall.SOL_SOCKET, syscall.SO_RCVBUF)
	}); err != nil {
		return 0
	}
	return size
}
