# VPS regression diagnostics runbook (Nov 2026)

Symptom on the VPS deployment: camera/mic are not received by other
participants, and even alone in a room the client cycles "Reconnecting" every
~10 seconds. Reproduces on demand. Local four-person e2e media scenarios pass
at HEAD, so the failure is deployment-environment-specific.

## Resolution (Nov 13, 2026)

The captures below pinpointed the root cause: **the network path between
clients and the VPS kills client→VPS UDP flows to the published ICE port
range after the first ~15-20 packets, while TCP is unaffected and
server→client UDP keeps flowing.** Wire evidence (tcpdump on the VPS NIC
during a live repro):

- Client→SFU: one burst per fresh ICE flow (the STUN/DTLS handshake), then
  silence — consent checks and RTP never arrive, so both ICE agents declare
  `disconnected` ~6s later (Chrome's consent timeout), producing the
  metronomic 10s Reconnecting cycle. Each ICE restart opens a fresh flow that
  briefly works, then dies the same way.
- SFU→client: continuous (that is why clients still received the SFU's
  consent checks while "Reconnecting").
- Plain UDP to a port outside the ICE range flowed for minutes; to an ICE-range
  port, nothing arrived. TCP (signaling WebSocket, SSH) never dropped.
- Server CPU throttling was ruled out (`nr_throttled=0` throughout), as were
  the SFU code changes (the local e2e passes at HEAD; the captures show the
  packets never reach the NIC).

**Fix deployed on the VPS (Nov 13):** relay all media through TURN over TCP, which the
path cannot cut. coturn is now enabled (compose `turn` profile) and SlowMeet
was configured with `ICE_TRANSPORT_POLICY=relay`, so every viable ICE pair
terminated inside coturn; clients reach coturn over TCP 3478. Verified by
scripted two-participant sessions through the deployed server: 75s with zero
ICE state changes, video+audio received in both directions.

**Product decision (Nov 14): direct-first is the default again.** The
deployment moved back to `ICE_TRANSPORT_POLICY=all` (coturn and TCP-only TURN
URLs stay — TURN/TLS on 5349 with the ACME cert was added as a second
fallback), so direct candidates win whenever the network allows them and the
connection-method switcher offers every choice. Because the path cuts
direct-led sessions, the client recovery learned to converge instead of
cycling (commits 7abb0e3/ecb1edf):

- an ICE-restart waits 12s (instead of 5s) when relay candidates were
  gathered, letting Chrome nominate the fallback pair naturally;
- after two direct-led restart cycles, an "Automatic" session stops
  restarting and reconnects with its peer built as TURN/TCP — no UDP burst
  races the relay allocation, so it lands on a stable relay pair (verified:
  2 cycles, then stable relay→host for 60s+); explicit user method choices
  are never overridden, and the strike count resets on page load.

Companion code change: `internal/webrtc/peer.go` skips the 1:1 host-candidate
rewrite when the transport policy is relay (pion rejects the combination
otherwise); regression test
`TestNewPeerWithRelayPolicyAndPublicIPSetsLocalDescription`.

Trade-offs to revisit when the UDP path heals: with direct-first, sessions on
this path spend ~20-30s reconnecting before settling on relay, and relay
routes all fallback media through coturn (`TURN_CPUS` raised to 1.0). When
the STUN probe reports CLEAR, the transient cycle disappears on its own and
direct carries all traffic. The client's per-user connection-method switcher
(auto / direct / turn-udp / turn-tcp / turn-tls) remains available.

## Regression and fix (Nov 17): the failover handoff stopped firing

After deploying master `c3ce35b`, the automatic direct-UDP → TURN/TCP
handoff stopped switching. The deployed server posture was verified correct
(`GET /ice-config`: `ice_transport_policy=all`, TCP 3478 + TURNS 5349 URLs,
`turn-tcp`/`turn-tls` enabled+available), and the served client bundle was
the new build (`/js/path-memory.js` present) — the break was client-side.

Root cause: commit `32a6d4b` ("reset TURN/TCP failover strikes when a peer
connects") cleared the strike latch unconditionally in the ICE-connected
branch. On this path every ICE restart *briefly connects the dying direct
pair* (see Resolution), so the latch was washed back to zero each cycle and
never reached its limit of 2 — the session cycled restarts forever without
rebuilding the peer as TURN/TCP. The same momentary-connect flaw cleared the
24h direct-UDP failure memory in the stats loop (3d4981d), so the second
fallback trigger was wiped too. This is the same bug class `ecb1edf` fixed
for the restart-attempt counter.

Fix (client-only): a momentary `connected` transition is no longer treated
as proof. The latch and the remembered failure now clear only after a live
non-relay pair has held on a connected peer for 30 consecutive diagnostics
samples (`directPathStableResetSeconds`); flapping cycles are far shorter,
so the latch survives to reach the handoff. To keep `32a6d4b`'s protection
(stale strikes must not strand a deployment with **no** TURN configured at
the "Method unavailable" dead end), `effectiveConnectionMethod` only diverts
to `turn-tcp` when the server actually enables that method. Tripwires:
`scripts/test-renegotiation-queue.js` (latch shape + guard) and
`scripts/test-connection-methods.js` (gated memory clear).

### Completion (Nov 17, later): the latch also stopped *filling*

Keeping the latch from being washed was necessary but not sufficient on the
live path. Wire evidence from a fresh repro (server logs + coturn RSTs
correlated per cycle; two headless fake-media participants reproduced the
exact metronomic `connected → disconnected` churn in ~5s cycles): the
transport dies ~5-7s after each connect with **no TCP teardown at that
moment** — coturn only sees the client's clean FIN ~10s later, when the
client rebuilds. Each doomed direct pair *self-recovers* into `connected`
(a fresh flow gets the path's small packet allowance again), and that
recovery cancels the pending ICE-restart timer (`iceRestartRelayGraceDelayMs`
= 12s never elapses), so `requestIceRestart` — the only strike source —
never ran. Strikes stayed at zero not because they were washed but because
nothing accrued them; the handoff still never fired.

Completion (client-only): every direct-led disconnect **episode** now counts
one strike (`noteDirectLedDisconnectEpisode`, deduped per episode, called
from both the `disconnected` and `failed` branches), and once the latch is
full the session hands off to the reconnect state machine directly — no
dependence on a restart actually firing. Relay-led blips do not count; the
restart-driven path remains for attempts that do fire; `requestIceRestart`
keeps the handoff check but no longer increments (one episode = one strike,
never double-counted). Convergence contract restored: ~2 doomed episodes
(~20-30s) → peer rebuilt as TURN/TCP, which the wire probes show holds
indefinitely (120s forced-`turn-tcp` session: zero ICE transitions).

## Original diagnosis notes (Nov 13)

- The deployed binary is committed `d759b35` — confirmed by rebuilding that
  commit with the Dockerfile flags and matching the handoff-recorded deployed
  hash (`b138b6ca…`). The regression window is whatever ran before that deploy.
- The client "Reconnecting" label only appears on real ICE
  `disconnected`/`failed` states (`web/js/app.js` `updatePeerConnectionUI`),
  and the ~10s cadence matches Chrome's ~5s consent-loss detection plus the
  client's 5s `ice_restart` retry timer. Something is making ICE consent fail
  persistently on the VPS.
- Known server-side risk from the CPU investigation
  ([vps-cpu-investigation-handoff.md](vps-cpu-investigation-handoff.md)):
  0.75-core container quota with documented throttling, 75-80% system CPU,
  coturn limited to 0.20 CPU.

## Probe campaign (Nov 14): the policer's rule, fully characterized

An attempt to restore the direct UDP path by moving the ICE port range was
probed out. Sustained single-flow probes from a client machine (tcpdump on the
VPS eth0 verifying arrivals, 20s per probe):

| Flow | Port(s) | Result |
|---|---|---|
| plain UDP 50pps, 1000B | 50050 (current ICE range) | **passes** (~95% arrived, no cutting) |
| plain UDP 50pps | 40050, 60050 (fresh ranges) | passes |
| SRTP-shaped (RTP v2 header + random payload) 220pps | 50050, 40050, 60050 | **passes** (~97% arrived) |
| real WebRTC session (STUN+DTLS+SRTP) | current range | **cut ~1s after handshake** (metronomic cycle returns) |
| real STUN Binding Requests 50pps (valid structure) | 3478 (coturn) | **exactly 16 arrived, then silence** for the remaining 21s |
| invalid STUN-shaped payload (magic cookie, bogus length) | 41234 | passes |

**Rule:** the path allows roughly the first 16 packets of any UDP flow, then
cuts flows that carry *structurally valid* STUN messages — regardless of port
(3478, 50000-50100, fresh ranges), rate, or packet size. Plain UDP and
non-STUN traffic flow indefinitely; TURN over TCP also flows (STUN inside TCP
is not inspected). This is deliberate, content-validating WebRTC blocking —
characteristic of ISP-side anti-VPN filtering, not of a server or code fault.

**Re-probed Nov 14:** the rule is stable. Valid STUN to coturn:3478 was cut
again after ~12 packets (12 of 1092 arrived, all in the first 0.3s); plain UDP
on a ufw-allowed port passed fully (969/995); plain UDP on a non-allowed port
was cut mid-flow (~43%) — inconsistent treatment of non-service ports, but
operationally irrelevant. The WebRTC block has not lifted; the relay-only
deployment remains correct.

**Re-probed Nov 15:** rule unchanged — 733 valid STUN Binding Requests → 14
responses (first 0.37s only), while 1093/1094 plain UDP packets arrived on a
allowed port. TURN-over-UDP was also re-tested end-to-end (UDP TURN URL added
to TURN_URLS): allocations survive the allowance but the sustained relay pair
is cut mid-session, so the UDP entry was reverted; TCP/TLS relay remains the
working path. Direct-first still converges on relay within ~2 cycles.

**d759b35 revert A/B (Nov 14): no effect, as predicted.** A binary built at
`db9ac7f` (this repo's `d759b35`'s parent — identical code minus exactly
d759b35's rate limiters, `network_state` validation, and systemd `GOMEMLIMIT`
line) was deployed temporarily with `ICE_TRANSPORT_POLICY=all`. The valid-STUN
cut was identical (725 real Binding Requests → 12 responses, all within
0.5s), and the solo session cycled without converging within the window. This
matches the wire evidence: d759b35 is signaling-layer only and cannot alter
the fate of browser-generated UDP packets that never reach the server. The
revert is not a fix and was not kept; the HEAD deployment was restored and
re-verified (2 cycles → stable relay→host).

**Re-checked again the same day** with the one-command marker probe
(`scripts/probe-stun-path.sh`, runnable from any machine or network): 729 real
Binding Requests → 16 responses, all within the first 0.5s. Same verdict. The
script prints the operational verdict itself and needs no root or server
access — run it periodically to detect when the blocking lifts.

**Consequences:**

- Moving the ICE port range cannot restore direct UDP: real WebRTC requires
  valid STUN (ICE mandates it), and valid STUN is exactly what gets cut.
- TURN over UDP is equally cut (it is STUN over UDP) — confirmed live when the
  relay-UDP pair died mid-media during the original diagnosis.
- The relay-over-TCP architecture is the only working fallback for this path.
  Since Nov 14 the product default is direct-first (`ICE_TRANSPORT_POLICY=all`)
  with this relay as the automatic fallback and a client-side learning rule
  (see the product-decision note above); relay-only remains the posture for
  deployments on fully-blocked paths.
- Re-run `scripts/probe-stun-path.sh` (or `scripts/diagnose-vps-regression.sh`)
  periodically: if real STUN flows start passing, the blocking has lifted and
  direct-first sessions stop cycling entirely — no config change needed.
- A phone on mobile data joins with relay like any other client; testing there
  only tells us whether a *different* ISP also blocks (useful to attribute the
  blocking to the home ISP vs the provider edge, not to change the fix).

## Session flow

Run the [diagnostic script](../scripts/diagnose-vps-regression.sh) ON THE VPS
(read-only; safe during a live call):

```sh
# 1. Baseline snapshot: container limits + image revision, cpu.stat, sockets,
#    last 6h of filtered signaling/media logs.
./scripts/diagnose-vps-regression.sh baseline

# 2. Live capture: start this, then reproduce the Reconnecting cycle.
./scripts/diagnose-vps-regression.sh watch 180

# 3. While the repro is still active: 30s CPU profile + heap + goroutines.
SLOWMEET_ADMIN_PASSWORD=... ./scripts/diagnose-vps-regression.sh profile

# 4. After the repro: throttling/socket deltas vs the baseline.
./scripts/diagnose-vps-regression.sh summary
```

Archive `/tmp/slowmeet-diag-<timestamp>/` from each step and share it. Do not
share the admin password.

## Live call CPU capture (handoff step 2)

One command captures everything the [CPU investigation handoff](vps-cpu-investigation-handoff.md)
step 2 asks for during a real call — per-interval samples of cgroup CPU
(including the user/system split), throttling, CPU pressure, the app process's
own utime/stime, per-interface packet counters, `/metrics` quality gauges, the
filtered signaling log timeline, and a metadata block (capture window, container
image + revision, **binary sha256**, CPU quota, kernel, workload note). All
streams share one epoch, so a slow interval aligns across files.

```sh
# Start the capture, then join/keep the five-device call for the window.
SLOWMEET_CAPTURE_NOTE="five-device call" \
  ./scripts/diagnose-vps-regression.sh capture 300

# Optional: also take a binary CPU profile mid-window (needs the admin
# password; the profile overlaps the load by starting a third of the way in).
SLOWMEET_CAPTURE_PROFILE=1 SLOWMEET_ADMIN_PASSWORD=... \
  ./scripts/diagnose-vps-regression.sh capture 300
```

Knobs: `SLOWMEET_CAPTURE_INTERVAL` (default 2 s — the effective cadence is
slightly longer because `docker stats`/`docker exec` probing takes a second),
`SLOWMEET_CAPTURE_PROFILE_SECONDS` (default 15), `SLOWMEET_CAPTURE_NOTE`
(free-text workload description stored in `metadata.txt`). Ctrl-C stops early
and still finalizes the metadata and log timeline.

What each output answers: `cpu-interval.log` (throttling + user/system split),
`pressure-interval.log` (PSI), `process-interval.log` (process-level split),
`packets-interval.log` (packet rates = post-hoc deltas), `metrics-interval.log`
(reconnects, RTT, loss, jitter, bitrate gauges — room-global, last-reporter
values), `logs-capture.txt` (the media-path event fingerprints),
`cpu-pprof.pb` (binary profile when enabled), `metadata.txt` (identity).
Rates and deltas are computed post-hoc from the counter series. The capture is
read-only and safe during a live call; archive the directory the same way.

## Client-side capture (browser)

During the same repro:

1. Open `chrome://webrtc-internals`, click **Create Dump**, then download the
   dump file. Key fields: `type: icecandidatepair` / `selected-candidate-pair`
   (`localCandidateType` — `host`/`srflx` vs `relay` tells us whether media is
   going through TURN), `bytesSent/Received` deltas, ICE state timeline.
2. The meeting page's settings sidebar prints a live diagnostics JSON every
   second; a copy of it around a Reconnecting flip is useful too.

## What each outcome means

| Observation | Conclusion |
|---|---|
| Server logs show `network_degraded`/`webrtc_failed` at the same ~10s cadence as the client | Real consent failure on the SFU↔client path — check `summary` throttling delta and the selected candidate pair |
| `nr_throttled`/`throttled_usec` climbs steeply during the repro | 0.75-core quota starvation — raise `SLOWMEET_CPUS` (the Nov 12 trial at 1.0 eliminated throttling) |
| Selected candidate pair is `relay` | Everything goes through coturn (0.20 CPU) — direct path is broken (firewall/`ICE_PUBLIC_IP`/STUN reachability) or coturn is saturated |
| Server ICE stays connected while clients flap | Signaling/client side — check `invalid_message`, `ice_restart_rate_limited`, `video_subscriptions_rate_limited` warnings (added Nov 13) |
| `media_publication_read_stopped` / `media_publication_replaced_track` bursts | Router teardown/swap churn — code fix + regression test |

The diagnostic logging build (limiter-drop and `invalid_message` warnings,
plus a `runtime_info` startup line reporting GOMAXPROCS/NumCPU/mem limit) can
be deployed for a second capture pass if the first pass is inconclusive.

## Nov 18, 2026: SFU audio loss on relayed calls and the reconnect mute

Two-person browser trials with generated media (120 s, forced TURN/TCP and
TURN/TLS, with and without a verified Xray proxy route) reproduced the
"Connected but unusable" complaint and separated two application defects from
the degraded client↔VPS path:

1. **The SFU discarded compliant audio catch-up bursts.** Header-only tcpdump
   inside the SFU namespace showed inbound Opus arriving with **zero sequence
   gaps** while the forwarded stream lost 360–465 packets. TCP head-of-line
   blocking releases ~1 s of audio at once; the audio admission bucket allowed
   only max(rate/10, 1200 B) ≈ 100 ms of burst, and each receiver's audio
   mailbox was 4 packets deep with no age limit — together they dropped
   21–28% of inbound audio while ICE stayed connected.
2. **The Automatic handoff muted the microphone.** `resetMediaConnection`
   cleared the capture stream and refreshed controls (washing
   `aria-pressed`), and `startWebRTC` restored `track.enabled` from that
   washed attribute, so both clients went silent after every peer rebuild.

Fixes (commit `857e1dd`): `internal/media/audio.go` adds a bounded 2-second
byte-credit window at the configured cap and a 256-packet audio mailbox with
80 ms expiry and immediate drain (no pacing, video path unchanged), plus
aggregate drop counters (`slowmeet_audio_{admission,queue_overflow,queue_expired}_drops_total`,
`slowmeet_audio_write_failures_total`). `web/js/app.js` adds a
`microphoneRequested` intent state that survives peer rebuilds, honors device
replacement, and resets on intentional leave.

Gates: full `make check`; focused burst tests (race) and a real-peer burst
integration test (zero drops, 3 runs); replay of the captured bursts (3361 /
3361 admitted); the Go weaknet netns suite 9/9; impaired four-person browser
scenarios. `blackout-and-recovery` also had a pre-existing flaky assertion —
raw 2 s counter deltas fail when a peer replacement resets counters (CI on
unmodified `1129c18` reproduced it with a negative frame delta); the scenario
now polls with `waitForAudioFlow`.

Live verification after deploying the patched image (rollback retained):

| Check | Before | After |
|---|---|---|
| Inbound audio loss (forced TURN/TCP, direct route) | 1,066–1,709 packets (21–28%) | 0 on both participants |
| SFU wire gaps (header capture) | 360–465 output gaps on 0-gap input | 0 in → 0 out |
| Inbound audio bitrate | 23–25 kbps vs 32 kbps outbound | ≈32 kbps, matches outbound |
| Proxy route (TURN/TCP via verified Xray) | 21–26% loss | 0 loss, 0 wire gaps |
| Mic after two Automatic rebuilds onto relay/TCP | muted | enabled preserved |
| Drop counters | invisible | 0/0/0 across all trials |

The 717 counted egress write failures are transport errors during the
trials' RTT spikes — previously invisible, now observable.

Still unresolved and environmental: the client↔VPS path has severe delay
spikes (RTT median 550–680 ms, max ~4.8 s during the Nov 18 trials), which
still trigger protect-audio video suspension. The repairs remove the SFU's
self-inflicted audio loss and the reconnect mute; they cannot fix the route.
Real-device and different-ISP comparisons remain pending user-side checks.

## Nov 18, 2026 (later): a resumed participant received no audio after a grace reconnect

The four-person netns CI job failed deterministically on
`blackout-and-recovery`, `all-distinct-qualities`, and `delay-and-jitter-links`
with "P2 inbound audio never flowed (last=0)" — the impaired participant is
the only one that rebuilds its peer, and only its inbound audio was zero while
ICE stayed connected and its outbound media flowed.

Instrumented router traces (temporary debug logging, since reverted) captured
the exact sequence on a pinned 2-core reproduction of the CI environment:

1. The impaired client disconnects; the reconnect-grace path arms a pending
   reconnect and **defers** the superseded client's teardown
   (`teardownClientMedia`), so the dead peer's receiver targets stay
   registered under the participant ID in every publication.
2. The client resumes; `Register` re-queues subscriptions — but
   `queueSubscriptionLocked` sees the stale target and skips every one.
3. Camera publications self-heal only because the resume churn replaces them
   (the swap removes the stale target and re-queues); **audio publications
   are long-lived and never swap while their publisher keeps flowing**, so
   the rebuilt peer never gains an audio receiver: zero inbound audio for the
   rest of the meeting. The standalone uclient and burst probes could not see
   this because it only manifests across a peer rebuild on an impaired
   participant.

Fix: `Register` now purges any target still registered under the incoming
participant ID before queueing subscriptions — at registration the ID always
belongs to a brand-new peer, so such targets can only be the dead
predecessor's (`internal/media/router.go`). Regression test
`TestRouterRegisterReplacesSupersededReceiverTargets` fails on the unfixed
router (no offer is ever dispatched to the rebuilt peer) and passes with the
fix. The four-person harness also lightens the netns media profile (240p
captures, smaller viewport) so the 2-core CI runner can feed four encoders in
real time, and failure artifacts now record per-peer transceivers and
inbound-RTP state for this class of diagnosis.

Pinned 2-core verification after the fix: all three previously failing
scenarios plus `ice-restart-under-impairment` and `cold-join-under-impairment`
pass; the same three pass unpinned; `make check` green. The CI failures on
unmodified `1129c18` had the same signature — they were this defect, not
environment starvation alone.

## Nov 19, 2026: TCP relay flows degrade ~20 s in; relay rotation

TURN over TLS on 443 (HAProxy SNI split: `turn.<domain>` to coturn's TLS
listener, everything else to Caddy with PROXY v2; coturn needs
`relay-ip=<public IP>` because HAProxy reaches it over loopback) did not
improve calls. Proxy-free headless Chrome trials from the affected access
network isolated the cause:

| Path (same moment) | Result |
|---|---|
| Plain SSH echo stream, 400 kbps both ways, 90 s | ~75 ms, no stalls |
| Generated audio+video over TURN/TLS 443 or TURN/TCP 3478 | clean (RTT ~155 ms, 20 fps) for ~20 s, then RTT 1–3 s, 10–17 freezes |
| Same, TURN tunneled through SSH | 60 s clean |
| Same over TURN/TLS 443 with an ICE restart every 15 s | 90 s clean: 0 freezes, RTT 150–165 ms |

Client-side `ss` showed the sender's own TURN socket retransmitting
continuously from second ~19 while the server-side socket stayed at ~80 ms
with almost no retransmits: the access network drops uplink packets on a
long-lived real-time TCP flow, independent of port, TLS, and SNI, and a new
connection is clean again. Video was ~200 kbps, so this is not a bandwidth cap.

Fix: relay rotation (`web/js/relay-rotation.js`, `TURN_TCP_ROTATE_SECONDS`,
default 12). Verified locally with two browsers forced onto TURN/TCP through a
throwaway coturn: rotations every interval + ~1 s with no drift, one peer
connection throughout, never leaves `connected`, no status flicker, inbound
audio advances in every 3-second window, and each rotation moves media to new
TCP connections (old ones close after ~90 s, so the count plateaus).

First live deploy found one more defect: Chrome reports the selected pair as
`in-progress` while a connectivity check is outstanding, and the shared
`selectedCandidatePair()` only accepts `succeeded` pairs, so the rotation
clock reset every few seconds and rotations stopped (throttle returned with
RTT spikes to 4.5 s). Rotation now reads the transport's selected pair in any
check state and only restarts its clock after 3 s off the relay. Live
verification over the affected ISP path (two headless participants, TURN/TLS
443, production coturn):

| Rotation | Duration | RTT median | RTT max | Samples > 500 ms |
|---|---|---|---|---|
| on (12 s) | 120 s | 77–79 ms | 103–105 ms | 0 |
| off (control) | 90 s | 115–180 ms | 0.9–1.5 s | 8 per participant |

## Nov 19, 2026 (later): rotation as explicit methods, in-place switching, faster Automatic

Rotation is no longer implicit on every TCP/TLS relay. It is now two
connection methods (`turn-tcp-rotate`, `turn-tls-rotate`); the plain methods
never rotate. `Automatic` falls back in the order rotating TCP, rotating TLS,
TCP, TLS (TCP first since real calls on this path ran better over TURN/TCP) and, on a rotating relay, probes the plain relay in the background
(see `docs/configuration.md`).

Two latency fixes for networks like this one:

- A method change (and the Automatic handoff) used to close the socket, rejoin
  and restart capture. It is now `setConfiguration` plus a planned ICE restart
  on the live peer. `make test-relay-rotation-e2e` (loopback TURN/TCP, two
  Chromium participants) measured 0.2-0.5 s for relay to direct or plain to
  rotating and about 3 s for direct to relay, with the same WebSocket and
  RTCPeerConnection throughout and the other participant's audio never
  stalling.
- Automatic needed two direct-led disconnect episodes plus a rejoin before it
  used a relay. A direct path that dies within 20 s of first connecting now
  hands off immediately and in place.

Review fixes to the first rotation change: the rate-limit refusal is matched
by a stable error `code` instead of message text; `ice_restart` carries a
`reason` (`rotate`/`switch`) that the server validates, logs at debug level,
and counts in `slowmeet_ice_restarts_total{reason}`.

## Nov 19, 2026 (evening): video froze ~2 s at every rotation; make-before-break ICE restart

A real call on the rotating method showed the remote video stopping for about
2 s every rotation. Cause: `pion/ice` `Agent.Restart` is break-before-make. It
clears the selected pair and closes all candidates when the server creates the
restart offer, so the SFU can neither send nor receive until the restarted
session selects a pair (answer round trip, the browser's new TURN/TCP
allocation, connectivity checks). Chrome keeps its old pair until the new one
works, which is why the browser-to-browser trials never showed it, and the
earlier rotation checks only looked at RTT and coarse audio progress.

`internal/webrtc/restart_continuity_test.go` reproduces it without a browser:
with the client's answer held for 1 s, a 50 packets/s stream went silent for
1.22 s in both directions on upstream pion.

Fix: a vendored, patched `pion/ice` (`third_party/`, see its README) keeps the
previously selected pair carrying media until the new pair is selected, and
keeps receiving on it while the browser still sends there. Results in
`make test-relay-rotation-e2e` (camera and microphone on, 100 ms sampling):

| | Longest audio gap | Longest video gap | Video freezes |
|---|---|---|---|
| Across two rotations per participant | 100 ms | 100-200 ms | 0 |
| Direct -> rotating relay switch, both directions | 100 ms | 100-200 ms | 0 |

(100 ms is the sampling interval.)

Live, over the affected ISP path (two headless participants, camera and
microphone on, TURN over TLS rotating through the production coturn, 73 s
measured, 100 ms sampling):

| Image | Longest audio gap | Audio gaps > 500 ms | Longest video gap | Video gaps > 700 ms | Freezes |
|---|---|---|---|---|---|
| upstream pion/ice | 2.2 s | 6-7 | 3.3-3.4 s | 7-11 | 10-11 |
| patched pion/ice | 101 ms | 0 | 200 ms | 0 | 0 |

One side effect to know: when a relay
replaces a direct pair, Chrome keeps the old direct pair selected until its own
5 s connectivity timeout, so the reported path changes about 5 s after the
switch although media flows throughout.

During a restart the server holds one extra UDP port per restarting
participant for up to 10 s; keep `ICE_UDP_PORT_MIN`-`ICE_UDP_PORT_MAX` larger
than twice the room size.

## Nov 20, 2026: rotation overhead removed; RTCP relay mix measured

Two costs paid on every rotation bought nothing once restarts became
make-before-break:

- The answer handler requested video keyframes after every answer, including
  rotation restarts. A pure `rotate` restart now requests none (recovery and
  `switch` restarts, and a rotation merged with queued renegotiation, still do).
- The server's own peer connections were given the TURN URLs, so every ICE
  gathering, and every rotation, made the SFU allocate relays on coturn that
  were never used. With `ICE_PUBLIC_IP` set and a non-`relay` policy the
  server peer now gets no TURN servers.

Live, over the affected ISP path (two headless participants, camera and
microphone on, TURN over TCP rotating, 73 s, 11 rotations in total):

| Per participant | Before | After |
|---|---|---|
| Keyframes encoded | 22 | 0 |
| PLIs received | 33 | 0 |
| Relay candidates offered by the server | 4-6 | 0 |
| Longest audio / video gap | 200 ms / 200 ms | 200 ms / 200 ms |
| Video freezes | 0 | 0 |

SFU CPU time for the run was the same within noise (3.35 s both), and the
generated 160 kbps test video is too small for the keyframe saving to show in
bitrate; the saving grows with real camera resolution and with room size
(one forced keyframe per viewer per rotation, per publisher).

RTCP relay mix from the same run (`slowmeet_rtcp_relayed_total`): 2,576
forwarded batches in about 80 s for two participants, of which 2,573 (99.9%)
carried no PLI/FIR/NACK: 2,394 transport-cc feedback packets, 179 receiver
reports, 3 PLIs. Almost everything the SFU encrypts and sends to publishers on
this path is subscriber transport-cc feedback. Whether to stop forwarding it
is an open decision (it needs an A/B on publisher bitrate adaptation); the
counters are in place for it.

Also added: an optional host-network compose override
(`deploy/compose.host-network.yml`). On this VPS Docker's userland proxy runs
101 processes (106 MB) for the ICE UDP range.

### Host networking applied on the VPS (Nov 20)

A/B with temporary instances over the affected ISP path (same image, two
headless participants on rotating TURN/TCP, 75 s per run):

- Host networking as first written produced one 2-5 s audio/video gap per run
  (5 of 5 runs) while bridge runs were clean. Cause: on the host network the
  SFU also sees `docker0` and the compose bridge, and the 1:1 public-IP
  rewrite advertised candidates on those interfaces under the public address;
  ICE restarts stalled on them. `internal/webrtc/peer.go` now gathers only on
  the public interface when `ICE_PUBLIC_IP` is one of the host's own
  addresses. With that fix: 3 of 3 host runs with no gap above 200 ms.
- CPU per 75 s run (after the fix; 3 host runs, 2 bridge runs): SFU 2.53 s vs
  2.65 s, coturn 2.82 s vs 3.05 s, whole host 28.9 s vs 30.5 s busy. A 5-8%
  reduction, close to run-to-run noise.

Live container switched to `deploy/compose.host-network.yml`:

| | Bridge | Host network |
|---|---|---|
| `docker-proxy` processes | 102 | 0 |
| Memory used by them | 105 MB | 0 |
| Available memory | 645 MB | 781 MB |
| Processes on the VPS | 147 | 45 |

## Nov 19, 2026 (audit): load and slow-link fixes from a code review

A read-through of the server, client, and installer, with no live call to
measure (the container had just restarted). What changed and what is and is
not measured:

- **Subscriber RTCP is no longer forwarded wholesale.** The SFU forwarded
  every RTCP batch a subscriber sent about a track to that track's publisher.
  The Nov 20 counters put 99.9% of those batches at transport-cc feedback and
  receiver reports, which describe the SFU-to-subscriber leg in the
  subscriber's SSRC and sequence space; the SFU already sends publishers its
  own reports and transport-cc feedback. Only PLI, FIR, NACK, and REMB are
  forwarded now (`slowmeet_rtcp_forwarded_batches_total`).
- **Opus DTX** (`OPUS_DTX_ENABLED`, default on). Estimate, not measured: in a
  five-person call with one speaker, audio drops from about 1,000 forwarded
  packets per second to about 240.
- **WebSocket compression.** Measured with the server's own offer: 21 KB for 8
  media sections (4.5 KB per video section), 2.2 KB deflated. A five-person
  room on a rotating method exchanged roughly 26 KB each way every 12 s per
  participant, about 17 kbps per direction, before compression.
- **RTT bands relative to the path's floor** (see `docs/configuration.md`):
  with fixed bands a healthy relay path at 120-250 ms could step quality down
  but never up, and an automatic video pause could not lift.
- **Uplink loss signal revived.** It read `packetsLost` from `outbound-rtp`,
  which has no such field; it now reads the paired `remote-inbound-rtp`.
- **Reconnect attempts** are cleared when media connects, not when the socket
  opens; before, the retry limit was unreachable and the delay stayed at 2 s.
- **Plain TURN/TCP and TURN/TLS** get a banner offering the rotating variant
  when the stall signature shows, and a 5 s instead of 12 s recovery restart.
- **Installer:** the coturn CPU bump never applied (the shipped `.env` value
  counted as "already set"); coturn could not read its certificate (image
  user `nobody`, files `root:caddy 0640`), so TURN/TLS never started on
  installer-made deployments; coturn relayed to any peer. coturn's
  allowed-over-denied precedence was checked against the 4.18 image.

Still open: ICE-TCP on the SFU (would take coturn out of the media path; the
vendored ICE patch must cover it), `net.ipv4.tcp_notsent_lowat` to bound relay
queueing on slow downlinks, and one `turns:` URL instead of two per rotation.

## Nov 19, 2026 (audit, second batch): smaller client and installer fixes

- **Rotation gathers on one TURN URL.** With two `turns:` URLs configured,
  every rotation was two TLS handshakes and two allocations for one used pair.
  The peer's server list is reduced to the selected relay's URL before a
  rotation and restored before a recovery restart. Checked in
  `make test-relay-rotation-e2e` with two loopback TURN servers: both used for
  the first connection, one kept from the first rotation on, no media gap.
- **Quality ladder flapping.** A stale poor streak stepped every fresh climb
  straight back down, so a link between the two lowest levels switched about
  every 6 s. Both streaks now restart on every transition and a failed climb
  doubles the wait before the next one (5, 10, 20, 40, 60 samples).
- **Saved connection type survived a failed `/ice-config`.** One failed fetch
  used to overwrite the saved type with Automatic. Checked in headless
  Chromium: with the request blocked the selector shows Automatic and storage
  keeps `turn-tcp-rotate`; the next normal load selects it again.
- **Hidden tabs.** Adaptation used to stop entirely in a hidden tab while the
  rotation check still called `getStats` every second. Measured over 12 s on a
  local server: 12 calls visible, 4 hidden, with adaptation running.
- **Plain-relay probe** starts only with 150 kbps of estimated headroom.
- **Certificate renewal** signals coturn (`SIGUSR2`) instead of restarting it.
  Checked against the 4.18 image: the served certificate changes after the
  signal and the process stays up.

Not changed on purpose: the 24-hour expiry of a remembered direct-UDP failure
is the only moment Automatic re-tests direct UDP.
