const {
  chooseAdaptationLevel,
  shouldRecoverVideo,
  applyServerDefaults,
  resolveCodecName,
  profileNameForQuality,
  isBelowBitrate,
  chooseParticipantLayout
} = require("../web/js/adaptation-policy.js");

const transition = (level, poor, good) =>
  chooseAdaptationLevel(level, poor, good, 4);

if (transition(2, 2, 0).level !== 1) throw new Error("poor network should downgrade normal to slow");
if (transition(1, 2, 0).level !== 0) throw new Error("poor network should downgrade slow to very-slow");
if (transition(0, 2, 0).level !== 0) throw new Error("downgrade should stop at very-slow");
if (transition(0, 0, 5).level !== 1) throw new Error("good network should upgrade very-slow to slow");
if (transition(1, 0, 5).level !== 2) throw new Error("good network should upgrade slow to normal");
if (transition(2, 0, 5).level !== 3) throw new Error("good network should upgrade normal to high");
if (transition(3, 0, 5).level !== 3) throw new Error("upgrade should stop at high");
if (transition(2, 1, 0).level !== 2) throw new Error("downgrade requires two samples");
if (transition(0, 0, 4).level !== 0) throw new Error("upgrade requires five samples");
if (!shouldRecoverVideo(5, true) || shouldRecoverVideo(4, true) || shouldRecoverVideo(5, false)) {
  throw new Error("video recovery requires five consecutive good samples");
}
const profile = { name: "slow", fps: 10, audioBitrate: 32000 };
const configured = applyServerDefaults(profile, { videoFPS: 15, audioBitrate: 48000 }, true);
if (configured.fps !== 15 || configured.audioBitrate !== 48000 || profile.fps !== 10) {
  throw new Error("server defaults should override only the selected profile copy");
}
if (applyServerDefaults(profile, { videoFPS: 5, audioBitrate: 24000 }, false) !== profile) {
  throw new Error("disabled server defaults should preserve the selected profile");
}
const codecById = new Map([["C1", "video/VP8"], ["C2", "audio/opus"]]);
if (resolveCodecName(codecById, "C1") !== "video/VP8" ||
    resolveCodecName(codecById, "C2") !== "audio/opus" ||
    resolveCodecName(codecById, "unknown") !== "unknown") {
  throw new Error("codec stats should resolve opaque codec IDs to MIME names");
}
if (profileNameForQuality("low") !== "slow" ||
    profileNameForQuality("medium") !== "normal" ||
    profileNameForQuality("high") !== "high") {
  throw new Error("host quality names should map to client profile names");
}
if (isBelowBitrate(20, 40) !== true ||
    isBelowBitrate(40, 40) !== false ||
    isBelowBitrate(null, 40) !== false ||
    isBelowBitrate(undefined, 40) !== false) {
  throw new Error("missing inbound video bitrate must not be treated as critical");
}
const sixPersonLayout = chooseParticipantLayout({ width: 1200, height: 620, count: 6 });
if (sixPersonLayout.columns !== 2 || sixPersonLayout.rows !== 3 ||
    sixPersonLayout.rowCounts.some((rowCount) => rowCount > 2) ||
    sixPersonLayout.tileWidth < 260 || sixPersonLayout.tileHeight < 140) {
  throw new Error("six participants should use a compact two-column layout");
}
const mobileLayout = chooseParticipantLayout({ width: 344, height: 500, count: 6, minTileWidth: 160 });
const fourParticipantMobileLayout = chooseParticipantLayout({ width: 344, height: 500, count: 4, maxColumns: 1, minTileWidth: 160 });
if (mobileLayout.columns !== 2 || mobileLayout.rows !== 3 || mobileLayout.tileWidth < 140 ||
    fourParticipantMobileLayout.columns !== 1 || fourParticipantMobileLayout.rows !== 4) {
  throw new Error("mobile layouts should use one tile per row through four participants");
}
// Stage content is narrower than the viewport because of the meeting gutters.
const compactPhoneLayout = chooseParticipantLayout({ width: 288, height: 504, count: 6, minTileWidth: 160 });
const narrowPhoneLayout = chooseParticipantLayout({ width: 328, height: 676, count: 6, minTileWidth: 160 });
const standardPhoneLayout = chooseParticipantLayout({ width: 358, height: 812, count: 6, minTileWidth: 160 });
const widePhoneLayout = chooseParticipantLayout({ width: 398, height: 900, count: 6, minTileWidth: 160 });
if (compactPhoneLayout.columns !== 1 || compactPhoneLayout.rows !== 6 ||
    narrowPhoneLayout.columns !== 1 || narrowPhoneLayout.rows !== 6 ||
    standardPhoneLayout.columns !== 2 || standardPhoneLayout.rows !== 3 ||
    widePhoneLayout.columns !== 2 || widePhoneLayout.rows !== 3) {
  throw new Error("phone layout policy should preserve the adaptive non-mobile behavior");
}
const eightPersonLayout = chooseParticipantLayout({ width: 1280, height: 720, count: 8 });
if (eightPersonLayout.columns !== 2 || eightPersonLayout.rows !== 4 ||
    eightPersonLayout.rowCounts.some((rowCount) => rowCount > 2) ||
    Math.abs(eightPersonLayout.tileWidth / eightPersonLayout.tileHeight - 16 / 9) > 0.01) {
  throw new Error("eight participants should remain two-column rectangular tiles");
}
const ultraNarrowLayout = chooseParticipantLayout({ width: 120, height: 1110, count: 5, minTileWidth: 132 });
if (ultraNarrowLayout.columns !== 1 || ultraNarrowLayout.rows !== 5 ||
    Math.abs(ultraNarrowLayout.tileWidth / ultraNarrowLayout.tileHeight - 16 / 9) > 0.01) {
  throw new Error("ultra-narrow stages should use one-column rectangular tiles");
}
const singleLayout = chooseParticipantLayout({ width: 1600, height: 800, count: 1 });
if (singleLayout.columns !== 1 || singleLayout.rows !== 1 || singleLayout.tileWidth > 720) {
  throw new Error("single participant layout should have a sensible maximum size");
}

