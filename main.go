package main

import (
	"log/slog"
	"net/http"

	"SlowMeet/internal/config"
	"SlowMeet/internal/httpserver"
)

func main() {
	cfg, err := config.LoadFromEnv()
	if err != nil {
		slog.Error("invalid configuration", "error", err)
		return
	}
	logger := httpserver.NewLogger(cfg.LogLevel)
	logger.Info("server_starting", "addr", cfg.HTTPAddr)
	if err := http.ListenAndServe(cfg.HTTPAddr, httpserver.New(cfg, logger)); err != nil {
		logger.Error("server_stopped", "error", err)
	}
}
