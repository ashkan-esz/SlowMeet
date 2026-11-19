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
block direct UDP, enable the TURN relay built into SlowMeet and advertise its
UDP, TCP, and TLS transports, for example:

```text
turn:meet.example.com:3478?transport=udp
turn:meet.example.com:3478?transport=tcp
turns:meet.example.com:5349?transport=tcp
```

Set `TURN_SHARED_SECRET` to issue short-lived browser credentials; the relay
verifies them with the same secret. `TURN_CREDENTIAL_TTL_SECONDS` defaults to
24 hours. Legacy `TURN_URL`, `TURN_USERNAME`, and `TURN_PASSWORD` settings
remain supported for server-side use; static credentials are not sent to
browsers.

### Built-in TURN relay

SlowMeet relays TURN itself; no separate TURN server is needed. Turn it on
with `TURN_SERVER_ENABLED=true`, or under Docker or Podman Compose by adding
`deploy/compose.turn.yml` or `deploy/podman-compose.turn.yml` (see the
[container deployment guide](container-deployment.md)). It needs
`TURN_SHARED_SECRET`, and `TURN_URLS` naming this host so browsers are told to
use it. With the relay off, none of the settings below are read.

| Setting | Default | Meaning |
| --- | --- | --- |
| `TURN_SERVER_ENABLED` | `false` | Run the relay inside the SlowMeet process |
| `TURN_SERVER_PORT` | `3478` | TURN over UDP and TCP |
| `TURN_SERVER_TLS_PORT` | `5349` | TURN over TLS; `0` turns it off. The listener starts only when both certificate settings are set |
| `TURN_SERVER_TLS_CERT_FILE`, `TURN_SERVER_TLS_KEY_FILE` | empty | PEM certificate chain and key the process can read |
| `TURN_SERVER_REALM` | `slowmeet` | TURN realm; any name works |
| `TURN_SERVER_RELAY_PORT_MIN`, `TURN_SERVER_RELAY_PORT_MAX` | `49152`, `49999` | UDP ports for relay allocations; must not overlap the ICE UDP range |
| `TURN_SERVER_RELAY_IP` | automatic | Local IPv4 address relay sockets bind |

What to expect from it:

- **It relays only to this server.** The only permitted peers are
  `ICE_PUBLIC_IP` and the relay's own address, and only UDP relay addresses
  are offered. A TURN credential, which anyone who can join a meeting
  receives, cannot be used to reach other hosts or private networks.
- **Only the listen ports face the network.** Clients must reach
  `TURN_SERVER_PORT` over UDP and TCP and `TURN_SERVER_TLS_PORT` over TCP. The
  relay port range carries traffic only between the relay and the SFU on the
  same host, so it needs neither a firewall rule nor published container
  ports.
- **It works behind NAT without hairpinning.** Relay sockets bind
  `ICE_PUBLIC_IP` when this host owns that address, otherwise the address of
  the default route, and then translate the public address to the local one
  themselves. Set `TURN_SERVER_RELAY_IP` only if that choice is wrong for your
  host. Browsers may therefore see a private address in their relay
  candidate; that is expected.
- **It answers from the address it was asked on.** UDP is bound on each local
  address separately at startup. After adding an address to the host, restart
  SlowMeet.
- **A relay that cannot listen stops startup.** If a listen port is taken, the
  process exits with an error naming the port instead of running without a
  relay. A missing certificate is not fatal: TURN over UDP and TCP work, and
  TLS handshakes fail until the files exist.
- **Certificates reload by themselves.** Replaced certificate files are picked
  up within about 30 seconds, without a restart and without dropping calls.
- **It shares the app's resource limits.** Relayed media passes through the
  SlowMeet process and counts against `SLOWMEET_CPUS` (0.75 by default, which
  the installer does not change) and `SLOWMEET_MEMORY_LIMIT`. Raise them
  yourself if many participants are relayed and the container is throttled.

The log line `turn_server_started` lists the bound addresses, the relay
address, and whether the public address is translated. Rejected credentials,
denied peers, and malformed packets are logged only with `LOG_LEVEL=debug`.
The relay has no per-user quota and no limit on idle TCP connections.

To serve TURN over TLS on port 443 next to the HTTPS proxy, put an SNI router
in front of both and forward the TURN name to `TURN_SERVER_TLS_PORT`; the
container cannot bind ports below 1024 itself.

### External TURN server

