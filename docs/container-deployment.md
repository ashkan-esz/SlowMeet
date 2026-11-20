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

The image includes the TURN relay. To use it, add `TURN_SERVER_ENABLED=true`,
`TURN_SHARED_SECRET`, and `TURN_URLS` naming your host to `.env`, and publish
the relay's listen ports in `compose.yaml` (`"3478:3478/udp"`,
`"3478:3478/tcp"`, and `"5349:5349/tcp"` when you mount a certificate for TURN
over TLS). See the
[configuration guide](configuration.md#built-in-turn-relay) for the settings.

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

### Built-in TURN relay (optional)

SlowMeet relays TURN itself. Set `TURN_SHARED_SECRET` and `TURN_URLS` in
`.env` (see the [configuration guide](configuration.md#built-in-turn-relay)),
then add the relay's override file:

```sh
docker compose -f docker-compose.yml -f deploy/compose.turn.yml up -d --build
```

The override turns the relay on, publishes its listen ports (UDP and TCP 3478,
TCP 5349), and mounts `TURN_CERT_DIR` (default `deploy/turn-certs`) for TURN
over TLS. Put `fullchain.pem` and `privkey.pem` there, readable by the
container user (`10001:10001`); renewed files are picked up without a restart.
`deploy/` is left out of the image build context (`.dockerignore`,
`.containerignore`), so the key is never sent to a build.
Without a certificate, TURN over UDP and TCP still work. Allow the three listen
ports in the host and provider firewalls. The relay port range
(`49152-49999`) is not published and needs no firewall rule: only the SFU in
the same container sends to it.

To keep the override for every later command, list it once in `.env`:

```text
COMPOSE_FILE=docker-compose.yml:deploy/compose.turn.yml
```

#### Moving from the coturn profile

Earlier versions ran coturn as a Compose profile (`--profile turn`). That
service is gone. `deploy/install.sh` moves an installation it manages when you
update it; for a deployment you manage by hand:

1. Remove the old container, which still holds the TURN ports:
   `docker rm -f "$(docker ps -aq --filter label=com.docker.compose.service=coturn)"`.
2. Keep `TURN_URLS` and `TURN_SHARED_SECRET` as they are: the relay accepts
   the same credentials on the same ports. If `turnserver.conf` used other
   listen ports, set `TURN_SERVER_PORT` and `TURN_SERVER_TLS_PORT` to match.
3. Make the certificate files readable by the container user, for example
   `chown -R 10001:10001 deploy/coturn/certs`, or move them to
   `deploy/turn-certs` and update `TURN_CERT_DIR`.
4. Give the app container the memory coturn had: raise
   `SLOWMEET_MEMORY_LIMIT` and `SLOWMEET_GOMEMLIMIT`. The relay also shares
   `SLOWMEET_CPUS`; raise it if relayed calls are throttled.
5. Start with the override file as shown above.
6. Once the relay works, delete `turnserver.conf` (it holds the shared secret) and the unused
   `TURN_CONFIG_FILE`, `TURN_CPUS`, `TURN_MEMORY_LIMIT`, and `TURN_PIDS_LIMIT`
   lines in `.env`. The firewall rule for the relay port range is no longer
   needed.

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

With host networking and the TURN relay together, list the relay override
first, so the host-network override drops the ports it publishes and the relay
binds them on the host itself:

```text
COMPOSE_FILE=docker-compose.yml:deploy/compose.turn.yml:deploy/compose.host-network.yml
```

Open UDP/TCP 3478 and TCP 5349 in the host firewall. If HTTPS already uses TCP
443 on the same address, TURN over TLS on 443 needs a separate IP or TCP
passthrough (SNI) routing to port 5349.

For Podman, use `podman compose -f podman-compose.yml up -d --build`, adding
`-f deploy/podman-compose.turn.yml` for the TURN relay. Podman's
Compose wrapper requires a provider connected to the Podman API socket; check
it with `podman compose version` and `make podman-check`. The Makefile also offers
`make docker-up`, `make docker-turn-up`, `make podman-up`, and
`make podman-turn-up`.

When `podman-compose` is that provider, `up -d` starts the existing container
again unless the Compose configuration changed, so a rebuilt image alone does
not replace it. After pulling a newer checkout, run `down` (it keeps the data
volume) before `up -d --build`. `deploy/install.sh` does the same when it
updates a Podman installation: it builds first, then removes and starts the
containers.

The default container limits are 0.75 CPU and 256 MiB for SlowMeet. The TURN
relay runs inside the same container and shares them. With it enabled, raise
`SLOWMEET_MEMORY_LIMIT` and `SLOWMEET_GOMEMLIMIT` in `.env` (the installer
uses 384m and 300MiB); the CPU limit stays at 0.75 unless you raise
`SLOWMEET_CPUS` yourself. As a
host-sizing starting estimate for up to five participants, allow 1 vCPU and
1 GiB RAM for SlowMeet alone, or 2 vCPU and 2 GiB RAM when it also relays TURN
and co-hosts the HTTPS proxy. These host estimates are not benchmarked minimums; scale
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
