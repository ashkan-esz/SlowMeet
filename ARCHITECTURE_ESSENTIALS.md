# SlowMeet Architecture Essentials

This is the short onboarding reference for maintainers. Read
`ARCHITECTURE.md` for the full design and `PRD.md` for product requirements.

## What SlowMeet is

SlowMeet is a small Go service for one active browser meeting:

```text
Browser UI ── HTTPS/WSS ──> Go HTTP server
                               │
                               ├─ signaling hub
                               ├─ in-memory meeting state
                               ├─ Pion peer connections
                               ├─ RTP SFU router
                               └─ health, metrics, and admin control
```

The frontend is embedded in the binary. There is no database in the active
meeting path and no server-side media transcoding.

## The critical path

1. `main.go` loads environment configuration and creates the HTTP application.
2. `internal/httpserver` serves the meeting page, configuration endpoints,
   health/readiness, metrics, admin routes, and `/ws`.
3. A browser opens `/ws` and sends a versioned `join` message.
4. `internal/signaling` validates the message and asks `internal/meeting` to
   admit the participant.
5. The hub creates a Pion peer and registers it with `internal/media`.
6. SDP and ICE messages establish peer connections.
7. The media router forwards RTP publications to subscriber peers.
8. Disconnect, ICE failure, or track failure triggers cleanup and optional
   reconnect handling.

## Package map

| Package/path | Owns | Does not own |
| --- | --- | --- |
| `main.go` | Process lifecycle and graceful shutdown | Meeting behavior |
| `internal/config` | Environment settings and persisted runtime settings | WebSocket authentication flow |
| `internal/httpserver` | HTTP routing and static assets | RTP forwarding |
| `internal/signaling` | WebSocket clients, protocol, participant lifecycle, control events | Low-level Pion implementation |
| `internal/meeting` | Active membership and capacity | Transport or media |
| `internal/webrtc` | Pion peer wrapper and SDP/ICE operations | Room policy |
| `internal/media` | Publications, subscriptions, RTP limits, forwarding | User authorization |
| `internal/metrics` | Counters and latest samples | Durable observability storage |
| `web/` | Browser UI, protocol parsing, adaptation, layout | Server authority |

## Rules that must stay true

- The server is authoritative for passwords, capacity, protocol validity, and
  runtime limits.
- Browser validation is only a convenience; repeat security validation on the
  server.
- The media router must not add an unbounded queue. It drops excess packets to
  preserve latency.
- Audio must not be hidden behind video degradation behavior.
- Every WebSocket, participant, peer, publication, and screen-share lease must
  be released when its owner is gone.
- Public configuration and metrics must not expose passwords or TURN secrets.
- Reverse proxies must preserve WebSocket upgrades and long-lived timeouts.

## Signaling vocabulary

The protocol is JSON with `version: 1` and a required `type`. Important types
include:

- `join`, `leave`, `participant_joined`, `participant_left`;
- `offer`, `answer`, `candidate`, `ice_restart`;
- `media_state`, `network_state`, `screen_share`, `screen_share_state`;
- `hand_state`, `chat_message`, `emoji_reaction`;
- `config_update` and `error`.

When adding a message type, update server validation, browser parsing, tests,
and the architecture/PRD contract together.

## Media mental model

```text
source browser
   │ remote RTP track
   ▼
publication + bitrate/FPS limiter
   │ packet-by-packet forwarding
   ├── local track → subscriber peer A
   └── local track → subscriber peer B
```

The router forwards RTP without transcoding. Bitrate and FPS limits are hard
ceilings. A packet that cannot pass the limiter is dropped immediately rather
than delayed.

## Important operational facts

- Application listener: `8080` by default.
- Direct ICE UDP range in the Compose example: `50000-50100` by default.
- TURN is optional but recommended for restrictive NATs or UDP-blocked users.
- Production browser media requires HTTPS.
- Frontend files do not need to be mounted into the container because they are
  embedded into the binary.
- Runtime settings may be persisted under the configured data path; meeting
  membership remains in memory.
- `/health`, `/ready`, and `/metrics` are the primary deployment/monitoring
  endpoints.

## Safe change map

### Changing a browser feature

Start in the relevant `web/js/` module. If it changes a signaling field or
event, update `internal/signaling/protocol.go`, hub handling, browser parsing,
and protocol tests.

### Changing participant behavior

Start with `internal/meeting` for membership rules, then inspect signaling
cleanup and reconnect paths. Add tests for join, leave, capacity, and
disconnect behavior.

### Changing media policy

Inspect configuration validation, the signaling hub's router construction, and
`internal/media/router.go`. Preserve the no-queue behavior and test both new
and already-published tracks after a limit update.

### Changing deployment behavior

Update the relevant Compose, reverse-proxy, systemd, README, and architecture
documentation together. Verify WebSocket upgrades, HTTPS assumptions, ICE UDP
ports, TURN listeners, and data-volume permissions.

### Changing admin settings

Trace the value through `internal/config`, `/admin/config`, the admin UI, and
the affected runtime subsystem. A failed validation or persistence write must
leave the previous active configuration unchanged.

## Verification commands

```sh
go test ./...
go build ./...
./scripts/smoke.sh
node scripts/test-protocol.js
node scripts/test-adaptation.js
node scripts/test-meeting-layout.js
git diff --check
```

For browser media or deployment changes, also test behind HTTPS with the
configured reverse proxy and exercise both direct ICE and TURN paths where
available.

