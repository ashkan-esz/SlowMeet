# SlowMeet

SlowMeet is a small, self-hosted single-meeting video call focused on usable
audio and graceful degradation on slow or unstable connections.

The current MVP provides:

- One meeting at `/`
- Browser-persisted meeting preferences and device selections
- Optional meeting password
- Up to five participants by default
- WebSocket signaling and Pion WebRTC
- SFU RTP forwarding without server-side transcoding
- Camera/microphone controls
- Per-user remote video pause/resume control
- Bandwidth profiles and automatic video degradation
- Server-side RTP bitrate/FPS ceilings that drop excess packets without buffering
- Single active screen-share lease with disconnect cleanup
- Connection recovery, diagnostics, and runtime admin limits

## Run locally

```sh
cp .env.example .env
go run .
```

Open `http://localhost:8080/`.

Run tests and build:

```sh
go test ./...
go build ./...
node scripts/test-admin.js
```

Run the local HTTP smoke test:

```sh
./scripts/smoke.sh
```

## Configuration

The complete starter configuration is in `.env.example`.

Set `MEETING_PASSWORD` to require a password at join time. Set
`ADMIN_PASSWORD` separately to enable `/admin` and protect runtime settings.
Passwords are never sent to the frontend or written to logs.
Each WebSocket connection is limited to five join attempts to bound password
guessing and repeated join retries; reconnecting clients can open a fresh
connection when needed.

Open `/admin` to use the protected operations cockpit. It shows readiness,
active participants, peer connections, reconnects, RTT, packet loss, jitter,
and current audio/video bitrate, then groups the runtime limits by capacity,
video policy, audio policy, and meeting features. The dashboard refreshes
health and metrics automatically; settings remain unchanged if a save fails.

`STUN_SERVERS` accepts a comma-separated list. For users behind restrictive
NATs or networks that block UDP, configure coturn and set `TURN_URLS` to
include UDP, TCP, and TLS/TCP transports. A typical production list is:

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:443?transport=tcp
```

Set `TURN_SHARED_SECRET` to enable short-lived browser and server credentials;
`TURN_CREDENTIAL_TTL_SECONDS` defaults to 24 hours. The shared secret must
match coturn's `static-auth-secret` when `use-auth-secret` is enabled.
`TURN_URL`, `TURN_USERNAME`, and `TURN_PASSWORD` remain supported for
server-side legacy configurations, but static credentials are not sent to
browsers.

`ICE_IPV4_ONLY=true` is the default because it avoids broken or slow IPv6
paths. Set it to `false` only after IPv6 has been tested from your target
networks.

`MAX_VIDEO_QUALITY`, `MAX_VIDEO_BITRATE`, `MAX_VIDEO_FPS`, and
`MAX_AUDIO_BITRATE` are enforced as hard ceilings. The quality ceiling limits
the browser profile resolution; bitrate and FPS ceilings are also enforced by
the SFU, which drops excess RTP immediately rather than queuing or
transcoding. The built-in profiles include `very-good` at 720p/60 FPS and
`ultra` at 1080p/30 FPS; the starter configuration permits both with a 3 Mbps
video ceiling, a 60 FPS ceiling, and a 96 kbps audio ceiling.

## Docker and Podman

Docker Compose:

```sh
cp .env.example .env
docker compose up -d --build
```

With the optional coturn profile:

```sh
docker compose --profile turn up -d --build
```

Podman through its Compose wrapper:

```sh
podman compose -f podman-compose.yml up -d --build
```

Podman Compose requires an external Compose provider to be installed and
configured. Verify it before starting the stack:

```sh
podman compose version
make podman-check
```

The Compose provider must be able to reach the Podman API socket. For a
rootless Podman installation using the default socket, start the user socket
before running the Make target:

```sh
systemctl --user enable --now podman.socket
```

Do not mix modes: use `make podman-build` with the rootless socket, or use
`sudo make podman-build` only after enabling the rootful socket with
`sudo systemctl enable --now podman.socket`.

The equivalent Make targets are `make docker-up`, `make docker-turn-up`,
`make podman-up`, and `make podman-turn-up`. The Make targets intentionally use
`podman compose` and do not auto-select the standalone `podman-compose`
executable.

The application listens on port `8080`. Health endpoints are `/health` and
`/ready`.

Frontend assets are embedded in the Go binary, so the container and systemd
service do not need a separate runtime `web/` directory.

The Compose example publishes the configured `ICE_UDP_PORT_MIN` through
`ICE_UDP_PORT_MAX` range (default `50000-50100`) for direct ICE media
connectivity. Allow that range through the VPS firewall. TURN remains
recommended for restrictive NATs and networks that block inbound UDP.

TURN is optional and can run as the Compose `turn` profile. Open its client listeners on UDP/TCP 3478 and
TLS/TCP 443, plus the coturn UDP relay range configured by `min-port` and
`max-port`. If HTTPS already uses TCP 443 on the same address, use a separate
TURN IP or TCP passthrough routing.

The optional `turn` profile expects a local copy of
`deploy/coturn/turnserver.conf.example` at `deploy/coturn/turnserver.conf` and
certificates under `deploy/coturn/certs`. These paths are ignored by Git. The
profile uses host networking so coturn can expose its full relay range without
mapping thousands of ports. Rootless Podman may need a host-level permission
change or a non-privileged TLS port for TCP 443.

The default container limits are one CPU, 256 MiB of memory, and 128 PIDs for
SlowMeet; coturn defaults to half a CPU, 128 MiB, and 128 PIDs. Override them
with the `SLOWMEET_*` and `TURN_*` variables in `.env` when hosting larger
meetings.

Disconnected participants retain their meeting slot for
`RECONNECT_TIMEOUT_SECONDS` (default: 30 seconds), allowing the same browser
session to reconnect without changing participant identity.

## HTTPS and WebSockets

Production browsers require a secure origin for camera and microphone access.
Put Caddy, Nginx, or another TLS reverse proxy in front of SlowMeet. Examples
are provided in `deploy/caddy/Caddyfile` and `deploy/nginx/slowmeet.conf`.
For a non-container installation, `deploy/systemd/slowmeet.service` provides a
least-privilege service template.

The proxy must preserve WebSocket upgrade headers and allow long-lived
connections. Configure DNS and certificates for your actual hostname before
using the examples.

For low-bandwidth validation scenarios using Linux `tc netem`, see
`docs/network-testing.md`.
The included `scripts/netem.sh` runner applies named scenarios and removes the
qdisc automatically when it exits.

`/metrics` exposes Prometheus-compatible counters and latest network samples,
including active participants, peer connections, reconnects, ICE failures, RTT,
packet loss, jitter, and reported audio/video bitrate.

## Scope

SlowMeet intentionally does not include accounts, rooms, recording, chat,
transcoding, clustering, or a database in this MVP.
