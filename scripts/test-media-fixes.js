const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const appSource = fs.readFileSync(path.join(__dirname, "../web/js/app.js"), "utf8");
const adaptationSource = fs.readFileSync(
  path.join(__dirname, "../web/js/screen-share-adaptation.js"), "utf8");

const slice = (source, startMarker, endMarker) => {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `${startMarker} should be present`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  return source.slice(start, end > start ? end : undefined);
};

// Camera device switching must retarget the capture handles, otherwise the
// OS camera stays on after "camera off" and re-enabling drops the capture.
const replaceLocalDevice = slice(appSource, "async function replaceLocalDevice(",
  "\nasync function runDeviceTest()");
assert.match(replaceLocalDevice, /localCameraStream = stream;/,
  "a video device switch must retarget the camera capture stream");
assert.match(replaceLocalDevice, /localCameraTrack = nextTrack;/,
  "a video device switch must retarget the camera capture track");
assert.match(replaceLocalDevice, /previousCameraStream\.getTracks\(\)\)[\s\S]*?captureTrack\.stop\(\)/,
  "the replaced camera capture must be stopped");

// Re-enabling must reuse a capture parked by a device switch instead of
// acquiring a second device handle (and silently failing on the guard).
const enableCameraOnce = slice(appSource, "async function enableCameraOnce(",
  "\nasync function disableCamera()");
assert.match(enableCameraOnce,
  /const reusedCapture = Boolean\(localCameraTrack && localCameraStream &&\s*\n\s*localCameraTrack\.readyState === "live" && localCameraStream\.active\);/,
  "enableCameraOnce should detect a live existing capture");
