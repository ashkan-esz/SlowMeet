# Project review and recommended work

This review covers the Go server, signaling, meeting state, browser source,
deployment files, CI, and existing tests. Findings below distinguish reproduced
behavior from source inspection and proposed improvements. It is a source and
local test review; live browser media, production networking, and dependency
vulnerability scanning were not validated in this review.

## Prioritized findings

### 1. P1: Unjoined sockets receive private meeting events

**Reproduced.** `internal/signaling/hub.go:572` registers every upgraded socket
in `h.clients`. The broadcast helpers at lines 1149 and 1161 send to that whole
collection. Room chat, reactions, media state, hand state, participant joins,
and some departure and screen-share events use those helpers. The inbound
join gate does not restrict outbound messages.

A probe in `/tmp/slowmeet-probe/internal/signaling/probe_unjoined_test.go`
connected an observer without supplying a name or meeting password. After
two authenticated participants joined, the observer received participant join
events, Alice's private chat text, and her reaction. The corrected probe fails
with an ordinary assertion, without a panic.

**Fix:** Send all room events only to admitted room members, including an
exclude-sender variant. Audit every broadcast call. Keep admission and removal
consistent across failed initialization, reconnect takeover, disconnect, and
shutdown. Preserve any intentionally public configuration notification
separately from room data.

**Regression tests:** An unjoined observer, wrong-password client, and
capacity-rejected client receive no room events. Cover chat, reactions, hands,
media state, joins, leaves, and screen sharing. Use a joined control receiver
to prove each event was delivered. Also verify normal join and reconnect
snapshot delivery. End negative-read checks after the first WebSocket timeout.

### 2. P1: Authentication throttling does not limit password evaluation

**Verified in source.** `internal/httpserver/server.go:117` and `:213`, and
`internal/signaling/hub.go:720`, compare the password before consulting the
failure limiter. Exhausted budgets change the response to a wrong guess;
a correct guess continues to succeed. A new WebSocket also resets the
per-connection join-attempt count. The limiter therefore does not enforce its
advertised budget on credential evaluation.

Additionally, `internal/ratelimit/ratelimit.go:99` uses only `RemoteAddr`.
The supplied reverse proxies connect from loopback, so different visitors
share the proxy's failure budget. The comment claiming per-client protection
behind the supported proxy setups is misleading. This does **not** lock out
valid credentials in the current implementation, because verification comes
first.

**Fix:** Check whether attempts are permitted before verifying credentials;
define and test cooldown and refill behavior. Use an explicit trusted-proxy
configuration, trusting forwarded addresses only when the immediate peer is
trusted. Resolve a forwarded chain from the right, ignoring trusted hops,
rather than accepting a spoofable leftmost address. Retain safe direct-mode
behavior when no proxies are configured.

**Regression tests:** Exhausted budgets reject further attempts before the
credential comparison, including a correct password; fake-clock refill
restores access. Cover HTTP admin, room preview, and WebSocket joins across
fresh connections. Test independent proxy clients, untrusted headers,
spoofed chains, IPv6, and malformed addresses.

### 3. P2: Fatal HTTP startup errors report successful process exit

**Verified in source.** The fatal `ListenAndServe` branch in `main.go:44`
logs, closes the app, and returns from `main`, producing exit status 0.
`deploy/systemd/slowmeet.service:13` uses `Restart=on-failure`, so a bind error
does not trigger that restart policy.

**Fix:** Return the serving error through a testable run function and exit
nonzero after cleanup. Treat `http.ErrServerClosed` as normal shutdown using
`errors.Is`.

**Regression tests:** A subprocess started on an occupied address exits
nonzero; ordinary signal-driven shutdown succeeds and closes resources.

### 4. P2: Caddy fallback test failure (closed in pass 8)

**Original finding is obsolete.** The current installer uses a prerequisite
array and a conditional `detect_caddy_tls_mode` call, so the earlier exact-text
diagnosis no longer describes the test. `bash scripts/test-caddy-install-fallback.sh`
now exits successfully with `Caddy APT fallback checks passed`; the simulated
Cloudsmith fetch reports its unavailable repository before the fallback
assertions pass. The Xray fallback suite also passes. Both suites are included
in `.github/workflows/ci.yml`, including the execution and ShellCheck steps.

### 5. P2: Unauthenticated connections have no admission deadline or cap (closed in `2cc851f`, verified in source 2026-11-15)

**Remediated before this ledger was committed; the finding text below is
preserved as recorded.** The pending-connection pool is capped at 128
(`maxPendingConnections`, enforced before the WebSocket upgrade — the 129th
unauthenticated dial gets HTTP 503), every unauthenticated socket is force-closed
by a fixed 15-second join deadline that pongs cannot extend (`joinTimeout` →
`expireAdmission`), the pending slot is released on every exit path
(`releasePending` via `sync.Once`), and the expensive-operation rate limits the
"Improve" list asked for exist (chat 10/10 s, ICE restart 6/30 s, video
subscriptions 30/10 s, per-IP password budget 20/min). A pre-auth connection
holds no meeting slot, no router registration, and no media — only its pending
slot, one 512-slot outbound queue, and two goroutines for at most 15 seconds.

**Tests:** `TestPendingConnectionCapAndFixedJoinDeadline` (503 at the cap,
pongs do not extend the deadline, slots release, admitted sockets survive the
deadline) and `TestPendingSlotFloodKeepsAdmittedPeersUsable` (a full pending
pool rejects further dials while chat keeps flowing between admitted peers;
slots reclaim themselves at the deadline and are immediately reusable).

**Residual (accepted):** the 128 pending slots are not bounded per source — a
distributed opener can keep the pool churning at 503s for others. The impact is
bounded (≤128 sockets × ≤15 s, no media), but it is not per-source load-tested.

### 6. P2: Publisher keyframe retries depend on one arbitrary subscriber

