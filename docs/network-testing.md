# Network impairment testing

SlowMeet should be tested with two or more browsers while applying impairment
to the client network namespace or interface. These commands require Linux
`iproute2` and usually root privileges.

Two automated suites cover the weak-network guarantees without touching any
host interface:

- `make test-weaknet` runs the Go integration suite (`//go:build weaknet`)
  inside a disposable network namespace: real peer connections over shaped
  loopback assert that audio survives what starves video, loss is repaired
  through NACK, and recovery is immediate once the impairment lifts. The
  suite also covers an inconsistent link (three impairment cycles with the
  repair loop re-engaging in each window), a pure rate bottleneck (rate
  shaping with a small queue limit, where congestion — not injected loss —
  produces the drops that video must absorb before audio), a cold join whose
  handshakes establish under per-participant tiers with no clean state, and a
  total blackout on one subscriber's port that freezes its media while the
  rest of the room flows and resumes on the same connection after the lift.
- `make test-media-e2e-netns` runs the browser network profile in the same
  kind of namespace: impairment measurement and recovery, the severe 100 kbps
  profile (video yields before audio), and a signaling reconnect whose
  resumed session must survive impairment.
- `make test-media-e2e-four-netns` runs the four-person mixed-quality room:
  P1/P4 stay clean while P2 sees 200 kbit/200 ms/8% loss and P3 sees
  100 kbit/300 ms/12% loss (loss values sit above the client's poor/critical
  thresholds so the adaptation reaction is deterministic on any machine),
  applied per participant by classifying each browser's ICE UDP port into
  per-tier `tc` classes. The scenarios assert that audio
  keeps moving for everyone, each participant's degradation stays theirs, and
  a clean participant's screen share reaches the impaired viewers. The suite
  also covers the inconsistent, slow, and reconnection cases in the same
  four-person room:

  - `fluctuating-link` — the moderate tier arrives, lifts, and returns; every
    impaired window degrades the impaired camera while the clean pair stays
    live, and every lift recovers it before the next window.
  - `slow-bandwidth-room` — a rate-only `capped` tier (150 kbit/50 ms/0%
    loss) congests through queueing instead of injected loss; audio survives
    the standing queue, the capped participant's video trails the clean pair,
    and degradation stays owned by the capped link.
  - `reconnect-under-impairment` — an impaired participant's signaling socket
    is closed mid-impairment; the token resume restores the seat and media
    while the link stays degraded and the rest of the room keeps flowing.
  - `ice-restart-under-impairment` — an impaired participant's manual ICE
    restart renegotiates in place with no signaling reconnect.
  - `reconnect-after-expiry-under-impairment` — a killed impaired browser
    frees its seat after the grace window and the fresh rejoin re-establishes
    media while the impairment is still armed.
  - `cold-join-under-impairment` — all four browsers join while three tiers
    (moderate/severe/capped) are already armed: ICE gathering, DTLS, and the
    first media seconds happen under impairment, degradation stays per-tier
    on links that never knew a clean state, and the clean sender's camera
    still reaches the capped receiver.
  - `blackout-and-recovery` — a `blackout` tier (100% loss) severs one
    participant's media mid-call while the signaling WebSocket stays alive:
    the room keeps flowing, the impaired participant's video intake collapses
    on the clean observer while an unimpaired sender's keeps advancing, and
    the client's own recovery machinery restores media after the lift
    without a reload.
  - `all-distinct-qualities` — all four participants sit on different tiers
    at once (clean/moderate/severe/capped): audio advances everywhere, the
    severe camera yields on the clean observer, the capped receiver's view of
    the clean camera either trickles through the cap or shows the visible
    degradation reaction, and every camera recovers on lift.
  - `impaired-sharer-screen-share` — the inverse of the clean-sharer case:
    the share owner's own uplink is impaired while every viewer is clean; the
    lease survives a starving owner, the sharer keeps sending, and every
    viewer decodes the share again once the window lifts.
  - `delay-and-jitter-links` — the two degradation shapes no rate/loss tier
    covers, both as own-path contracts (each participant's media rides one
    client↔SFU connection, so remote tiles only see per-stream loss): a
    pure-latency link (RTT ≈ 350 ms, poor but not critical) turns the
    participant's own chip poor and steps the ladder while video keeps
    decoding at full rate, and a jitter-only link crosses the 50 ms jitter
    bar and steps the ladder without suspending video; the clean pair's
    chips stay unaffected, and the ladder climbs back from the floor on
    transport health once the tiers lift.
  - `all-fast-link-top-quality` — all four participants on the `fast` tier
    (20 mbit/10 ms/0% loss, both directions; shaped, unlike the unshaped
    clean default class). Every participant's Auto ladder reaches and holds
    level 3 (`high`) with no suspension or degraded tile, and the camera
    sender runs at the `high` bitrate. A short moderate window on one
    participant then lifts, and all four climb back to level 3.
  - `one-fast-three-bad-uplinks` — the 1 good / 3 bad room where the three
    bad participants have lossy uplinks (moderate/severe/moderate, both
    directions), so the fast participant has no clean inbound stream to
    calibrate against. Audio advances for everyone, the bad cameras degrade
    on the fast participant, one bad participant leaving alone does not
    interrupt the rest, and everything recovers on lift. The fast
    participant's own ladder and verdict are recorded as evidence for known
    issue B1 below, not asserted.
  - `all-four-impaired` — every participant on the moderate tier at once,
    each on its own copy of it (`moderate-2`…`moderate-4`, so four people do
    not share one 200 kbit queue), with no clean peer anywhere: audio keeps
    advancing, the room does not rebuild peers in a storm, and every camera
    recovers on lift.

