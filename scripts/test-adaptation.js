const {
  chooseAdaptationLevel,
  shouldRecoverVideo,
  applyServerDefaults,
  resolveCodecName,
  profileNameForQuality,
  isBelowBitrate
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

const fs = require("node:fs");
const path = require("node:path");
const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const styleSource = fs.readFileSync(path.join(__dirname, "..", "web/css/style.css"), "utf8");
if (!appSource.includes("const currentPeer = new RTCPeerConnection({ iceServers });\n  restartRequested = false;")) {
  throw new Error("new WebRTC generations must reset ICE restart state");
}
if (!appSource.includes('setConnection("fair", "Reconnecting");') ||
    !appSource.includes('setConnection("poor", "Connection lost");')) {
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
if (!appSource.includes('const streamPrefix = "lowmeet-";') ||
    !appSource.includes('return track.id?.split("|")[0] || "";') ||
    !appSource.includes("const stream = new MediaStream();") ||
    !appSource.includes("const participantID = remoteParticipantID(streams, track);") ||
    !appSource.includes("element.video.play().catch(() => {});")) {
  throw new Error("remote video tracks must resolve and start playback");
}
const indexSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
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
if (!indexSource.includes('id="mic" type="button" aria-pressed="false"') ||
    !indexSource.includes('id="camera" type="button" aria-pressed="false"')) {
  throw new Error("microphone and camera must start disabled by default");
}
for (const style of [
  "meeting-layout { display: block; }",
  "position: fixed",
  "bottom: max(.75rem, env(safe-area-inset-bottom))",
  "z-index: 20",
  "padding: 1rem 0 calc(5rem + env(safe-area-inset-bottom))",
  "width: min(calc(100% - 2rem), 760px)",
  "margin: 0 0 8px",
  "min-height: 44px",
  '.control-button[aria-pressed="true"] {\n  color: var(--primary);',
  '.control-button[aria-pressed="false"] {\n  color: var(--text);',
  "button.control-button:disabled"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`compact meeting layout style is missing: ${style}`);
  }
}
for (const style of [
  ".meeting-shell.sidebar-open .meeting-sidebar",
  ".sidebar-backdrop",
  ".participant-grid li.is-speaking",
  ".participant-grid li.is-disconnected",
  ".participant-grid li[data-sharing=\"true\"]",
  ".participant-mic",
  "aspect-ratio: 16 / 9",
  "background: rgba(0,0,0,.6)",
  "backdrop-filter: blur(8px)",
  "inset-inline-start: 12px",
  "inset-block-end: 12px",
  "#EC4899",
  "#F43F5E"
]) {
  if (!styleSource.includes(style)) {
    throw new Error(`meeting state style is missing: ${style}`);
  }
}
for (const behavior of [
  "video.hidden = true",
  "updateParticipantVideoVisibility(element)",
  "element.micIndicator.hidden = audioOn",
  "element.pausedChip.hidden = !videoPaused",
  "videoStage.append(avatar, video, pausedChip, quality)",
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
  "cameraQualityPresets",
  "meeting.cameraQuality",
  "cameraConstraintsForQuality",
  "selectedCameraQuality",
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
for (const behavior of [
  "sendChatMessage",
  "message.type === \"chat_message\"",
  "chat-message--own",
  "chat-message__meta",
  "unreadMessages"
]) {
  if (!appSource.includes(behavior) && !indexSource.includes(behavior)) {
    throw new Error(`chat behavior is missing: ${behavior}`);
  }
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
