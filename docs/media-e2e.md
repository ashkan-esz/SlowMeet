# Participant media E2E

The local Playwright harness runs each named scenario with two independent
Chromium processes. Participant A and participant B each get a fresh browser
context. The default `full` profile uses deterministic generated camera and
microphone media, reports every scenario as `PASS`, `FAIL`, or `NOT RUN`, and
continues after an individual scenario fails. Any selected scenario failure
returns a nonzero exit status.

## Audio quality and delay

Microphone E2E checks verify outbound and inbound audio RTP progress in both
directions, then verify the remote audio element is playing and its playback
time advances. Diagnostics report packet loss, RTP jitter, average jitter-buffer
delay, sample concealment counters when Chromium exposes them, and candidate-pair
RTT. RTT and jitter-buffer delay are separate indicators; neither is a
one-way mouth-to-ear measurement. The first-microphone scenario also sends a
time-coded synthetic audio marker in each direction and reports its one-way
arrival at the remote Web Audio capture. This measures the browser media path,
not physical microphone-to-speaker delay or acoustic echo. Missing optional
browser statistics are reported as unavailable rather than treated as zero.

Print per-direction audio samples during the microphone toggle scenario with:

```sh
MEDIA_E2E_SCENARIO='microphone mute and unmute with repeated toggles in both directions' make test-media-e2e
```

To capture the connection warning around A's one-way microphone start in both
browser contexts, run:

```sh
MEDIA_E2E_SCENARIO="A microphone start captures both browsers' connection quality timeline" make test-media-e2e
```

The browser's **Copy diagnostics** action includes the current sample and the
latest 30 one-second samples. Samples contain local/remote tile quality, the
connection warning, peer and ICE states, RTT, jitter, packet loss, and audio
rates and byte counters. The history stays in memory in that browser and is
cleared when the meeting ends; it is copied only after the user selects the
diagnostics action. Participant names and device details are not included.

The isolated network profile records baseline, impaired, and recovery audio
statistics while keeping both microphones active. It uses the same loopback
delay, bandwidth, and packet-loss profiles described below and verifies that
audio RTP continues in each direction.

## Camera stop/resume regression

The required `full` profile includes a time-coded synthetic-camera transition
regression. It covers A sharing before B, B sharing before A, each participant
stopping and resuming while the other camera remains live, repeated toggles
for both participants, back-to-back pause/resume bursts from both participants,
and near-simultaneous transitions. These scenarios run through the normal
two-Chromium/two-context media path; the time-coded camera source is installed
only for the marked test scenarios.

The capture waits for fresh, correctly routed local and remote marker frames
before measuring stop/resume transitions. Initial camera starts do not count as
resumes. It checks every orderly resumed frame and requires at least one
delivered, fresh frame from the rapid burst after its acknowledged prelude.
After the final transition,
the suite allows 500 ms to settle and observes five seconds of
stable playback. It fails if a decoded-frame gap exceeds 500 ms, decoded frame
age exceeds one second, any overlapping one-second playback or source-rate
window (sampled every 250 ms) falls outside 0.9–1.1×, the page
heartbeat stalls for more than 500 ms, or the resumed camera does not produce
a moving frame within one second of its remote camera-on state. The camera
that is intentionally off is excluded during that pause; the other participant
and both browser pages must remain responsive. ICE, peer-connection, and
signaling-socket health are checked throughout.

Run these required regression cases with the complete deterministic suite:

```sh
make test-media-e2e
```

The physical-camera profile remains a separate, optional acceptance run; it
does not replace the reproducible time-coded regression.

Install the browser-check dependencies once, then run the full local suite:

```sh
npm install
make test-media-e2e
```

For a focused rerun while debugging, select one exact scenario name:

```sh
MEDIA_E2E_SCENARIO='bidirectional ICE restart restores both media directions without reconnect' make test-media-e2e
```

The focused run reports every other case as `NOT RUN` and exits nonzero because
the complete required suite did not run. Use the unfiltered command for a full
suite result.

The suite covers pre-join validation and device preview, join ordering and the
configured two-person limit, roster updates, chat, reactions, raised hands,
local settings, keyboard and focus behavior, responsive layout, axe
accessibility checks, camera and microphone toggles, device replacement,
incoming-video controls, audio-only protection, self-view, ICE and signaling
recovery, screen-share ownership and lifecycle, leave and track cleanup, and
capture failures. Generated screen-share checks verify that received pixels
change as well as decoded frames and playback time. The accessibility scenario
fails for axe `critical` or `serious` findings.

The default profile excludes checks that need local hardware, a native picker,
or an isolated network namespace. It records those cases as `NOT RUN`; a default
pass does not claim confidence in those gates.

## Environment-qualified profiles

Run headed real-camera and microphone acceptance with two physical devices or
other known-good capture sources:

```sh
make test-media-e2e-real
```

Acceptance requires decoded remote frames and remote audio playback time to
advance in both directions while both participants remain connected. During the
headed stability window, speak a short phrase in each direction and listen for
gaps, distortion, or echo; headphones help avoid feedback. The E2E report records
network and jitter-buffer indicators, while the listening check covers audible
quality. The real-media profile also checks first mic enable with A and B using
the same device's microphone and speakers, records whether echo cancellation is
active, and asks the operator to repeat with headphones. A synthetic pass does
not replace this hardware check.

Run generated changing-content screen-share tests in headed Chromium:

```sh
make test-media-e2e-screen-share
```

Run native screen-picker and browser sharing-indicator coverage separately:

```sh
make test-media-e2e-picker
```

The native-picker gate requires a person to choose a source and stop sharing
from Chromium's browser indicator. These headed runs remain separate from the
deterministic default profile.

Exercise bandwidth, delay, and packet loss through the isolated namespace
profile:

```sh
make test-media-e2e-netns
```

This applies `tc netem` only to loopback inside a disposable Linux user/network
namespace. It does not change the host's shared network interface. The target
requires Linux `unshare`, `ip`, and `tc`; kernels that disable unprivileged user
namespaces report the environment limitation as a failed gate.

The runner refuses remote targets unless `MEDIA_E2E_ALLOW_EXTERNAL=1` is set.
For an explicitly authorized staging target, provide `MEDIA_E2E_BASE_URL` and,
when required, `MEDIA_E2E_MEETING_PASSWORD`. Do not point this runner at a
production meeting.

## Failure artifacts

For each failed scenario, the runner saves both participants' screenshots,
Playwright traces, console and page errors, request/response events, peer
statistics, camera-transition samples, and relevant server logs. By default
artifacts go under a unique
`/tmp/slowmeet-media-e2e-failure-*` directory. Set
`MEDIA_E2E_ARTIFACT_DIR` to choose a parent directory. Successful scenarios do
not save artifacts.

This suite is local-only: it is not part of PR CI or `make check`.
