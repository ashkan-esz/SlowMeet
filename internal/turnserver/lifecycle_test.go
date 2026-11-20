package turnserver

import (
	"bytes"
	"crypto/tls"
	"errors"
	"net"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"

	"SlowMeet/internal/config"
)

// channelDataFrame is payload as a TURN ChannelData frame: channel number,
// length, the payload, and padding to a multiple of four.
func channelDataFrame(payload []byte) []byte {
	frame := []byte{0x40, 0x00, byte(len(payload) >> 8), byte(len(payload))}
	frame = append(frame, payload...)
	for len(frame)%4 != 0 {
		frame = append(frame, 0)
	}
	return frame
}

func TestFramedConnPassesRelayedMediaUntouched(t *testing.T) {
	// What a browser sends the SFU through a relay: ICE checks, the DTLS
	// handshake, and RTP. None of it may be mistaken for a malformed frame.
	dtls := append([]byte{0x16, 0xfe, 0xfd, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x30}, make([]byte, 0x30)...)
	rtp := append([]byte{0x80, 0x6f, 0x12, 0x34, 0, 0, 0x03, 0xc0, 0xde, 0xad, 0xbe, 0xef}, make([]byte, 1188)...)
	tests := []struct {
		name    string
		payload []byte
	}{
		{"an ICE connectivity check", stunBindingRequest},
		{"a DTLS record", dtls},
		{"an RTP packet", rtp},
		{"a payload that needs padding", []byte{0x80, 1, 2, 3, 4}},
	}
	framed, client := framedPipe(t)
	go func() {
		for _, test := range tests {
			if _, err := client.Write(channelDataFrame(test.payload)); err != nil {
				return
			}
		}
	}()
	for _, test := range tests {
		if got, want := readFrame(t, framed), channelDataFrame(test.payload); !bytes.Equal(got, want) {
			t.Fatalf("%s arrived as %d bytes (% x...), want the %d-byte frame unchanged",
				test.name, len(got), got[:min(len(got), 8)], len(want))
		}
	}
}

func TestFramedConnReturnsAFrameAcrossSmallReads(t *testing.T) {
	framed, client := framedPipe(t)
	go func() { _, _ = client.Write(stunBindingRequest) }()
	if err := framed.SetReadDeadline(time.Now().Add(testTimeout)); err != nil {
		t.Fatal(err)
	}
	var got []byte
	buffer := make([]byte, 8)
	for len(got) < len(stunBindingRequest) {
		n, err := framed.Read(buffer)
		if err != nil {
			t.Fatalf("Read() error = %v after %d bytes", err, len(got))
		}
		if n == 0 {
			t.Fatal("Read() returned no bytes and no error")
		}
		got = append(got, buffer[:n]...)
	}
	if !bytes.Equal(got, stunBindingRequest) {
		t.Fatalf("frame read in pieces = % x, want the STUN message", got)
	}
}

func TestWarningGateLetsOneWarningThroughPerInterval(t *testing.T) {
	var gate warningGate
	now := time.Unix(1_000_000, 0)
	var passed atomic.Int32
	var group sync.WaitGroup
	for range 50 {
		group.Add(1)
		go func() {
			defer group.Done()
			if gate.open(now) {
				passed.Add(1)
			}
		}()
	}
	group.Wait()
	if got := passed.Load(); got != 1 {
		t.Fatalf("%d of 50 concurrent warnings passed, want 1", got)
	}
	if gate.open(now.Add(repeatedWarningInterval - time.Second)) {
		t.Fatal("a second warning passed inside the interval")
	}
	if !gate.open(now.Add(repeatedWarningInterval)) {
		t.Fatal("no warning passed once the interval was over")
	}
}

func TestStartListensOnlyOnTheConfiguredAddress(t *testing.T) {
	// TURN_SERVER_LISTEN_IP keeps the relay off the other addresses of a
	// host, for example so that an HTTPS proxy can have their port 443.
	cfg := withTLSListener(t, testConfig(t, 4))
	cfg.TURNServerPort = freeTURNPort(t)
	cfg.TURNServerListenIP = "127.0.0.1"
	server, err := Start(cfg, quietLogger())
	if err != nil {
		t.Fatalf("Start() error = %v", err)
	}
	defer server.Close()
	if len(server.udp) != 1 {
		t.Fatalf("the relay listens on %d UDP sockets, want the one configured address", len(server.udp))
	}
	for name, address := range map[string]net.Addr{
		"UDP": server.udp[0].LocalAddr(), "TCP": server.tcp.Addr(), "TLS": server.tls.Addr(),
	} {
		host, _, err := net.SplitHostPort(address.String())
		if err != nil || host != "127.0.0.1" {
			t.Errorf("the %s listener is on %s, want 127.0.0.1", name, address)
		}
	}
}

// withTLSListener returns cfg with TURN over TLS on a free port and a
// certificate on disk.
func withTLSListener(t *testing.T, cfg config.Config) config.Config {
	t.Helper()
	cfg.TURNServerTLSPort = freeTCPPort(t)
	cfg.TURNServerTLSCertFile, cfg.TURNServerTLSKeyFile = writeCertificate(t, t.TempDir(), "relay.test")
	return cfg
}

