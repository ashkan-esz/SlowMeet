package main

import (
	"bytes"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMainExitsNonzeroOnListenFailure(t *testing.T) {
	if os.Getenv("SLOWMEET_MAIN_CHILD") == "1" {
		main()
		return
	}

	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	env := make([]string, 0, len(os.Environ())+3)
	for _, value := range os.Environ() {
		if len(value) >= len("HTTP_ADDR=") && value[:len("HTTP_ADDR=")] == "HTTP_ADDR=" {
			continue
		}
		if len(value) >= len("CONFIG_FILE=") && value[:len("CONFIG_FILE=")] == "CONFIG_FILE=" {
			continue
		}
		if len(value) >= len("SLOWMEET_MAIN_CHILD=") && value[:len("SLOWMEET_MAIN_CHILD=")] == "SLOWMEET_MAIN_CHILD=" {
			continue
		}
		env = append(env, value)
	}
	env = append(env,
		"SLOWMEET_MAIN_CHILD=1",
		"HTTP_ADDR="+listener.Addr().String(),
		"CONFIG_FILE="+filepath.Join(t.TempDir(), "config.json"),
	)
	cmd := exec.Command(os.Args[0], "-test.run=^TestMainExitsNonzeroOnListenFailure$")
	cmd.Env = env
	if err := cmd.Run(); err == nil {
		t.Fatal("process exited successfully despite the occupied HTTP address")
	} else {
		var exitErr *exec.ExitError
		if !errors.As(err, &exitErr) {
			t.Fatalf("child process failed to run: %v", err)
		}
		if exitErr.ExitCode() != 1 {
			t.Fatalf("child exit code = %d, want 1", exitErr.ExitCode())
		}
	}
}

// relayChildEnv is the environment for a child process running main() with
// the built-in TURN relay enabled on turnPort. Variables it sets replace any
// inherited ones; the relay's "SFU" is loopback so no network is needed.
func relayChildEnv(t *testing.T, testName, httpAddr string, turnPort int) []string {
	t.Helper()
	overrides := map[string]string{
		"SLOWMEET_MAIN_CHILD":         testName,
		"HTTP_ADDR":                   httpAddr,
		"CONFIG_FILE":                 filepath.Join(t.TempDir(), "config.json"),
		"TURN_SERVER_ENABLED":         "true",
		"TURN_SERVER_PORT":            strconv.Itoa(turnPort),
		"TURN_SERVER_TLS_PORT":        "0",
		"TURN_SERVER_TLS_CERT_FILE":   "",
		"TURN_SERVER_TLS_KEY_FILE":    "",
		"TURN_SERVER_REALM":           "",
		"TURN_SERVER_RELAY_PORT_MIN":  "",
		"TURN_SERVER_RELAY_PORT_MAX":  "",
		"TURN_SERVER_RELAY_IP":        "",
		"TURN_SHARED_SECRET":          "main-test-secret",
		"TURN_CREDENTIAL_TTL_SECONDS": "",
		"TURN_URLS":                   "turn:127.0.0.1:" + strconv.Itoa(turnPort) + "?transport=udp",
		"TURN_URL":                    "",
		"ICE_PUBLIC_IP":               "127.0.0.1",
		"ICE_UDP_PORT_MIN":            "",
		"ICE_UDP_PORT_MAX":            "",
		"ICE_TRANSPORT_POLICY":        "",
	}
	env := make([]string, 0, len(os.Environ())+len(overrides))
	for _, value := range os.Environ() {
		key, _, _ := strings.Cut(value, "=")
		if _, overridden := overrides[key]; !overridden {
			env = append(env, value)
		}
	}
	for key, value := range overrides {
		env = append(env, key+"="+value)
	}
	return env
}

// freeTURNPort returns a port free for TCP and UDP on every address, which is
// how the relay binds.
func freeTURNPort(t *testing.T) int {
	t.Helper()
	for range 50 {
		listener, err := net.Listen("tcp", ":0")
		if err != nil {
			t.Fatal(err)
		}
		port := listener.Addr().(*net.TCPAddr).Port
		listener.Close()
		// A wildcard UDP bind fails if any single address holds the port.
		conn, err := net.ListenPacket("udp", net.JoinHostPort("", strconv.Itoa(port)))
		if err != nil {
			continue
		}
		conn.Close()
		return port
	}
	t.Fatal("no port is free for both TCP and UDP on every address")
	return 0
}

func TestMainExitsNonzeroWhenTheRelayPortIsTaken(t *testing.T) {
	const name = "TestMainExitsNonzeroWhenTheRelayPortIsTaken"
	if os.Getenv("SLOWMEET_MAIN_CHILD") == name {
		main()
		return
	}

	// Another TURN server (or a leftover coturn container) holds the port.
	occupied, err := net.Listen("tcp", ":0")
	if err != nil {
		t.Fatal(err)
	}
	defer occupied.Close()
	turnPort := occupied.Addr().(*net.TCPAddr).Port

	cmd := exec.Command(os.Args[0], "-test.run=^"+name+"$")
	cmd.Env = relayChildEnv(t, name, "127.0.0.1:0", turnPort)
	output, err := cmd.CombinedOutput()
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) {
		t.Fatalf("process did not fail although the TURN port is taken: err=%v\n%s", err, output)
	}
	if exitErr.ExitCode() != 1 {
		t.Fatalf("child exit code = %d, want 1\n%s", exitErr.ExitCode(), output)
	}
	if !strings.Contains(string(output), "start TURN relay") {
		t.Fatalf("the failure must name the TURN relay:\n%s", output)
	}
	if strings.Contains(string(output), "main-test-secret") {
		t.Fatalf("the shared secret must not be logged:\n%s", output)
	}
}

