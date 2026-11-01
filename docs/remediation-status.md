# Project review remediation

This tracks implementation and validation of the project review on November 1,
2026. The original review is preserved in [project-review.md](project-review.md).

## Admission and privacy

Room broadcasts use the admitted membership set, including configuration,
participant, chat, reaction, media, screen, hand, room-full and disconnect events.
The pending WebSocket pool is capped at 128 connections. A connection must join
within 15 seconds; pongs do not extend this deadline. Admission releases the
pending slot, and failed upgrades and disconnects release it during cleanup.

Client chat, reaction and media-state broadcasts copy only their allowed fields;
unrelated credentials, SDP and other protocol fields are discarded before fanout
or retention.

TURN authorization is tied to a currently admitted connection. A pending,
disconnected or superseded connection cannot renew credentials.

## Authentication and deployment

Password attempts reserve their budget before credential verification, including
attempts on fresh WebSockets. Successful attempts refund their reservation;
exhausted budgets reject even a correct password until refill. HTTP roster and
admin authentication follow the same rule. `TRUSTED_PROXY_CIDRS` opts into
forwarded-address handling, using the first untrusted hop when walking
`X-Forwarded-For` from the socket peer toward the visitor. Untrusted peers and
malformed forwarded values use the socket address.

Public `GET /ice-config` keeps connection-method discovery available without
returning TURN usernames or credentials. `GET /ice-config/credentials` requires
an active admitted reconnect token as a bearer token. Responses are not cached.
The browser waits for admitted credentials before creating its peer connection,
including reconnects; prejoin discovery never sends a stale reconnect token.

HTTP serving errors now reach the process exit status after application cleanup.
Tests cover an occupied port in both the runner and a subprocess, plus normal
shutdown releasing its listener.

Publisher keyframe retries follow publication identity and remain active while
any eligible subscriber remains. Last-subscriber removal and publication
replacement cancel obsolete retries. Integration ICE-gathering waits have a
10-second timeout so failures cannot leave the suite waiting indefinitely.

Docker and Podman Compose default to loopback HTTP publication. The documented
`HTTP_PUBLISH_ADDRESS=0.0.0.0` override enables direct public access. The Caddy
fallback test now checks the real preparation/install order with command stubs.
CI includes Caddy, Xray, container binding checks and Go and npm vulnerability scanning.
Release smoke workflows run two-participant browser media against each released
image with its UDP ICE port range published.

## Browser maintenance

Outbound signaling room messages are sanitized before broadcasting. Remote media
identity parsing and participant avatar identity helpers have moved from the main
browser application into small tested modules. Larger signaling, rendering and
media lifecycle extractions remain incremental work.

Camera enable now explicitly reactivates the established sender encoding. Screen
sharing pauses this encoding; replacing its track alone previously left a camera
manually enabled after sharing unable to send frames.

## Validation

- `GOCACHE=/tmp/slowmeet-gocache make check`: passed (formatting, race-enabled Go
  tests, vet, build and JavaScript checks).
- `GOCACHE=/tmp/slowmeet-gocache go test -race ./... -count=1 -timeout=120s`:
  passed without cached results.
- `go test ./... -cover -timeout=120s`: passed. Changed Go packages range from
  81.6% to 91.0% statement coverage; the unchanged WebRTC package remains at
  57.3%, so a repository-wide per-package 80% target is not yet satisfied.
- Privacy regressions reproduced the original leak before the fix and now pass
  for unjoined, wrong-password and capacity-rejected sockets, with admitted
  controls receiving the same events.
- Authentication tests cover exhausted budgets across fresh connections,
  deterministic refill, trusted proxies, spoofed headers and IPv6.
- Rendered Chromium keyboard navigation, dialog roles/names, focus trapping,
  Escape dismissal and focus restoration: passed.
- Rendered axe checks on prejoin and meeting surfaces: passed after correcting
  control contrast, visible-label names and participant list semantics.
- Two connected Chromium participants with generated camera input: first enable,
  off/on, repeated rapid toggles and incoming-video pause/resume in both
  directions, and signaling reconnect passed with advancing remote video.
  Media assertions now cover both grid and
  pinned layouts.
- Headed Chromium with generated screen content: start, stop, restart,
  competing-owner rejection, simulated picker cancellation preserving the camera,
  and manual camera re-enable after sharing passed with advancing decoded frames
  and playback. Screen pixels changed between samples.
- Installer configuration, Docker LXC fallback, Caddy fallback, Xray fallback,
  and container binding suites: passed. Installer ShellCheck style checks passed
  using the cached scanner image with networking disabled.
- `npm audit --audit-level=high`: passed with zero reported advisories.
- Local `govulncheck ./...`: could not complete because the advisory service
  returned HTTP 403. The CI scan remains enabled; Go advisory status is unverified.
- Locally source-built Docker and Podman images: two connected participants
  passed first camera enable, off/on and rapid toggles in both directions, with
  advancing remote video through published UDP ports. ICE advertised the host
  interface address; advertising container loopback failed this check and was
  corrected in the release smoke configuration. Test containers were removed.

Native camera capture, manual interaction with the operating-system screen picker,
production load and the published release images require separate acceptance.
Local container checks used source-built images. Go advisory status remains
unverified because the advisory service rejected the local scan.
