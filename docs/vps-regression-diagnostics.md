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

**Fix deployed on the VPS:** relay all media through TURN over TCP, which the
path cannot cut. coturn is now enabled (compose `turn` profile) and SlowMeet
is configured with `ICE_TRANSPORT_POLICY=relay`, so every viable ICE pair
terminates inside coturn; clients reach coturn over TCP 3478. Verified by
scripted two-participant sessions through the deployed server: 75s with zero
ICE state changes, video+audio received in both directions.

Companion code change: `internal/webrtc/peer.go` skips the 1:1 host-candidate
rewrite when the transport policy is relay (pion rejects the combination
otherwise); regression test
`TestNewPeerWithRelayPolicyAndPublicIPSetsLocalDescription`.

Trade-offs to revisit when the UDP path heals: relay-only routes all media
through coturn (raise `TURN_CPUS` accordingly — done, 1.0), and reverting
`ICE_TRANSPORT_POLICY=all` restores the direct low-latency path for clean
networks. The client's per-user connection-method switcher (auto / direct /
turn-udp / turn-tcp / turn-tls) remains available.

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
- The relay-over-TCP deployment is the correct and only working architecture
  for this path. `ICE_TRANSPORT_POLICY=relay` with TCP-only TURN stays.
- Re-run `scripts/diagnose-vps-regression.sh` (or the raw-UDP/STUN probes)
  periodically: if real STUN flows start passing, the blocking has lifted and
  `ICE_TRANSPORT_POLICY=all` restores the direct path with TURN fallback.
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
