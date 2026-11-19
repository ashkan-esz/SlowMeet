# Patched third-party code

## `pion-ice/` — github.com/pion/ice/v4 v4.4.7, with one patch

`go.mod` replaces `github.com/pion/ice/v4` with this directory. It is the
upstream v4.4.7 source (non-test Go files, `go.mod`, `go.sum`, `LICENSE`)
plus `pion-ice.patch`.

### Why

Upstream `Agent.Restart` is break-before-make: it clears the selected pair and
closes every candidate at once, so no media can be sent or received until the
restarted ICE session has finished its own connectivity checks. SlowMeet
restarts ICE on purpose: the rotating TURN connection methods do it every
`TURN_TCP_ROTATE_SECONDS`, and a connection-method change does it once. With
upstream pion that was a 1-2 second audio and video freeze per restart.

The patch keeps the previously selected pair alive as a "legacy pair" that
only carries application data until the restarted session selects a new pair
(and then until the remote stops sending on it). See the comment at the top of
`pion-ice/legacy_pair.go`. No exported API changes.

### What guards it

- `internal/webrtc/restart_continuity_test.go` fails with upstream behaviour
  (the stream goes silent for the whole restart) and passes with the patch.
- `make test-relay-rotation-e2e` asserts no audio or video pause across
  rotations and across a direct-to-relay switch in Chromium.

Upstream's own test suite is not vendored and was not run against the patch.

### Upgrading pion/ice

1. Replace the contents of `pion-ice/` with the new upstream version's
   non-test Go files, `go.mod`, `go.sum`, and `LICENSE`.
2. From `third_party/`, run `patch -p1 -d pion-ice < pion-ice.patch` and
   resolve any rejects (`Restart`, `setSelectedPair`,
   `validateNonSTUNTraffic`, `close` in `agent.go`; `Conn.Write` in
   `transport.go`; `legacy_pair.go` is a new file).
3. Regenerate `pion-ice.patch` from a pristine copy
   (`diff -ruN a b > pion-ice.patch`), then run `go test ./internal/webrtc/`
   and `make test-relay-rotation-e2e`.

If upstream gains make-before-break restarts, drop the replace and this
directory, and keep the two tests.
