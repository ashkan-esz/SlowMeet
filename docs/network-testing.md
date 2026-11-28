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
    clean default class), each on its own copy of it (`fast-2`…`fast-4`,
    opt-in like `moderate-2`…`moderate-4`), so the four links do not share
    one 20 mbit queue and one participant's burst cannot read as another's
    loss. Every participant's Auto ladder reaches and holds
    level 3 (`high`) with no suspension or degraded tile, and the camera
    sender runs at the `high` bitrate. A short moderate window on one
    participant then lifts, and all four climb back to level 3.
  - `one-fast-three-bad-uplinks` — the 1 good / 3 bad room where the three
    bad participants have lossy uplinks (moderate/severe/moderate, both
    directions), so the fast participant has no clean inbound stream to
    calibrate against. Audio advances for everyone, the bad cameras degrade
    on the fast participant, one bad participant leaving alone does not
    interrupt the rest, and everything recovers on lift. The fast
    participant's own camera must never pause, and its ladder may step down
    at most once and must spend most of the window at, and end at, the top
    level (fixed issue B1 below).
  - `all-four-impaired` — every participant on the moderate tier at once,
    each on its own copy of it (`moderate-2`…`moderate-4`, so four people do
    not share one 200 kbit queue), with no clean peer anywhere: audio keeps
    advancing, the room does not rebuild peers in a storm, and every camera
    recovers on lift.
  - `bad-downlink-among-bad-senders` — the guard on the sender discount: one
    participant's own download loses 12 % (`lossy-downlink`: no rate cap,
    10 ms, clean upload) while the other three send over uploads losing
    10 % (`lossy-uplink`). Only inbound loss can show that participant's
    damage, and the discount for the senders' loss must not cancel it: its
    own loss must read above 5 % in at least 60 % of the samples and its
    ladder must step down (fixed issue B14 below). The SFU's own measurement
    of each download (F4 below) must read 8-16 % for that participant and
    under 3 % for the three clean downloads, and that participant's
    adaptation must use it in at least 80 % of the samples.
  - `lossy-downlink-clean-senders` — the guard on that measurement under
    NACK repair: the same 12 % download carrying only video (the three
    senders' microphones are taken off the wire), so every lost packet is
    resent. The SFU must still read 8-19 % and no jitter. Not in the CI list.
  - `lossy-downlink-clean-senders-firefox` — the same with a Firefox
    receiver (P2), whose transport-cc feedback, resends and stats are its
    own; it also asserts that Firefox's adaptation used the SFU's value. In
    the `firefox` group, so it runs only by name or with
    `MEDIA_E2E_FOUR_GROUP=firefox`, and needs `MEDIA_E2E_FOUR_ENGINES=mixed`.

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
  `KNOWN ISSUE B10` if it ever reproduces. A dedicated hunt with that
  change in place found no ghost in 12 runs with
  `SLOWMEET_KNOWN_FAILING=1`. Those were 10 runs of the scenario alone and 2
  of the whole `resilience` group, with every tile's add, remove and
  connection change logged on the stalled page. Earlier runs had not shown
  it either. If it comes back, log P2's tiles the same way (a
  `MutationObserver` on `li[data-participant-id]` in the
  `createParticipant` init script) to see what kept the tile.

