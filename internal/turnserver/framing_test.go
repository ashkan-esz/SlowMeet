package turnserver

import (
	"bytes"
	"errors"
	"net"
	"testing"
	"time"

	"github.com/pion/turn/v5"
)

// stunBindingRequest is a complete 20-byte STUN binding request.
var stunBindingRequest = []byte{
	0x00, 0x01, 0x00, 0x00, 0x21, 0x12, 0xa4, 0x42,
	1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
}

// framedPipe returns a framedConn and the client end that feeds it.
func framedPipe(t *testing.T) (*framedConn, net.Conn) {
	t.Helper()
	client, server := net.Pipe()
	t.Cleanup(func() {
		_ = client.Close()
		_ = server.Close()
	})
	return newFramedConn(server), client
}

func readFrame(t *testing.T, conn net.Conn) []byte {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(testTimeout)); err != nil {
		t.Fatal(err)
	}
	buffer := make([]byte, turnFrameLimit)
	n, err := conn.Read(buffer)
	if err != nil {
		t.Fatalf("Read() error = %v", err)
	}
	return buffer[:n]
}

func TestFramedConnReturnsOneWholeFramePerRead(t *testing.T) {
	framed, client := framedPipe(t)
	channelData := []byte{0x40, 0x00, 0x00, 0x05, 'h', 'e', 'l', 'l', 'o', 0, 0, 0}
	go func() {
		// A byte at a time, the way a slow or hostile client sends.
		for _, b := range append(append([]byte{}, stunBindingRequest...), channelData...) {
			if _, err := client.Write([]byte{b}); err != nil {
				return
			}
		}
	}()
	if got := readFrame(t, framed); !bytes.Equal(got, stunBindingRequest) {
		t.Fatalf("first frame = % x, want the STUN message", got)
	}
	if got := readFrame(t, framed); !bytes.Equal(got, channelData) {
		t.Fatalf("second frame = % x, want the padded ChannelData", got)
	}
}

func TestFramedConnSkipsAFrameTheLibraryWouldDrop(t *testing.T) {
	framed, client := framedPipe(t)
	oversized := append([]byte{0x00, 0x01, 0x0b, 0xb8, 0x21, 0x12, 0xa4, 0x42}, make([]byte, 3000+12)...)
	go func() {
		_, _ = client.Write(oversized)
		_, _ = client.Write(stunBindingRequest)
	}()
	if got := readFrame(t, framed); !bytes.Equal(got, stunBindingRequest) {
		t.Fatalf("frame after an oversized one = % x (%d bytes), want the STUN message", got[:min(len(got), 8)], len(got))
	}
}

func TestFramedConnRejectsWhatIsNotTURN(t *testing.T) {
	tests := map[string][]byte{
		"first byte outside STUN and ChannelData": {0x80, 0x00, 0x00, 0x04, 1, 2, 3, 4},
		"STUN message without the magic cookie":   {0x00, 0x01, 0x00, 0x00, 1, 2, 3, 4},
		"ChannelData that starts with the cookie": {0x40, 0x00, 0x00, 0x04, 0x21, 0x12, 0xa4, 0x42},
	}
	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			framed, client := framedPipe(t)
			go func() { _, _ = client.Write(data) }()
			_ = framed.SetReadDeadline(time.Now().Add(testTimeout))
			if _, err := framed.Read(make([]byte, turnFrameLimit)); !errors.Is(err, errNotATURNFrame) {
				t.Fatalf("Read() error = %v, want errNotATURNFrame", err)
			}
		})
	}
}

func TestLibraryNeverSeesAFrameWhoseLengthOverflows(t *testing.T) {
	// The TURN library adds a frame's length to its header size in 16 bits.
	// These nine bytes wrap that to zero: read directly, it reports a frame
	// of no bytes without consuming anything and its read loop spins for
	// good. Behind framedConn it must simply wait for the rest of the
	// (oversized) frame, and end when the client goes away.
	tests := map[string][]byte{
		"STUN":        {0x00, 0x01, 0xff, 0xec, 0x21, 0x12, 0xa4, 0x42, 0},
		"ChannelData": {0x40, 0x00, 0xff, 0xfc, 1, 2, 3, 4, 5},
	}
	for name, data := range tests {
		t.Run(name, func(t *testing.T) {
			framed, client := framedPipe(t)
			library := turn.NewSTUNConn(framed)
			type result struct {
				n   int
				err error
			}
			done := make(chan result, 1)
			go func() {
				n, _, err := library.ReadFrom(make([]byte, turnFrameLimit))
				done <- result{n, err}
			}()
			if _, err := client.Write(data); err != nil {
				t.Fatal(err)
			}
			select {
			case got := <-done:
				t.Fatalf("the library was handed a frame of %d bytes (error %v) for a length that overflows", got.n, got.err)
			case <-time.After(300 * time.Millisecond):
			}
			_ = client.Close()
			select {
			case got := <-done:
				if got.err == nil {
					t.Fatalf("read returned %d bytes without error after the client left", got.n)
				}
			case <-time.After(testTimeout):
				t.Fatal("the read did not end when the client left")
			}
		})
	}
}

func TestRelayClosesAConnectionThatDoesNotSpeakTURN(t *testing.T) {
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	client, err := net.DialTimeout("tcp", server.tcp.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	// The start of a TLS handshake, as a client sends that takes the plain
	// TCP port for the TLS one: by its first byte a STUN message, but without
	// the magic cookie.
	if _, err := client.Write([]byte{0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01, 0xfc, 0x03, 0x03}); err != nil {
		t.Fatal(err)
	}
	_ = client.SetReadDeadline(time.Now().Add(testTimeout))
	_, err = client.Read(make([]byte, 1))
	var timeout net.Error
	if err == nil || (errors.As(err, &timeout) && timeout.Timeout()) {
		t.Fatalf("the relay kept a connection that sent no TURN frame: %v", err)
	}
	eventually(t, "the connection is released", func() bool { return server.Stats().TCPConnections == 0 })
}

func TestRelayReleasesAConnectionThatSentAMalformedFrame(t *testing.T) {
	cfg := testConfig(t, 4)
	server := startRelay(t, cfg)
	bad, err := net.DialTimeout("tcp", server.tcp.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer bad.Close()
	if _, err := bad.Write([]byte{0x40, 0x00, 0xff, 0xfc, 1, 2, 3, 4, 5}); err != nil {
		t.Fatal(err)
	}
	good, err := net.DialTimeout("tcp", server.tcp.Addr().String(), testTimeout)
	if err != nil {
		t.Fatal(err)
	}
	defer good.Close()
	if !stunBinding(t, good, testTimeout) {
		t.Fatal("another client was not served while a malformed frame was pending")
	}
	eventually(t, "both connections are counted", func() bool { return server.Stats().TCPConnections == 2 })
	// The connection's read loop must end with its client; a loop that spins
	// on the frame never notices and keeps the connection slot.
	_ = bad.Close()
	eventually(t, "the malformed connection is released", func() bool { return server.Stats().TCPConnections == 1 })
}
