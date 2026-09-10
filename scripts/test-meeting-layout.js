const fs = require("node:fs");
const path = require("node:path");
const {
  deriveMeetingLayoutMode,
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

if (deriveMeetingLayoutMode({ pinnedParticipantId: "p1", activeScreenShareId: "p2" }) !== "screen-share" ||
    deriveMeetingLayoutMode({ pinnedParticipantId: "p1" }) !== "pinned" ||
    deriveMeetingLayoutMode({}) !== "grid") {
  throw new Error("layout mode precedence is incorrect");
}
if (parseDebugMode("?debug=5") !== 5 || parseDebugMode("?debug=6") !== 6 ||
    parseDebugMode("?debug=7") !== 0 || parseDebugMode("?debug=6&debug=5") !== 6) {
  throw new Error("debug mode parsing should accept only exact 5 and 6 values");
}
const poorFixture = createPoorConnectionFixture();
if (poorFixture.id !== "debug-poor-network" || !poorFixture.debugPoorConnection ||
    poorFixture.debugNetwork.rttMs < 500 || poorFixture.debugNetwork.packetLoss10 < 100) {
  throw new Error("poor connection fixture is not sufficiently degraded");
}
if (chooseDebugParticipants(5).length !== 1 || chooseDebugParticipants(5)[0].id !== poorFixture.id ||
    chooseDebugParticipants(6).length !== 5 ||
    chooseDebugParticipants(6).filter((participant) => participant.debugPoorConnection).length !== 1) {
  throw new Error("debug modes should share one poor connection fixture");
}
if (visibleParticipantIds(["local", "p1", "p2"], "local", false).join(",") !== "p1,p2") {
  throw new Error("self-view filtering must not alter the roster order");
}
if (visibleParticipantIds(["local", "p1"], "local", true).length !== 2) {
  throw new Error("self-view enabled should preserve all participants");
}
const five = chooseParticipantLayout({ width: 1200, height: 620, count: 5 });
if (five.columns !== 3 || five.rows !== 2 || five.rowCounts.join(",") !== "3,2") {
  throw new Error("five tiles should use a centered 3+2 incomplete row");
}
const wide = chooseParticipantLayout({ width: 1200, height: 620, count: 6 });
const narrow = chooseParticipantLayout({ width: 344, height: 500, count: 6 });
if (wide.columns !== 3 || wide.rows !== 2 || narrow.columns !== 2 || narrow.rows !== 3) {
  throw new Error("wide and narrow grid choices are incorrect");
}
const singlePinned = chooseFilmstripLayout({ width: 323, height: 634, count: 1, orientation: "vertical", minTileHeight: 102 });
if (singlePinned.rows !== 1 || singlePinned.tileWidth !== 323 || singlePinned.tileHeight !== 634 || singlePinned.overflow) {
  throw new Error("one pinned companion should fill the desktop filmstrip without overflow");
}
const multiplePinned = chooseFilmstripLayout({ width: 323, height: 634, count: 5, orientation: "vertical", minTileHeight: 102 });
if (multiplePinned.rows !== 5 || multiplePinned.tileWidth !== 323 || multiplePinned.tileHeight !== 117 || multiplePinned.overflow) {
  throw new Error("desktop pinned companions should share the available rail height");
}
const crowdedPinned = chooseFilmstripLayout({ width: 323, height: 634, count: 8, orientation: "vertical", minTileHeight: 102 });
if (!crowdedPinned.overflow || crowdedPinned.tileHeight !== 102) {
  throw new Error("desktop filmstrip overflow should occur only below the minimum tile height");
}
const mobilePinned = chooseFilmstripLayout({ width: 368, height: 112, count: 3, orientation: "horizontal" });
if (mobilePinned.rows !== 1 || mobilePinned.tileWidth !== 160 || mobilePinned.tileHeight !== 90 || !mobilePinned.overflow) {
  throw new Error("mobile pinned companions should remain touch-sized and horizontally scrollable");
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
  'if (event.key === "Escape") {\n    if (connectionPopover && !connectionPopover.hidden) setConnectionPopoverOpen(false);\n    closeOpenPanel();',
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
console.log("Meeting layout tests passed");
