package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/httpserver"
)

func main() {
	if err := run(); err != nil {
		slog.Error("server_failed", "error", err)
		os.Exit(1)
	}
}

func run() error {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		return fmt.Errorf("invalid configuration: %w", err)
	}
	logger := httpserver.NewLogger(cfg.LogLevel)
	app := httpserver.New(cfg, logger)
	server := &http.Server{
		Addr:              cfg.HTTPAddr,
		Handler:           app,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       2 * time.Minute,
	}
	logger.Info("server_starting", "addr", cfg.HTTPAddr)

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	if err := runHTTPServer(ctx, server, app.Close); err != nil {
		return err
	}
	logger.Info("server_stopped")
	return nil
}

func runHTTPServer(ctx context.Context, server *http.Server, closeApp func()) error {
	return runHTTPServerWithServe(ctx, server, closeApp, server.ListenAndServe)
}

func runHTTPServerWithServe(ctx context.Context, server *http.Server, closeApp func(), serve func() error) error {
	serveErr := make(chan error, 1)
	go func() {
		serveErr <- serve()
	}()

	var runErr error
	serveFinished := false
	select {
	case err := <-serveErr:
		serveFinished = true
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			runErr = fmt.Errorf("HTTP server failed: %w", err)
		}
	case <-ctx.Done():
	}

	closeApp()
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdownCtx); err != nil {
		runErr = errors.Join(runErr, fmt.Errorf("HTTP server shutdown failed: %w", err))
		if closeErr := server.Close(); closeErr != nil {
			runErr = errors.Join(runErr, fmt.Errorf("HTTP server close failed: %w", closeErr))
		}
	}

	// Shutdown closes the listener; collect an error if serving stopped at the
	// same time as the shutdown signal and the select chose the context branch.
	if !serveFinished {
		err := <-serveErr
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			runErr = errors.Join(runErr, fmt.Errorf("HTTP server failed: %w", err))
		}
	}
	return runErr
}
