# Four Person Room E2E Findings

Failures from `make test-media-e2e-four` are appended; prior entries and artifacts are preserved.

## 2026-11-01T18:08:06.501Z — startup

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: listen EPERM: operation not permitted 127.0.0.1
- Failure type: environment-or-browser (the runner probed `/healthz`; this repository exposes `/health`; corrected in the runner)
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-MpDflj`

## 2026-11-01T18:10:35.710Z — startup

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: local server did not become ready
{"time":"2026-11-01T21:40:09.708036145+03:30","level":"INFO","msg":"server_starting","addr":"127.0.0.1:43731"}

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-b1o7ym`

## 2026-11-01T18:13:02.017Z — staggered-and-simultaneous-joins

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: browserType.launch: Executable doesn't exist at /home/ashkan/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell
╔════════════════════════════════════════════════════════════╗
║ Looks like Playwright was just installed or updated.       ║
║ Please run the following command to download new browsers: ║
║                                                            ║
║     npx playwright install                                 ║
║                                                            ║
║ <3 Playwright Team                                         ║
╚════════════════════════════════════════════════════════════╝
- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-RKrOiq`

## 2026-11-01T18:13:52.397Z — staggered-and-simultaneous-joins

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: P1 has no advancing decoded video [{"width":0,"height":0,"time":0,"name":""},{"width":0,"height":0,"time":2.24,"name":""},{"width":0,"height":0,"time":0,"name":"ALow bandwidthCamera offScreen sharingAveryYou"},{"width":0,"height":0,"time":0,"name":"ALow bandwidthCamera offScreen sharingAveryYou"},{"width":0,"height":0,"time":0,"name":"BLow bandwidthCamera offScreen sharingBlakeYou"},{"width":0,"height":0,"time":0,"name":"BLow bandwidthCamera offScreen sharingBlakeYou"},{"width":0,"height":0,"time":0,"name":"DLow bandwidthCamera offScreen sharingDrewYou"},{"width":0,"height":0,"time":0,"name":"DLow bandwidthCamera offScreen sharingDrewYou"},{"width":0,"height":0,"time":0,"name":"CLow bandwidthCamera offScreen sharingCaseyYou"},{"width":0,"height":0,"time":0,"name":"CLow bandwidthCamera offScreen sharingCaseyYou"}]
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-HIqPEq`

## 2026-11-01T18:14:24.435Z — reactions-and-raised-hands

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: Avery hand not raised

'false' !== 'true'

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-DLAajS`

## 2026-11-01T18:15:42.935Z — fifth-participant-capacity

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: locator.waitFor: Timeout 20000ms exceeded.
Call log:
[2m  - waiting for locator('#meeting') to be visible[22m
[2m    44 × locator resolved to hidden <section hidden="" id="meeting" class="meeting-shell" aria-labelledby="meeting-title">…</section>[22m

- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-aFT7yz`

## 2026-11-01T18:17:52.457Z — generated-screen-share

- Reproduction: `make test-media-e2e-four`
- Expected: Avery observes Casey's screen-share state start and stop.
- Actual: Casey's local share control did not remain active and Avery never observed Casey as the sharing participant; remote sharing-state wait timed out after 15 seconds.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-1COSnb`

## 2026-11-01T20:46:59.659Z — generated-screen-share

- Reproduction: `make test-media-e2e-four`
- Expected: Avery observes Casey's screen-share state start and stop.
- Actual: Avery did not observe Casey's remote screen-share state: {"owner":"false","tiles":[{"name":"ALow bandwidth#1Screen sharingAveryYou","sharing":"false"},{"name":"BLow bandwidth#2Screen sharingBlakeYou","sharing":"false"},{"name":"DLow bandwidth#3Screen sharingDrewYou","sharing":"false"},{"name":"CLow bandwidthCamera offScreen sharingCaseyYou","sharing":"false"}]}
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-implementation/generated-screen-share`

## 2026-11-01T20:49:32.655Z — generated-screen-share

- Reproduction: `make test-media-e2e-four`
- Expected: Avery observes Casey's screen-share state start and stop.
- Actual: Avery did not observe Casey's remote screen-share state: {"owner":"false","tiles":[{"name":"ALow bandwidth#1Screen sharingAveryYou","sharing":"false"},{"name":"BLow bandwidth#2Screen sharingBlakeYou","sharing":"false"},{"name":"DLow bandwidth#3Screen sharingDrewYou","sharing":"false"},{"name":"CLow bandwidthCamera offScreen sharingCaseyYou","sharing":"false"}]}
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-instrumented/generated-screen-share`