**Verified in source; playback impact not reproduced.**
`internal/media/router.go:465` chooses one map-selected receiver to anchor a
publisher-wide keyframe retry sequence, then breaks. Retry processing at
line 527 stops if that receiver's sender has gone away, even when other
subscribers still need the publication. A disconnect or subscription toggle
can therefore cancel recovery requests for the remaining audience.

**Fix:** Track publisher-wide retries by publication identity and keep them
alive while that publication has eligible subscribers. Preserve bounded retry
counts and cancellation when the publication is replaced or removed.

**Regression tests:** With two subscribers, remove the receiver selected for
the initial request and verify the remaining subscriber still gets the retry
sequence. Removing all subscribers or replacing the publication must stop old
retries. Confirm moving decoded frames in the browser before claiming a
playback recovery fix.

### 7. P3: Container documentation disagrees with the shipped HTTP binding

**Verified in source.** `docker-compose.yml:18` defaults HTTP publishing to
`0.0.0.0`; `docs/container-deployment.md:20` describes `127.0.0.1` and says
direct HTTP access requires an explicit override. `.env.example` also uses
the public binding. Following the documented assumptions can leave the app
reachable directly through the host's published port.

**Improve:** Choose and document one default across Docker, Podman, the
environment example, and installers. Prefer loopback for the documented
same-host reverse-proxy workflow, with an explicit public-access override.
Call out the binding change if adopted.

**Tests:** Check resolved Compose configuration with defaults and explicit
overrides, plus parity between the supported container definitions.

### 8. Known limitation: the adaptation classifier is blind to its own uplink congestion (evidence recorded 2026-11-16; needs decision)

**Verified in source; measured in the impaired soak** (docs/severe-audio-blackout.md).
The network classifier's loss and jitter inputs come exclusively from
`inbound-rtp` (web/js/app.js:4673/:4711) — `outbound-rtp.packetsLost` is never
read anywhere — and the own-link attribution takes the minimum across inbound
streams while explicitly refusing local-tile loss attribution
(web/js/app.js:4821-4827). Uplink congestion therefore reaches the classifier
only indirectly: candidate-pair `currentRoundTripTime` excursions and the
candidate-pair `availableOutgoingBitrate` sender-side BWE (which can contribute
`poor`, never `critical`).

**Consequence (measured):** a sender on a saturated uplink pushes its camera at
full configured bitrate (~300 kbps) into a queue dropping ~90% of packets for
entire impaired windows — the sender-side actuator exists (`doApplyProfile`
steps per-layer `encodings[].maxBitrate`/`maxFramerate` via `setParameters`,
web/js/app.js:5062-5092, and protect-audio can pause the own camera at the
auto floor) but the signal never arrives. This amplifies the severe-tier
blackout: the wasted uplink traffic deepens the sender's own inbound trickle
starvation and lengthens post-rebuild resumption.

**Decision needed (not implemented here — coordination constraint:
scripts/test-adaptation.js has WIP in flight from another session):** fold a
delta-based outbound-loss uplink signal (and/or lean on the BWE estimate) into
the sender-side ladder so the existing actuator can step a congested camera
down, versus accepting the blindness and mitigating tier-side. Design cautions:
Chrome's outbound-rtp `packetsLost` reporting is cumulative and can reset on
simulcast layer switches (delta windows handle both, mirroring the inbound
counter deltas), and the new signal must not misattribute remote-sender uplink
loss to the local sender — outbound counters are the local sender's own path,
so attribution is structurally correct. The full-simulcast case (per-layer
loss) is unverified.

## Further improvements

- Extract browser signaling/reconnect, media lifecycle, and participant/chat
  rendering from `web/js/app.js` incrementally; it currently contains roughly
  5,450 lines. Preserve behavior and use the existing small JS modules as the
  pattern. Avoid a large rewrite during security fixes.
- Consolidate the growing WebRTC constructor argument chain into an options
  value when next changing peer setup. Preserve existing tested defaults.
- Construct outbound room messages from permitted fields instead of
  rebroadcasting the entire incoming `Message`, particularly stored media
  state. Test that unrelated fields cannot be relayed or replayed.
- Define upper bounds for reported audio/video throughput in
  `internal/signaling/protocol.go:138`. Clarify that current network gauges
  describe the last reporter, while averages aggregate over time; do not
  present them as current room-wide health.
- Add dependency scanning to CI and review Go/container version maintenance.
  No vulnerability or support-status claim is made here: vulnerability
  scanners were unavailable locally and no dependency advisory scan ran.

## Test priorities and acceptance

1. Add failing security regressions for private-room event isolation and
   password-attempt enforcement, then make them pass in separate focused fixes.
2. Cover process startup failure and repair the Caddy fallback suite; add the
   missing shell suites to CI.
3. Expand WebRTC coverage around negotiated sender removal/replacement,
   candidate ordering, offer collisions, reconnect takeover, and shutdown.
   Prefer observable behavior over tests of constructor wrappers.
   Document and test whether router registration requires prior unregister:
   replacing an existing ID currently leaves subscriptions attached to the
   old peer. The inspected reconnect path does unregister first, so this is
   an API-contract coverage improvement rather than a reproduced reconnect bug.
4. Run the existing deterministic two-participant browser suite in CI. Cover
   first camera enable, sender off/on, receiver incoming-video off/on,
   screen-share stop/restart, picker cancellation, and reconnect. Assert both
   peers stay connected and decoded frames and playback time advance after
   toggles. Synthetic media results must be identified as synthetic.
5. Keep a separate native camera/screen-picker acceptance pass and a network
   degradation/recovery pass. Include keyboard-only join, dialog dismissal,
   focus restoration, and accessible control names in browser checks.

## Verification performed

- Go race tests passed across all tested packages earlier in this review.
  Reported coverage: WebRTC 57.3%, signaling 81.5%, config 83.0%, media 87.4%,
  rate limiting 88.6%, HTTP server 89.1%, meeting 94.7%, and metrics 100%.