assert.match(enableCameraOnce, /if \(reusedCapture\) \{[\s\S]*?stream = localCameraStream;/,
  "enableCameraOnce should reuse the parked capture instead of acquiring again");
assert.match(enableCameraOnce, /if \(!reusedCapture\) localStream\?\.addTrack\(track\);/,
  "a reused capture must not be re-added to the local stream");

// A participant who rejoins within the tile-linger window reattaches to the
// same <audio> element; a second createMediaElementSource call throws and the
// tile used to stay silent permanently.
assert.match(appSource, /const audioElementSourceNodes = new WeakMap\(\);/,
  "media element source nodes must be cached per element");
const attachSpeakerAnalyzer = slice(appSource, "function attachSpeakerAnalyzer(",
  "\nfunction attachLocalMicrophoneAnalyzer()");
assert.match(attachSpeakerAnalyzer, /audioElementSourceNodes\.get\(source\)/,
  "reattaching must reuse the element's existing source node");
assert.match(attachSpeakerAnalyzer, /if \(!sourceNode\) \{[\s\S]*?createMediaElementSource\(source\)/,
  "only the first attach may wrap the element");

// Reconnects restore the pre-drop microphone state instead of forcing mute.
const startWebRTCAudio = slice(appSource, "audioStream.getAudioTracks().forEach((track) => {",
  "setupStream.addTrack(track);");
assert.match(startWebRTCAudio, /track\.enabled = mic\.getAttribute\("aria-pressed"\) === "true";/,
  "reconnect should restore the previous microphone state");

// One unusable queued ICE candidate must not abort the offer/answer flush.
assert.match(appSource, /await Promise\.allSettled\(pendingCandidates\.splice\(0\)\.map\(\(candidate\) =>[\s\S]*?addIceCandidate\(candidate\)\.catch/,
  "queued candidate flushes must tolerate individual failures");
assert.equal((appSource.match(/Promise\.allSettled\(pendingCandidates/g) || []).length, 2,
  "both the offer and answer paths must use the tolerant flush");

// Small bug fixes.
assert.match(appSource, /isFullscreen \? "Exit full screen" : "Full screen"/,
  "fullscreen controls must expose an exit label");
assert.match(appSource, /!event\.target\.closest\("button, \[role='button'\], a, summary"\)/,
  "push-to-talk must not trigger while an activatable control has focus");
assert.match(appSource, /for \(const trackID of element\?\.trackIDs \|\| \[\]\) \{[\s\S]*?remoteTrackRoles\.delete\(trackID\);/,
  "forgotten participants must prune their remote track roles");
const leaveHandler = slice(appSource, "leave.addEventListener(\"click\", () => {",
  "\nrejoin?.addEventListener");
assert.match(leaveHandler, /unreadMessages = 0;/,
  "leaving must reset the unread badge for the next meeting");
assert.match(leaveHandler, /chatHistoryTracker\?\.reset\(\);/,
  "leaving must reset the chat history tracker");
const rejoinHandler = slice(appSource, "rejoin?.addEventListener(\"click\", () => {",
  "\nfunction requestParticipantLayout");
assert.ok(rejoinHandler.length > 0, "rejoin handler should be present");
assert.match(appSource.slice(appSource.indexOf("rejoin?.addEventListener")),
  /queueRoomRosterRefresh\(\);/,
  "rejoining must re-arm the roster preview");

// Performance: layout renders fire several times per second during active
// conversation, so redundant DOM moves, play/pause churn, and full rebuilds
// must be skipped.
const renderMeetingLayout = slice(appSource, "function renderMeetingLayout() {",
  "\nfunction requestParticipantLayout()");
assert.match(renderMeetingLayout, /if \(container\.lastElementChild !== element\.item\) container\.append\(element\.item\);/,
  "layout rendering must skip re-appending tiles already in place");
const videoVisibility = slice(appSource, "function updateParticipantVideoVisibility(",
  "\nfunction updateParticipantPagination()");
assert.match(videoVisibility, /if \(element\.cameraVideo\.paused\) element\.cameraVideo\.play\(\)/,
  "video visibility must not restart playback that is already running");
assert.match(videoVisibility, /else if \(!element\.cameraVideo\.paused\) element\.cameraVideo\.pause\(\);/,
  "video visibility must not pause already-paused elements");
const updateDiagnostics = slice(appSource, "async function updateDiagnostics() {",
  "\nasync function runDiagnosticsUpdate()");
assert.match(updateDiagnostics, /if \(document\.hidden\) return;/,
  "the stats loop must idle while the tab is hidden");
assert.match(appSource, /if \(!diagnostics\.hidden && !diagnostics\.closest\("\[hidden\]"\)\) \{[\s\S]*?diagnostics\.textContent = JSON\.stringify/,
  "the diagnostics dump must be skipped while its panel is hidden");
assert.match(appSource, /function syncConnectionPopoverStats\(\) \{\n  if \(!connectionPopover \|\| connectionPopover\.hidden\) return;/,
  "popover stat mirroring must be skipped while the popover is closed");
const renderPeopleList = slice(appSource, "let peopleListSignature = \"\";",
  "\nfunction updateParticipantCount()");
assert.match(renderPeopleList, /if \(signature === peopleListSignature\) return;/,
  "the people list must skip rebuilds when its inputs are unchanged");
const runSpeakerDetection = slice(appSource, "function runSpeakerDetection(",
  "\nfunction attachSpeakerAnalyzer");
assert.match(runSpeakerDetection, /speakerDetectionIntervalMs/,
  "speaker detection must run below the animation frame rate");
assert.match(runSpeakerDetection, /1 - Math\.exp\(-sampleInterval \/ speakerLevelTimeConstantMs\)/,
  "speaker smoothing must keep its time constant at the lower sample rate");
assert.match(appSource, /while \(chatMessages\.children\.length > 300\) chatMessages\.firstElementChild\.remove\(\);/,
  "the chat rail must stay bounded on long meetings");

// Screen-share adaptation keeps learned degradation across same-budget
// refreshes (profile/config changes) and only resets when the budget changes.
const adaptationUpdate = slice(adaptationSource, "async update(bitrate, fps) {", "},\n      sample,");
assert.match(adaptationUpdate, /if \(nextBitrate === maxBitrate && nextFrameRate === maxFrameRate\) \{/,
  "same-budget updates must preserve the adapted frame rate and resolution");

// Pass 2: a microphone enabled after a failed join-time capture must adopt
// the reserved recvonly audio transceiver and renegotiate.
assert.match(appSource, /audioTransceiver = currentPeer\.addTransceiver\("audio", \{ direction: "recvonly" \}\);/,
  "the join flow must keep the audio transceiver reference");
const replaceLocalDeviceSource = appSource.slice(
  appSource.indexOf("async function replaceLocalDevice("),
  appSource.indexOf("async function runDeviceTest()"));
assert.match(replaceLocalDeviceSource,
  /!sender && audioTransceiver && peer\?\.getTransceivers\(\)\.includes\(audioTransceiver\)[\s\S]*?audioTransceiver\.direction = "sendrecv";[\s\S]*?await audioTransceiver\.sender\.replaceTrack\(nextTrack\);[\s\S]*?await renegotiateLocalMedia\(\);/,
  "a late microphone must be adopted onto the reserved m-line and renegotiated");
for (const resetSite of appSource.matchAll(/videoTransceiver = undefined;/g)) {
  // both reset sites (reconnect teardown and leave) must clear the audio
  // transceiver alongside the video one
}
assert.equal((appSource.match(/audioTransceiver = undefined;/g) || []).length, 2,
  "the audio transceiver must be reset on reconnect teardown and leave");

// The people-list signature must include camera state and incoming-video
// preference; both feed participantCameraLabel.
const peopleListSource = appSource.slice(
  appSource.indexOf("let peopleListSignature = \"\";"),
  appSource.indexOf("\nfunction updateParticipantCount()"));
assert.match(peopleListSource, /element\.item\.dataset\.camera \|\| ""/,
  "the people-list signature must track camera state");
assert.match(peopleListSource, /receiveVideoEnabled \? 1 : 0/,
  "the people-list signature must track the incoming-video preference");

// The camera reuse branch must discard a dead parked capture and fall through
// to the fresh-capture path.
const enableCameraOnceSource = appSource.slice(
  appSource.indexOf("async function enableCameraOnce("),
  appSource.indexOf("\nasync function disableCamera()"));
assert.match(enableCameraOnceSource,
  /localCameraTrack\.readyState === "live" && localCameraStream\.active/,
  "a parked capture must be live before it is reused");
assert.match(enableCameraOnceSource,
  /localCameraTrack = undefined;\n\s*localCameraStream = undefined;/,
  "a dead parked capture must be discarded");

// Profile refreshes while a screen share is active must resolve against the
// screen stream so the camera-quality preset cannot cap the share's fps.
assert.ok((appSource.match(/applyProfile\(profile\.value, peer, screenStream \|\| localStream\)/g) || []).length >= 5,
  "profile change, config_update, adaptation, and the pre-existing sites must resolve against the active stream");

// Successful reconnects must increment the visible reconnects metric.
assert.match(appSource, /wasReconnectResume = Boolean\(reconnectToken\);/,
  "the join flow must record whether it resumed a dropped session");
assert.match(appSource, /if \(wasReconnectResume\) \{[\s\S]*?connectionMetrics\.reconnects \+= 1;/,
  "a resumed session must count a reconnect");

console.log("Media fix checks passed (pass 2)");