To use another TURN server instead, leave `TURN_SERVER_ENABLED` off, name the
server in `TURN_URLS`, and give it the same `TURN_SHARED_SECRET` (for coturn:
`use-auth-secret` with `static-auth-secret`). Restrict the peers it relays to;
SlowMeet browsers only ever need to reach this server's media address.

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
time, so keep the relay port range comfortably larger than that times the room
size (the built-in relay's default range has 848 ports). Plain TURN methods,
Direct, and TURN/UDP never rotate.

Rotation does not interrupt media: the server keeps the previous ICE pair
carrying audio and video until the restarted one is selected (a patched
`pion/ice`, see `third_party/README.md`). During each restart the server holds
one extra UDP port per rotating participant for a few seconds, so keep the
`ICE_UDP_PORT_MIN`-`ICE_UDP_PORT_MAX` range larger than twice the room size.

A rotation gathers only on the TURN URL that already carries the call. The
first connection and every recovery restart use all configured URLs of the
method, so listing two `turns:` URLs as fallbacks for each other costs one TLS
handshake and one allocation per rotation, not two.

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
method always rotates. The test starts only while the browser's bandwidth
estimate shows at least 150 kbps of room above what the call is sending;
without that room rotation simply continues.

### Changing the method during a call

A method change is applied to the live connection: the browser swaps its ICE
servers and policy and the server restarts ICE, so the signaling socket, room
seat, camera, and microphone all stay. Switching between a plain method and
its rotating variant needs no restart at all. If the new path has not
connected within 8 seconds the client falls back to a full rejoin.

An explicitly chosen plain `TURN over TCP` or `TURN over TLS` is never
changed automatically. When its round-trip time keeps exceeding 500 ms (3 of
the last 10 one-second samples, the same signature rotation exists for) and
the server enables the rotating variant, the meeting shows a banner offering
it; accepting switches in place, declining hides the offer until the method
is changed again. A recovery ICE restart on any TURN-only method waits 5
seconds instead of 12, since there is no other pair for ICE to fall back to.

### Reconnecting

After a dropped call the client reconnects with a delay that doubles from 2
to 30 seconds and stops after 5 attempts ("Offline"). An attempt counts as
recovered only once media is connected again, not when the signaling socket
reopens.

### Quality adaptation and round-trip time

The quality ladder and the automatic video pause judge round-trip time
against the connection's own recent minimum, not only against fixed limits. A
relayed path that sits at 150-250 ms while healthy would otherwise only ever
step down. The fixed limits (healthy below 120 ms, poor above 250 ms, critical
above 500 ms) are the minimum of each band; above a floor of 60 ms the bands
are floor + 60 / + 150 / + 400 ms, with the floor capped at 300 ms.

A step up needs 5 healthy samples. If that step has to be taken back within
15 samples, the next attempt needs twice as many (10, 20, 40, at most 60); a
step that holds restores 5. A link whose capacity lies between two levels
therefore settles on the lower one instead of switching every few seconds.

A hidden tab keeps adapting: it samples every third second instead of every
second, since it still publishes its camera and microphone.

If the page cannot fetch `/ice-config`, it falls back to `Automatic` for that
page load only; the saved connection type is kept and used again once the
configuration loads.

`/metrics` exports `slowmeet_ice_restarts_total{reason="recovery"|"rotate"|"switch"}`.

A rotation restart does not request video keyframes (nothing is lost during
it); recovery and method-switch restarts still do. When `ICE_PUBLIC_IP` is set
and the policy is not `relay`, the server's own peer connections do not use
the TURN servers: the server is directly reachable, including from a browser's
relay, so it would otherwise create unused TURN allocations on every ICE
gathering and rotation.

`/metrics` also exports `slowmeet_rtcp_relayed_total{type=...}`,
`slowmeet_rtcp_relayed_batches_total`, and
`slowmeet_rtcp_relayed_report_only_batches_total`: the RTCP subscribers send
the SFU about its tracks. Only keyframe requests (PLI, FIR), NACKs, and REMB
are forwarded to the publisher; `slowmeet_rtcp_forwarded_batches_total` counts
those batches. Receiver reports and transport-cc feedback describe the
SFU-to-subscriber leg and are dropped: the SFU sends the publisher its own
reports and transport-cc feedback for the publisher's leg.

`OPUS_DTX_ENABLED=true` (the default) adds `usedtx=1` to the Opus parameters in
every SDP the server sends, so browsers send discontinuous audio: a
comfort-noise packet every 400 ms while a participant is silent or muted
instead of 50 packets per second. Audio is forwarded to every other
participant, so in a room where one person talks this removes most of the
packets the SFU and the TURN relay handle and most of the audio a listener's
downlink carries. Listeners hear generated comfort noise during the gaps. Set
it to `false` to rule it out while debugging an audio problem; the change
applies to participants who join afterwards.

That setting is the default. Each participant can switch it for their own
outgoing audio with **Silence suppression** in the meeting's Settings; the
choice is remembered in their browser and overrides the server default in
either direction. A browser takes this parameter from the description it
receives, so the page rewrites the server's SDP before applying it and
renegotiates once when the switch changes, which applies it to the live call
(`/ice-config` reports the default as `opus_dtx_enabled`).

Signaling uses WebSocket per-message compression when the browser offers it
(all current browsers do). SDP offers and answers are 5-25 KB of repetitive
text and shrink to about a tenth, which matters most with the rotating
methods' offer/answer pair every `TURN_TCP_ROTATE_SECONDS`.

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
