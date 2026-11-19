# Container deployment

SlowMeet supports Docker Compose and Podman Compose. The app listens on port
`8080`; direct WebRTC media uses the configured UDP port range (default
`50000-50100`). Allow those ports through both the host and provider firewalls.
For TURN port and relay-range details, see
[`network-testing.md`](network-testing.md#container-media-ports).

## Run a published image

Create `compose.yaml`:

```yaml
services:
  slowmeet:
    image: ${SLOWMEET_IMAGE}
    restart: unless-stopped
    env_file: .env
    ports:
      - "${HTTP_PUBLISH_ADDRESS:-127.0.0.1}:${HTTP_PUBLISH_PORT:-8080}:8080"
      - "${ICE_UDP_PORT_MIN:-50000}-${ICE_UDP_PORT_MAX:-50100}:${ICE_UDP_PORT_MIN:-50000}-${ICE_UDP_PORT_MAX:-50100}/udp"
    volumes:
      - slowmeet-data:/app/data

volumes:
  slowmeet-data:
```

Create `.env` beside it and choose a released version tag:

```dotenv
SLOWMEET_IMAGE=ghcr.io/ashkan-esz/slowmeet:<release-tag>
APP_ENV=production
HTTP_ADDR=:8080
CONFIG_FILE=data/config.json
ADMIN_PASSWORD=replace-with-a-long-random-secret
HTTP_PUBLISH_ADDRESS=127.0.0.1
HTTP_PUBLISH_PORT=8080
ICE_UDP_PORT_MIN=50000
ICE_UDP_PORT_MAX=50100
ICE_PUBLIC_IP=
STUN_SERVERS=
TURN_URLS=
TURN_USERNAME=
TURN_PASSWORD=
```

Keep `.env` private. The loopback HTTP binding is intended for a reverse proxy
on the same host; set `HTTP_PUBLISH_ADDRESS=0.0.0.0` for direct HTTP access.
Public meetings should use HTTPS. The compose file stores app data in a named
volume; `docker compose down` preserves it, while `down --volumes` deletes it.

Start and inspect the app:

```sh
docker compose up -d
docker compose ps
docker compose logs -f slowmeet
```

For Podman, use `podman compose` with the same commands and select the matching
`-podman` image tag. On SELinux hosts, add `:Z` to the data-volume mount. To
update, change the image tag, then run:

```sh
docker compose pull
docker compose up -d
```

Use the Podman equivalent when running Podman. Health checks are available at
`/health` and `/ready`.

The alternative [published-image installer](install-container-script.md)
installs Docker or Podman when needed and can manage install, update, resume,
and uninstall. It leaves firewall, proxy, and TLS setup to the operator.
On a fresh Ubuntu or Debian server, run it with:

```sh
sudo bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y ca-certificates curl && curl -fsSL https://raw.githubusercontent.com/ashkan-esz/SlowMeet/master/deploy/install-container.sh | bash'
```

## Build from source

From the repository root:

```sh
cp .env.example .env
docker compose up -d --build
```

To start the optional coturn profile, first copy
`deploy/coturn/turnserver.conf.example` to
`deploy/coturn/turnserver.conf` and provide certificates under
`deploy/coturn/certs`, then run:

```sh
docker compose --profile turn up -d --build
```

### Host networking for the SlowMeet container (optional)

On the default bridge network Docker starts one `docker-proxy` process per
published UDP port (101 for the default ICE range, roughly 100 MB on a small
VPS) and NATs every media packet. To avoid both, add the override file:

```sh
docker compose -f docker-compose.yml -f deploy/compose.host-network.yml up -d
```

To make it permanent, list the files once in `.env`:

```text
COMPOSE_FILE=docker-compose.yml:deploy/compose.host-network.yml
```

Docker Compose reads `COMPOSE_FILE` from `.env` whenever it runs in that
directory without `-f`, and `deploy/install.sh` (install, update, removal)
uses the same list, so later deploys keep the override without extra flags.
Set `ICE_PUBLIC_IP` to the host's public address so the server gathers only on
that interface.

The app then binds `HTTP_PUBLISH_ADDRESS:HTTP_PUBLISH_PORT` and the ICE UDP
range directly on the host; the host firewall must allow the UDP range, and
Docker's network isolation no longer applies to this container. See the
comments in `deploy/compose.host-network.yml`. It needs Docker Compose v2.24+.

The TURN profile uses host networking so coturn can expose its relay range.
Open its configured UDP/TCP 3478 and TLS/TCP 5349 listeners, plus its UDP relay
range. If HTTPS already uses TCP 443 on the same address, TURN over TCP 443
needs a separate IP or TCP passthrough routing.

For Podman, use `podman compose -f podman-compose.yml up -d --build`. Podman's
Compose wrapper requires a provider connected to the Podman API socket; check
it with `podman compose version` and `make podman-check`. The Makefile also offers
`make docker-up`, `make docker-turn-up`, `make podman-up`, and
`make podman-turn-up`.

The default container limits are 0.75 CPU and 256 MiB for SlowMeet, plus 0.20
CPU and 128 MiB for coturn when enabled. `.env` can raise these limits. As a
host-sizing starting estimate for up to five participants, allow 1 vCPU and
1 GiB RAM for SlowMeet alone, or 2 vCPU and 2 GiB RAM when co-hosting coturn
and the HTTPS proxy. These host estimates are not benchmarked minimums; scale
for actual media use and load. The Go binary embeds the frontend assets, so
containers and the systemd service do not need a separate runtime `web/`
directory. GHCR release images support Linux `amd64` and `arm64`. Stable
releases publish version, major/minor, major, and `latest` tags; Podman-
compatible aliases use the same tags with `-podman`. Prereleases publish only
their exact version and commit tags, with matching Podman aliases. The workflow
publishes and smoke-tests immutable version tags, verifies anonymous pulls for
both engines, then promotes stable aliases. GHCR packages start private: after
the first publication, set the package visibility to public in its package
settings and rerun the workflow if its public-pull check failed. Later releases
use the workflow's scoped `GITHUB_TOKEN` permission to publish new versions.

To publish manually, authenticate both engines to GHCR first, then pass the
release tag from a clean checkout of that exact Git tag. The release targets
validate the tag, build for both supported architectures, and publish the same
release and alias tags as the workflow. Docker publishing requires Buildx;
Podman publishing may require QEMU/binfmt support for foreign-architecture
build steps.

```sh
docker login ghcr.io
podman login ghcr.io
make image-publish RELEASE_TAG=v1.2.3
```

Use `make image-publish-docker` or `make image-publish-podman` to publish one
engine's tags. The targets record the current Git commit and UTC build time.
Ensure the GHCR package is public in its package settings for anonymous pulls.
