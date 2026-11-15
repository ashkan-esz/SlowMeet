# VPS CPU investigation handoff

## Objective and constraints

Reduce SlowMeet server CPU usage while preserving low-bandwidth and lossy-network recovery, media quality, and latency. In particular, do not remove or delay NACK, PLI, FIR, congestion feedback, retransmission, or adaptation solely to lower CPU use without proving that the change is safe under weak-network conditions.

The user observed inconsistent meeting quality and disconnects at high CPU usage, including more than 60% Docker CPU with five real devices connected to the deployed app. The investigation below was performed on November 12–13, 2026. See [the available measurements and profile summaries](vps-cpu-investigation-measurements.md) for numerical evidence and its limitations.

## Environment and findings

- The VPS is an LXC environment with one online CPU. The SlowMeet container had a 0.75-core CPU limit and 256 MiB memory limit during the baseline. Docker CPU percentages here are percentages of one logical CPU.
- During the real five-device call, Docker reported 61.02% CPU in one observation. Eight two-second observations ranged approximately 43–67% CPU; system time represented roughly 75–80% of the process CPU in those observations. Cgroup counters showed quota throttling and high CPU pressure.
- In a consecutive 45-second-per-phase trial, temporarily increasing the container limit from 0.75 to 1.0 CPU eliminated observed quota-throttling events. CPU pressure remained high. The user could not tell whether meeting quality improved; the trial therefore does not establish a quality benefit. The original 0.75-core limit was restored and no persistent limit change was made.
- Two live Go CPU profiles showed that RTCP forwarding and its network writes dominated sampled CPU. This is evidence of where time was spent, not proof of why there were so many writes or that any specific kind of RTCP packet caused them. Go CPU sampling does not replace kernel-level profiling or packet-rate measurements.
- The deployed binary SHA-256 was `b138b6ca934cd9d85dfd07c5be0d1973a587ac7ffe879a05f7e88d05a2210fb7`. A local build of the original committed source using matching build flags produced the same hash, establishing a match for that deployed binary at the time of the investigation.
- Earlier `htop` process/thread percentages and Docker statistics did not agree in a synthetic test. The cause was not established; do not add thread rows or treat them as independent process totals without checking the display mode and sampling interval.

## Current local changes

Uncommitted changes in `internal/media/router.go` reuse already-parsed RTCP packets from Pion interceptor attributes and reuse a read buffer instead of invoking `ReadRTCP` and parsing each batch again. The existing forwarding and SSRC rewriting remain in place. `internal/media/router_test.go` adds cached/uncached parsing, error, compound feedback, NACK-preservation coverage, and a small benchmark.

On the local machine, the small transport-feedback benchmark measured about 90–93 ns/op and 96 B/op for an additional unmarshal versus 58–59 ns/op and 48 B/op for the reuse path. This is a microbenchmark, not a production CPU measurement; the dominant network-write cost remains. No production deployment or restart was performed for this change.

The working tree also contained unrelated untracked `.zcode/` and `docs/project-review.md`; preserve them.

## Verification and gaps

- `GOCACHE=/tmp/slowmeet-gocache make check` passed, including the Go race suite, vet, build, and standard JavaScript checks. The later added focused compound-feedback test passed in the focused race run.
- The focused media race tests covering the new read path, feedback routing, and NACK recovery passed with local WebRTC networking allowed.
- The four-person browser suite passed several media scenarios, including generated cameras, camera/microphone toggles, ICE restart, screen-share startup and decoding, and receive-video toggle, then timed out in `chat-dom-cap`.
- A separately selected `congestion-adaptation` browser scenario timed out waiting for the expected paused camera state. The same scenario timed out at the same wait on an isolated copy of the original committed code. This is not evidence that the change caused the timeout, and it does not establish weak-network correctness.
- The Go weak-network suite could not run: creating its isolated network namespace failed with `unshare: write failed /proc/self/uid_map: Operation not permitted`. Mixed-quality browser scenarios requiring that namespace were skipped.
- Browser failure artifacts were produced under `/tmp/slowmeet-four-person-e2e-failure-dfbqvB`, `/tmp/slowmeet-four-person-e2e-failure-8qPExl`, and `/tmp/slowmeet-four-person-e2e-failure-b6p4YG`; these temporary paths may no longer exist in a later session.

## Suggested next steps

1. Preserve this handoff and the current dirty worktree. Do not deploy or restart a live call merely to collect measurements.
2. During a comparable real five-device call, capture timestamped per-interval process and cgroup CPU, user/system split, throttling, CPU pressure, network packet rates, and media-quality indicators. Save raw samples and a binary Go CPU profile, recording capture time, duration, workload, CPU quota, build identity, and relevant limitations. Keep credentials and participant identifiers out of artifacts.
3. Determine RTCP packet types and rates and how often writes occur per participant/publication. Investigate why writes dominate before proposing filtering, batching, or other behavior changes. Do not assume TWCC or a feedback loop is responsible without measurement.
4. DONE 2026-11-15 — [RTCP parse-reuse A/B under impairment](rtcp-reuse-ab.md): the pre-reuse build (`32a6d4b`) and the reuse build ran the identical impaired four-person soak in a disposable netns, three runs per side. Behavior guards green on both; total CPU within noise (write-dominated, as the live profiles predicted); allocation rate down ~27% with the duplicated-parse site eliminated.
5. The congestion-adaptation and chat-capacity timeouts were resolved on the current tree: both scenarios pass (the recorded timeouts pre-dated the client fixes), and the full four-person netns block is green in CI. Only consider a controlled production deployment and persistent quota adjustment after comparing CPU and call quality and establishing an appropriate rollback path.

## Artifact availability

The original five-device binary profiles were temporary and deleted after analysis. The individual samples from the quota trial were not retained in the available session records. The linked measurements document preserves only the available aggregate results and printed profile summaries. Do not label a new capture as one of the original profiles.