// dialStream connects to the relay's TCP or TLS listener.
func dialStream(t *testing.T, server *Server, transport string) net.Conn {
	t.Helper()
	dialer := &net.Dialer{Timeout: testTimeout}
	var (
		conn net.Conn
		err  error
	)
	switch transport {
	case "tcp":
		conn, err = dialer.Dial("tcp", server.tcp.Addr().String())
	case "tls":
		conn, err = tls.DialWithDialer(dialer, "tcp", server.tls.Addr().String(), &tls.Config{InsecureSkipVerify: true})
	default:
		t.Fatalf("unknown stream transport %q", transport)
	}
	if err != nil {
		t.Fatalf("connect to the relay over %s: %v", transport, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// streamTURNClient is a TURN client over tcp or tls together with the
// connection under it, so a test can drop the connection the way a client
// that vanished does: without releasing its allocation first.
func streamTURNClient(t *testing.T, server *Server, transport, username, password string) (*turn.Client, net.Conn) {
	t.Helper()
	stream := dialStream(t, server, transport)
	loggers := logging.NewDefaultLoggerFactory()
	loggers.DefaultLogLevel = logging.LogLevelDisabled
	address := stream.RemoteAddr().String()
	client, err := turn.NewClient(&turn.ClientConfig{
		STUNServerAddr: address,
		TURNServerAddr: address,
		Conn:           turn.NewSTUNConn(stream),
		Username:       username,
		Password:       password,
		Realm:          testRealm,
		LoggerFactory:  loggers,
	})
	if err != nil {
		t.Fatalf("create TURN client: %v", err)
	}
	t.Cleanup(client.Close)
	if err := client.Listen(); err != nil {
		t.Fatalf("start TURN client: %v", err)
	}
	return client, stream
}

func TestDroppedStreamConnectionReleasesItsAllocation(t *testing.T) {
	// A browser that loses its network never says goodbye. Its relay port must
	// come back with the connection, not when the allocation would have
	// expired: on a rotating method every participant holds several.
	for _, transport := range []string{"tcp", "tls"} {
		t.Run(transport, func(t *testing.T) {
			cfg := testConfig(t, 1)
			if transport == "tls" {
				cfg = withTLSListener(t, cfg)
			}
			server := startRelay(t, cfg)
			username, password := browserCredentials(t, cfg)

			client, stream := streamTURNClient(t, server, transport, username, password)
			if _, err := client.Allocate(); err != nil {
				t.Fatalf("allocate over %s: %v", transport, err)
			}
			if got := server.AllocationCount(); got != 1 {
				t.Fatalf("AllocationCount() = %d, want 1", got)
			}

			_ = stream.Close()
			eventually(t, "the dropped client's allocation is gone", func() bool {
				return server.AllocationCount() == 0
			})
			// The range has one port: only a released one can be allocated.
			relay, err := newTURNClient(t, server, transport, username, password).Allocate()
			if err != nil {
				t.Fatalf("allocate after another client dropped its connection: %v", err)
			}
			_ = relay.Close()
		})
	}
}

func TestCloseWhileClientsRelayMedia(t *testing.T) {
	// The ordinary stop: a restart or an upgrade in the middle of a meeting,
	// with media crossing the relay and connections that carry nothing yet.
	for _, transport := range []string{"udp", "tcp", "tls"} {
		t.Run(transport, func(t *testing.T) {
			cfg := withTLSListener(t, testConfig(t, 4))
			sfu := sfuSocket(t, cfg)
			server := startRelay(t, cfg)
			username, password := browserCredentials(t, cfg)

			relay, err := newTURNClient(t, server, transport, username, password).Allocate()
			if err != nil {
				t.Fatalf("allocate over %s: %v", transport, err)
			}
			relayAddress := relay.LocalAddr().String()
			if _, err := relay.WriteTo([]byte("media"), sfu.LocalAddr()); err != nil {
				t.Fatalf("send through the relay: %v", err)
			}
			if payload, _ := readDatagram(t, sfu); payload != "media" {
				t.Fatalf("the SFU received %q, want the relayed datagram", payload)
			}
			silentTCP := dialStream(t, server, "tcp")
			silentTLS := dialStream(t, server, "tls")

			stop := make(chan struct{})
			var senders sync.WaitGroup
			senders.Add(1)
			go func() {
				defer senders.Done()
				for {
					select {
					case <-stop:
						return
					default:
					}
					// Errors are expected once the relay is closing.
					_, _ = relay.WriteTo([]byte("media"), sfu.LocalAddr())
					time.Sleep(time.Millisecond)
				}
			}()
			time.Sleep(50 * time.Millisecond)

			closed := make(chan error, 1)
			go func() { closed <- server.Close() }()
			select {
			case err := <-closed:
				if err != nil {
					t.Errorf("Close() error = %v", err)
				}
			case <-time.After(testTimeout):
				t.Error("Close() did not return while media was being relayed")
			}
			close(stop)
			senders.Wait()

			eventually(t, "no allocation is left", func() bool { return server.AllocationCount() == 0 })
			eventually(t, "the relay socket is closed", func() bool {
				conn, err := net.ListenPacket("udp4", relayAddress)
				if err != nil {
					return false
				}
				return conn.Close() == nil
			})
			for name, conn := range map[string]net.Conn{"TCP": silentTCP, "TLS": silentTLS} {
				_ = conn.SetReadDeadline(time.Now().Add(testTimeout))
				_, err := conn.Read(make([]byte, 1))
				var timeout net.Error
				if err == nil || (errors.As(err, &timeout) && timeout.Timeout()) {
					t.Errorf("a silent TURN-over-%s connection stayed open after Close: %v", name, err)
				}
			}
			if stats := server.Stats(); stats.TCPConnections != 0 || stats.TLSConnections != 0 {
				t.Errorf("Stats() after Close = %+v, want no stream connections", stats)
			}
		})
	}
}
