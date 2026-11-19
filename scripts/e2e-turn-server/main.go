// Command e2e-turn-server is a loopback TURN-over-TCP server for browser
// end-to-end tests (scripts/test-relay-rotation-e2e.js). It accepts the same
// time-limited shared-secret credentials SlowMeet issues for coturn, so a
// local SlowMeet started with TURN_SHARED_SECRET set to -secret can hand
// browsers working TURN/TCP credentials without any external service.
//
// It is a test fixture: never expose it beyond loopback.
package main

import (
	"flag"
	"fmt"
	"log"
	"net"
	"os"
	"os/signal"
	"syscall"

	"github.com/pion/logging"
	"github.com/pion/turn/v5"
)

func main() {
	address := flag.String("listen", "127.0.0.1:0", "loopback TCP address to listen on")
	secret := flag.String("secret", "", "shared secret (matches SlowMeet's TURN_SHARED_SECRET)")
	realm := flag.String("realm", "slowmeet-e2e.local", "TURN realm")
	flag.Parse()
	if *secret == "" {
		log.Fatal("-secret is required")
	}
	listener, err := net.Listen("tcp4", *address)
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	host, _, err := net.SplitHostPort(listener.Addr().String())
	if err != nil || !net.ParseIP(host).IsLoopback() {
		log.Fatalf("refusing to serve on non-loopback address %s", listener.Addr())
	}
	loggerFactory := logging.NewDefaultLoggerFactory()
	loggerFactory.DefaultLogLevel = logging.LogLevelError
	server, err := turn.NewServer(turn.ServerConfig{
		Realm:         *realm,
		AuthHandler:   turn.LongTermTURNRESTAuthHandler(*secret, loggerFactory.NewLogger("auth")),
		LoggerFactory: loggerFactory,
		ListenerConfigs: []turn.ListenerConfig{{
			Listener: listener,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP(host),
				Address:      host,
			},
		}},
	})
	if err != nil {
		log.Fatalf("start TURN server: %v", err)
	}
	// The test harness reads this line to learn the chosen port.
	fmt.Printf("turn-server listening %s\n", listener.Addr())

	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
	<-signals
	if err := server.Close(); err != nil {
		log.Printf("close: %v", err)
	}
}