- **Open: `simulcast-mixed-room` still fails now and then.** After B17 it
  was recorded as 4 of 4. Measured again: 1 failure in 6 runs on the B17
  commit and 4 in 10 with B18 and B19 fixed, too few runs to call the two
  rates different. Three of the four fail as "P3 decodes P1's camera at 0 px,
  not the 360 px top layer after the cap lifted": P3's receiver for P1's
  medium layer is bound and live but stopped receiving at about 150 to
  230 KB while the other cameras' medium layers passed 950 KB. One fails the
  sender-side B12 check (P1's medium layer capped at 60 kbps); that one was
  the split layer writers, fixed under B12 below. In every
  failing run the server's video path dropped nothing
  (`slowmeet_video_frames_dropped_total` and
  `slowmeet_video_mailbox_drops_total` all 0), no publisher changed codec,
  and the server log has no warning, so neither B18 nor B19 is the cause.
  Followed up: with `DEFAULT_VIDEO_CODEC=vp8` it passed 8 of 8, with the AV1
  default it failed 6 of 22 in all, so it goes with AV1 simulcast layers
  (too few runs to be sure). Chromium accepts every layer change the refit
  makes with the AV1 layer mode set (`setParameters` with one, two and three
  layers), so the refit is not being refused. In a failing run P1, the
  participant on the fast tier, is on the `slow` profile at the end while
  the other three are still on `normal`, without having rejoined or
  reloaded: its own adaptation stepped it down during the run. `slow`
  captures 360x240, which `planCameraSimulcast` gives one layer, so P1 no
  longer sends the 360 px layer the check waits for, and P3 keeps a bound
  receiver that gets nothing. What makes P1 step down on a clean link, and
  only with AV1, was not found; its link figures at the end are clean (0 %
  loss, estimated 558 kbps out against 948 and 1023 for P2 and P4).
  Later "0 px" failures had P1 on `normal`, with the medium encoding active
  but no longer encoded: its `outbound-rtp` had no frame size and
  `qualityLimitationReason` `bandwidth` (AV1 through
  `SimulcastEncoderAdapter`), so Chromium had dropped the layer for its
  bandwidth estimate and the SFU had nothing to forward. The rate follows
  machine load: in alternating runs while another browser suite ran beside
  them, 3 of 6 failed without the B12 layer-writer fix and 1 of 6 with it,
  and 6 of 10 failed with the fix in a run of its own beside that suite.

- **Closed, a fault of the test: "signaling reconnects under network
  impairment" failed every second run** of `make test-media-e2e-netns` (3
  failures in 6 runs on `c506d5a`, 2 in 5 on `d42c094`, 3 in 5 after B20 and
  B21, 2 in 4 after B23, and in CI on a fresh machine): its second
  participant's join did not reach the meeting view within 20 s. The join
  page said why: "This room is full". The scenario before it ends under a
  severe profile. When that scenario's pages were closed, one participant's
  leave reached the server 2.2 s late (its TCP connection was still backing
  off from the impairment; the media connection closed at once), and the
  seat is held for the reconnect timeout after that (1 s in this suite):
  3.2 s in all. The harness waited a fixed 1.1 s between scenarios, so the
  next scenario's first participant took one seat, the participant who had
  not left yet held the other, and the room of two refused the second. The
  harness now waits until `/metrics` reports
  `slowmeet_active_participants 0` (`waitForEmptyRoom` in
  `scripts/test-media-e2e.js`): 6 passes in 6 runs. The server did what it
  is meant to. Not explained: why passes and failures alternated strictly.
  Seen on the way, once in 10 runs and not looked into: before any
  impairment, one participant's audio element for the other was playing
  with a playback clock that stood still at 16004 s while audio packets
  arrived ("remote audio playback time did not advance").