- Formatting inspection and `go vet ./...` passed earlier in this review.
- `make test-js` passed, including the camera readiness/quality, layout,
  renegotiation, chat, connection-method, and remote screen checks.
- Installer configuration, Docker/LXC fallback, and Xray fallback shell suites
  passed. Caddy fallback failed as described above.
- The isolated unjoined-socket probe failed as expected, reproducing the
  privacy defect. Its test source remains under `/tmp/slowmeet-probe`.
- ShellCheck, Staticcheck, and govulncheck were unavailable locally. Live media
  E2E, native device capture, deployment builds, and production load tests were
  not run. Passing source/unit checks does not establish those behaviors.

Only this review document was added to the project. Existing changes to
`.gitignore`, `.github/hooks/`, and `.zcode/` were preserved.

## Follow-up work deferred from the 2026-11 bug/performance pass

The November 2026 bug-and-performance pass (media router hot path, duplicate
publication replacement, per-receiver egress mailboxes, hub race and admission
fixes, browser media-lifecycle and rendering fixes) deferred one invasive
change and several architectural notes:

- **Defer media teardown into the reconnect grace window.** `Hub.disconnect`
  (`internal/signaling/hub.go`) runs `router.Unregister`, `peer.Close`, and
  `releaseScreenShare` before deciding whether a reconnect grace period
  applies. Every transient drop therefore tears down all publications and
  senders and forces a full re-publish and renegotiation on resume, even
  though the meeting slot was preserved. The fix reshapes `reclaim`
  ordering (it waits on `previous.finished`, which is closed after
  teardown), so it needs its own focused change with takeover tests:
  defer `Unregister`/`peer.Close`/`releaseScreenShare` until the grace
  timer fires, keep the PeerConnection alive across short blips, and cancel
  the deferred teardown on reclaim.
- **RTCP passthrough filtering.** `relayRTCP` forwards receiver reports,
  TWCC, and REMB with receiver-side SSRC/sequence spaces to publishers;
  filtering to PLI/FIR/NACK only would keep publisher bandwidth estimation
  clean.
- **No server-side retransmission cache.** A mid-frame loss always costs one
  corrupted frame; recovery requires the full receiver→SFU→publisher RTT.
- **Congestion-driven adaptation.** The server paces with fixed caps and a
  4-frame queue without REMB/TWCC feedback; receivers only learn caps from
  config broadcast.

Related e2e note: the `testUnavailableCamera` scenario
(`scripts/test-media-e2e.js`) was already failing in headless runs on this
machine before the pass (the `#status` "Camera unavailable" wait times out);
it is a pre-existing harness/environment issue, not a regression from this
pass.

## Second pass (2026-11) — re-audit of the restructured code and remaining findings

A second full review re-audited the current tree after the first pass. The
prioritized findings below were verified in source; several were reproduced
against the pinned pion v4.2.23 module sources. Outcomes are marked.

### Fixed in this pass

1. **P1 — a microphone enabled after a failed join-time capture was never
   published.** Only the join loop attached audio tracks to the peer, and the
   audio transceiver (`recvonly`) was discarded. Selecting a mic later found
   no sender, so the track stayed local-only while every participant saw
   "mic on". Fixed by keeping the `audioTransceiver` reference and adopting
   it (direction `sendrecv` + `replaceTrack` + renegotiation) in
   `replaceLocalDevice`.
2. **P2 — publication swaps leaked one orphaned m-line per receiver per
   swap.** `RemoveTrack`+`AddTrack` always creates a new pion transceiver, so
   device swaps accumulated transceivers and forced a renegotiation per
   receiver per swap. Swaps now migrate each receiver's sender onto the new
   publication with `ReplaceTrack` (no renegotiation), with a per-sender SSRC
   holder so the long-lived relay goroutine retargets feedback to the new
   source track. Regression test pins stable transceiver counts across two
   consecutive swaps.
3. **P2 — chat fan-out and left-event broadcasts skipped `Message.prepare`**,
   re-marshaling per writer. Fixed.
