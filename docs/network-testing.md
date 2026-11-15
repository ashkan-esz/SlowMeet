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

  Run the whole gated set the way CI does:

  ```sh
  MEDIA_E2E_FOUR_SCENARIO="mixed-quality-room,screen-share-mixed-quality,fluctuating-link,slow-bandwidth-room,reconnect-under-impairment,ice-restart-under-impairment,reconnect-after-expiry-under-impairment,cold-join-under-impairment,blackout-and-recovery,all-distinct-qualities,impaired-sharer-screen-share" make test-media-e2e-four-netns
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
  clean soak (`make test-soak`) is unchanged. Not gated in CI — opt-in
  until its runtime is proven stable.

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
