SHELL := /bin/sh

APP_NAME ?= slowmeet
GO ?= go
NODE ?= node
COMPOSE ?= docker compose
DOCKER_COMPOSE ?= docker compose -f docker-compose.yml
PODMAN_COMPOSE ?= podman compose -f podman-compose.yml

.PHONY: help run build test vet fmt fmt-check tidy \
	test-js test-admin test-protocol test-adaptation test-layout smoke \
	check docker-build docker-up docker-turn-up docker-down docker-logs \
	podman-check podman-build podman-up podman-turn-up podman-down podman-logs \
	container-config

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
	$(DOCKER_COMPOSE) build

docker-up: ## Build and start the Compose stack
	$(DOCKER_COMPOSE) up -d --build

docker-turn-up: ## Build and start Docker Compose with coturn
	$(DOCKER_COMPOSE) --profile turn up -d --build

docker-down: ## Stop the Compose stack
	$(DOCKER_COMPOSE) down

docker-logs: ## Follow Compose service logs
	$(DOCKER_COMPOSE) logs -f

podman-check: ## Verify Podman Compose is available
	@command -v podman >/dev/null 2>&1 || { \
		echo "Podman is required but was not found in PATH."; \
		exit 1; \
	}
	@$(PODMAN_COMPOSE) version || { \
		status=$$?; \
		echo "Podman Compose preflight failed. Check the Podman runtime and Compose provider."; \
		echo "Retry with: $(PODMAN_COMPOSE) version"; \
		exit $$status; \
	}
	@$(PODMAN_COMPOSE) ps --all >/dev/null || { \
		status=$$?; \
		echo "Podman Compose cannot reach the Podman API socket."; \
		if [ "$$(id -u)" -eq 0 ]; then \
			echo "For rootful Podman, start it with: systemctl enable --now podman.socket"; \
		else \
			echo "For rootless Podman, start it with: systemctl --user enable --now podman.socket"; \
		fi; \
		exit $$status; \
	}

podman-build podman-up podman-turn-up podman-down podman-logs: podman-check

podman-build: ## Build the Podman image
	$(PODMAN_COMPOSE) build

podman-up: ## Build and start the Podman Compose stack
	$(PODMAN_COMPOSE) up -d --build

podman-turn-up: ## Build and start Podman Compose with coturn
	$(PODMAN_COMPOSE) --profile turn up -d --build

podman-down: ## Stop the Podman Compose stack
	$(PODMAN_COMPOSE) down

podman-logs: ## Follow Podman Compose service logs
	$(PODMAN_COMPOSE) logs -f

container-config: podman-check ## Validate Docker and Podman Compose manifests
	$(DOCKER_COMPOSE) config --quiet
	$(DOCKER_COMPOSE) --profile turn config --quiet
	$(PODMAN_COMPOSE) config --quiet
	$(PODMAN_COMPOSE) --profile turn config --quiet