4. **P2 — people-panel stale camera/incoming-video labels** (regression of
   the first pass's signature check): the signature now includes
   `dataset.camera` and the incoming-video preference.
5. **P2 — a dead parked capture could be published** by the reuse branch
   added in the first pass; the branch now requires a live track and falls
   back to fresh acquisition.
6. **P2 — screen-share fps was capped by the camera-quality preset** on
   profile changes, config updates, and auto-adaptation; those call sites now
   resolve against the active screen stream.
7. **P3 set**: join replay moved inside `admit` (no live broadcast can
   interleave and overwrite replayed state); join replay headroom (outbound
   queue 512); ICE-failure teardown re-checks live ICE state before closing;
   `applyPendingCandidates` re-queues the remainder after a bad candidate;
   pending-ID set replaces the O(n×m) join scan; `requestScreenShare` skips
   no-change broadcasts; fan-out no longer clones packets (pion v4.2.23
   `WriteRTP` copies into pooled storage before rewriting — verified in the
   pinned module; the enqueue comment pins this dependency); camera-layer
   selection is computed per frame instead of per packet.
8. **Delivery path**: the 860 KB `icon.png` favicon replaced by the 189-byte
   SVG (file removed from the embed); gzip middleware for compressible
   responses (skips WebSocket upgrades and range requests); `defer` on all
   page scripts; dead `backdrop-filter` layers removed;
   `contain: layout paint` on participant tiles; `HEAD` accepted on health
   endpoints.
9. **Config/deploy**: bitrate upper bounds and ICE-server scheme validation;
   `LoadStore` takes the app logger; second SIGTERM no longer swallowed by
   the shutdown path (metrics RTT average switched to an EWMA window);
   systemd `LimitNOFILE`; coturn example relay range no longer overlaps the
   compose UDP range; installer Caddy fallback on install-time repo failure;
   smoke test builds a real binary (no more orphaned `go run`); netem trap
   exits on INT/TERM; build-context ignores the compiled binary and
   workspace dirs.
10. **Dead code removed**: `SetVideoSubscriptions` wrapper, PiP drag
    handlers (`is-pip-mode` was never set; the live arrow-key self-view
    positioning and its aria hint were kept and corrected),
    `speakerDebounce`/`formatMetric`, the `chooseFilmstripLayout` guard now
    checks the function actually called, and `camera-readiness.js` (loaded
    by every page, referenced by nothing).

### Stale e2e expectations fixed

`testUnavailableCamera` and `testUnavailableMicrophone` failed in headless
runs on the baseline too. Both asserted pre-router behavior: in-meeting
statuses now route to the `#meeting-status` banner, and the mic control's
accessible label composes the visible "Mic" prefix. The assertions were
updated; both scenarios now pass.

### Deferred (unchanged or newly documented)

- **NACK retransmissions are dropped by the frame buffer** when a
  retransmitted packet's timestamp is older than the last completed frame.
  The server keeps no retransmission cache, so a mid-frame loss recovers via
  PLI only. This is the deliberate design; see the first pass's follow-up
  list for the architectural alternatives.
- Grace-window media teardown deferral, RTCP passthrough filtering,
  congestion-driven adaptation: unchanged follow-ups.
- `HEAD /admin` method-ordering cosmetics, `/config` field parity, and the
  mandatory `env_file` in compose remain accepted quirks.

### Full e2e comparison (this pass)

The complete deterministic two-browser suite was run on this pass's tree and
on the pre-change baseline (26/36 pass/fail versus 24/40). No scenario that
passed on the baseline fails now; the two fixed stale assertions account for
the difference. The remaining 36 failures fail identically on both trees —
they are pre-existing expectation drift (roster/prejoin flows asserting the
join-form status line and element states that the meeting-status router and
later UI changes moved), concentrated in `scripts/media-e2e/participant-flows.js`
and the viewport-layout scenario. Triaging and updating that cluster is its
own follow-up; it is unrelated to this pass's product changes.

## Third pass (2026-11) — performance with zero network-tolerance sacrifice

Priority for this pass was set by the maintainer: performance work must not
cost weak-network tolerance, delay, or reconnect resilience. Items were
selected and ordered under that constraint; two candidate items that could
touch network behavior were cut (audio RTCP relay filtering, and forcing
GOMAXPROCS in deployment).

### Fixed

1. **Grace-window media teardown deferral** (weak-network win): a dropped
   connection's publications and peer connection stay alive for the
   reconnect grace window instead of being torn down at drop time. A resumed
   client re-binds its streams through publication swap — the rest of the
   room keeps its m-lines and skips the unsubscribe/republish/renegotiation
   cycle entirely. Expiry tears down; intentional leave and zero-timeout
   configurations tear down immediately; the screen-share lease stays
   connection-bound; superseded (active-takeover) sessions re-bind through
   the same swap with a delayed peer close. Dedicated tests cover
   keep-within-grace, expiry teardown, and immediate-leave teardown; the
   "signaling socket reconnect restores both cameras" e2e scenario verifies
   the resume path end to end.
2. **Pion egress calls moved out of the router write lock**: AddTrack and
   RemoveTrack (hundreds of microseconds to milliseconds each, ~2N per
   join/leave) ran under the global router lock, stalling every media
   forward on the server. Subscription decisions are now queued under the
   lock and applied after release, with each install revalidated against
   current router state so a superseding mutation compensates by removing
   the just-added sender. Migration (publication swap) stays under the lock:
   swaps are rare device-change events, unlike bulk joins.
3. **Offer fan-out**: Register deduplicated its offers (the same offerer was
   queued once per publication, costing one wasted full SDP round-trip per
   join) and offers now dispatch with bounded concurrency instead of a
   serial loop, so a large room's join/leave tail takes the slowest single
   offer rather than their sum.
4. **GC pressure**: ingress reads reuse a per-publication buffer instead of
   pion's fresh ~1500-byte allocation per packet (the largest single source
   of GC churn at scale; payloads are copied out because the read buffer is
   reused); the video pacer reuses one timer instead of allocating one per
   paced packet; audio publications no longer spawn a pacer goroutine that
   parks forever; hub broadcasts iterate the member map directly instead of
   collecting a slice per broadcast; the outbound queue carries *Message so
   broadcasts stop copying a ~496-byte struct into every client's channel.
5. **Precompressed static assets**: level-9 gzip variants are built once at
   startup and served directly (app.js 243 KB→53 KB on the wire, style.css
   →26 KB) with representation-specific ETags; the runtime compressor now
   skips responses that already chose an encoding and handles only dynamic
   JSON. Cold page loads on slow links get ~3.7× less asset traffic without
   per-request CPU.
6. **Runtime guidance**: GOMEMLIMIT pinned in the compose files (~80% of the
   container cap) — the Go runtime does not read cgroup limits, so join
   storms could previously OOM-kill the process instead of GC'ing early.
7. **Browser main-thread**: speaker flushes apply all pending flips before a
   single layout pass (previously one full layout per flip); the grid layout
   skips identical CSS custom-property writes (the write-then-measure cycle
   forced a full relayout on every speaker change); reaction rendering
   caches the reduced-motion media query and batches geometry reads.

### Deferred (unchanged)

Per-receiver egress pump and single-sender-per-camera simulcast (the only
changes that alter the O(N²) goroutine/sender shape), simulcast layer
selection caching, app.js code splitting, and the 36 pre-existing
two-browser e2e expectation fixes.

## Fourth pass (2026-11) — weak-network client bugs, pass-3 correctness, SDP observability

Three fresh audits: a correctness re-review of the pass-3 refactorings, the
first dedicated audit of the browser client's weak-network behavior, and a
feasibility assessment of the remaining O(N²) scaling redesigns.