const fs = require("node:fs");
const path = require("node:path");
const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const styleSource = fs.readFileSync(path.join(__dirname, "..", "web/css/style.css"), "utf8");
if (!appSource.includes("const currentPeer = new RTCPeerConnection({ iceServers });\n  restartRequested = false;")) {
  throw new Error("new WebRTC generations must reset ICE restart state");
}
if (!appSource.includes('setConnection("fair", "Reconnecting");') ||
    !appSource.includes('setConnection("poor", "Offline");')) {
  throw new Error("signaling disconnects must be visible in the connection indicator");
}
if (!appSource.includes('mic.setAttribute("aria-pressed", String(audioAvailable && audioTrack.enabled));') ||
    !appSource.includes('receiveVideo.setAttribute("aria-pressed", String(enabled));') ||
    !appSource.includes('screen.setAttribute("aria-pressed", String(Boolean(screenStream)));')) {
  throw new Error("meeting controls must expose their current toggle state");
}
if (!appSource.includes("screen.disabled = !screenShareEnabled || ownedByOther || Boolean(audioOnly?.checked);") ||
    appSource.includes("screen.disabled = false;")) {
  throw new Error("disabled screen sharing must remain disabled after UI refresh");
}
if (!styleSource.includes(".participant-grid video.local-camera-preview") ||
    !styleSource.includes(".participant-grid video.remote-camera-preview") ||
    !styleSource.includes("transform: scaleX(-1);") ||
    !appSource.includes("setLocalVideoMirror(true);") ||
    !appSource.includes("setLocalVideoMirror(false);") ||
    !appSource.includes("updateVideoOrientation(previousScreenShareOwner);") ||
    !appSource.includes("updateVideoOrientation(screenShareOwner);")) {
  throw new Error("camera previews should be mirrored without mirroring screen shares");
}
if (!appSource.includes('const streamPrefix = "slowmeet-";') ||
    !appSource.includes('return track.id?.split("|")[0] || "";') ||
    !appSource.includes("const stream = new MediaStream();") ||
    !appSource.includes("const participantID = remoteParticipantID(streams, track);") ||
    !appSource.includes("element.video.play().catch(() => {});")) {
  throw new Error("remote video tracks must resolve and start playback");
}
const indexSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
if (!indexSource.includes('id="audio-only" type="checkbox" autocomplete="off"') ||
    indexSource.includes('id="audio-only" type="checkbox" checked')) {
  throw new Error("protect-audio toggle must default to off");
}
const sidebarPosition = indexSource.indexOf('id="meeting-sidebar"');
const stagePosition = indexSource.indexOf('<section class="stage-panel"');
if (sidebarPosition < 0 || stagePosition < 0 || sidebarPosition > stagePosition) {
  throw new Error("meeting sidebar must precede the participant stage");
}
for (const behavior of [
  'const brandBar = document.querySelector(".brand-bar");',
  "brandBar.hidden = true;",
  "brandBar.hidden = false;",
  "let cameraRequested = false;",
  "runDeviceTest",
  "attachSpeakerAnalyzer",
  "is-speaking"
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`meeting media behavior is missing: ${behavior}`);
  }
}
for (const element of [
  'id="test-media"',
  'id="device-preview"',
  'id="test-camera"',
  'id="test-microphone"',
  'id="stop-media-test"'
]) {
  if (!indexSource.includes(element)) {
    throw new Error(`device test element is missing: ${element}`);
  }
}
for (const element of [
  'id="connection-popover"',
  'id="popover-stat-rtt"',
  'id="connection-popover-controls"'
]) {
  if (!indexSource.includes(element)) {
    throw new Error(`connection details element is missing: ${element}`);
  }
}
if (appSource.includes('if (setupStream.getTracks().length === 0) throw new Error("No microphone is available");')) {
  throw new Error("joining must continue when the microphone is unavailable");
}
if (!appSource.includes("if (localStream.getAudioTracks().length) attachSpeakerAnalyzer(localParticipantID, localStream);")) {
  throw new Error("local speaker analysis must be skipped without an audio track");
}
for (const behavior of [
  "setConnectionPopoverOpen",
  "syncConnectionPopoverStats",
  "connectionPopover?.hidden !== false"
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`connection details behavior is missing: ${behavior}`);
  }
}
if (!indexSource.includes('id="mic" type="button" aria-pressed="false"') ||
    !indexSource.includes('id="camera" type="button" aria-pressed="false"')) {
  throw new Error("microphone and camera must start disabled by default");
}
for (const style of [
  "--lm-header: #151b22",
  "--lm-stage: #0b0f13",
  "--lm-surface-hover: #27313d",
  "--lm-control-size: 52px",
  "--lm-toolbar-height: 72px",
  ".meeting-toolbar",
  ".toolbar-primary",
  ".toolbar-secondary",
  ".toolbar-spacer { flex: 1 1 8px; min-width: 8px; }",
  ".toolbar-session",
  "overflow: visible",
  "--lm-z-backdrop: 1200",
  "--lm-z-rail: 1300",
  "[data-tooltip]::after",
  "@container toolbar (max-width: 760px)",
  "@media (max-width: 680px)",
  "max-height: calc(100dvh - 52px - var(--lm-toolbar-height))",
  "transform: translateY(100%)"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`responsive meeting layout style is missing: ${style}`);
  }
}
for (const style of [
  ".meeting-shell.sidebar-open .meeting-sidebar",
  ".sidebar-backdrop",
  ".participant-grid li.is-speaking",
  ".participant-grid li.is-disconnected",
  ".participant-grid li[data-sharing=\"true\"]",
  ".participant-mic",
  ".chat-messages:empty::before",
  "aspect-ratio: 16 / 9",
  "background: rgba(13, 16, 20, .84)",
  "backdrop-filter: none",
  "inset-inline-start: 12px",
  "inset-block-end: 12px",
  ".participant-you",
  ".participant-menu-trigger",
  "z-index: var(--lm-z-menu)"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`meeting state style is missing: ${style}`);
  }
}
for (const style of [
  'data-count="8"',
  "grid-template-columns: repeat(2, minmax(0, 1fr))",
  "aspect-ratio: 16 / 9 !important",
  "scrollbar-width: thin",
  "-webkit-overflow-scrolling: touch",
  ".toolbar-primary",
  ".toolbar-secondary",
  ".toolbar-session",
  "data-columns=\"1\"",
  "data-columns=\"2\"",
  "grid-template-rows: none !important",
  "grid-auto-rows: max-content !important",
  "@media (max-width: 700px)",
  "overflow-y: auto"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`responsive meeting layout style is missing: ${style}`);
  }
}
if (!appSource.includes("maxColumns: mode === \"grid\" && window.matchMedia?.(\"(max-width: 700px)\").matches && visibleItems.length <= 4 ? 1 : 0") ||
    !appSource.includes("minTileWidth: Math.min(180, Math.max(160, bounds.width / 2.6))")) {
  throw new Error("runtime participant layout must use a readable mobile minimum tile width");
}
for (const behavior of [
  "video.hidden = true",
  "updateParticipantVideoVisibility(element)",
  "element.micIndicator.hidden = audioOn",
  "element.pausedChip.hidden = !videoPaused",
  "videoStage.append(avatar, video, pausedChip, quality, handIndicator)",
  "video_paused: videoPaused"
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`self-contained participant tile behavior is missing: ${behavior}`);
  }
}
for (const behavior of [
  "video_paused",
  "videoSuspendedAutomatically",
  "setVideoSending(false, true)",
  "participantForInboundStat",
  "setParticipantQuality(element, classifyParticipantQuality",
  "trackIdentifier",
  "packetsLost"
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`bandwidth status behavior is missing: ${behavior}`);
  }
}
for (const style of [
  ".participant-video-paused",
  "rgba(251,191,36,.9)",
  ".participant-quality",
  'data-quality="good"',
  'data-quality="degraded"',
  'data-quality="poor"'
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`bandwidth status style is missing: ${style}`);
  }
}
for (const behavior of [
  "remoteParticipantCount",
  "participantPageSize = 9",
  "updateParticipantPagination",
  "participantPagePrevious",
  "dataset.remoteCount",
  "setPipPosition",
  "pipPositionForPoint",
  "pointerdown",
  "ArrowUp",
  "meeting.pipPosition"
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`self-view PiP behavior is missing: ${behavior}`);
  }
}
for (const behavior of [
  "id=\"participant-menu\"",
  "participant-menu-trigger",
  "meetingLayoutHost.addEventListener(\"click\"",
  "setPinnedParticipant",
  "data-action=\"pin\"",
  "data-action=\"self-view\"",
  "ArrowDown",
  "Home",
  "Participant actions"
]) {
  if (!appSource.includes(behavior) && !indexSource.includes(behavior)) {
    throw new Error(`participant tile menu behavior is missing: ${behavior}`);
  }
}
if (appSource.includes("participants.addEventListener(\"click\"")) {
  throw new Error("participant menu delegation must include pinned and screen-share layouts");
}
for (const behavior of [
  "cameraQualityPresets",
  "meeting.cameraQuality",
  "cameraConstraintsForQuality",
  "selectedCameraQuality",
  "getVideoTracks",
  "hasCameraTrack",
  "updateParticipantAriaLabel",
  "item.tabIndex = 0",
  "participantFocusStatus"
]) {
  if (!appSource.includes(behavior) && !indexSource.includes(behavior)) {
    throw new Error(`production edge-case behavior is missing: ${behavior}`);
  }
}
for (const behavior of [
  "const isFormField = event.target.matches(\"input, textarea, select\");",
  "if (event.key === \"Escape\")",
  "if (event.key === \"Tab\" && meeting.classList.contains(\"sidebar-open\"))",
  "connection.setAttribute(\"aria-expanded\", String(open));",
  "cameraRequested = false;",
  "!audioOnly?.checked",
  "preserveAutomaticSuspension",
  "sharingLocal"
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`interaction hardening behavior is missing: ${behavior}`);
  }
}
for (const element of [
  'id="camera-quality"',
  'id="participant-pagination"',
  'id="participant-page-previous"',
  'id="participant-page-next"',
  'id="participant-focus-status"',
  'id="participants" class="participant-grid" data-count="0" tabindex="-1"'
]) {
  if (!indexSource.includes(element)) {
    throw new Error(`production edge-case element is missing: ${element}`);
  }
}
if (!indexSource.includes('id="chat" type="button" aria-controls="chat-rail"')) {
  throw new Error("chat toggle must identify the controlled rail");
}
for (const element of [
  'class="controls meeting-toolbar"',
  'class="toolbar-primary"',
  'class="toolbar-secondary"',
  'class="toolbar-spacer"',
  'class="toolbar-session"',
  'aria-label="Turn off incoming video"',
  'aria-describedby="incoming-video-help"',
  'id="incoming-video-help"',
  'id="more-state-badge"'
]) {
  if (!indexSource.includes(element)) {
    throw new Error(`meeting UI accessibility or priority structure is missing: ${element}`);
  }
}
for (const behavior of [
  "participant-you",
  "element.youBadge.hidden = false",
  "(You)",
  'setMeasuredConnection("fair", "Unstable connection")',
  'setMeasuredConnection("poor", "Unstable connection")',
  'button.dataset.receiveVideo = enabled ? "on" : "off"',
  "setMoreIncomingVideoState(enabled)",
  'updateControlLabel(chatToggle, open ? "Close chat" : "Open chat")',
  'chatRail.setAttribute("aria-hidden", "false")',
  'chatRail.setAttribute("aria-hidden", "true")',
  "function setStatValue(element, value)",
  "function mediaAccessMessage(kind, error)",
  'status.textContent = "Joining meeting…"',
  'addChatSystem("Message could not be sent. Try again.")'
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`meeting state semantics are missing: ${behavior}`);
  }
}
for (const behavior of [
  "speakerThresholdDb = -50",
  "speakerStartHoldMs = 200",
  "speakerStopHoldMs = 300",
  "pendingSpeakerStates",
  "flushSpeakerStates",
  "setSpeakerState(participantID, false, true)"
]) {
  if (!appSource.includes(behavior)) {
    throw new Error(`active-speaker smoothing is missing: ${behavior}`);
  }
}
for (const style of [
  "transition: box-shadow 150ms ease",
  "participant-grid li.participant-tile { transition: none !important; }"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`active-speaker motion style is missing: ${style}`);
  }
}
for (const style of [
  ".participant-grid.has-remote .participant-tile.is-local",
  "width: 160px",
  "height: 90px",
  "cursor: grab",
  "touch-action: none",
  "data-pip-position=\"top-left\"",
  "data-pip-position=\"bottom-right\""
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`self-view PiP style is missing: ${style}`);
  }
}
for (const style of [
  ".participant-pagination",
  ".participant-tile[hidden]",
  ".participant-tile.is-focused",
  "env(safe-area-inset-bottom)",
  "min-width: 44px",
  "@media (max-width: 400px)",
  ".participant-grid[data-count=\"7\"]",
  "min-height: 0"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`production edge-case style is missing: ${style}`);
  }
}
for (const style of [
      ".meeting-layout-host[data-layout-mode=\"grid\"] > .participant-grid",
      ".meeting-layout-host[data-layout-mode=\"grid\"] > .participant-grid > .participant-tile",
      ".meeting-layout-host[data-layout-mode=\"grid\"] > .participant-grid > .participant-tile.is-local",
      ".meeting-layout-host[data-layout-mode=\"grid\"] > .participant-grid.has-remote > .participant-tile.is-local",
      "overflow-y: auto",
      "aspect-ratio: 16 / 9",
      "inset-inline: auto",
      "inset-block: auto",
      "inset-inline-start: auto",
      "inset-inline-end: auto",
      "inset-block-start: auto",
      "inset-block-end: auto"
    ]) {
  if (!styleSource.includes(style)) {
    throw new Error(`narrow grid width behavior is missing: ${style}`);
  }
}
for (const behavior of [
  "sendChatMessage",
  "message.type === \"chat_message\"",
  "emoji_reaction",
  "renderReaction",
  "insertChatEmoji",
  "reactionEmojiSet",
  "chat-message--own",
  "chat-message__meta",
  "unreadMessages"
]) {
  if (!appSource.includes(behavior) && !indexSource.includes(behavior)) {
    throw new Error(`chat behavior is missing: ${behavior}`);
  }
}
for (const element of [
  'id="reactions"',
  'id="reaction-picker"',
  'id="reaction-overlay"',
  'id="chat-emoji"',
  'id="chat-emoji-picker"',
  'aria-live="polite"'
]) {
  if (!indexSource.includes(element)) throw new Error(`emoji UI contract is missing: ${element}`);
}
for (const style of [
  ".reaction-overlay",
  ".floating-reaction",
  "@keyframes reaction-float",
  "@media (prefers-reduced-motion: reduce)",
  ".emoji-picker--toolbar",
  ".emoji-picker--chat"
]) {
  if (!styleSource.includes(style)) throw new Error(`emoji style is missing: ${style}`);
}
for (const style of [
  ".chat-rail.is-open",
  "width: 100%; height: 60dvh",
  "background: rgba(59,130,246,.12)",
  "background: rgba(255,255,255,.06)",
  "max-width: 280px"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`chat rail style is missing: ${style}`);
  }
}
for (const style of [
  ".meeting-content {\n  display: contents;",
  "@media (max-width: 900px) {\n  .meeting-shell.has-rail { grid-template-columns: minmax(0, 1fr); }",
  ".meeting-sidebar,\n.chat-rail {\n  min-width: 0;\n  width: 100%;"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`responsive shell geometry contract is missing: ${style}`);
  }
}
if (styleSource.includes(".meeting-content {\n  min-height: 0;\n  display: grid;")) {
  throw new Error("meeting content must not create a competing panel grid");
}
for (const control of ["mic", "camera", "receive-video", "screen"]) {
  if (!indexSource.includes(`id="${control}"`) ||
      !indexSource.includes(`id="${control}" type="button" aria-pressed="`)) {
    throw new Error(`${control} control must declare an initial pressed state`);
  }
}
if (indexSource.includes("control-button__label") ||
    appSource.includes("setControlLabel")) {
  throw new Error("meeting controls should use their direct button labels");
}

console.log("Adaptation tests passed");
