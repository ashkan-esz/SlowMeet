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
- Failed password attempts on the join, roster-preview, and admin surfaces are
  throttled per client IP; over the budget, requests are rejected until the
  attempt budget refills.

Each WebSocket connection allows up to five join attempts. Reconnecting clients
can open a fresh connection when needed.

`RECONNECT_TIMEOUT_SECONDS` is how long a disconnected participant keeps their
slot before it is released (default 30, maximum 600). Setting it to `0`
disables the grace period: the slot is released as soon as the connection
drops and reconnects take a fresh slot.

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

### Rotating TURN methods

Besides `Direct`, `TURN over UDP`, `TURN over TCP`, and `TURN over TLS`, the
connection-method list offers `TURN over TCP (rotating)` and
`TURN over TLS (rotating)` (`turn-tcp-rotate`, `turn-tls-rotate`). A rotating
method uses the same TURN URLs as its plain counterpart; in addition, the
browser asks the server for an ICE restart every `TURN_TCP_ROTATE_SECONDS`
(default `12`, `0` disables the rotating methods, otherwise 10–600). Chrome
allocates fresh TURN connections, moves media onto them before releasing the
old pair, and closes the old connections about 90 seconds later.

Some access networks start dropping uplink packets on a long-lived real-time
TCP flow about 20 seconds after it starts, which turns into multi-second
freezes; a fresh connection is clean again, so rotation keeps every flow inside
that window. Rotation is separate from recovery restarts: it does not count
toward the client's restart attempts or change the connection status. Expect
about `90 / interval + 1` TURN allocations per rotating participant at any
time, so keep coturn's relay port range comfortably larger than that times the
room size. Plain TURN methods, Direct, and TURN/UDP never rotate.

Rotation does not interrupt media: the server keeps the previous ICE pair
carrying audio and video until the restarted one is selected (a patched
`pion/ice`, see `third_party/README.md`). During each restart the server holds
one extra UDP port per rotating participant for a few seconds, so keep the
`ICE_UDP_PORT_MIN`-`ICE_UDP_PORT_MAX` range larger than twice the room size.

Administrators enable or disable each method on the admin page. A settings
file saved before the rotating methods existed enables each rotating method
whose plain counterpart was enabled.

### Automatic

`Automatic` starts direct. When the direct path dies it moves the call to the
first enabled relay of: rotating TCP, rotating TLS, TCP, TLS. A direct path
that dies within 20 seconds of first connecting (the signature of a network
that polices WebRTC UDP) triggers the move at once; otherwise two failed
episodes do. The failure is remembered in the browser for 24 hours so later
joins start on the relay.

While `Automatic` is on a rotating relay, the browser tests once whether a
plain relay would hold up: about 10 seconds into the call it echoes a 64 kbps
stream through the plain relay for 40 seconds on throwaway connections and
judges the part after the 20-second mark. On a pass it stops rotating (fewer
restarts and TURN allocations) and keeps watching the call's round-trip time;
three samples over 500 ms within ten resume rotation immediately. A pass is
remembered for 1 hour and a fail for 6 hours. An explicitly chosen rotating
method always rotates.

### Changing the method during a call

A method change is applied to the live connection: the browser swaps its ICE
servers and policy and the server restarts ICE, so the signaling socket, room
seat, camera, and microphone all stay. Switching between a plain method and
its rotating variant needs no restart at all. If the new path has not
connected within 8 seconds the client falls back to a full rejoin.

`/metrics` exports `slowmeet_ice_restarts_total{reason="recovery"|"rotate"|"switch"}`.

`ICE_IPV4_ONLY=true` is the default. Set it to `false` only after testing IPv6
on the target networks. `ICE_PUBLIC_IP` can rewrite host ICE candidates for a
server behind 1:1 NAT; the VPS installer detects and sets the public IPv4
address. Allow the configured `ICE_UDP_PORT_MIN`–`ICE_UDP_PORT_MAX` range
through host and provider firewalls.

## Media limits and diagnostics

`MAX_VIDEO_QUALITY`, `MAX_VIDEO_BITRATE`, and `MAX_VIDEO_FPS` set hard video
ceilings. The quality limit caps browser profile resolution. The SFU paces
video RTP to the bitrate ceiling and forwards complete frames only; it drops
whole frames when the FPS ceiling or a full pacing queue requires it.
Screen-share senders adapt to the configured bitrate and FPS limits, reducing
frame rate before resolution to preserve text sharpness. `MAX_AUDIO_BITRATE`
sets the separate audio ceiling.
The built-in `very-good` profile is 720p at 60 FPS and `ultra` is 1080p at
30 FPS. The starter settings allow both with a 3 Mbps video ceiling, a 60 FPS
ceiling, and a 96 kbps audio ceiling.

`/health` and `/ready` expose service health. `/metrics` exposes
Prometheus-compatible counters and the latest network samples, including active
participants, peer connections, reconnects, ICE failures, RTT, packet loss,
jitter, and reported audio/video bitrate. These are current-state diagnostics,
not a durable event or audit log.