## 2026-11-01T20:50:55.451Z — generated-screen-share

- Reproduction: `make test-media-e2e-four`
- Expected: Avery observes Casey's screen-share state start and stop.
- Actual: Avery did not observe Casey's remote screen-share state: {"owner":"false","tiles":[{"name":"ALow bandwidth#1Screen sharingAveryYou","sharing":"false"},{"name":"BLow bandwidth#2Screen sharingBlakeYou","sharing":"false"},{"name":"DLow bandwidth#3Screen sharingDrewYou","sharing":"false"},{"name":"CLow bandwidthCamera offScreen sharingCaseyYou","sharing":"false"}]}
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-offer-size/generated-screen-share`

## 2026-11-01T22:01:16.825Z — staggered-and-simultaneous-joins

- Reproduction: `make test-media-e2e-four`
- Expected: All four named participants appear in each roster and connect to the room.
- Actual: browserContext.grantPermissions: Unknown permission: camera
- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/.ctx-mode-9hCjga/slowmeet-four-person-e2e-failure-DKmjwQ`

## 2026-11-01T22:01:49.818Z — startup

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: listen EPERM: operation not permitted 127.0.0.1
- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-23teD3`

## 2026-11-01T22:02:21.201Z — startup

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: listen EPERM: operation not permitted 127.0.0.1
- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-osFxN5`

## 2026-11-01T22:03:12.052Z — simultaneous-four-way-chat

