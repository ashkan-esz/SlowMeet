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
- Bandwidth profiles and automatic video degradation
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

`STUN_SERVERS` accepts a comma-separated list. For users behind restrictive
NATs, configure a coturn deployment and set `TURN_URL`, `TURN_USERNAME`, and
`TURN_PASSWORD` as appropriate.

## Docker

```sh
cp .env.example .env
docker compose up -d --build
```

The application listens on port `8080`. Health endpoints are `/health` and
`/ready`.

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

## Scope

LowMeet intentionally does not include accounts, rooms, recording, chat,
transcoding, clustering, or a database in this MVP.
