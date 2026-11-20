//go:build linux

package turnserver

import (
	"net"
	"syscall"
	"time"
)

// tcpUserTimeout is TCP_USER_TIMEOUT from <linux/tcp.h>. The syscall package
// does not define it for every architecture; the value is the same on all.
const tcpUserTimeout = 0x12

// setStreamUserTimeout sets, on an accepted TCP connection, how long data
// sent to the client may stay unacknowledged before the kernel gives the
// connection up. A connection that is not a TCP socket is left alone.
func setStreamUserTimeout(conn net.Conn, timeout time.Duration) error {
	tcp, ok := conn.(*net.TCPConn)
	if !ok {
		return nil
	}
	raw, err := tcp.SyscallConn()
	if err != nil {
		return err
	}
	var optionErr error
	if err := raw.Control(func(fd uintptr) {
		optionErr = syscall.SetsockoptInt(int(fd), syscall.IPPROTO_TCP, tcpUserTimeout, int(timeout.Milliseconds()))
	}); err != nil {
		return err
	}
	return optionErr
}

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
