# RTCP parse-reuse A/B under impairment

Evidence for [step 4 of the VPS CPU investigation handoff](vps-cpu-investigation-handoff.md):
the RTCP parse-reuse change (`707a89e`, "perf: reuse the NACK interceptor's
parsed RTCP batches") compared against its parent (`32a6d4b`, the pre-reuse
build) under an identical impaired workload, in the disposable network
namespace the weak-network soak uses.

## Method

- Harness: `SOAK_IMPAIRMENT=1 make test-soak-netns` — four headless Chromium
  participants with synthetic camera+audio, one clean / one moderate /
  one severe / one capped-downlink tier, two impaired windows (a 15 s server
  CPU profile captured mid-window in each) each followed by a clean recovery
  window, per-window `/metrics` timeline, reconnect-count and goroutine-leak
  guards. Identical harness files were copied untracked into a
  `git worktree` of `32a6d4b`, so both sides ran byte-identical measurement
  code against their own committed Go trees.
- Machine: local development host (many cores, idle during each run; runs
  were gated on a quiescent machine). Loopback inside the namespace; no
  cgroup CPU cap. Three runs per side.
- What was compared: pprof total samples per CPU window, cumulative samples
  of the RTCP-relay path, allocation rate over the run bracket, and the
  per-site allocation diff.

## Correctness on both builds

Every run on BOTH builds passed the soak's guards: audio advanced within
each impaired window, every lift recovered every camera for the clean
observer, reconnect count stayed +0 across windows, goroutines returned to
baseline (166–167). The weak-network integration suites additionally prove
NACK repair and audio continuity on the current build. So the reuse change
costs nothing observable in behavior — the A/B question was only cost.

## Numbers

CPU (total pprof samples per 15 s window, both windows per run):

| build | run 1 | run 2 | run 3 |
|---|---|---|---|
| before (32a6d4b) | 540 + 530 ms | 520 + 690 ms | 570 + 540 ms |
| after (707a89e)  | 520 + 940 ms | 570 + 700 ms | 500 + 660 ms |

No resolvable total-CPU difference at this workload. That matches the VPS
profiles: `relayRTCP`'s cost is dominated by `WriteRTCP`/`sendto` syscalls,
which the reuse change does not touch; the parse work it removes is a
minority share, and at these packet rates the absolute delta is inside
run-to-run noise.

Allocations (rate over the ~78 s measurement bracket, and the
`(*RTPSender).ReadRTCP` re-unmarshal site from the alloc diff):

| build | alloc rate (runs) | `RTPSender.ReadRTCP` alloc site |
|---|---|---|
| before | 1.62 / 3.28 / 1.73 MB/s (avg 2.21) | 29.5 / 183.7 / 61.1 MB cum — present every run |
| after  | 2.15 / 1.37 / 1.34 MB/s (avg 1.62) | absent — the call no longer happens |

The eliminated re-unmarshal is visible exactly where the microbenchmark
predicted: the before build allocates a second full RTCP parse per feedback
batch inside `RTPSender.ReadRTCP` (12–183 MB per ~78 s bracket), the after
build parses once in the interceptor and reuses the result. Average
allocation rate dropped ~27% (before 2.21 MB/s → after 1.62 MB/s; per-run
variance is high, driven by encoder-dependent feedback volume). `live heap`
trended lower after (11–14 MB vs 15–23 MB), goroutines identical (167).

## Verdict

- Behavior: unchanged (guards green on both builds; full weak-network suite
  green on the current build).
- CPU: no measurable total delta at this workload — the win, if any, is on
  the throttled one-core VPS where the unmarshal share (~12–24% of
  relayRTCP's cumulative per the live profiles) competes with everything
  else for a scarce quota, not on an idle many-core host.
- Allocations: clear reduction (~27% average rate; the duplicated-parse
  site eliminated). Lower allocation rate means fewer GC cycles per minute —
  on the VPS that is direct CPU saved by the collector.

Step 4 is therefore closed: the reuse change is safe under loss, jitter and
bandwidth constraints and reduces GC pressure, with total-CPU gains to be
confirmed (or not) by the real-call capture in step 2.

## Artifacts

- before: `/tmp/slowmeet-ab-before/soak-artifacts/2026-11-15T14-12-40-933Z-p4-s300s`,
  `…14-14-13-711Z…`, `…14-15-45-643Z…` (worktree removed after extraction)
- after: `soak-artifacts/2026-11-15T14-25-05-400Z-p4-s300s`,
  `…14-26-36-574Z…`, `…14-28-07-677Z…` (gitignored, local)
- run logs and the extraction helper: `/tmp/ab/` (before-*.log, after-*.log,
  validate-master.log, extract.sh, run-side.sh)

## Limitations

- Loopback on an idle many-core host is not the 0.75-core LXC VPS: absolute
  CPU numbers here are an order of magnitude below the deployed profile, and
  scheduling/jitter dynamics differ. The comparison is A/B-fair but not
  production-representative.
- Whole-lo shaping in the namespace includes signaling/HTTP; identical on
  both sides, so the comparison is unaffected.
- Synthetic media: the fake camera's encoder efficiency drives feedback
  volume, so per-run RTCP rates vary (visible in the before-side's 3.28 MB/s
  outlier). Three runs per side bound, but do not eliminate, that variance.