- **Fixed: B1–B9 and B11–B23.** Their tests now enforce the fix without a gate.
  - B1, a participant on a good link blaming its own link: its own-link
    estimate is the minimum loss across inbound streams, and with every
    remote sender on a bad uplink there is no clean stream. In
    `one-fast-three-bad-uplinks` the fast participant read up to 70 % loss,
    stepped 3 -> 0 and paused its camera in 33–34 of 40 samples. Most of that
    loss is created at the SFU: over a slow lossy uplink the SFU's NACKs do
    recover the packets (so the sender's own receiver reports read 0 %), but
    too late, after their frame was forwarded or skipped. The SFU now
    measures, per publication, the share of the publisher's sequence numbers
    it did not forward (`forward_loss.go`, the higher of its window in
    progress and the last one-second window) and relays it per sender and kind in
    `source_quality`, with the jitter of what it forwards (B13); receivers discount
    each stream by its sender's share and pool the reported streams
    (`selectOwnLinkMeasurements`, B14). The fast participant now never pauses,
    reads 0 % in nearly every sample, and at most steps down once in the
    first second or two, before the first measurement reaches it. That early
    step once left it at level 2 for the rest of the window: the bad senders
    pause their cameras at the floor, a paused camera has no uplink jitter to
    report, and their audio still carried 30–45 ms of their own uplink
    queueing, which the fast participant read as its own jitter, so it never
    counted a healthy sample to climb back. Senders now also report their
    microphone's uplink jitter (`audio_uplink_jitter_ms` in `network_state`
    and `source_quality`), and receivers discount each stream by its own
    kind's report (`senderUplinkForStream`). The early step also used to
    count as a failed climb (the fast participant had just climbed to the
    top), doubling the healthy samples the next climb needed. A climb only
    raises what a participant sends, so the climb backoff now doubles only
    when the step-down shows on the send path: uplink loss above 5 %, a
    round trip above the poor bar, or a send estimate below 220 kbps
    (`sendPathPoor`, `noteStepDown(onSendPath)`). The early step itself is
    gone too (see B13): the hub re-reads the SFU's measurements every 250 ms
    and relays a worsening at once, instead of waiting for the sender's next
    report and a 1 s minimum interval (`refreshSourceQuality`), and the SFU
    includes its measurement window in progress, so the onset is no longer
    under-reported for a second. The scenario asserts no pause, no step-down,
    the top level at the end of the window, and the top level for at least
    90 % of it. `TestHubPushesForwardMeasurementWithoutSenderReport`,
    `TestForwardLossReportsWindowInProgress`, `TestHubRelaysAudioUplinkJitter`
    and the paused-camera case in `scripts/test-room-network-scenarios.js`
    cover the relay and the discount. `TestForwardLossMeasuresUnforwardedSequences`,
    `TestHubRelaysReportedUplinkQuality`,
    `scripts/test-room-network-scenarios.js`, `one-fast-three-bad-uplinks`.
  - B13, leftover jitter slowing the fast participant's climb back: even
    with the per-kind discount, its own-link jitter read 18–46 ms now and
    then on a clean 20 ms link, and each such sample restarted its climb
    streak (9/40 samples at the top in one run, ~30 s to climb back). The
    evidence showed every bad sender's report present but reading 0–1 ms
    while its audio reached receivers with 30–60 ms of jitter: the jitter in
    the SFU's receiver reports, which the sender relays, does not reflect its
    uplink queueing. The SFU now measures the RFC 3550 jitter of what it
    forwards, per publication, at the moment of forwarding
    (`forward_jitter.go`, its window in progress and the last one-second
    window, like the loss), and the hub relays that in `source_quality` with the sender's
    report as the fallback. Over five runs no sample after the first 5 s
    read 30 ms or more; the fast participant held the top for 34, 34, 28, 34
    and 39 of 39 samples and climbed back within 5–11 s (the 11 s one waited
    out a single late loss reading). That early step and late reading came
    from lag: the hub read the SFU's measurements only when a sender's own
    report arrived, at most once a second, and the SFU reported only
    completed one-second windows, so at onset it said ~55 % loss while the
    streams already lost 78–92 %. With the 250 ms push (worsenings at once)
    and the window in progress, five more rounds never stepped down and held
    the top for every sample (39/39, 39/39, 40/40, 40/40, 40/40).
    `TestForwardJitterMeasuresForwardedInterarrivalJitter`,
    `TestRouterForwardJitterPicksAudioAndBusiestCameraLayer`,
    `one-fast-three-bad-uplinks`.
  - B14, the sender discount hiding a receiver's own bad download: in
    `bad-downlink-among-bad-senders` the participant whose download loses
    12 % read its own loss above 5 % in only 0-2 of 35 samples and never
    stepped down. Three causes. The own-link estimate took the minimum over
    discounted streams, and a video stream with five packets in a second
    reads 0 % about a third of the time at 20 % loss; the SFU reported the
    worst of four windows, each a noisy count of about 50 audio packets, so a
    10 % uplink read 14-20 % and the excess cancelled the receiver's own
    loss; and senders near an outage (the moderate tier's audio loses
    60-85 %) leave too few packets to reveal anything, while the discount
    divides by what is left and turns a 2-point report gap into 7-10 % own
    loss. Now the estimate pools every reported stream (packets received
    against packets the receiver's path was handed after each sender's
    reported loss), keeps the minimum only for unreported streams, skips
    streams whose sender reports 50 % loss or more, and treats a pool under
    20 packets as unmeasurable rather than falling back to the polluted
    pooled loss (`selectOwnLinkMeasurements`); the SFU reports the higher of
    its window in progress and the last complete window only. Three rounds:
    own loss visible in 27, 29 and 26 of 35 samples, ladder at the floor; the
    fast participant in `one-fast-three-bad-uplinks` still 40/40 at the top
    with no step-down. With only near-outage senders a receiver's own
    download loss is unmeasurable from their streams (its round trip and send
    path still judge the link). `scripts/test-room-network-scenarios.js`
    (pooling, lucky small samples, near-outage and small-pool cases),
    `TestForwardJitterReportsLastCompleteWindow`,
    `bad-downlink-among-bad-senders`. The jitter discount has the same
    shape and limit: a receiver's own 60 ms of download jitter shows through
    accurate sender reports and reads poor, reports 20 ms too high leave it
    neither poor nor healthy, 40 ms too high hide it (unit cases in the same
    script). Superseded by a direct measurement (F4, next).
  - F4, a receiver's own download measured at the SFU: the estimate above
    can only infer the download from what the senders' streams lost, so
    over-stated sender reports hide it and near-outage senders leave it
    unmeasurable. Since B15 every SFU transport numbers its own packets, so
    each browser's transport-cc feedback says which of the SFU's packets
    reached it and when. A per-peer interceptor (`downlinkMeter`, registered
    before the transport-cc stamper so it sees the stamped number) records
    each send time and reads that feedback: loss is the share reported
    missing (a late arrival corrects it within the window), jitter is RFC
    3550 jitter of the one-way transit. It keeps the same one-second
    windows and 250 ms window-in-progress as the forward measurements and
    reports the worse of the two, loss and jitter each on its own. The hub
    sends each room member its own value (`downlink_quality`, server-only):
    a worsening at once, otherwise once a second, which also tells the
    browser the value is fresh. The browser uses it for its own-link loss
    and jitter while it is under 3 s old and falls back to
    `selectOwnLinkMeasurements` otherwise (old servers, a peer without
    transport-cc, the first seconds of a call; `chooseOwnLinkQuality`).
    It drives the quality ladder only. The loss is counted before NACK
    repair (since the fix below), so a 12 % download reads about 12 % steadily
    and crosses the 10 % critical bar in most samples, and pausing the own
    camera cannot help a download: when it drove the pause too, the camera was
    paused in 34 of 35 samples in each of three runs of
    `bad-downlink-among-bad-senders`.
    Pausing and resuming therefore stay on the estimate (`pauseCondition` in
    `app.js`): of seven runs each, the camera paused in two (21 and 16
    samples), and before this change in three (9, 25 and 6).
    Measured in the netns rooms: the `lossy-downlink` receiver read a median
    of 9.9-13.2 % over twelve runs of its 12 % tier, from the SFU's
    measurement in every sample; the three clean downloads behind lossy
    senders read a median of 0 %; the fast participant in
    `one-fast-three-bad-uplinks` held the top level in 40 of 40 samples. The
    jitter is far above a browser's own on an overloaded link (up to 662 ms),
    but no sample in `bad-downlink-among-bad-senders` or
    `one-fast-three-bad-uplinks` was poor by its jitter alone, and on the
    700 kbit download it stayed at or under 30 ms. A Firefox receiver
    measures the same (`lossy-downlink-clean-senders-firefox`, five runs of
    the 12 % video-only download): the SFU read medians of 12.9-16.0 % with
    no jitter from its feedback, against 12.0-12.9 % dropped by the tier and
    11.8-13.0 % in Firefox's own estimate; Firefox's adaptation used the
    SFU's value in every sample, its ladder reached the floor in 6-8 s and
    the camera paused in 19-31 of 34 samples. On the code from before F4,
    when Firefox's estimate drove the ladder, five runs reached the floor in
    6-8 s with 22-33 paused samples. A Chromium receiver with two Firefox
    senders read 13.5-15.0 % (three runs).
    `TestDownlinkMeterMeasuresLossAndJitterFromFeedback`,
    `TestDownlinkMeterReportsTheWorseOfEachMeasure`,
    `TestRouterMeasuresEachReceiversDownlink` (reads nothing with the meter
    registered after the stamper), `TestHubTellsEachMemberItsOwnDownlink`
    (fails when the value is broadcast), `bad-downlink-among-bad-senders`
    (asserts the SFU-measured loss per participant and that the receiver's
    adaptation used it).
    As first pushed, the measurement missed most video loss: pion's NACK
    responder was registered before the stamper, so a resend repeated the
    lost packet's transport number, the browser reported that number as
    arrived, and the meter took the loss back. On a 12 % download with a
    10 ms round trip, two instrumented runs left 11.5 and 12.2 % of the
    audio (never resent) lost but 0.5 and 1.6 % of the video. The room
    above hid it: a receiver this lossy takes the low camera layers, so three
    quarters of its packets are audio. A repair that beat the first feedback
    also read as jitter. The meter, the stamper and a header copy for resends
    (`resendHeaderCloner`) are now registered before the responder, so a
    resend is numbered and recorded as a packet of its own; the sender reports
    stay after it. With a video-only download, three runs before read medians
    of 4.8, 4.8 and 10.3 % and 7, 7 and 14 ms; ten runs after, 10.9-15.6 % and
    0 ms (the browser's own estimate: 9.7-11.7 %). In
    `bad-downlink-among-bad-senders` the lossy download now reads 13.6-14.2 %
    (three runs). The ladder reached its floor in 8, 20 and 23 s before, in
    6-8 s after, and in 6-10 s in five runs of the code from before F4, when
    the estimate drove it; the camera then paused in 18-32 of 35 samples, and
    in 5-34 after the fix.
    `TestResentPacketsGetTheirOwnTransportNumber`,
    `TestDownlinkMeterSeesLossThatResendsRepair`,
    `TestConcurrentResendsOfOnePacketDoNotShareItsHeader`,
    `TestResendsStayOutOfSenderReports`, `lossy-downlink-clean-senders`
    (not in the CI list).
  - B15, a transport-cc feedback flood: `all-fast-link-top-quality` failed
    in every full CI-list run (also on code from before B14) yet passed on
    its own. Late in a long session the browsers sent 1,600-12,600 non-RTP
    packets a second each (normal is 25-50) and the SFU relayed up to 20,000
    transport-cc feedback packets a second, saturating the shared 20 mbit
    fast tier (13 % dropped) so every participant read loss on a clean link.
    The SFU negotiated the transport-cc header extension with every browser
    but only generated feedback for what it received
    (`ConfigureTWCCSenderWithOptions`); nothing stamped its own transport
    sequence on what it sent, so each forwarded packet kept its publisher's
    number. A receiver saw its senders' unrelated counters interleaved as one
    transport, and as they drifted apart (an impaired publisher sends less)
    every packet read as a huge jump or reorder. The SFU now registers pion's
    transport-cc header extension interceptor, so each of its transports
    numbers its own packets; each receiver's write gets its own copy of the
    packet's header extensions (now `egressHeaderExtensions`, see B17),
    since the interceptor writes into them in place. Three runs of the CI list
    up to the fast scenario: 24-51 non-RTP packets a second per browser and
    every scenario passing. The scenario asserts under 200 a second per
    browser and logs the rate; on failure it records the tiers' tc counters,
    host load and every browser's packet counters.
    `TestRouterStampsItsOwnTransportSequenceOnForwardedPackets`,
    `TestWithOwnHeaderExtensionsIsolatesConcurrentWriters`,
    `all-fast-link-top-quality`.
  - B16, a source-quality change marked as sent without being sent: the
    hub's 250 ms refresher recorded each relayed value before checking that
    the sender's connection was still a room member. Between a resume (or
    during a reconnect grace window) and the new connection's first report,
    it recorded changes for the old, gone connection and broadcast nothing,
    so the room kept the stale value until the next real change. The hub now
    records only what it broadcasts, and a joiner is not replayed a value
    never sent. `TestHubRelaysChangeMeasuredDuringReconnectAfterResume`.
  - B17, forwarded packets naming the publisher's transceiver:
    `simulcast-mixed-room` passed about half its runs. The SFU forwarded
    each publisher's RTP header extensions unchanged, and every forwarded
    camera packet carried the publisher's mid ("4", "5") while the
    receiver's transceiver for that track had another (1, 6, 7, 8, 9).
    Chrome routes an incoming packet by its mid before its SSRC, so a
    forwarded layer was delivered to whichever of the receiver's
    transceivers happened to have that mid; whether the sender's top layer
    decoded depended on how the mids lined up (Chrome's SFU-side IDs match
    the publisher's, so the IDs were fine; the values were not). Stripping
    the extensions made it worse (0 of 3). Each receiver's forwarded packets
    now drop all of the publisher's extensions (which a Firefox publisher
    also numbers differently) and carry the receiver's own transceiver mid;
    the transport-cc interceptor adds the SFU's transport sequence
    (`egressHeaderExtensions`). `simulcast-mixed-room` 4 of 4, a mixed
    Chromium/Firefox room 4 of 4, and the core netns scenarios pass.
    `TestRouterGivesEachReceiverItsOwnMid` (fails with the publisher's
    mid forwarded), `TestEgressHeaderExtensionsRewriteForEachReceiver`.
  - B18, a receiver's video mailbox smaller than the pacer's burst: a
    shared screen at 720p or 1080p never appeared for the viewer, in any
    codec, on a loss-free local link. The pacer hands a frame's packets to
    each receiver's mailbox back to back while the token bucket allows (31
    full packets at the 3 Mbps default), in microseconds, and the mailbox
    held 24: every frame above about 28 KB lost its tail for every receiver.
    Repair by retransmission could not keep up, the viewer asked for a
    keyframe, and the keyframe lost its tail too. Measured with a 1280x720
    VP8 screen: the viewer received 5341 packets, counted 444 lost, sent
    1670 NACKs and 108 PLIs and assembled 0 frames; the sender encoded 85
    keyframes. At 640x360 the same scenario passed. The mailbox now holds a
    whole frame (`maxFramePackets`); the same run shows 0 NACKs and a
    keyframe only on request. `TestVideoTargetMailboxHoldsAWholeFrame`, and
    the browser scenario "a screen share uses the room's codec, follows a
    codec pick, and keeps arriving" at 1920x1080
    (`MEDIA_E2E_SCREEN_SIZE` changes the size).
  - B19, the frames right behind a large keyframe dropped: with B18 fixed,
    a 1080p AV1 screen from Chromium still showed the viewer 10 of 77 encoded
    frames in 12 s on a loss-free link. The pacer is busy with a keyframe
    larger than its burst for 170 to 300 ms; the frames the publisher sends
    right behind it arrive meanwhile, and the queue of complete frames held
    4. The fifth was dropped whole (14 drops in one run, all of 1 to 5
    packets, in clusters right after a keyframe), so the picture could not
    continue from its own keyframe; the viewer froze about 3 s, asked for a
    keyframe, and the same happened again. The queue now holds 64 frames.
    `TestFramesBehindALargeKeyframeAreNotDropped`;
    `slowmeet_video_frames_dropped_total{reason="queue_full"}` counts what
    it still drops.
  - B20, a frame the SFU drops froze the picture for about three seconds:
    the frame-rate gate dropped one frame of a 720p VP8 screen (two captured
    frames 12 ms apart) and the viewer showed 19 of the 49 frames encoded in
    the next 12 s. Every later frame builds on the dropped one, and nothing
    asked for a keyframe until the viewer's own timeout did. The SFU now asks
    the publisher itself as soon as it drops a frame at the gate or at a full
    pacing queue, through the shared request budget and at most once a second
    per stream; not for a frame larger than it buffers, whose replacement
    would be too large again.
    `TestDroppedFrameAsksForAKeyframeButAnOversizedOneDoesNot`,
    `TestKeyframeAfterDropIsBoundedAndWaitsForTheSharedBudget`.
  - B21, a shared screen stuck at a frame every few seconds: on the default
    slow profile (180 kbps) a full-size screen in VP9 or VP8 fell into a
    keyframe loop after a codec change in the middle of the share. One
    1920x1080 keyframe costs seconds of that bitrate; the change asks for
    several, the viewer sees nothing for longer than the three seconds it
    waits before asking again, and every frame becomes a keyframe. Measured
    per 12 s, loss-free: VP9 2 to 4 frames at 1920x1080 and at 1280x720, 87 at
    960x540; VP8 12, 61 and 90; AV1 119 at full size (its keyframes are small).
    The same on the production server: VP9 2 frames in 12 s. VP9 from the
    start of a share did not loop in Chromium (10 fps at 34 kbps). The
    sender's screen adaptation only watched the bitrate, which stays inside
    the cap. It now also compares the frames the screen offers with the
    frames the encoder makes (`screenShareStarving`); below 2 a second for two
    samples it sends the next smaller size (1.5, 2, 3) and keeps the starved
    size ruled out for three minutes or until the budget grows. Browser
    scenario "a shared screen too large for its bitrate shrinks until it
    moves again": 4 frames in the first 12 s, then 76 (Chromium) and 46
    (Firefox). Where the browser does not report its video source, only an
    encoder using half its budget for less than a frame a second counts, so
    a slow VP8 encoder in Firefox (6 to 8 frames in 12 s at 55 kbps) is not
    caught. A smaller picture helps Firefox as much: per 12 s at 180 kbps,
    VP9 made 5, 24, 58 and 73 frames at 1920x1080, 1280x720, 960x540 and
    640x360, and VP8 12, 14, 48 and 70; in those runs the rule did shrink
    Firefox's share (to 1280x720, then 853x480), because its encoder was
    using the budget. What starvation teaches is kept per codec: a share that shrank
    in VP9 is full size again within one sample of being sent in AV1, and
    shrinks at once when the room returns to VP9. For 20 s after a codec
    change the rule samples every 2 s instead of every 5 s: measured from the
    codec pick on a moving 1920x1080 screen at 180 kbps, the share shrank
    after 12 to 16 s and moved again (ten frames in four seconds) after 21 to
    29 s before, and shrinks after 6 to 7 s and moves after 14 to 17 s now, in
    Chromium and Firefox. Two things the short samples must not do, both seen
    in the first attempt: the bitrate rule does not read them (it cut the
    frame-rate cap from 15 to between 7 and 12 after every codec change), and
    the sample right after a size change is not judged (it holds the new
    size's keyframe and took the picture straight on to 960x540).
  - B22, video many seconds late with nothing lost: a sender whose profile
    reaches `MAX_VIDEO_BITRATE` encodes at exactly the rate the SFU's pacer
    lets through, and is 1 to 3% over it once packet headers and the
    encoder's own overshoot are counted. The pacing queue then only grows.
    With room for 4 frames (before B19) that was a steady trickle of dropped
    frames; with room for 64 it was delay: a browser sharing a moving screen
    through a 300 kbps limit had every frame reach the viewers 12 s late (63
    frames queued, 0 dropped, so no counter showed it). The same follows a
    keyframe at any limit it is large against. The pacer now sends a frame
    that has waited 250 ms at one and a half times the rate and one that has
    waited a second at twice the rate, until the backlog is gone. Same
    browser run after: at most 5 frames queued, and steady state no longer
    grows. Synthetic, 20% over the rate for 20 s: longest wait 3.2 s before,
    0.2 s after. `slowmeet_video_frame_wait_max_ms` and
    `slowmeet_video_frame_queue_peak_frames` now show this delay.
    `TestASenderALittleOverTheRateDoesNotFallBehind`,
    `TestPacedVideoBytesSpeedUpALateFrame`.
  - B23, keyframes asked for while one was already on its way: a new viewer
    of a stream, a layer switch, and a publisher's renegotiation each sent
    three requests 250 ms apart, whether or not a keyframe was arriving. A
    sender on a small bitrate needs seconds to deliver one, so the request
    and both repeats went out while the first keyframe of a new screen share
    was still arriving (it would have reached the new viewer whole), and
    the encoder answered them one after another: 4 keyframes of about
    250 KB in the first 20 s of a 720p VP8 screen at 300 kbps, the viewer
    showed 5 of 23 frames and the pacer was 12 s behind. The SFU now reads
    the few header bits that mark a keyframe's first packet in VP8, VP9, AV1
    and H.264 (`startsVideoKeyFrame`; counts checked against the browser's
    own in all four), and neither asks nor repeats while a keyframe has
    started to arrive and not yet gone out, or once one has gone out since
    the request. Same run after: 2 keyframes (the second from a resolution
    step), no request, 16 of 19 frames shown, at most 1.2 s behind; AV1 at
    1920x1080: 3 keyframes before, 1 after. A viewer's own request (it asks
    every few seconds while it shows nothing) is likewise not passed on while
    a keyframe is arriving, queued, being sent, or was sent in the last
    250 ms: after a codec change in the middle of a 1080p share at 180 kbps
    the sender received 9 requests and made 7 keyframes in the first seconds
    before, 4 and 4 after. That change still costs 14 to 17 s of a crawling
    picture in VP9 (21 to 29 s before the faster sampling described under
    B21) until the sender has shrunk it and the smaller picture's keyframe
    has arrived; one full-size VP9 keyframe is simply seconds of that
    bitrate.
    `slowmeet_video_keyframes_total` counts keyframes.
    `TestVideoKeyFrameStartIsRecognisedPerCodec`, `TestKeyFrameComing`,
    `TestKeyFrameInTransit`, `TestKeyFramesAreCountedOnceAndMarkedOnTheirWayOut`,
    `TestKeyFrameRequestIsNotRepeatedOnceAKeyFrameIsComing`; browser scenario
    "a sender at the server's bitrate limit does not fall seconds behind"
    covers B22 and B23 together.
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
  - B12, simulcast cameras stuck on one tiny layer. With
    `SIMULCAST_ENABLED=true` every camera reached receivers as a single
    90x60 layer, so per-receiver layer selection had nothing to choose
    from. First reported as "impaired participants' cameras reach no one";
    that part was the protect-audio pause, which happens the same way with
    simulcast off. Five causes, all fixed:
    - Only the profile pass wrote the layers' scales and bitrates; the
      reconcile after a negotiation and the pause/resume write recomputed
      the plan from the capture but wrote only `active`. A camera whose
      layers were last fitted to a one-layer plan (the 360x240 `slow`
      capture, or a capture size read before it changed) and that then ran
      at 640x360 had its medium layer switched on at full size with the
      0.15 fallback share: `low:true:1:400000`, `medium:true:1:60000`,
      `high:false`, failing `simulcast-mixed-room`'s sender-side check now
      and then. Every writer
      now fits active, scale and bitrate together from one plan
      (`fitCameraSimulcastEncodings`), reusing the last profile bitrate
      and frame rate.
    - The three encodings had fixed 4/2/1 scales. Chrome caps simulcast
      layers by capture size (one below 480x270, two below 960x540) and
      keeps the lowest, so a 240p or 360p camera sent only the quarter-scale
      layer at 15 % of the bitrate. `planCameraSimulcast` now fits the
      layer count, scales and bitrate shares to the capture, the same way
      in every browser.
    - pion repeated the pause marks of the browser's first offer
      (`a=simulcast:recv low;~medium;~high`) in every later offer, and
      Chrome applies them to its encodings, so each renegotiation switched
      the upper layer off again. The SFU now sets
      `SetIgnoreRidPauseForRecv`, and the client puts its layers back to
      what it wants after every negotiation (`reconcileCameraSimulcast`).
      The pause and resume write also joined the serialized
      sender-parameter chain, so a stale write cannot land last.
    - The SFU can deliver a layer on a transceiver whose browser track ID
      is not the signaled one (the page's own first video transceiver, or
      one reused from another source). The client now reads each
      receiver's identity from the remote description's `a=msid`
      (`signaledTrackID`), not from `track.id`.
    - The client picked the shown layer by the browser's `muted` flag,
      which lags the SFU's switch by seconds. It now shows the layer track
      that is receiving packets (`selectLayer`'s `isFlowing`, sampled each
      stats tick).
    `TestSFUDoesNotEchoSimulcastPauseMarks`, `scripts/test-adaptation.js`
    (`planCameraSimulcast`), `scripts/test-remote-camera-video.js`,
    `simulcast-mixed-room`.

  A `knownIssue("Bn", ...)` check in the browser suite logs `KNOWN ISSUE
  Bn still present` and fails only with `SLOWMEET_KNOWN_FAILING=1`.

  Run the whole gated set the way CI does:

  ```sh
  MEDIA_E2E_FOUR_SCENARIO="mixed-quality-room,screen-share-mixed-quality,fluctuating-link,slow-bandwidth-room,reconnect-under-impairment,ice-restart-under-impairment,reconnect-after-expiry-under-impairment,cold-join-under-impairment,blackout-and-recovery,all-distinct-qualities,impaired-sharer-screen-share,delay-and-jitter-links,all-fast-link-top-quality,one-fast-three-bad-uplinks,all-four-impaired,slow-uplink-room,bad-downlink-among-bad-senders" make test-media-e2e-four-netns
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
TURN/TCP fallback. None of them runs in CI. They also cover:

- `repeated-signaling-resumes`: five TCP resets of one participant's
  signaling in a row, each resuming the same identity.
- `seat-handover-churn` and `seat-handover-churn-simulcast`: a new
  participant taking a departed one's seat, with every page binding the
  newcomer to its own tile.
- `simulcast-mixed-room`: every 360p camera sends a 180 px and a 360 px
  layer (B12); a receiver on the `narrow-downlink` tier (700 kbit, fits
  only the low layers) steps down and decodes every camera at 180 px while
  the fast and clean receivers keep 360 px, then climbs back once the cap
  lifts. It and `seat-handover-churn-simulcast` run on a server with
  `SIMULCAST_ENABLED=true`.

The netns runner uses Chromium for all four participants unless
`MEDIA_E2E_FOUR_ENGINES=mixed` puts P2 and P4 on Firefox. In the namespace
Firefox gathers only the address of its default route, and the namespace has
none, so it had no ICE candidate at all ("failed to find default addresses"
in its nICEr log); `media.peerconnection.ice.default_address_only` does not
change that, and a default route over loopback gives no source address. For
a mixed run the runner adds a dummy interface (10.77.0.1) with the default
route: that address becomes Firefox's host candidate, and its traffic to the
SFU on 127.0.0.1 is local, so it still crosses `lo` and the tiers' port
classifiers. The suite also allows loopback and turns mDNS host names off
for Firefox there (`firefoxUserPrefs` in `scripts/test-four-person-e2e.js`);
whether either is still needed with the dummy interface was not tested. Only
`mixed-quality-room` and the lossy-download scenarios have been run that
way; the rest of the netns list has not.

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
the CI list cannot pick them up by accident. The CI list names one of them
exactly, `slow-uplink-room`: it is the mirror of `one-fast-three-bad-uplinks`
(one participant with a thin lossy uplink, three clean), so the weaknet job
covers both 1 good / 3 bad and 3 good / 1 bad.

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
- **New tiers** (`thin-uplink`, `bursty`, `relay-lossy`, `flap`,
  `narrow-downlink`) are
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
