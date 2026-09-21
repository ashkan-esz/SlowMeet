# SlowMeet Product Requirements Document

## Document status

This document describes the implemented SlowMeet MVP as of September 2026.
Items under **Roadmap** are proposals and are not part of the current product
contract.

## Product summary

SlowMeet is a small, self-hosted video meeting service for one active meeting.
It is designed for teams that need a simple meeting room they can operate on
their own infrastructure, including networks where bandwidth and connection
quality are inconsistent.

The product prioritizes usable audio, predictable degradation, low operational
complexity, and transparent diagnostics over large-scale conferencing features.
The browser supplies the user interface and WebRTC media; the Go service owns
meeting state, signaling, peer connections, media forwarding, configuration,
and operational metrics.

## Problem and opportunity

Self-hosted video tools often become difficult to operate because they combine
heavy infrastructure, opaque media behavior, and poor visibility into degraded
connections. SlowMeet addresses a narrower problem:

- provide one dependable meeting room with minimal infrastructure;
- keep media latency low when bandwidth is constrained;
- make connection health visible to participants and operators;
- keep passwords and deployment configuration server-side;
- make the system understandable enough to run on a small VPS or private host.

## Target users

### Meeting participants

Participants need to join quickly, choose a display name, control their camera
and microphone, see who is speaking, recover from temporary network failures,
and understand when their connection is degraded.

### Meeting operators

Operators need to deploy the service behind HTTPS, configure STUN/TURN and
media limits, inspect readiness and metrics, and adjust safe runtime limits
without editing the application binary.

### Maintainers

Maintainers need clear package boundaries, a small protocol surface, focused
tests, and operational behavior that can be reasoned about without a database
or external control plane.

## Goals

1. Offer a usable single-room browser meeting with audio, camera video, and
   optional screen sharing.
2. Preserve low latency by forwarding RTP without server-side transcoding or
   packet queues.
3. Degrade video before audio when network conditions deteriorate.
4. Make joining, reconnecting, and peer negotiation resilient to normal
   browser and network interruptions.
5. Provide operators with health, readiness, Prometheus-style metrics, and a
   protected runtime settings page.
6. Keep sensitive values server-side and avoid exposing passwords or full
   environment contents to the browser.
7. Keep deployment practical for Docker/Podman and a least-privilege systemd
   installation.

## Non-goals

- Multi-room tenancy or a persistent meeting database.
- Recording, transcription, moderation history, or server-side media storage.
- Server-side video/audio transcoding or composition.
- Large-scale conferencing beyond the configured participant limit.
- Native mobile or desktop applications.
- A durable audit log for admin activity.
- Automatic certificate management inside the application.

## Current product scope

| Area | Implemented behavior |
| --- | --- |
| Meeting model | One active in-memory meeting at `/` |
| Join security | Optional meeting password; bounded join attempts per WebSocket connection |
| Participants | Configurable maximum, five by default |
| Signaling | WebSocket protocol version 1 with join, leave, SDP, ICE, media state, chat, reactions, and diagnostics messages |
| Media | Pion WebRTC peer connections and SFU RTP forwarding |
| Video policy | Browser quality profiles, adaptive degradation, and server-side bitrate/FPS ceilings |
| Audio policy | Browser audio controls and server-side bitrate ceiling |
| Screen sharing | One active screen-share lease with cleanup on disconnect |
| Collaboration | Chat history retention setting, hand raising, and approved emoji reactions |
| Recovery | Reconnect tokens, ICE restart, connection state handling, and participant cleanup |
| Operations | `/health`, `/ready`, `/metrics`, protected admin settings, and a browser operations cockpit |
| Deployment | Embedded frontend assets, container examples, optional coturn, reverse-proxy examples, and systemd service template |

## Primary user journeys

### Join a meeting

1. The browser loads the embedded meeting page.
2. The client fetches public configuration and ICE server configuration.
3. The client opens `/ws` and sends a versioned `join` message containing a
   display name, optional meeting password, and optional reconnect token.
4. The server validates the message, checks the password and capacity, creates
   or restores the participant, and broadcasts the participant state.
5. The client and server exchange SDP and ICE messages for the participant's
   peer connection.
6. Published camera, microphone, and screen tracks are forwarded to the
   appropriate peers.

### Use media under poor network conditions

1. The browser reports RTT, packet loss, jitter, and current bitrates.
2. The client adaptation policy lowers video quality or pauses remote video as
   needed while preserving audio.
3. The server applies hard bitrate and FPS ceilings by dropping excess RTP
   packets without buffering or transcoding.
4. The UI exposes degraded state and diagnostics instead of silently failing.

### Recover after interruption

1. The browser detects a disconnected or failed peer/WebSocket state.
2. It reconnects with the participant's reconnect token when possible.
3. The server restores the participant within the configured reconnect window
   or treats the connection as a new join after expiry.
4. ICE restart and renegotiation restore media paths when the network permits.

### Operate the service

1. The operator places SlowMeet behind HTTPS and configures the firewall and
   ICE/TURN paths.