### Fixed — server (pass-3 correctness)

1. **P1 — RTP header extensions aliased the reused ingress read buffer.** The
   pass-3 read-buffer reuse copied only the payload, but pion rtp's
   `Header.Unmarshal` also slices extension payloads (MID, transport-cc,
   audio level — present on essentially every real packet) straight out of
   the buffer, which the next read overwrites while frame buffers and
   mailboxes hold packets: a data race plus torn extension bytes in egress
   RTP. `readIngressPacket` now returns `Packet.Clone()` (verified to
   deep-copy extensions and payload in the pinned rtp version), extracted
   behind `decodeIngressPacket` with a wire-bytes regression test that
   overwrites the buffer and re-marshals the held packet.
2. **P2 — decide-time subscription filter dropped**: `Register`/`Publish`
   queued subscriptions without the `shouldSubscribeLocked` gate, so every
   publish queued the publisher as its own subscriber (AddTrack →
   RemoveTrack churn plus renegotiation offers to peers whose subscriptions
   exclude the source) and pion transceivers accumulated per churn. The
   gate is restored at both call sites.
3. **P2 — queued RemoveTrack could kill a migrated sender**: a removal
   decision that raced a publication swap would remove a sender the swap had
   just migrated into the replacement publication, silently ending that
   receiver's media. Removals now skip when any registered publication still
   owns the sender.
4. **P3 batch**: `Hub.Close` tears down grace-window media (previously the
   deferred peer connections and forward goroutines outlived the hub);
   chat-history expiry re-arms when the room refilled at fire time; a
   post-reclaim hard failure (peer creation, admission) drops the resume
   intent so the slot is not held for the whole grace window; identity
   responses get `Vary: Accept-Encoding` on compressible types, `gzip;q=0`
   is honored, and branded HTML paths reject non-GET/HEAD with 405.

### Fixed — browser client weak-network behavior (the core of this pass)

1. **HIGH — the protect-audio pause was partially ineffective under
   simulcast**: `setSenderEncodingActive` flipped only `encodings[0]`, so a
   three-encoding camera kept its medium and high layers streaming during
   the auto-pause. All encodings now flip together.
2. **Auto-suspended video could stay off indefinitely**: recovery required 5
   consecutive `good` samples and `good` demands BWE ≥ 350 kbps, while the
   floor profile needs 90 — after congestion the estimate can sit below the
   bar for a long time. Recovery now also accrues at the floor profile on
   recovered loss/RTT/jitter, and while an automatic pause holds it keys on
   transport health alone (a paused sender starves its own BWE sample).
3. **ICE-restart exhaustion stranded the client in Offline**: after three
   failed restarts nothing automatic remained unless the server's own ICE
   also failed. One delayed full reconnect is now scheduled — closing the
   socket hands control to the ordinary reconnect state machine, whose token
   resume re-enters the meeting without the room renegotiating.
4. **The screen-share adaptation was a one-way ratchet**: degraded shares
   never stepped back up. A recovery streak (5 within-budget samples)
   now raises the frame rate first, then resolution, mirroring the
   down-step; and a budget cut seeds the learned state from the measured
   bitrate instead of resetting to full quality (which overspent for two
   sampling windows after every camera up-step).
5. **Camera-layer choice misattributed decode drops to the network**: a slow
   decoder on a perfect link downgraded its SFU layer and never recovered.
   Receiver-side frame drops are excluded from the layer decision when the
   measured packet loss is zero.
6. **A failed media setup stranded a live signaling socket** with no peer
   connection and no retry; the catch now closes the socket so the reconnect
   state machine takes over.
7. **Sender parameter writes serialized**: the adaptation loop, profile
   picker, config updates, device switches, and camera enables all
   read-modify-write the same senders' parameters; they now queue through a
   shared promise chain so stale snapshots cannot clobber newer writes.
8. **Camera intent survives a transient reconnect-restore failure**: one
   retry after 250 ms before the intent is dropped.
9. **Auto-profile down-steps skip live capture reconfiguration**
   (`applyConstraints` briefly stalls the track on the weakest link); the
   encoder's maintain-framerate degradation preference shrinks resolution
   immediately under the lower cap instead. Capture constraints re-arm on
   up-steps and manual changes.

### Fixed — small performance

- The one-second diagnostics loop's twelve `querySelector` calls per tick
  are now a cached element map; per-tile quality writes skip when unchanged;
  the popover-stat mirror was already hidden-gated (verified).
- SDP size telemetry: `sdp_offer_sent`/`sdp_answer_received` debug logs carry
  byte counts and media-section counts — the early warning for the 64 KB
  signaling cap and the measurement that gates the redesign below.

### Assessed and deferred (with reasoning)

- **Single sender per (camera, receiver) with layer switching** — verified
  renegotiation-free in pion v4.2.23 (per-write SSRC/PT rewrite; ReplaceTrack
  binds the same SSRC; identical codec capability across layers), and the
  only change that cuts simulcast SDP/senders/goroutines ~3× and lifts the
  64 KB signaling ceiling. Deferred as its own flagged pass: zero benefit
  while `SIMULCAST_ENABLED` is false (the default), and the client's
  three-track model needs a rework in the same change. Gated on the new SDP
  measurements.
- **Per-receiver egress pump** — rejected: pion's `ReadRTCP` has no
  selectable form, and a per-receiver pump reintroduces head-of-line
  blocking through TURN-over-TCP (audio starved behind video) — a direct
  weak-network sacrifice for memory that doesn't bind at realistic scales.
- Layer-selection caching (dormant by default) and RTCP filtering remain
  deferred; the two-browser e2e expectation cluster and the four-person
  suite run remain skipped per the maintainer's instruction.

## Fifth pass (2026-11) — CPU hygiene + profiling, zero behavior change

