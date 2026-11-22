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
  pauses it. In `one-fast-three-bad-uplinks` the fast participant fell from
  level 3 to 0 within about 5 s and paused its camera for most of the
  window in every run so far (33–34 of 40 samples, up to 70 % loss, in the
  three runs after the change below).
  Partly addressed: each sender now reports its own uplink loss and jitter
  in `network_state`, the server relays them as `source_quality`, and
  `selectOwnLinkMeasurements` discounts each stream by its sender's report.
  That fixes the room model (`scripts/test-room-network-scenarios.js`, whose
  B1 rows now hold) but not the browser scenario: there the senders report
  0 % uplink loss, because the SFU's NACKs recover their packets, while the
  fast participant still sees ~70 % loss. The loss is created at the SFU, which
  forwards a frame once complete or skips it, so retransmissions that
  arrive late over a slow lossy uplink never reach receivers. The remaining
  fix is for the SFU to measure each publication's forwarded-versus-expected
  packets and relay that instead of, or with, the sender's own report.
- **B10 — a ghost tile after a signaling stall.** In
  `signaling-stall-during-churn` one participant's signaling is held while
  another leaves and rejoins; when the held `participant_left`,
  `participant_joined` and offers arrive in one burst, the departed tile
  ("Participant left") has stayed next to the rejoined one for more than
  20 s instead of being removed after 1.2 s. Seen once, in the first two
  runs that reached the check, and not since. The `participant_left`
  handler now schedules the tile's removal before its UI updates, so an
  exception in one of them can no longer leave the tile behind; whether
  that was the cause is unproven, so the scenario keeps logging
  `KNOWN ISSUE B10` if it ever reproduces.

- **Fixed: B2–B9 and B11.** Their tests now enforce the fix without a gate.
  - B2, keyframe requests not coalesced: one retry series per publication
    (not per receiver), and relayed PLI/FIR share a 200 ms budget per
    publication with the SFU's own requests, so N receivers losing the
    picture together cost the encoder one keyframe.
    `TestSubscriberKeyFrameRequestsFanInToPublisher`,
    `TestLayerTransitionKeyFrameRetriesPerReceiver`.
  - B3, frames over 128 packets dropped whole: `maxFramePackets` is 512, so a
    1080p keyframe at 3 Mbps (~130 packets) is forwarded.
    `TestVideoFrameBufferMaxPacketsBoundary`.
  - B4, the FPS gate halving a jittered source at the cap: the gate keeps a
    schedule with a quarter-interval slack instead of a minimum gap, so
    capture jitter passes and faster sources are still held to the cap.
    `TestBitrateLimiterFPSGateAtSourceRate`.
  - B5, a peer announced twice when admissions overlap: `admit` now
    broadcasts the joiner's `participant_joined` and replays only
    participants the room already knows (the hub's `announced` set) under
    one lock hold. `TestHubSimultaneousReconnect`,
    `TestHubRestartRejoinWithStaleTokensFillsExactlyFourSeats`.
  - B6, a takeover closing the superseded peer at once: `disconnect` leaves
    a superseded client's media to the takeover, which closes the old peer
    after `supersededCloseDelay`. `TestResumeSupersededPeerCloseDelay`.
  - B7, receiver feedback going to a resumed publisher's old peer: each
    receiver's relay reads a feedback route (peer and SSRC) that a
    publication swap replaces. `TestRouterResumedCameraPublisherRebindsThreeReceivers`.
  - B8, a lossy thin uplink starving its own audio: the documented cause
    (NACKs for frames the SFU drops on purpose) was only part of it.
    Every receiver NACKed each packet lost on the publisher's uplink, on
    top of the SFU's own NACK generator, so the publisher resent each loss
    up to four times and filled the link (its netem class dropped ~5,400
    packets in 8 s against ~145 from the configured loss). A receiver's
    NACK now reaches the publisher only for packets the SFU dropped from
    that receiver's mailbox, the one loss only the publisher can repair;
    the SFU's NACK responder answers downlink loss and its generator
    uplink loss. Audio rose from 107–164 to 264–288 of ~300 packets.
    `TestWeakNetImpairedPublisherUplinkReachesEverySubscriber/lossy_uplink`,
    `TestSubscriberKeyFrameRequestsFanInToPublisher`.
  - B9, a camera turned on after a mid-share resume never shown (viewers got
    one packet, then nothing): a browser closes its old peer connection
    when it reconnects, so the SFU's reads of its publications ended with
    `EOF` about 2 s after the drop and the publications were removed. The
    resume then republished onto whichever free transceivers pion's
    `AddTrack` picked; the owner's new screen took the receivers' old camera
    transceiver and its camera the old screen one. A browser keeps a
    receiver's `track.id` from that transceiver's first use, so the client
    saw the camera as `|screen` and showed nothing. Now the SFU keeps a
    publication whose media ends while its publisher is in the grace window
    or has resumed onto a new peer (`HoldPublications`,
    `keepStoppedPublicationLocked`), and the resume swaps into the same
    senders and transceivers (`migrateTargetsLocked`): track IDs stay right
    and the room is not renegotiated (the scenario went from 34 s to 15 s).
    `TestKeepStoppedPublicationAcrossResume`, `sharer-reconnect-mid-share`.
  - B11, a resumed participant not heard: two causes on that swap path.
    No `ontrack` fires for a swap, so the tile that `participant_left`
    cleared stayed unbound; the client now remembers each participant's
    bound tracks and binds the live ones again on `participant_joined`
    (`web/js/remote-track-memory.js`, `rebindRememberedTracks`). And the
    receiver's sender keeps its SSRC while the source becomes the resumed
    publisher with unrelated RTP sequence numbers and timestamps, which a
    browser's audio receiver dropped as out of sequence; a swapped audio
    target now continues the receiver's stream (`audioRebase`).
    `TestAudioRebaseContinuesSwappedStream`,
    `scripts/test-remote-track-memory.js`,
    `sharer-reconnect-mid-share-impaired`,
    `reconnect-under-impairment-isolated`.

  A `knownIssue("Bn", ...)` check in the browser suite logs `KNOWN ISSUE
  Bn still present` and fails only with `SLOWMEET_KNOWN_FAILING=1`.

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
  `SOAK_IMPAIRMENT=0`). Each impaired window must show traffic in every
  tier's class (a classifier that never matched a port fails the soak).
  The default path lifts each window once its checks finish (about 35 s);
  `make test-soak-netns-strict` (`SOAK_STRICT=1`) holds the full
  `SOAK_IMPAIR_WINDOW_SECONDS`, measures per-participant audio continuity
  (no participant may hear total silence from the room for more than
  `SOAK_STRICT_ROOM_SILENCE_MS`, default 3000) and counts reconnects from
  the moment the tiers are armed.