Deterministic coverage for the same rooms runs in `make check` without a
namespace:

- `scripts/test-room-network-scenarios.js` (`make test-room-network-scenarios`)
  drives the real adaptation-policy functions through the same ladder wiring
  as `web/js/app.js`: a fast link climbing to and holding level 3 (including
  missing stats fields and isolated loss blips), recovery to the top after a
  failed climb, and a room-mix table (4 good, 3/1, 2/2, 1 good/3 bad, 4 bad)
  for the participant on the good link.
- `internal/media` Go tests: a four-party full mesh on loopback
  (`TestRouterForwardsFourPartyFullMesh`), keyframe-request fan-in from
  several subscribers, mixed simulcast layers across four receivers,
  high-rate fan-out to three healthy targets, and three saturated targets
  beside a healthy one.
- `TestWeakNetSymmetricMeshIsolatesCleanParticipant` (`make test-weaknet`)
  is the Go form of the 1 good / 3 bad room: four peers that all publish,
  three with impaired uplinks.

### Known issues pinned by tests

These tests pin today's behaviour and say in a `KNOWN ISSUE (Bn)` comment
what should change. Fixing an issue means flipping that assertion.

- **B1 — good participant blames its own link.** The own-link loss estimate
  is the minimum loss across inbound streams. When every remote sender has a
  lossy uplink, that minimum is high even though the receiver's link is
  clean, so a fast participant steps its own camera down and, above 10%,
  pauses it. Pinned in `scripts/test-room-network-scenarios.js`. In
  `one-fast-three-bad-uplinks` the fast participant fell from level 3 to 0
  within about 5 s and paused its camera for most of the window in every
  run so far.
- **B2 — keyframe requests are not coalesced.** Every subscriber's PLI/FIR
  reaches the publisher, and server keyframe retries run once per receiver,
  so three lossy subscribers multiply keyframe requests on a shared
  publisher. Pinned in `TestSubscriberKeyFrameRequestsFanInToPublisher` and
  `TestLayerTransitionKeyFrameRetriesPerReceiver`.
- **B3 — frames over 128 packets are dropped whole.** A large keyframe at
  the default 3 Mbps cap can exceed the frame buffer's packet limit. Pinned
  in `TestVideoFrameBufferMaxPacketsBoundary`.
- **B4 — FPS gate decimates a source at the cap.** With capture-time jitter,
  a source running at exactly the configured frame-rate cap loses about
  half its frames. Pinned in `TestBitrateLimiterFPSGateAtSourceRate`.

  Run the whole gated set the way CI does:

  ```sh
  MEDIA_E2E_FOUR_SCENARIO="mixed-quality-room,screen-share-mixed-quality,fluctuating-link,slow-bandwidth-room,reconnect-under-impairment,ice-restart-under-impairment,reconnect-after-expiry-under-impairment,cold-join-under-impairment,blackout-and-recovery,all-distinct-qualities,impaired-sharer-screen-share,delay-and-jitter-links,all-fast-link-top-quality,one-fast-three-bad-uplinks,all-four-impaired" make test-media-e2e-four-netns
  ```

- `make test-soak-netns` runs the sustained weak-network soak: the same
  four-tier room (P1 clean, P2 moderate, P3 severe, P4 capped-downlink)
  under CYCLING impairment — two impaired windows (~90 s each, a CPU
  profile captured mid-window) each followed by a clean recovery window.
  Where the scenarios above prove each guarantee in a short window, the
  soak proves it holds over time: audio advances within every window
  (impaired ones included), every lift recovers every camera for the clean
  observer, reconnect counts stay bounded per window, and the goroutine
  count returns to baseline after each clean window (recovery-loop leak
  guard). Artifacts land in `soak-artifacts/` with the usual pprof
  captures plus a `metrics.json` timeline of `/metrics` snapshots per
  window. `SOAK_SECONDS=300` (default) runs two full cycles; the plain
  clean soak (`make test-soak`) is unchanged. Gated in the weaknet CI
  job; locally it stays opt-in for shorter or clean soaks (`SOAK_SECONDS`,
  `SOAK_IMPAIRMENT=0`).

