# Severe-tier inbound-audio blackout — root-cause classification

Closes the open item from the weak-network soak work: under sustained severe
impairment, a participant's inbound audio can go silent for ~20–30 s. The soak
tolerates ≤30 s via a wait-for-flow allowance; this pass instruments the soak
so the cause is measured, not guessed.

## Instrumentation (all harness-side, no product changes)

`scripts/test-soak.js` + `scripts/netem-tiers.js` now write three correlated
evidence streams into `soak-artifacts/<run>/`:

1. `audio-timeline.json` — every participant's cumulative audio bytes
   (sent/received, from `getStats`) sampled at 1 s, timestamped against a run
   epoch (`timelineEpoch`).
2. `server.log` — the previously-discarded server stdout, each slog line
   prefixed with its offset from the same epoch. `SOAK_LOG_LEVEL=debug`
   opts into SDP/renegotiation lines (default `info` keeps artifacts small).
3. `netem-snapshots.json` — `tc -s class/qdisc show dev lo` captured at each
   dark onset/end detected by `assertAudioAdvanced`, plus window boundaries.

## What was measured (3 instrumented runs, 2026-11-15)

- **The severe tier's queue drops ~85–92% of all packets.** `tc -s` on class
  `1:30` (100 kbit, limit 20, both directions) at a dark-onset snapshot:
  `1427 pkt sent, dropped 17569` — the severe participant's own camera uplink
  (~300 kbps encoded) plus the ~182 kbps forwarded downlink mix oversubscribe
  the 100 kbit class ~5×, and the shallow queue turns the overflow into drops.
- **An established peer receives a thin trickle, never a flatline.** P3's
  per-second `received` deltas: median 644–1390 B/s (a clean peer runs
  ~4 kB/s), **zero flat samples across both runs** — once connected, the 1 s
  counters always advance. Pure FIFO starvation of an established flow is
  therefore NOT the blackout.
- **Peer rebuilds are visible as large negative counter jumps** (the rebuilt
  peer's counters restart at zero): largest observed −164 810 bytes at
  +73.3 s into run 1. The server log has **no events within ±8 s** of that
  jump — the rebuild is client-initiated (exhausted-restart media reconnect),
  and its server-side SDP fingerprints are Debug-level, suppressed at the
  default `info`.
- **Resumption through the starved queue is the blackout.** After a rebuild,
  ICE connectivity checks and the DTLS handshake must traverse the ~90%-drop
  queue; each check succeeds with ~8–15% probability and the handshake needs
  multiple round trips, so resumption takes tens of seconds of retries. The
  occasional short dark blip (a 13 ms one was caught onset→end in run 1) is a
  rebuild whose checks got lucky.

## Classification

**Compound: client-side rebuilds are the trigger, netem starvation is the
amplifier.** The blackout is not an SFU forwarding pause and not starvation of
an established flow — it is the *re-establishment* of media through a queue
that drops ~90% of everything, after the client's own impairment recovery
(rebuild) fires. The soak's ≤30 s allowance is a reasonable bound for that
resumption; permanent silence still fails it.

## Follow-up levers (deliberately not done here)

1. **Severe → downlink-only** (like `capped`): removes the uplink camera from
   the queue, dropping the loss rate sharply — but P3's camera degradation
   assertions then need rethinking (its camera would flow clean).
2. **Exempt consent/DTLS from shaping**: a `tc filter` priority for small
   packets (ICE checks, DTLS records) keeps resumption fast while the media
   queue stays saturated — closest to how real radios treat control traffic.
3. **Cap the severe participant's own camera** client-side: resolved as
   **uplink blindness** — code-verified that the adaptation classifier cannot
   see its own uplink loss (`outbound-rtp.packetsLost` is never read; loss
   inputs are inbound-only; only RTT excursions and the candidate-pair BWE
   carry uplink evidence, and BWE feeds `poor`, never `critical`). The
   sender-side actuator exists; the signal does not. Recorded as a needs-decision
   ledger entry (docs/project-review.md §8) — making the client uplink-aware is
   a product change deferred out of this pass.

Any of these is a behavior change to the impairment tiers/scenarios and needs
the network-first review; the instrumentation now in place will measure
whichever is chosen (drop rates before/after are one `tc -s` snapshot away).

## Artifacts

`soak-artifacts/2026-11-15T21-35-56-288Z-p4-s300s` (dark blip + full streams),
`…21-40-06-393Z…`, `…21-41-39-893Z…` (gitignored, local). Run logs and the
extraction snippets in `/tmp/ab/`.
