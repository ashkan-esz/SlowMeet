const fs = require("node:fs");
const path = require("node:path");
const {
  deriveMeetingLayoutMode,
  visibleParticipantIds,
  formatMetric,
  chooseActiveSpeaker,
  speakerDebounce
} = require("../web/js/meeting-layout.js");
const { chooseParticipantLayout } = require("../web/js/adaptation-policy.js");

if (deriveMeetingLayoutMode({ pinnedParticipantId: "p1", activeScreenShareId: "p2" }) !== "screen-share" ||
    deriveMeetingLayoutMode({ pinnedParticipantId: "p1" }) !== "pinned" ||
    deriveMeetingLayoutMode({}) !== "grid") {
  throw new Error("layout mode precedence is incorrect");
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
console.log("Meeting layout tests passed");