2. The operator uses `/health`, `/ready`, and `/metrics` for deployment and
   monitoring checks.
3. The operator opens `/admin`, supplies the admin password, and reviews
   readiness, participants, peer state, reconnects, and network samples.
4. Runtime settings can be changed for participant capacity, video policy,
   audio policy, screen sharing, and chat history retention.
5. Settings are persisted atomically when a configuration path is available.

## Functional requirements

### FR-1: Meeting access

- The service MUST serve a meeting at `/`.
- The service MUST reject malformed or unsupported signaling protocol versions.
- The service MUST enforce the configured participant limit.
- If a meeting password is configured, the password MUST be checked server-side.
- Passwords MUST NOT be sent to the frontend after validation or written to
  logs.

### FR-2: Participant state

- The service MUST assign each participant a stable identifier for the active
  session.
- The service MUST broadcast joins and leaves to connected participants.
- A disconnected participant MUST be removed after the applicable reconnect
  grace period.
- Participant state MUST include the media and collaboration state needed by
  the browser UI, but MUST NOT include secrets.

### FR-3: Signaling and media

- The service MUST support SDP offer/answer and trickle ICE exchange.
- The service MUST support ICE restart.
- The SFU MUST forward published RTP tracks to subscribed peers without
  transcoding.
- Bitrate and FPS limits MUST be hard ceilings and MUST NOT introduce a packet
  queue.

### FR-4: Participant controls

The browser MUST support camera and microphone controls, remote video pause,
screen sharing when enabled, hand raising, chat, approved emoji reactions, and
connection diagnostics.

### FR-5: Configuration

The service MUST support environment-backed configuration for HTTP listening,
meeting access, admin access, ICE/TURN, participant limits, media policy,
screen sharing, chat retention, logging, and persistence.

Runtime admin updates MUST validate ranges before applying them. A failed save
MUST leave the previous settings active.

### FR-6: Operations

- `/health` MUST provide a lightweight liveness response.
- `/ready` MUST report whether the application is ready to serve traffic.
- `/metrics` MUST expose active participant, peer, reconnect, ICE failure, and
  latest network/media measurements in Prometheus-compatible text format.
- The service MUST shut down its signaling and media resources before the HTTP
  server exits.

## Non-functional requirements

### Performance and media behavior

- Keep the media path latency-oriented: no server-side transcoding and no
  unbounded buffering.
- Preserve audio as the first-class experience during video degradation.
- Apply limits to existing publications when runtime media settings change.
- Bound WebSocket reads and writes to prevent untrusted clients from consuming
  unbounded memory or blocking the hub.

### Security and privacy

- Require HTTPS in production because browsers require a secure origin for
  camera and microphone access.
- Preserve WebSocket upgrade behavior through the reverse proxy.
- Authenticate admin configuration requests with the server-side admin
  password.
- Avoid returning TURN static credentials to browsers when short-lived shared
  secret credentials can be generated.
- Do not commit passwords, TURN credentials, private keys, or real `.env`
  values.

### Operability

- The container MUST remain useful with a read-only root filesystem and a
  dedicated data volume.
- The default application listener is port `8080`.
- Direct ICE media uses the configured UDP range, `50000-50100` by default in
  the Compose example.
- TURN MUST remain optional but documented for restrictive NATs and UDP-blocked
  networks.

## Success measures

The MVP is successful when an operator can deploy it and a participant can:

- join a password-protected meeting over HTTPS;
- publish and receive audio/video;
- share a screen when enabled;
- recover from a temporary WebSocket or ICE interruption;
- see meaningful degraded-network feedback;
- use chat, reactions, and hand raising;
- operate within configured participant and media limits.

Operationally, a deployment should expose useful liveness, readiness, and
network/media metrics without requiring a database or a separate application
service.

## Constraints and trade-offs

- In-memory meeting state keeps the service small but means a process restart
  ends the active meeting.
- SFU forwarding avoids transcoding cost and latency but requires compatible
  browser codecs and sends each publication to subscribed peers.
- Packet dropping preserves latency under a hard cap but relies on WebRTC loss
  recovery and can reduce visual quality.
- A single meeting simplifies operations but is not a tenancy or scale-out
  model.
- Reverse-proxy TLS keeps certificate concerns outside the Go process but makes
  correct WebSocket and media network configuration part of deployment.

## Roadmap proposals

These are intentionally outside the current product contract and should be
validated before implementation.

### Near term

- Improve operator-facing event history without presenting it as a durable
  audit log until persistence exists.
- Add more explicit capacity and media-policy presets for common small-VPS
  profiles.
- Expand automated browser-level coverage for reconnect, screen sharing, and
  degraded-network transitions.

### Medium term

- Support multiple named rooms with explicit lifecycle and authorization.
- Add durable meeting and operator configuration storage with migration and
  backup behavior.
- Add optional recording integrations that keep media storage outside the core
  SFU process.

### Longer term

- Introduce horizontal scaling only after room ownership, signaling routing,
  shared state, and media distribution are explicitly designed.
- Consider managed identity or external authentication integrations without
  weakening the server-side secret boundary.

