const fs = require("node:fs");
const path = require("node:path");
const {
  deriveMeetingLayoutMode,
  pinParticipant,
  unpinParticipant,
  visibleParticipantIds,
  formatMetric,
  parseDebugMode,
  createPoorConnectionFixture,
  chooseDebugParticipants,
  chooseActiveSpeaker,
  speakerDebounce,
  chooseFilmstripLayout
} = require("../web/js/meeting-layout.js");
const { chooseParticipantLayout } = require("../web/js/adaptation-policy.js");

if (deriveMeetingLayoutMode({ pinnedParticipantIds: ["p1"], activeScreenShareId: "p2" }) !== "pinned" ||
    deriveMeetingLayoutMode({ activeScreenShareId: "p2" }) !== "grid" ||
    deriveMeetingLayoutMode({ pinnedParticipantIds: ["p1", "p2"] }) !== "pinned" ||
    deriveMeetingLayoutMode({}) !== "grid") {
  throw new Error("layout mode precedence is incorrect");
}
if (pinParticipant([], "p1").join(",") !== "p1" ||
    pinParticipant(["p1"], "p2").join(",") !== "p1,p2" ||
    pinParticipant(["p1", "p2"], "p3").join(",") !== "p2,p3" ||
    pinParticipant(["p1", "p2"], "p2").join(",") !== "p1,p2" ||
    unpinParticipant(["p1", "p2"], "p1").join(",") !== "p2") {
  throw new Error("two-participant pin state should preserve order and replace the oldest pin");
}
const pinAppSource = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const pinStyleSource = fs.readFileSync(path.join(__dirname, "../web/css/style.css"), "utf8");
if (!pinAppSource.includes("let pinnedParticipantIDs = []") ||
    !pinAppSource.includes("meetingViewState.pinnedParticipantIds = [...pinnedParticipantIDs]") ||
    !pinAppSource.includes("pinnedParticipantIDs.includes(participantID)")) {
  throw new Error("two-participant pin state wiring is missing");
}
if (!pinStyleSource.includes("grid-template-columns: repeat(var(--pinned-count, 1), minmax(0, 1fr));")) {
  throw new Error("pinned stage must support equal two-up tiles");
}
for (let mode = 1; mode <= 10; mode += 1) {
  if (parseDebugMode(`?debug=${mode}`) !== mode) {
    throw new Error(`debug mode ${mode} should be accepted`);
  }
}
if (parseDebugMode("?debug=0") !== 0 || parseDebugMode("?debug=11") !== 0 ||
    parseDebugMode("?debug=-1") !== 0 || parseDebugMode("?debug=1.5") !== 0 ||
    parseDebugMode("?debug=abc") !== 0 || parseDebugMode("?debug=6&debug=5") !== 6) {
  throw new Error("debug mode parsing should accept only integer values from 1 through 10");
}
if (!pinAppSource.includes('meetingLayoutHost.dataset.debugDensity = mode >= 6 ? "compact" : "default";') ||
    !pinStyleSource.includes('@media (max-width: 700px)') ||
    !pinStyleSource.includes('#meeting-layout-host[data-debug-density="compact"] .participant-meta') ||
    !pinStyleSource.includes('#meeting-layout-host[data-debug-density="compact"] .participant-state') ||
    !pinStyleSource.includes('#meeting-layout-host[data-debug-density="compact"] .participant-menu') ||
    !pinStyleSource.includes('#meeting-layout-host[data-debug-density="compact"] .participant-menu-trigger') ||
    !pinStyleSource.includes('min-width: 44px;') ||
    !pinStyleSource.includes('min-height: 44px;')) {
  throw new Error("dense debug participant controls must be scoped to mobile debug modes and retain touch targets");
}
const poorFixture = createPoorConnectionFixture();
if (poorFixture.id !== "debug-poor-network" || !poorFixture.debugPoorConnection ||
    poorFixture.debugNetwork.rttMs < 500 || poorFixture.debugNetwork.packetLoss10 < 100) {
  throw new Error("poor connection fixture is not sufficiently degraded");
}
for (let mode = 1; mode <= 10; mode += 1) {
  const participants = chooseDebugParticipants(mode);
  if (participants.length !== mode - 1) {
    throw new Error(`debug mode ${mode} should provide ${mode - 1} synthetic participants`);
  }
  if (new Set(participants.map((participant) => participant.id)).size !== participants.length) {
    throw new Error(`debug mode ${mode} should provide unique participant IDs`);
  }
}
const debugRoster = chooseDebugParticipants(10);
if (!debugRoster.some((participant) => participant.debugPoorConnection) ||
    !debugRoster.some((participant) => participant.debugTalking) ||
    !debugRoster.some((participant) => participant.audioEnabled === false) ||
    !debugRoster.some((participant) => participant.videoEnabled === false && !participant.videoPaused) ||
    !debugRoster.some((participant) => participant.videoPaused) ||
    debugRoster.filter((participant) => participant.raisedHand === true).length < 2 ||
    debugRoster.filter((participant) => participant.debugPoorConnection).length !== 1) {
  throw new Error("debug mode 10 should cover connection, talking, mute, video, and raised-hand states");
}
if (visibleParticipantIds(["local", "p1", "p2"], "local", false).join(",") !== "p1,p2") {
  throw new Error("self-view filtering must not alter the roster order");
}
if (visibleParticipantIds(["local", "p1"], "local", true).length !== 2) {
  throw new Error("self-view enabled should preserve all participants");
}
const five = chooseParticipantLayout({ width: 1200, height: 620, count: 5 });
if (five.columns !== 3 || five.rows !== 2 || five.rowCounts.join(",") !== "3,2") {
  throw new Error("five tiles should use the largest fitting responsive layout");
}
const wide = chooseParticipantLayout({ width: 1200, height: 620, count: 6 });
const narrow = chooseParticipantLayout({ width: 344, height: 500, count: 6 });
const ultraNarrow = chooseParticipantLayout({ width: 120, height: 1110, count: 5, minTileWidth: 132 });
const eight = chooseParticipantLayout({ width: 1200, height: 620, count: 8 });
const nine = chooseParticipantLayout({ width: 1200, height: 620, count: 9 });
if (wide.columns !== 3 || wide.rows !== 2 || narrow.columns !== 2 || narrow.rows !== 3 ||
    ultraNarrow.columns !== 1 || ultraNarrow.rows !== 5 ||
    eight.columns !== 3 || eight.rows !== 3 || nine.columns !== 3 || nine.rows !== 3 ||
    [five, wide, narrow, ultraNarrow, eight, nine].some((layout) => layout.overflow)) {
  throw new Error("participant layouts should use fitting responsive grids without overflow");
}
for (const [width, height] of [[368, 220], [748, 220], [1408, 300]]) {
  for (let count = 1; count <= 8; count += 1) {
    const layout = chooseParticipantLayout({ width, height, count, minTileWidth: 104, minTileHeight: 58 });
    const usedWidth = layout.columns * layout.tileWidth + Math.max(0, layout.columns - 1) * 12;
    const usedHeight = layout.rows * layout.tileHeight + Math.max(0, layout.rows - 1) * 12;
    if (usedWidth > width + 0.01 || usedHeight > height + 0.01 || layout.overflow) {
      throw new Error(`pinned companion grid ${width}x${height} count ${count} must fit`);
    }
  }
}
if (formatMetric(null, " ms") !== "No sample" || formatMetric(undefined, " kbps", "Unavailable") !== "Unavailable" ||
    formatMetric(42, " ms") !== "42 ms") {
  throw new Error("metric placeholders are incorrect");
}
if (chooseActiveSpeaker(new Map([["muted", 9], ["quiet", 2], ["loud", 4]]), new Set(["muted"])) !== "loud") {
  throw new Error("muted speakers must not win active-speaker selection");
}
let state = { speaking: false, since: 0, quietSince: 0 };
state = speakerDebounce(state, 1, 299);
if (state.speaking) throw new Error("speaker activation should be debounced");
state = speakerDebounce(state, 1, 300);
if (!state.speaking) throw new Error("speaker activation delay was not applied");
state = speakerDebounce(state, 0, 1299);
if (!state.speaking) throw new Error("speaker deactivation hold was not applied");
state = speakerDebounce(state, 0, 1300);
if (state.speaking) throw new Error("speaker deactivation should occur after the hold");

const indexSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const styleSource = fs.readFileSync(path.join(__dirname, "..", "web/css/style.css"), "utf8");
for (const element of [
  'class="mobile-more-actions"',
  'id="mobile-chat"',
  'id="mobile-people"'
]) {
  if (!indexSource.includes(element)) {
    throw new Error(`mobile meeting action is missing: ${element}`);
  }
}
for (const behavior of [
  'const mobileChat = document.querySelector("#mobile-chat");',
  'const mobilePeople = document.querySelector("#mobile-people");',
  'mobileChat?.addEventListener("click", () => setOpenPanel("chat", mobileChat));',
  'function openPeoplePanel(trigger = participantsButton)',
  'mobilePeople?.addEventListener("click", () => openPeoplePanel(mobilePeople));'
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`mobile meeting action behavior is missing: ${behavior}`);
  }
}
for (const behavior of [
  "function closeOpenPanel(restoreFocus = true) {",
  'meetingViewState.openPanel = "none";',
  "const chatWasOpen = Boolean(chatRail && !chatRail.hidden);",
  "setChatOpen(false, null, restoreFocus);",
  "setSidebarOpen(false, null, restoreFocus && sidebarWasOpen && !chatWasOpen);",
  'closeChat?.addEventListener("click", () => closeOpenPanel());',
  'closeSidebar.addEventListener("click", () => {\n  closeOpenPanel();\n});',
  'sidebarBackdrop.addEventListener("click", () => {\n  closeOpenPanel();\n});',
  'if (event.key === "Escape") {\n    if (connectionPopover && !connectionPopover.hidden) setConnectionPopoverOpen(false);\n    if (reactionPicker && !reactionPicker.hidden) setReactionPickerOpen(false);\n    if (chatEmojiPicker && !chatEmojiPicker.hidden) setChatEmojiPickerOpen(false);\n    closeOpenPanel();',
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`panel close behavior is missing: ${behavior}`);
  }
}
for (const behavior of [
  'setTimeout(() => chatRail.classList.add("is-open"), 0);',
  'setTimeout(() => chatInput?.focus(), 0);'
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`chat panel opening must not depend on a stalled animation frame: ${behavior}`);
  }
}
for (const behavior of [
  'setTimeout(() => {\n      connectionPopover.classList.add("is-open");',
  'closeConnectionPopover?.focus();\n    }, 0);'
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`connection popover opening must not depend on a stalled animation frame: ${behavior}`);
  }
}
for (const behavior of [
  'function openPeoplePanel(trigger = participantsButton) {\n  setOpenPanel("people", trigger);\n  setTimeout(() => {',
  'peopleList.focus({ preventScroll: true });\n  }, 0);'
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`People panel focus must not depend on a stalled animation frame: ${behavior}`);
  }
}
if ((appSource.match(/closeOpenPanel\(false\);/g) || []).length < 2) {
  throw new Error("connection popover and meeting teardown must clear panel state");
}
if ((indexSource.match(/id="receive-video"/g) || []).length !== 1 ||
    indexSource.includes("pause-all") || indexSource.includes("more-receive-video") ||
    appSource.includes("pauseAll") || appSource.includes("moreReceiveVideo")) {
  throw new Error("legacy incoming-video controls are still present");
}
for (const behavior of [
  "navigator.mediaDevices.getUserMedia({",
  "video: {",
  "cameraSender",
  "screenSender",
  "renderMeetingLayout()",
  "cameraVideo",
  "screenVideo",
  "media_stream_id"
]) {
  if (!appSource.includes(behavior) && !indexSource.includes(behavior)) {
    throw new Error(`meeting layout/media contract is missing: ${behavior}`);
  }
}
if (!appSource.includes('item.classList.toggle("is-poor-connection", normalized === "poor")') ||
    !appSource.includes('debugPoorConnection') ||
    !appSource.includes('cameraOperation') ||
    !appSource.includes('for (let attempt = 0; attempt < 3; attempt += 1)')) {
  throw new Error("media and poor-connection state handling is missing");
}
if (!indexSource.includes('data-network-summary') || !indexSource.includes('id="chat-rail"')) {
  throw new Error("meeting status and chat rail markup is missing");
}
if ((indexSource.match(/id="leave"/g) || []).length !== 1 ||
    !indexSource.includes('<button id="leave"') ||
    !indexSource.includes('</div>\n        <button id="leave"')) {
  throw new Error("leave control must remain a single toolbar action aligned outside the session group");
}
for (const rule of [
  ".stage-panel {\n  border: 0;",
  ".participant-grid {\n  width: 100%;",
  "@media (max-height: 1220px) and (min-width: 901px)",
  "@media (min-height: 1101px) and (min-width: 901px)",
  ".participant-grid > li.participant-tile",
  ".participant-grid.has-remote > li.participant-tile.is-local",
  ".meeting-toolbar {\n  justify-content: space-between;",
  ".meeting-toolbar::before",
  ".meeting-toolbar > #leave",
  ".network-chip.connection {\n  min-width: 0;"
]) {
  if (!styleSource.includes(rule)) {
    throw new Error(`meeting UI refinement rule is missing: ${rule}`);
  }
}
for (const rule of [
  "grid-template-columns: repeat(var(--layout-columns, 1), minmax(0, 1fr));",
  "grid-template-rows: repeat(var(--layout-rows, 1), minmax(0, 1fr)) !important;",
  ".pinned-layout { grid-template-columns: minmax(0, 1fr);",
  ".pinned-layout[data-unpinned-count=\"0\"]",
  "grid-template-columns: repeat(var(--filmstrip-columns, 1), minmax(0, 1fr));",
  "overflow: hidden !important;",
  ".participant-tile > .participant-video",
  "height: 100% !important;",
  "@media (max-width: 700px) and (orientation: portrait)",
  "[data-layout-mode=\"pinned\"] > .pinned-layout[data-pinned-count=\"2\"] > .layout-main",
  "grid-template-rows: repeat(2, minmax(0, 1fr));",
  "aspect-ratio: 16 / 9;",
  "[data-layout-mode=\"pinned\"] > .pinned-layout[data-pinned-count=\"2\"]",
  "grid-template-rows: minmax(0, 1.3fr) minmax(0, .7fr);",
  "grid-template-rows: repeat(var(--filmstrip-rows, 1), var(--filmstrip-tile-height, 90px));",
  "row-gap: 8px;",
  "align-content: start;",
  "height: var(--filmstrip-tile-height, 90px);",
  "[data-pinned-count=\"2\"][data-unpinned-count=\"1\"] > .layout-filmstrip > .participant-tile",
  "width: 240px;",
  "height: 135px;",
  "@media (max-width: 700px) and (orientation: landscape)",
  "[data-layout-mode=\"pinned\"] > .pinned-layout[data-pinned-count=\"1\"]",
  "grid-template-rows: minmax(0, .8fr) minmax(0, 1fr);",
  "[data-columns=\"2\"][data-rows=\"2\"] > .participant-tile:nth-child(3):last-child",
  "grid-column: 1 / -1;"
]) {
  if (!styleSource.includes(rule)) {
    throw new Error(`no-scroll participant layout rule is missing: ${rule}`);
  }
}
for (const behavior of [
  'pinnedLayout.dataset.unpinnedCount',
  'const screenMain = hasScreen;',
  'filmstripContainer.style.setProperty("--filmstrip-columns"',
  'filmstripContainer.dataset.overflow = "false"',
  'maxColumns: 0'
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`responsive participant layout behavior is missing: ${behavior}`);
  }
}
if (appSource.includes('mode === "screen-share"') ||
    appSource.includes('screenShareLayout') ||
    appSource.includes('screenShareMain') ||
    styleSource.includes('.screen-share-layout')) {
  throw new Error("screen sharing must not create a dedicated layout");
}
console.log("Meeting layout tests passed");