### Opt-in resilience tests

These cover what the CI set does not: whole-link outages, several
participants reconnecting at once, server restarts, path changes, flapping,
bursty and upload-only links, rooms where nobody has a good link, and the
TURN/TCP fallback. None of them runs in CI.

| Target | What it runs | Time |
| --- | --- | --- |
| `make test-media-e2e-four-resilience` | the `resilience` scenarios below, in the netns | ~35 min |
| `make test-media-e2e-four-resilience-slow` | `link-outage-long`, `long-blackout-retry-budget` | ~15 min |
| `make test-media-e2e-four-netns-strict` | the CI scenarios with their strict checks (per-pair audio gaps, every pair's media after a recovery) | ~30 min |
| `make test-media-e2e-four-reconnect` | clean-link reconnect, identity, takeover and chat-replay scenarios, on the host | ~6 min |
| `make test-media-e2e-four-reconnect-expiry` | the same with a 1 s grace (fresh identity after expiry) | ~2 min |
| `make test-weaknet-extended` | the Go weak-net suite plus thin uplinks, an all-impaired mesh and burst loss | ~5 min |
| `make test-known-failing-go` | the Go tests that pinned B5–B8, all fixed (expected to pass) | ~2 min |
| `make test-soak-netns-strict` | the weak-network soak with full windows and continuity | ~7 min |

Run one scenario with `MEDIA_E2E_FOUR_SCENARIO=<exact name> make
test-media-e2e-four-netns`. Grouped scenarios never match a substring, so
the CI list cannot pick them up by accident.

`resilience` scenarios: `sharer-reconnect-mid-share` (and `-impaired`),
`simultaneous-reconnect`, `server-restart-rejoin`,
`path-change-auto-ice-restart`, `slow-uplink-room`, `bursty-link-room`,
`all-impaired-room`, `reconnect-under-impairment-isolated`,
`rapid-flap-link`, `link-outage-short`, `signaling-stall-during-churn`,
`udp-blocked-relay-failover` and `relay-path-under-loss` (both start a
server with the built-in TURN relay).

How the faults are made:

- **One participant's signaling.** tc cannot single out one browser's
  WebSocket: every browser talks to the server's one TCP port on loopback.
  The scenario re-joins that participant through `scripts/signaling-relay.js`,
  a local TCP relay that can blackhole the connection (hold every byte and
  every close, the way a dead radio looks from both ends), refuse new
  connections, reset live ones, or add delay.
- **All of one participant's UDP.** `armRoleUdpIsolation` in
  `scripts/netem-tiers.js` allowlists the other participants' ports and
  sends every other UDP packet into a tier, so ports the participant opens
  later (a rebuilt peer, an ICE restart) are caught too.
- **New tiers** (`thin-uplink`, `bursty`, `relay-lossy`, `flap`) are
  installed only when a scenario names them, so the CI scenarios keep
  issuing exactly the tc commands pinned by `scripts/test-netem-tiers.js`.
- **Proof of fault.** Every armed tier must show traffic in its class
  counters when the scenario stops it; resilience scenarios also check the
  relay's held bytes or the blackout class's drops.

What the timings pin: the signaling hub evicts a silent participant after
the 60 s pong wait; a takeover or grace-window resume keeps the identity and
a resume after the grace window gets a new one; a restarted server forgets
every reconnect token, so everyone rejoins as a new participant and the
chat history is gone; a client whose media never connects goes Offline
after five failed signaling sessions (2, 4, 8, 16, 30 s apart) and stays
Offline until Leave and Rejoin.

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