Exploratory request: reduce server CPU without sacrificing anything. Three
prior passes already took the big wins, so this pass is deliberately
micro-optimization plus measurement capability, under the standing
network-first constraint. Expected magnitude is honest: modest, µs-per-event
scale — the dominant remaining CPU is SRTP crypto and pion per-packet
interceptor work, which is the price of that constraint. The main deliverable
is the profiling baseline that makes any further reduction evidence-driven.

### Fixed

1. **Eager SDP debug-log computation gated** (`internal/signaling/hub.go`):
   `sdp_answer_received` and `sdp_offer_sent` computed `strings.Count(sdp,
   "\nm=")` — a full O(SDP) scan — as a slog argument on every offer/answer
   even when debug logging was off. Both now sit behind an
   `Enabled(ctx, LevelDebug)` check; output is byte-identical when debug is on.
2. **Broadcast fan-out shares one `*Message`** (`internal/signaling/hub.go`):
   `write(msg Message)` copied a ~496-byte struct per client per message and
   heap-allocated it, even for broadcasts whose writers share the already
   encoded `msg.raw`. New `writePrepared(msg *Message)` enqueues the pointer
   directly (the channel send is the happens-before edge; writers only read
   `raw`/`flush`), `write` delegates to it, and `broadcastExcept`,
   `broadcastToRoom`, and `recordAndBroadcastChat` prepare once and fan out the
   same pointer. Every broadcast call site was audited for post-call mutation;
   the immutability contract is pinned on `writePrepared`, and a regression
   test asserts all members receive byte-identical frames (race-detector
   covered).
3. **Chat length counts runes without allocating** (`internal/signaling/protocol.go`):
   `len([]rune(text))` → `utf8.RuneCountInString(text)`.
4. **Admin-gated pprof endpoints** (`internal/httpserver/server.go`):
   `/debug/pprof/` (Index, incl. named profiles such as `heap`), `/profile`,
   `/cmdline`, `/symbol`, `/trace`, each behind the same fail-closed
   credential gate as `/admin/config` (401 with no admin password configured,
   shared admin rate limiter, `X-Admin-Password` header, GET/HEAD only).
   Profile generation costs CPU while it runs, but only an authenticated
   admin can trigger it.

### Attempted and dropped

Per-connection reuse of the inbound JSON decoder (one `json.Decoder` +
`bytes.Reader` per client instead of per message): the Go 1.26 toolchain
removed `Decoder.Reset`, and a hand-rolled reset state machine would risk the
exact security behavior the decoder exists to keep (`DisallowUnknownFields` +
single-object trailing rejection). The win was the smallest of the pass
(~2 small allocations per inbound message at ~1 message/s per participant), so
the per-message decoder is retained.

### Cannot-cut-without-sacrifice ledger (verified against pinned pion v4.2.23)

Recorded so future sessions don't re-litigate: SRTP crypto per egress packet;
NACK responder (per-packet clone) and NACK generator (100 ms ticker per
inbound stream) — loss recovery both directions; TWCC sender — publisher
uplink bandwidth estimation; SR/RR report interceptors and the stats
interceptor that feeds them; the 100 ms video RTX idle poll
(`internal/media/router.go`, `videoRTXReadPollInterval`) — deliberate
retransmission delivery when a stream is idle, measured trivial; RTCP relay
filtering — cut in pass 3 under the network-first constraint; GOMAXPROCS
pinning — cut in pass 3; the 1 Hz `network_state` cadence — client adaptation
depends on it.

### Deferred, gated on profile evidence

Ingress packet pooling with refcounted packet lifetime:
`decodeIngressPacket` (`internal/media/router.go`) is the last per-packet
allocation pair (fresh `rtp.Packet` + full wire copy, required because
`Header.Unmarshal` aliases its input for payload and extensions). Packets
outlive the read loop in frame buffers and mailboxes, so pooling needs a
refcount across targets — invasive, GC-win only at scale, benchmarked by
`internal/media/ingress_benchmark_test.go`. Revisit only if a heap/GC profile
from the new endpoints shows it binding.

## Sixth pass (2026-11) — pion stats-interceptor removal + soak baseline

### Fixed

1. **The pion stats interceptor is gone** (`internal/webrtc/peer.go`): all
   PeerConnections previously built their API with pion's defaults, which
   register `ConfigureStatsInterceptorWithOptions` — an interceptor whose
   recorder data has exactly one consumer (`PeerConnection.GetStats()`,
   never called anywhere in this codebase; the SR/RR report interceptors
   keep their own per-stream state). Its per-packet price: a full
   `rtp.Header.Clone()` plus a mutex critical section on every outgoing
   packet (it is the outermost wrapper on the write path), mutex-and-counter
   work on every inbound packet, and an O(streams) walk under a shared mutex
   per RTCP batch. The API now builds a custom `MediaEngine` +
   `interceptor.Registry` replicating `RegisterDefaultInterceptorsWithOptions`
   (webrtc/v4@v4.2.23 `interceptor.go:33-74`, including the logger wiring)
   minus the stats step — which touches no MediaEngine state, so codecs,
   header extensions, and feedback negotiation are unchanged. The recipe is
   pinned against webrtc/v4@v4.2.23 / interceptor@v0.1.49 in the
   `newMediaEngineAndRegistry` comment; re-verify if pion is bumped.
   `TestCustomRegistrySDPMatchesDefaultInterceptors` pins the negotiated SDP
   content against a default-construction peer (order-insensitive: pion
   emits `a=extmap` lines in map-iteration order, unstable even between two
   default constructions — the ID-to-URI mapping is the contract, not the
   line order). Verification: the weaknet integration suite (real RTP with
   NACK loss repair through the new registry), the four-browser soak (frames
   advance end to end), and the two-browser e2e suite — 103 scenarios pass;
   the 8 failures are the documented pre-existing roster/viewport drift
   cluster (the harness files are under concurrent edit in the same window)
   plus one transient camera rate-window blip; every media-lifecycle scenario
   through the new registry passed.
