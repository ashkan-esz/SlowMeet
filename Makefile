SHELL := /bin/sh

APP_NAME ?= slowmeet
CONTAINER_IMAGE ?= slowmeet
IMAGE_TAG ?= dev
VERSION ?= dev
VCS_REF ?= local
BUILD_DATE ?= unknown
RELEASE_IMAGE ?= ghcr.io/ashkan-esz/slowmeet
RELEASE_TAG ?=
RELEASE_VERSION = $(patsubst v%,%,$(RELEASE_TAG))
RELEASE_VCS_REF ?= $(shell git rev-parse HEAD)
RELEASE_BUILD_DATE ?= $(shell date -u +%Y-%m-%dT%H:%M:%SZ)
RELEASE_PLATFORMS ?= linux/amd64,linux/arm64
GO ?= go
NODE ?= node
COMPOSE ?= docker compose
DOCKER_COMPOSE ?= docker compose -f docker-compose.yml
PODMAN_COMPOSE ?= podman compose -f podman-compose.yml

.PHONY: help run build test vet fmt fmt-check tidy \
	test-js test-admin test-protocol test-adaptation test-layout smoke \
	check docker-build docker-up docker-turn-up docker-down docker-logs \
	podman-check podman-build podman-up podman-turn-up podman-down podman-logs \
	container-config container-parity image-build image-build-podman image-check release-preflight \
	image-publish image-publish-docker image-publish-podman

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

container-parity: ## Verify Docker and Podman build definitions stay synchronized
	@cmp -s Dockerfile Containerfile || { \
		echo "Dockerfile and Containerfile differ."; \
		exit 1; \
	}

image-build: ## Build a versioned Docker image directly
	docker build --file Dockerfile --tag $(CONTAINER_IMAGE):$(IMAGE_TAG) \
		--build-arg VERSION=$(VERSION) \
		--build-arg VCS_REF=$(VCS_REF) \
		--build-arg BUILD_DATE=$(BUILD_DATE) .

image-build-podman: ## Build a versioned Podman image directly
	podman build --format docker --file Containerfile --tag $(CONTAINER_IMAGE):$(IMAGE_TAG)-podman \
		--build-arg VERSION=$(VERSION) \
		--build-arg VCS_REF=$(VCS_REF) \
		--build-arg BUILD_DATE=$(BUILD_DATE) .

image-check: container-parity image-build image-build-podman ## Build both local container variants

release-preflight: container-parity ## Validate a clean checkout at the requested release tag
	@test -n "$(RELEASE_TAG)" || { echo "Set RELEASE_TAG to a release tag, for example v1.2.3."; exit 2; }
	@scripts/release-tags.sh "$(RELEASE_TAG)" docker "$(RELEASE_IMAGE)" "$(RELEASE_VCS_REF)" >/dev/null
	@set -eu; \
	tag_commit="$$(git rev-parse --verify "refs/tags/$(RELEASE_TAG)^{commit}" 2>/dev/null)" || { \
		echo "RELEASE_TAG=$(RELEASE_TAG) must exist in the local Git checkout."; \
		exit 2; \
	}; \
	if [ "$$tag_commit" != "$$(git rev-parse HEAD)" ]; then \
		echo "HEAD must be checked out at RELEASE_TAG=$(RELEASE_TAG)."; \
		exit 2; \
	fi
	@test -z "$$(git status --porcelain)" || { \
		echo "The working tree must be clean before publishing release images."; \
		exit 2; \
	}

image-publish-docker: release-preflight ## Build and publish Docker release tags to GHCR
	@set -eu; \
	tags="$$(scripts/release-tags.sh "$(RELEASE_TAG)" docker "$(RELEASE_IMAGE)" "$(RELEASE_VCS_REF)")"; \
	set --; \
	for tag in $$tags; do set -- "$$@" --tag "$$tag"; done; \
	docker buildx build --platform "$(RELEASE_PLATFORMS)" --file Dockerfile \
		--build-arg VERSION="$(RELEASE_VERSION)" \
		--build-arg VCS_REF="$(RELEASE_VCS_REF)" \
		--build-arg BUILD_DATE="$(RELEASE_BUILD_DATE)" \
		"$$@" --push .

image-publish-podman: release-preflight ## Build and publish Podman release tags to GHCR
	@command -v podman >/dev/null 2>&1 || { echo "Podman is required but was not found in PATH."; exit 1; }
	@set -eu; \
	manifest="localhost/slowmeet:release-$(RELEASE_VERSION)"; \
	trap 'podman manifest rm "$$manifest" >/dev/null 2>&1 || true' EXIT HUP INT TERM; \
	tags="$$(scripts/release-tags.sh "$(RELEASE_TAG)" podman "$(RELEASE_IMAGE)" "$(RELEASE_VCS_REF)")"; \
	podman manifest rm "$$manifest" >/dev/null 2>&1 || true; \
	podman build --format docker --platform "$(RELEASE_PLATFORMS)" \
		--manifest "$$manifest" --file Containerfile \
		--build-arg VERSION="$(RELEASE_VERSION)" \
		--build-arg VCS_REF="$(RELEASE_VCS_REF)" \
		--build-arg BUILD_DATE="$(RELEASE_BUILD_DATE)" .; \
	for tag in $$tags; do podman manifest push --all "$$manifest" "docker://$$tag"; done

image-publish: image-publish-docker image-publish-podman ## Build and publish Docker and Podman release tags to GHCR
