# Participant media E2E

The Playwright harness starts a local SlowMeet server and opens two isolated
Chromium contexts. The default run uses Chromium's generated camera and
microphone, then checks participant messaging, reactions, hand state, controls,
device selection, media toggles, ICE recovery, signaling reconnect, leave/rejoin,
and controlled capture failures.

```sh
make test-media-e2e
```

For real camera and microphone capture, run Chromium headed and grant capture
permission to the local test origin:

```sh
MEDIA_E2E_REAL_MEDIA=1 MEDIA_E2E_HEADED=1 node scripts/test-media-e2e.js
```

When Chromium exposes a second input, the harness switches to it and verifies
that the existing sender continues with the replacement track. If only one
input is available, the report marks device switching as blocked. In synthetic
mode, a test fixture exposes a second selectable camera and microphone while
still using Chromium's generated capture tracks.

The headed screen-share run creates a changing-content source page and uses
Chromium's test-only automatic source selection. This checks capture delivery,
camera RTP during sharing, competing-share blocking, stopping, and restarting
without counting native picker UI coverage:

```sh
MEDIA_E2E_REAL_MEDIA=1 MEDIA_E2E_HEADED=1 MEDIA_E2E_SCREEN_SHARE=1 node scripts/test-media-e2e.js
```

Use `MEDIA_E2E_SCREEN_SHARE_ONLY=1` with the same headed and screen-share
settings to run just the camera setup and bidirectional changing-window share
checks. This is useful when isolating a screen-capture issue from ICE-restart
coverage.

Set `MEDIA_E2E_SCREEN_SHARE_NATIVE=1` for the separate manual picker and browser
sharing-indicator path. It requires a person to choose the source and stop the
share from Chromium's indicator.

To exercise bandwidth, delay, and packet loss, run the dedicated namespace
target:

```sh
make test-media-e2e-netns
```

It applies `tc netem` only to loopback inside a disposable Linux user/network
namespace, then checks media continuity and recovery after removing the profile.
It does not change the host's shared network interface. The target requires
Linux `unshare`, `ip`, and `tc`; kernels that disable unprivileged user
namespaces will report the run as unavailable.

Failure screenshots, Playwright traces, console/network events, and peer stats
are written under `/tmp/slowmeet-media-e2e-failure-*`. Set
`MEDIA_E2E_ARTIFACT_DIR` to choose another directory. Passing runs do not save
screenshots or traces.
