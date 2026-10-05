# Configuration

The complete environment-variable template is [`.env.example`](../.env.example).
Compose reads a neighboring `.env` file; native `go run .` deployments read
environment variables from the shell and do not load `.env` automatically.
Keep files containing credentials private. Environment variables configure
deployment-time settings and secrets; an optional JSON file stores validated
runtime settings changed through `/admin`.

## Passwords and administration

- Set `MEETING_PASSWORD` to require a password when joining the meeting.
- Set `ADMIN_PASSWORD` to protect `/admin` and its runtime controls.
- Passwords and TURN secrets stay server-side and are not included in public
  configuration responses or application logs.

Each WebSocket connection allows up to five join attempts. Reconnecting clients
can open a fresh connection when needed.

The admin page reports readiness, active participants, peer connections,
reconnects, RTT, packet loss, jitter, and reported audio/video bitrate. It also
controls capacity, media limits, and meeting features. A failed save leaves the
previous settings in place.

## ICE and TURN

`STUN_SERVERS` and `TURN_URLS` accept comma-separated URLs. For networks that
block direct UDP, configure coturn and advertise available UDP, TCP, and TLS
transports, for example:

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

Set `TURN_SHARED_SECRET` to issue short-lived browser credentials; its value
must match coturn's `static-auth-secret` when `use-auth-secret` is enabled.
`TURN_CREDENTIAL_TTL_SECONDS` defaults to 24 hours. Legacy
`TURN_URL`, `TURN_USERNAME`, and `TURN_PASSWORD` settings remain supported for
server-side use; static credentials are not sent to browsers.

`ICE_IPV4_ONLY=true` is the default. Set it to `false` only after testing IPv6
on the target networks. `ICE_PUBLIC_IP` can rewrite host ICE candidates for a
server behind 1:1 NAT; the VPS installer detects and sets the public IPv4
address. Allow the configured `ICE_UDP_PORT_MIN`–`ICE_UDP_PORT_MAX` range
through host and provider firewalls.

## Media limits and diagnostics

`MAX_VIDEO_QUALITY`, `MAX_VIDEO_BITRATE`, `MAX_VIDEO_FPS`, and
`MAX_AUDIO_BITRATE` set hard ceilings. The quality limit caps browser profile
resolution; the SFU drops RTP that exceeds bitrate or frame-rate limits rather
than buffering or transcoding it. The built-in `very-good` profile is 720p at
60 FPS and `ultra` is 1080p at 30 FPS. The starter settings allow both with a
3 Mbps video ceiling, a 60 FPS ceiling, and a 96 kbps audio ceiling.

`/health` and `/ready` expose service health. `/metrics` exposes
Prometheus-compatible counters and the latest network samples, including active
participants, peer connections, reconnects, ICE failures, RTT, packet loss,
jitter, and reported audio/video bitrate. These are current-state diagnostics,
not a durable event or audit log.