func TestMainServesTheBuiltInRelayAndStopsCleanly(t *testing.T) {
	const name = "TestMainServesTheBuiltInRelayAndStopsCleanly"
	if os.Getenv("SLOWMEET_MAIN_CHILD") == name {
		main()
		return
	}

	turnPort := freeTURNPort(t)
	httpListener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	httpAddr := httpListener.Addr().String()
	httpListener.Close()

	cmd := exec.Command(os.Args[0], "-test.run=^"+name+"$")
	cmd.Env = relayChildEnv(t, name, httpAddr, turnPort)
	var output bytes.Buffer
	cmd.Stdout, cmd.Stderr = &output, &output
	if err := cmd.Start(); err != nil {
		t.Fatalf("start child: %v", err)
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	defer cmd.Process.Kill()

	turnAddr := net.JoinHostPort("127.0.0.1", strconv.Itoa(turnPort))
	waitForTCP := func(what, address string) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for {
			connection, dialErr := net.DialTimeout("tcp4", address, 200*time.Millisecond)
			if dialErr == nil {
				connection.Close()
				return
			}
			select {
			case waitErr := <-exited:
				t.Fatalf("child exited before %s was reachable: %v\n%s", what, waitErr, output.String())
			default:
			}
			if time.Now().After(deadline) {
				t.Fatalf("%s never became reachable: %v\n%s", what, dialErr, output.String())
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	waitForTCP("the TURN relay", turnAddr)
	waitForTCP("the HTTP server", httpAddr)

	// The running relay is visible to an operator.
	response, err := (&http.Client{Timeout: 5 * time.Second}).Get("http://" + httpAddr + "/metrics")
	if err != nil {
		t.Fatalf("fetch metrics: %v\n%s", err, output.String())
	}
	metrics, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil || !strings.Contains(string(metrics), "slowmeet_turn_allocations 0\n") {
		t.Fatalf("metrics do not report the relay's allocations (%v):\n%s", err, metrics)
	}

	if err := cmd.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("signal child: %v", err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("child did not stop cleanly: %v\n%s", err, output.String())
		}
	case <-time.After(15 * time.Second):
		t.Fatalf("child did not stop after SIGTERM\n%s", output.String())
	}
	logs := output.String()
	for _, want := range []string{"turn_server_started", "turn_server_stopped", "server_stopped"} {
		if !strings.Contains(logs, want) {
			t.Fatalf("child logs lack %q:\n%s", want, logs)
		}
	}
}

func TestRunHTTPServerReturnsListenErrorAndClosesApp(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()

	server := &http.Server{Addr: listener.Addr().String()}
	closed := false
	err = runHTTPServer(context.Background(), server, func() { closed = true })
	if !errors.Is(err, syscall.EADDRINUSE) {
		t.Fatalf("runHTTPServer() error = %v, want address-in-use error", err)
	}
	if !closed {
		t.Fatal("application cleanup was not called after listen failure")
	}
}

func TestRunHTTPServerShutdownReleasesListener(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	closed := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- runHTTPServerWithServe(ctx, server, func() { close(closed) }, func() error {
			return server.Serve(listener)
		})
	}()

	client := &http.Client{Timeout: 100 * time.Millisecond}
	deadline := time.Now().Add(2 * time.Second)
	for {
		response, requestErr := client.Get("http://" + address)
		if requestErr == nil {
			response.Body.Close()
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("server did not start listening: %v", requestErr)
		}
		time.Sleep(10 * time.Millisecond)
	}

	cancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runHTTPServerWithServe() error = %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("server shutdown did not finish")
	}
	select {
	case <-closed:
	default:
		t.Fatal("application cleanup was not called")
	}

	connection, err := net.DialTimeout("tcp4", address, 100*time.Millisecond)
	if err == nil {
		connection.Close()
		t.Fatal("listener still accepts connections after shutdown")
	}
}