Inspect the active interface first:

```sh
ip route get 1.1.1.1
```

Apply one scenario at a time:

```sh
# 1 Mbps, 50 ms RTT, no loss
sudo tc qdisc replace dev IFACE root netem rate 1mbit delay 50ms

# 500 kbps, 100 ms RTT, 1% loss
sudo tc qdisc replace dev IFACE root netem rate 500kbit delay 100ms loss 1%

# 200 kbps, 200 ms RTT, 3% loss
sudo tc qdisc replace dev IFACE root netem rate 200kbit delay 200ms loss 3%

# 100 kbps, 300 ms RTT, 5% loss
sudo tc qdisc replace dev IFACE root netem rate 100kbit delay 300ms loss 5%
```

The repository includes an explicit runner that removes the qdisc when it
exits:

```sh
sudo scripts/netem.sh --interface IFACE --scenario 500kbit --duration 60
sudo scripts/netem.sh --interface IFACE --scenario changing --duration 120
```

Keep the browser meeting open while the runner is active. The `changing`
scenario applies the 1 Mbps, 200 kbps, 80 kbps, and 1 Mbps phases for equal
quarters of the requested duration.

Remove impairment after every test:

```sh
sudo tc qdisc del dev IFACE root
```

## Expected behavior

| Available bandwidth | Expected result |
| --- | --- |
| 1 Mbps | 360p–480p video and clear audio |
| 300–500 kbps | 240p–360p video and usable audio |
| 100–200 kbps | Very low or disabled video; audio remains usable |
| Increased loss/jitter | Video degrades before audio |

Also test a changing link by replacing the qdisc during a live call (the
automated form of this case is `fluctuating-link` and the Go
`TestWeakNetFluctuatingImpairment`; the manual recipe below stays useful for
observation):

```sh
sudo tc qdisc replace dev IFACE root netem rate 1mbit delay 50ms
sudo tc qdisc replace dev IFACE root netem rate 200kbit delay 200ms loss 3%
sudo tc qdisc replace dev IFACE root netem rate 80kbit delay 300ms loss 5%
sudo tc qdisc replace dev IFACE root netem rate 1mbit delay 50ms
```

Record for each run:

- Whether audio remains understandable
- Time until video downgrades
- Whether video reaches audio-only mode
- Time until video recovers
- RTT, packet loss, bitrate, FPS, and resolution from the diagnostics panel
- Whether the WebSocket or ICE connection reconnects

Do not run these commands on a shared production interface. `tc` changes the
interface for all traffic handled by that namespace.

## Container media ports

The default container configuration limits Pion's server-side ICE UDP
allocation to ports `50000-50100`. Docker Compose and podman-compose publish
the configured range automatically; if you change `ICE_UDP_PORT_MIN` or
`ICE_UDP_PORT_MAX`, allow the resulting range through the host firewall. Use
TURN when direct UDP is blocked by the network or NAT.

The TURN relay built into SlowMeet listens on UDP and TCP `3478` and, for TURN
over TLS, TCP `5349`. `deploy/compose.turn.yml` (or its Podman twin) publishes
those three ports; allow them through the host and provider firewalls. The
relay's own UDP port range (`49152-49999` by default) carries traffic only
between the relay and the SFU in the same container or host: do not publish it
and do not open it in a firewall. `scripts/probe-stun-path.sh` tests the UDP
path to port 3478 with plain STUN requests, which the relay answers without
credentials.

## ICE path and simulcast staging

Keep production on `ICE_TRANSPORT_POLICY=all` and
`SIMULCAST_ENABLED=false` until the staging matrix passes. The ICE policy is
returned by `/ice-config` for browsers and also applied to the server peer
connections.

Compare one path at a time:

| Test | ICE policy | TURN configuration |
| --- | --- | --- |
| Direct UDP | `all` | Disable TURN URLs |
| TURN/UDP | `relay` | Configure one `turn:` URL with `transport=udp` |
| TURN/TLS on 443 | `relay` | Configure one `turns:` URL on port 443 with `transport=tcp` |

TURN/TLS can cross networks that block UDP. TCP can add delay when packets are
lost, so compare it with TURN/UDP on the same access network. Do not combine
multiple TURN URLs during an individual comparison.

After ICE path comparisons, enable `SIMULCAST_ENABLED=true` in staging and
compare calls with 2, 4, and 8 participants on desktop Chrome, Android Chrome,
and iOS Safari. Confirm layer switching, audio continuity, screen share, and
single-layer fallback. Record publisher uplink, SFU load, receiver bitrate,
frame drops, RTT, loss, and reconnects for each network profile above. Repeat
on available Iranian mobile and fixed connections and record provider and
access type. A regional pilot should move the SFU and TURN together; retain a
move only when p95 RTT improves by at least 20% without lower connection
success.