2. **Sustained-meeting soak harness** (`scripts/test-soak.js`,
   `make test-soak`): N headless Chromium participants (default 4) on
   synthetic camera+audio media, joins, verifies decoded frames advance, and
   captures two CPU profile windows plus heap/goroutine profiles from the
   admin-gated pprof endpoints while media flows. First measured baseline
   below; rerun around any media-path change for a before/after comparison.

### Measured (4 participants, synthetic camera+audio, 2×15 s windows)

The removed interceptor alone accounted for **250 ms of 690 ms (36.2%)** and
**310 ms of 750 ms (41.3%)** of all server CPU samples in the two baseline
windows (`pprof -show pkg/stats` on the saved profiles); after the change
those frames are absent (0 samples in both windows). Whole-server totals
(690/750 ms before vs 790/740 ms after per 15 s window, ~5% of one core,
193→194 goroutines) are noise-dominated at this scale — the focused
measurement is the reliable one. Baseline profile composition for future
passes: UDP/ICE syscalls ~25%, scheduler ~20%, then the per-packet media
path (`writePackets`, NACK responder copy, sender-report `processRTP`).
Profiles are preserved in `/tmp/slowmeet-soak-*` per run directory.

### Decision gates (unchanged, now measurable)

Heap/GC pressure from a soak profile green-lights the deferred ingress packet
pooling; GC wall-time high → opt-in GOGC compose passthrough; micro bundle
(per-packet `time.Now` sampling, limiter lock combining) only if a profile
shows it. Not-doing additions verified this pass: `nack.DisableCopy` is
unsafe here (packets outlive `WriteRTP` in frame buffers/mailboxes — the
default per-packet copy in the NACK responder is required), and UDPMux /
interval retuning remain rejected (deployment-visible / timing changes).

## Seventh pass (2026-11) — perf-gate evidence + chat fan-out guard

### Measured: the pooling and GOGC gates both close

The soak harness (`scripts/test-soak.js`) now persists artifacts under the
repo (`soak-artifacts/`, gitignored — the pass-6 evidence was lost to tmp
cleaners) and takes two `allocs`/`heap` protobuf snapshots ~30 s apart to
measure the steady-state allocation rate directly (`pprof -diff_base` for
the per-site delta). Baseline run, 4 participants, synthetic camera+audio:

- **Allocation rate 1.19 MB/s** (35.88 MB over 30 s; cumulative allocs
  82.02 MB → 117.90 MB), **live heap 20.61 MB**, 195 goroutines.
- Rough GC cadence at GOGC=100 (heap doubles before collecting): ~17 s
  between collections — each on a 20 MB heap, sub-millisecond.
- Top allocation sites over the window: pion's NACK-responder packet copy
  9.01 MB (25% — required for subscriber loss recovery, `nack.DisableCopy`
  is unsafe here), TWCC feedback unmarshal 3.50 MB (load-bearing), pion
  attribute header cache 3.50 MB cum, gzip-middleware flate writers ~5.5 MB
  cum, and the deferred pooling candidate **`decodeIngressPacket` at 2 MB —
  6.7% of allocated bytes** (measurement overhead itself, the CPU profiler,
  added 2.31 MB).

**Verdict: ingress packet pooling is not justified** — even a perfect
refcounted pool would recover ~0.07 MB/s on a 20 MB heap and cannot move GC
cadence; the dominant allocator (NACK responder copy) is pion-side and
required. Gate closed; re-open condition: a soak at ≥10 participants, or any
future profile showing the `internal/media` packet path above ~30% of
allocated bytes. **GOGC compose knob: not justified** — nothing to fix at a
17 s cadence with sub-ms pauses. Both verdicts rest on the persisted profiles
in `soak-artifacts/2026-11-11T21-59-01-414Z-p4-s30s`.

### Fixed