- Reproduction: `make test-media-e2e-four`
- Expected: Concurrent chat messages from all participants appear on all four browsers.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
[2m  - waiting for locator('#chat-form button[type=submit]')[22m
[2m    - locator resolved to <button type="submit" class="send-button" aria-label="Send message" title="Send message (Enter)">…</button>[22m
[2m  - attempting click action[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not visible[22m
[2m    - retrying click action[22m
[2m    - waiting 20ms[22m
[2m    2 × waiting for element to be visible, enabled and stable[22m
[2m      - element is not visible[22m
[2m    - retrying click action[22m
[2m      - waiting 100ms[22m
[2m    53 × waiting for element to be visible, enabled and stable[22m
[2m       - element is not visible[22m
[2m     - retrying click action[22m
[2m       - waiting 500ms[22m

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-9PzdmV`

## 2026-11-01T22:04:33.563Z — signaling-reconnect

- Reproduction: `make test-media-e2e-four`
- Expected: Avery reconnects signaling and resumes advancing video.
- Actual: P2 decoded video frames did not advance (103 -> 103)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-yWW9yZ`

## 2026-11-01T22:05:53.447Z — signaling-reconnect

- Reproduction: `make test-media-e2e-four`
- Expected: Avery reconnects signaling and resumes advancing video.
- Actual: P2 decoded video frames did not advance (105 -> 105)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-mu4gnd`

## 2026-11-01T22:08:43.563Z — signaling-reconnect

- Reproduction: `make test-media-e2e-four`
- Expected: Avery reconnects signaling and resumes advancing video.
- Actual: P2 decoded video frames did not advance (100 -> 100)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-XTHTVu`

## 2026-11-01T22:10:23.534Z — signaling-reconnect

- Reproduction: `make test-media-e2e-four`
- Expected: Avery reconnects signaling and resumes advancing video.
- Actual: P2 decoded video frames did not advance (70 -> 70)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-ZvOngP`

## 2026-11-01T22:18:16.541Z — simultaneous-reactions

- Reproduction: `make test-media-e2e-four`
- Expected: Concurrent reactions from all participants appear on all four browsers.
- Actual: page.waitForFunction: Timeout 30000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-h51Wfv`

## 2026-11-03T21:45:21.881Z — staggered-and-simultaneous-joins

- Reproduction: `make test-media-e2e-four`
- Expected: All four named participants appear in each roster and connect to the room.
- Actual: page.goto: NS_ERROR_NET_ERROR_RESPONSE
Call log:
  - navigating to "http://127.0.0.1:41285/", waiting until "load"

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-KIyx66`

## 2026-11-03T21:45:52.308Z — staggered-and-simultaneous-joins

- Reproduction: `make test-media-e2e-four`
- Expected: All four named participants appear in each roster and connect to the room.
- Actual: page.goto: NS_ERROR_NET_ERROR_RESPONSE
Call log:
  - navigating to "http://127.0.0.1:42265/", waiting until "load"

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-t2Yb5J`

## 2026-11-03T21:47:01.358Z — media-state-propagation

- Reproduction: `make test-media-e2e-four`
- Expected: Mic and camera toggles by each participant flip the matching tile state on every other browser.
- Actual: page.waitForFunction: Timeout 10000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-m97t0C`

## 2026-11-03T21:50:26.266Z — departure-and-rejoin

- Reproduction: `make test-media-e2e-four`
- Expected: Drew leaves without a ghost tile, then rejoins the four-person roster.
- Actual: page.waitForFunction: Timeout 15000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-WCLPSW`

## 2026-11-03T21:51:27.554Z — simultaneous-departures

- Reproduction: `make test-media-e2e-four`
- Expected: Two participants leaving at once converge every roster to the same two members and both slots are reusable.
- Actual: page.waitForFunction: Timeout 20000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-q9kwQB`

## 2026-11-03T21:57:40.408Z — audio-only-mode

- Reproduction: `make test-media-e2e-four`
- Expected: Protect audio pauses the participant's camera room-wide and blocks screen sharing until it is turned off again.
- Actual: share control should be disabled while Protect audio is enabled
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-V2mbKQ`

## 2026-11-03T21:58:54.624Z — rejoin-via-button

- Reproduction: `make test-media-e2e-four`
- Expected: Drew rejoins through the post-leave Rejoin action with the name preserved and media re-establishes.
- Actual: roster has ghost or duplicate tiles: ALow bandwidthScreen sharingAveryYou | BLow bandwidthScreen sharingBlakeYou | CLow bandwidthScreen sharingCaseyYou | DLow bandwidthParticipant leftScreen sharingDrewYou | DLow bandwidthCamera offScreen sharingDrewYou

5 !== 4

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-9Km9Ko`

## 2026-11-03T22:01:32.495Z — rejoin-via-button

- Reproduction: `make test-media-e2e-four`
- Expected: Drew rejoins through the post-leave Rejoin action with the name preserved and media re-establishes.
- Actual: roster has ghost or duplicate tiles: ALow bandwidthScreen sharingAveryYou | BLow bandwidthScreen sharingBlakeYou | CLow bandwidthScreen sharingCaseyYou | DLow bandwidthParticipant leftScreen sharingDrewYou | DLow bandwidthCamera offScreen sharingDrewYou

5 !== 4

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/four-debug/rejoin-via-button`

## 2026-11-03T22:04:51.066Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: lease loser was not told the share is active: Connected
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-h3lr0I`

## 2026-11-03T22:05:23.639Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: lease loser was not told the share is active: Connected
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-zHoSd3`

## 2026-11-03T22:07:11.136Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#screen')
    - locator resolved to <button id="screen" type="button" aria-pressed="false" title="Share screen" class="control-button" aria-label="Share screen">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-TT8g2Q`

## 2026-11-03T22:07:51.796Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#screen')
    - locator resolved to <button id="screen" type="button" aria-pressed="false" title="Share screen" class="control-button" aria-label="Share screen">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-l0umqf`

## 2026-11-03T22:11:01.684Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#screen')
    - locator resolved to <button id="screen" type="button" aria-pressed="false" title="Share screen" class="control-button" aria-label="Share screen">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/four-debug2/screen-share-lease-race`

## 2026-11-03T22:11:42.730Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#screen')
    - locator resolved to <button id="screen" type="button" aria-pressed="false" title="Share screen" class="control-button" aria-label="Share screen">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/four-debug2/screen-share-lease-race`

## 2026-11-03T22:12:33.719Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#screen')
    - locator resolved to <button id="screen" type="button" aria-pressed="false" title="Share screen" class="control-button" aria-label="Share screen">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/four-debug2/screen-share-lease-race`

## 2026-11-03T22:17:40.057Z — staggered-and-simultaneous-joins

- Reproduction: `make test-media-e2e-four`
- Expected: All four named participants appear in each roster and connect to the room.
- Actual: page.goto: Download is starting
Call log:
  - navigating to "http://127.0.0.1:36079/", waiting until "load"

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-pFuEhs`

## 2026-11-03T22:18:13.776Z — staggered-and-simultaneous-joins

- Reproduction: `make test-media-e2e-four`
- Expected: All four named participants appear in each roster and connect to the room.
- Actual: page.goto: Download is starting
Call log:
  - navigating to "http://127.0.0.1:40273/", waiting until "load"

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-zl7tJn`

## 2026-11-03T22:26:32.184Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#screen')
    - locator resolved to <button id="screen" type="button" aria-pressed="false" title="Share screen" class="control-button" aria-label="Share screen">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-rIbPcQ`

## 2026-11-03T22:29:11.674Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: locator.click: Timeout 30000ms exceeded.
Call log:
  - waiting for locator('#screen')
    - locator resolved to <button id="screen" type="button" aria-pressed="false" title="Share screen" class="control-button" aria-label="Share screen">…</button>
  - attempting click action
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
    - waiting 20ms
    2 × waiting for element to be visible, enabled and stable
      - element is not enabled
    - retrying click action
      - waiting 100ms
    53 × waiting for element to be visible, enabled and stable
       - element is not enabled
     - retrying click action
       - waiting 500ms

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-HXztSM`

## 2026-11-03T22:31:14.005Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: lease loser was not told the share is active: Connected
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-NeJZ5y`

## 2026-11-03T22:31:55.115Z — screen-share-lease-race

- Reproduction: `make test-media-e2e-four`
- Expected: Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.
- Actual: lease loser was not told the share is active
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-iyqBRj`

## 2026-11-03T22:38:58.016Z — sharer-departs-mid-share

- Reproduction: `make test-media-e2e-four`
- Expected: A sharer leaving clears sharing state room-wide and releases the lease for the next participant.
- Actual: page.evaluate: Error: [{"direction":"receive","message":{"type":"error","error":"screen sharing is already active"},"bytes":72,"readyState":1}]
    at eval (eval at evaluate (:311:30), <anonymous>:4:41)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-MSx6or`

## 2026-11-04T21:53:47.218Z — camera-quality-preset

- Reproduction: `make test-media-e2e-four`
- Expected: Setting the camera quality to off pauses the participant's camera room-wide and a preset restores it.
- Actual: page.waitForFunction: Timeout 10000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-L5KEdV`

## 2026-11-04T21:54:44.991Z — push-to-talk

- Reproduction: `make test-media-e2e-four`
- Expected: Holding Space unmutes a muted mic for the room and releasing mutes it again.
- Actual: page.waitForFunction: Timeout 5000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-zp7bd5`

## 2026-11-04T21:56:42.522Z — camera-quality-preset

- Reproduction: `make test-media-e2e-four`
- Expected: Setting the camera quality to off pauses the participant's camera room-wide and a preset restores it.
- Actual: locator.waitFor: Timeout 5000ms exceeded.
Call log:
  - waiting for locator('#camera-quality') to be visible
    14 × locator resolved to hidden <select id="camera-quality">…</select>

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-75P7Lx`

## 2026-11-06T21:45:13.865Z — self-view-toggle

- Reproduction: `make test-media-e2e-four`
- Expected: Hiding self-view removes only the local tile on that browser while everyone else still sees the participant.
- Actual: page.evaluate: names is not defined
@debugger eval code line 311 > eval:3:49
@debugger eval code line 311 > eval:3:8
evaluate@debugger eval code:313:16
@debugger eval code:1:44
@debugger eval code:1:62

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-MQ8re8`

## 2026-11-06T21:46:21.589Z — escape-priority-chain

- Reproduction: `make test-media-e2e-four`
- Expected: Escape dismisses stacked stage focus, connection popover, reaction picker, and chat rail in priority order.
- Actual: page.waitForFunction: Timeout 5000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-uEM774`

## 2026-11-06T21:47:57.435Z — startup

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: local server did not become ready
# SlowMeet/internal/media
internal/media/router.go:1029:40: extension.payload undefined (cannot refer to unexported field payload)
internal/media/router.go:1030:26: extension.payload undefined (cannot refer to unexported field payload)
internal/media/router.go:1031:13: extension.payload undefined (cannot refer to unexported field payload)

- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-5uboVi`

## 2026-11-06T21:50:18.093Z — welcome-roster-preview

- Reproduction: `make test-media-e2e-four`
- Expected: The prejoin screen previews the three current members before the fourth joins.
- Actual: page.waitForFunction: ReferenceError: names is not defined
    at eval (eval at predicate (eval at evaluate (:311:30)), <anonymous>:3:13)
    at predicate (eval at evaluate (:311:30), <anonymous>:7:27)
    at next (eval at evaluate (:311:30), <anonymous>:29:33)
    at eval (eval at evaluate (:311:30), <anonymous>:42:13)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-mgdCSl`

## 2026-11-06T21:50:37.265Z — welcome-roster-preview

- Reproduction: `make test-media-e2e-four`
- Expected: The prejoin screen previews the three current members before the fourth joins.
- Actual: page.waitForFunction: ReferenceError: names is not defined
    at eval (eval at predicate (eval at evaluate (:311:30)), <anonymous>:3:13)
    at predicate (eval at evaluate (:311:30), <anonymous>:7:27)
    at next (eval at evaluate (:311:30), <anonymous>:29:33)
    at eval (eval at evaluate (:311:30), <anonymous>:42:13)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/w3debug/welcome-roster-preview`

## 2026-11-06T21:51:14.416Z — axe-accessibility

- Reproduction: `make test-media-e2e-four`
- Expected: The meeting surface has no axe critical or serious accessibility violations.
- Actual: page.addScriptTag: Executing inline script violates the following Content Security Policy directive 'script-src 'self''. Either the 'unsafe-inline' keyword, a hash ('sha256-E3EeTHvx5D/JxHMAmxf9pFfuV6852vl1jPB1znFLMxA='), or a nonce ('nonce-...') is required to enable inline execution. The action has been blocked.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-KXV9NB`

## 2026-11-06T21:52:02.225Z — startup

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants join, synchronize room state, exchange media, and reject a fifth join.
- Actual: local server did not become ready
# SlowMeet/internal/httpserver
internal/httpserver/server.go:663:17: undefined: strconv

- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-dqdiMO`

## 2026-11-06T21:53:10.194Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.waitForFunction: Timeout 30000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-1pYclv`

## 2026-11-06T21:55:13.318Z — reaction-rate-limit

- Reproduction: `make test-media-e2e-four`
- Expected: Ten rapid reactions from one client deliver exactly the six the 3-second limit allows, and the tile still renders the reaction.
- Actual: expected the 6-per-3s reaction limit to pass 6 of 10, saw 4

4 !== 6

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-9Lyr7R`

## 2026-11-06T21:58:32.566Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.waitForFunction: Timeout 30000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-h5R6y7`

## 2026-11-06T22:02:44.838Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.waitForFunction: Timeout 60000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-gRdiRG`

## 2026-11-06T22:03:37.181Z — admin-caps-and-chat-reset

- Reproduction: `make test-media-e2e-four`
- Expected: Admin bitrate caps and history-retention changes fan out to every browser and a reset empties what reconnect replays.
- Actual: locator.waitFor: Target page, context or browser has been closed
Browser logs:

<launching> /usr/bin/google-chrome --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-client-side-phishing-detection --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,DialMediaRouteProvider,GlobalMediaControls,HttpsUpgrades,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,BlockOriginHeaderModificationOnRedirect,Translate,AutoDeElevate,OptimizationHints,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --export-tagged-pdf --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --edge-skip-compat-layer-relaunch --disable-infobars --disable-search-engine-choice-screen --disable-sync --enable-unsafe-swiftshader --headless --hide-scrollbars --mute-audio --blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4 --no-sandbox --use-fake-device-for-media-stream --use-fake-ui-for-media-stream --autoplay-policy=no-user-gesture-required --no-proxy-server --user-data-dir=/tmp/playwright_chromiumdev_profile-rln2pZ --remote-debugging-pipe --no-startup-window
<launched> pid=143407
[pid=143407] <gracefully close start>
Call log:
  - waiting for locator('#join-form') to be visible

- Failure type: environment-or-browser
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-llfONW`

## 2026-11-07T06:35:30.428Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.waitForFunction: Timeout 60000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-sxa8hv`

## 2026-11-07T06:45:52.337Z — axe-accessibility

- Reproduction: `make test-media-e2e-four`
- Expected: The meeting surface has no axe critical or serious accessibility violations.
- Actual: the meeting surface has axe critical/serious violations
+ actual - expected

+ [
+   {
+     id: 'scrollable-region-focusable',
+     impact: 'serious',
+     nodes: [
+       [
+         '#chat-messages'
+       ]
+     ]
+   }
+ ]
- []

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-K4jVnV`

## 2026-11-07T06:50:20.823Z — escape-priority-chain

- Reproduction: `make test-media-e2e-four`
- Expected: Escape dismisses stacked stage focus, connection popover, reaction picker, and chat rail in priority order.
- Actual: page.waitForFunction: Timeout 5000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-Jy7TpR`

## 2026-11-07T06:59:38.624Z — grace-window-churn

- Reproduction: `make test-media-e2e-four`
- Expected: During a member's reconnect grace window the other browsers see the left state, then the same identity resumes without ghosts.
- Actual: page.waitForFunction: Timeout 20000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-MqiiCy`

## 2026-11-13T21:16:46.150Z — mixed-quality-room

- Reproduction: `make test-media-e2e-four`
- Expected: Four participants on three different link qualities: audio survives everywhere, degradation stays per-participant, and recovery is prompt.
- Actual: page.waitForFunction: Timeout 10000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-jX7Pxb`

## 2026-11-13T21:20:57.555Z — chat-dom-cap

- Reproduction: `make test-media-e2e-four`
- Expected: A four-sender flood cannot grow the chat rail past its 300-node cap.
- Actual: page.waitForFunction: Timeout 30000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-uLhpoT`

## 2026-11-13T21:20:58.294Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.evaluate: Error: [{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1}]
    at eval (eval at evaluate (:311:30), <anonymous>:4:41)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-qsw3hc`

## 2026-11-13T21:20:59.127Z — axe-accessibility

- Reproduction: `make test-media-e2e-four`
- Expected: The meeting surface has no axe critical or serious accessibility violations.
- Actual: page.evaluate: Error: [{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1}]
    at eval (eval at evaluate (:311:30), <anonymous>:4:41)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-aekMyx`

## 2026-11-13T21:20:59.894Z — fifth-participant-capacity

- Reproduction: `make test-media-e2e-four`
- Expected: The room rejects a fifth browser with a clear full-room message and every present participant sees the room-full notice.
- Actual: page.evaluate: Error: [{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1},{"direction":"receive","message":{"type":"error","error":"chat message rate limit exceeded"},"bytes":72,"readyState":1}]
    at eval (eval at evaluate (:311:30), <anonymous>:4:41)
    at UtilityScript.evaluate (<anonymous>:313:16)
    at UtilityScript.<anonymous> (<anonymous>:1:44)
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-27NU3c`

## 2026-11-13T21:26:29.927Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.waitForFunction: Timeout 30000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-YeN9oV`

## 2026-11-13T21:26:32.202Z — axe-accessibility

- Reproduction: `make test-media-e2e-four`
- Expected: The meeting surface has no axe critical or serious accessibility violations.
- Actual: the meeting surface has axe critical/serious violations
+ actual - expected

+ [
+   {
+     id: 'label-content-name-mismatch',
+     impact: 'serious',
+     nodes: [
+       [
+         '#chat'
+       ]
+     ]
+   }
+ ]
- []

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-fH2JjA`

## 2026-11-13T21:27:40.792Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.waitForFunction: Timeout 30000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-sXXQ8D`

## 2026-11-13T21:29:56.691Z — congestion-adaptation

- Reproduction: `make test-media-e2e-four`
- Expected: Injected packet loss drives automatic video pause room-wide and recovery restores it.
- Actual: page.waitForFunction: Timeout 60000ms exceeded.
- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-Qy8A5X`

## 2026-11-13T21:34:28.503Z — axe-accessibility

- Reproduction: `make test-media-e2e-four`
- Expected: The meeting surface has no axe critical or serious accessibility violations.
- Actual: the meeting surface has axe critical/serious violations
+ actual - expected

+ [
+   {
+     id: 'label-content-name-mismatch',
+     impact: 'serious',
+     nodes: [
+       [
+         '#chat'
+       ]
+     ]
+   }
+ ]
- []

- Failure type: application-or-assertion
- Participant roles: P1=Avery, P2=Blake, P3=Casey, P4=Drew
- Artifacts: `/tmp/slowmeet-four-person-e2e-failure-LKpXyi`
