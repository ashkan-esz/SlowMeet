# LowMeet

LowMeet is a small, self-hosted single-meeting video call focused on usable
audio and graceful degradation on slow or unstable connections.

The current MVP provides:

- One meeting at `/`
- Browser-persisted display name
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
NATs, configure a coturn deployment and set `TURN_URL`, `TURN_USERNAME`, and
`TURN_PASSWORD` as appropriate.

`MAX_VIDEO_QUALITY`, `MAX_VIDEO_BITRATE`, `MAX_VIDEO_FPS`, and
`MAX_AUDIO_BITRATE` are enforced as hard ceilings. The quality ceiling limits
the browser profile resolution; bitrate and FPS ceilings are also enforced by
the SFU, which drops excess RTP immediately rather than queuing or
transcoding.

## Docker

```sh
cp .env.example .env
docker compose up -d --build
```

The application listens on port `8080`. Health endpoints are `/health` and
`/ready`.

Frontend assets are embedded in the Go binary, so the container and systemd
service do not need a separate runtime `web/` directory.

The Compose example publishes the configured `ICE_UDP_PORT_MIN` through
`ICE_UDP_PORT_MAX` range (default `50000-50100`) for direct ICE media
connectivity. Allow that range through the VPS firewall. TURN remains
recommended for restrictive NATs and networks that block inbound UDP.

Disconnected participants retain their meeting slot for
`RECONNECT_TIMEOUT_SECONDS` (default: 30 seconds), allowing the same browser
session to reconnect without changing participant identity.

## HTTPS and WebSockets

Production browsers require a secure origin for camera and microphone access.
Put Caddy, Nginx, or another TLS reverse proxy in front of LowMeet. Examples
are provided in `deploy/caddy/Caddyfile` and `deploy/nginx/lowmeet.conf`.
For a non-container installation, `deploy/systemd/lowmeet.service` provides a
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

LowMeet intentionally does not include accounts, rooms, recording, chat,
transcoding, clustering, or a database in this MVP.