1. **Chat fan-out rate limit** (`internal/signaling/hub.go`): the most
   expensive room event (history entry + N-member queue writes) is now
   burst-limited per connection — 10 messages per 10 s, far above normal
   typing, mirroring the reaction limiter's window pattern. Beyond the
   limit the sender receives a direct `chat message rate limit exceeded`
   error (unlike reactions' silent drop, a lost chat is user-meaningful)
   and nothing reaches the room; history entries and fan-out allocations
   for limited messages cost nothing. `TestChatRateLimit` pins the window
   reset; `TestChatRateLimitRejectsBeyondBurstWithoutBroadcast` drives the
   real WebSocket path (accepted chats fan out, the flooded message does
   not, history holds only accepted entries). The exactly-once chat test's
   flood volume was reduced to the burst limit with a comment — that test
   verifies replay/live interleaving, not flood volume.
2. **Soak artifacts persist** (above) and the harness asserts a nonzero
   allocation delta, so a broken capture fails loudly instead of silently
   reporting no evidence.

### Deferred from the original review (picked up in pass 8)

The pass-7 perf-only scope choice deferred message-rate controls for ICE
restart and video-subscription changes, upper bounds on client-reported
`VideoKbps`/`AudioKbps`, confirmation of the Caddy fallback suite, and a
`GOMEMLIMIT` default for bare-metal systemd deployments. Pass 8 closes all
four; see the results below.

## Eighth pass (2026-11-12) — remaining review hardening

### Implemented

1. **ICE restart rate limit** (`internal/signaling/hub.go`): each connection
   can request 6 restarts per 30 seconds. The browser caps recovery at 3
   attempts, spaced about 5 seconds apart, so this allows twice that budget
   while bounding expensive pion `CreateOffer` work. A rejected restart gets a
   direct `TypeError`: the existing client error handler clears its latched
   request and rearms recovery, while a silent drop would strand it.
2. **Video subscription rate limit** (`internal/signaling/hub.go`): each
   connection can submit 30 updates per 10 seconds. Normal client traffic is
   about 2 updates per second, leaving burst headroom. Excess updates are
   silently dropped because the next accepted subscription update re-syncs the
   desired state and there is no per-message acknowledgement.
3. **Network-state throughput bounds** (`internal/signaling/protocol.go`):
   `VideoKbps` is capped at 25,000 and `AudioKbps` at 1,024, approximately
   25% and 100% above the server's 20 Mbps video and 512 kbps audio config
   caps. The `-1` unknown sentinel remains valid; invalid reports use the
   existing generic `TypeError` path and do not close the connection.
4. **systemd Go heap default** (`deploy/systemd/slowmeet.service`): the unit
   sets `GOMEMLIMIT=200MiB`, matching the Compose default because Go does not
   automatically use the systemd cgroup memory limit as its soft heap limit.
   `EnvironmentFile=/opt/slowmeet/.env` is applied after `Environment=`, so a
   bare `GOMEMLIMIT=` entry there overrides the default. `.env.example` now
   marks `SLOWMEET_GOMEMLIMIT` as Compose-only.
5. **Caddy fallback suite**: its former stale-assertion failure is obsolete;
   the current Caddy suite passes, as does the Xray suite. Both suites are
   already executed and ShellChecked by CI.

### Verification

`rtk make test-js`, `bash scripts/test-caddy-install-fallback.sh`, and
`bash scripts/test-xray-fallback.sh` passed. The Caddy test logged an
unavailable Cloudsmith fetch in its simulated APT path, then passed its
fallback assertions. The Go race suite could not start at the time: the
worktree's concurrent `go.mod` update required Go 1.26.11, the local
toolchain was 1.26.0, and downloading the required toolchain returned HTTP
403. **Completed 2026-11-13**: with Go 1.26.11 available locally, the
deferred verification ran green — `go test -race ./...` across all packages
(the never-run pass-8 regression tests included, plus the concurrently
in-flight RTCP packet-reuse work in `internal/media/router.go`), `make
check`, and `make smoke`. The Caddy fallback suite was re-confirmed green
locally.

The prioritized findings from the original review are now fully resolved or
deliberately closed. The perf-gated items retained as closed decisions are
documented in their respective pass sections.

## Fifth pass (2026-11) — four-person suite stabilization and concurrent-session fixes

The maintainer's four-person suite (47 scenarios, mixed Chromium/Firefox) had
grown large but aborted on first failure, carried a live runner race, and had
two scenarios failing on HEAD. This pass stabilized the runner, fixed the
concurrent session's server bugs, and product bugs the suite surfaced.

### Fixed — concurrent-session server code (audit findings)

1. **P2 — the re-armed chat-history timer deleted unconditionally.** The
   outer expiry callback re-checks room occupancy and re-arms, but the inner
   timer deleted the history unconditionally — a room that refilled before
   the first firing lost its history mid-meeting. Both timer generations now
   share one "delete only while the room is empty, otherwise re-arm" path
   (`expireChatHistory`, bounded re-arm depth).
2. **`senderMigrated` comment corrected** — the decide phase deletes the
   sender before the op is queued, so the branch cannot fire today; it is
   kept as defense against future decide-phase reorderings and documented as
   such.
3. **`sdp_offer_sent` telemetry moved after a successful write** (it
   previously reported "sent" even when the outbound queue was full).
4. **Missing tests added**: Hub.Close tears down grace-window media and frees
   slots; WebRTC-init failure and admission failure after reclaim release the
   slot immediately with no phantom broadcast (deterministic injections: an
   invalid ICE transport policy store, and an expired admission deadline);
   chat-history re-arm survives a room refill; `acceptsGzip` q-value table;
   branded HTML rejects non-GET/HEAD with 405 + Allow.

### Fixed — four-person runner

1. **Continue-on-failure**: every selected scenario runs; a failure captures
   artifacts, best-effort restores the shared room, and the run ends with a
   summary instead of aborting at the first break.
2. **Reaction-rate-limit read race fixed**: poll for the limiter's six
   deliveries, settle, then assert the exact count (the old
   burst-then-immediate-read saw 4 of 6).
3. **`assertMedia` video matching is name-keyed** instead of array-index
   keyed (tile order changes between snapshots).
4. **The two dead scenarios are registered**: `abrupt-close-no-resume` (the
   only browser-kill seat-reclaim coverage) and `push-to-talk`.
5. **The findings doc appends** instead of read-modify-write, so concurrent
   runs interleave instead of clobbering.
6. **`admin-caps-and-chat-reset` restores the bitrate cap** it sets, so later
   scenarios no longer run under a leaked 300 kbps cap.

### Product bugs the suite surfaced (fixed)

1. **Chat toggle accessible-name mismatch (axe serious)**: the unread badge
   changes the button's visible text ("250 Chat") while the accessible name
   stayed "Open chat" — axe `label-content-name-mismatch`. The badge count is
   now part of the accessible name (same pattern as the participants button),
   and the label refreshes when the badge appears.
2. **congestion-adaptation's injected loss never reached the classifier**:
   the client's own-link loss attribution takes the minimum across streams,
   and the injection only faked video loss — the clean audio stream masked
   the impaired path entirely. The injection now covers audio too, and the
   pause wait was extended to match the real descent math (2 poor samples per
   level, then 3 critical): the pause+recovery cycle now completes in ~14 s.
3. **chat-dom-cap's flood conflicted with the server's chat limiter** (10 per
   10 s per client): the raw burst was mostly rejected — it never reached the
   250-node wait target and its rejection errors poisoned every later
   scenario's strict error check. The flood is paced just under the
   sustained allowance and asserts the rail stops growing at the 300-node
   cap.

### Suite results

Full four-person run: **47 scenarios, all passing** (2 netns-gated scenarios
skip by design without MEDIA_E2E_FOUR_NETNS=1); the two previously-open HEAD
failures (grace-window-churn, escape-priority-chain) pass. Two-browser
spot-checks (device replacement, capture failures, signaling reconnect) all
pass.
