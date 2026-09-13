SHELL := /bin/sh

APP_NAME ?= slowmeet
GO ?= go
NODE ?= node
COMPOSE ?= docker compose

.PHONY: help run build test vet fmt fmt-check tidy \
	test-js test-admin test-protocol test-adaptation test-layout smoke \
	check docker-build docker-up docker-down docker-logs

help: ## Show available commands
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z0-9_.-]+:.*##/ {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

run: ## Run the service locally
	$(GO) run .

build: ## Build the application binary
	$(GO) build -trimpath -o $(APP_NAME) .

test: ## Run all Go tests
	$(GO) test ./...

vet: ## Run Go vet
	$(GO) vet ./...

fmt: ## Format Go source files
	$(GO) fmt ./...

fmt-check: ## Fail if Go source files need formatting
	@test -z "$$($(GO)fmt -l .)" || { \
		echo "Go files need formatting:"; \
		$(GO)fmt -l .; \
		exit 1; \
	}

tidy: ## Synchronize Go module dependencies
	$(GO) mod tidy

test-js: ## Run all JavaScript checks
	$(MAKE) test-admin test-protocol test-adaptation test-layout

test-admin: ## Test the admin dashboard
	$(NODE) scripts/test-admin.js

test-protocol: ## Test the signaling protocol
	$(NODE) scripts/test-protocol.js

test-adaptation: ## Test media adaptation behavior
	$(NODE) scripts/test-adaptation.js

test-layout: ## Test responsive meeting layout behavior
	$(NODE) scripts/test-meeting-layout.js

smoke: ## Run the local HTTP smoke test
	./scripts/smoke.sh

check: fmt-check test vet build test-js ## Run formatting, Go, JavaScript, and smoke-independent checks

docker-build: ## Build the container image
	$(COMPOSE) build

docker-up: ## Build and start the Compose stack
	$(COMPOSE) up -d --build

docker-down: ## Stop the Compose stack
	$(COMPOSE) down

docker-logs: ## Follow Compose service logs
	$(COMPOSE) logs -f
