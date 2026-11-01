package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
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
