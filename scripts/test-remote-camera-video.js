const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bindRemoteCameraTrack = require("../web/js/remote-camera-video.js");
const { remoteMediaRole, remoteCameraLayer, signaledTrackID } = require("../web/js/remote-media-identity.js");

// B12: a reused transceiver keeps its first track.id, so identity is read
// from the m-line's signaled msid instead.
const reusedSDP = [
  "v=0",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:1",
  "a=msid:slowmeet-p1-camera p1|camera|low",
  "a=sendonly",
  "m=video 9 UDP/TLS/RTP/SAVPF 96",
  "a=mid:10",
  "a=msid:slowmeet-p2-camera p2|camera|medium",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111",
  "a=mid:11",
  ""
].join("\r\n");
assert.equal(signaledTrackID(reusedSDP, "1"), "p1|camera|low");
assert.equal(signaledTrackID(reusedSDP, "10"), "p2|camera|medium", "a mid must not match a longer mid's prefix");
assert.equal(signaledTrackID(reusedSDP, "11"), "", "an m-line without msid signals no track");
assert.equal(signaledTrackID(reusedSDP, "2"), "");
assert.equal(signaledTrackID("", "1"), "");
assert.equal(remoteCameraLayer({ id: signaledTrackID(reusedSDP, "1") }), "low");

for (const [streams, track, role, layer] of [
  [[{ id: "participant-2-screen" }], { kind: "video" }, "screen", ""],
  [[], { id: "participant|2|screen", kind: "video" }, "screen", ""],
  [[], { id: "participant|2|camera|medium", kind: "video" }, "camera", "medium"],
  [[], { streamId: "participant-2-camera", kind: "video" }, "camera", ""],
  [[], { kind: "audio" }, "audio", ""],
  [undefined, undefined, "camera", ""],
]) {
  assert.equal(remoteMediaRole(streams, track), role);
  assert.equal(remoteCameraLayer(track), layer);
}
function createEventTarget() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, options) {
      const entries = listeners.get(type) || [];
      entries.push({ callback, once: options?.once });
      listeners.set(type, entries);
    },
    removeEventListener(type, callback) {
      const entries = listeners.get(type) || [];
      listeners.set(type, entries.filter((entry) => entry.callback !== callback));
    },
    emit(type) {
      const entries = listeners.get(type) || [];
      for (const entry of [...entries]) {
        if (entry.once) this.removeEventListener(type, entry.callback);
        entry.callback();
      }
    }
  };
}

function createTrack() {
  return {
    ...createEventTarget(),
    readyState: "live",
    muted: false,
    end() { this.emit("ended"); }
  };
}

function createVideo() {
  const events = createEventTarget();
  const video = {
    autoplay: false,
    muted: false,
    playsInline: false,
    playCalls: 0,
    pauseCalls: 0,
    addEventListener: events.addEventListener,
    removeEventListener: events.removeEventListener,
    emit: events.emit,
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
    pause() { this.pauseCalls += 1; }
  };
  return video;
}

function createStream(track) {
  return { track, getTracks: () => [track] };
}

function testPlaybackStartsAndRetriesWhenCameraBecomesReady() {
  const video = createVideo();
  const track = createTrack();
  let attachedSettings;
  Object.defineProperty(video, "srcObject", {
    get() { return this._srcObject || null; },
    set(stream) {
      this._srcObject = stream;
      if (stream) attachedSettings = {
        autoplay: this.autoplay,
        muted: this.muted,
        playsInline: this.playsInline
      };
    }
  });

  bindRemoteCameraTrack(video, track, () => {}, createStream);

  assert.deepEqual(attachedSettings, { autoplay: true, muted: true, playsInline: true });
  assert.equal(video.playCalls, 1, "binding should attempt playback immediately");
  track.emit("unmute");
  video.emit("loadedmetadata");
  assert.equal(video.playCalls, 3, "playback should retry on unmute and metadata");
}

function testStaleCameraTrackCannotClearReplacement() {
  const video = createVideo();
  let srcObject = null;
  Object.defineProperty(video, "srcObject", {
    get() { return srcObject; },
    set(stream) { srcObject = stream; }
  });
  const oldTrack = createTrack();
  const currentTrack = createTrack();
  let endedUpdates = 0;

  bindRemoteCameraTrack(video, oldTrack, () => { endedUpdates += 1; }, createStream);
  const currentStream = bindRemoteCameraTrack(video, currentTrack, () => { endedUpdates += 1; }, createStream);
  oldTrack.end();
  assert.equal(video.srcObject, currentStream, "stale track end must preserve the replacement camera");
  assert.equal(endedUpdates, 0, "stale track end must not update camera state");

  currentTrack.end();
  assert.equal(video.srcObject, null, "current track end should clear its video");
  assert.equal(video.pauseCalls, 1);
  assert.equal(endedUpdates, 1);
}

function testClearingCameraDetachesOldTrack() {
  const video = createVideo();
  let srcObject = null;
  Object.defineProperty(video, "srcObject", {
    get() { return srcObject; },
    set(stream) { srcObject = stream; }
  });
  const track = createTrack();
  let endedUpdates = 0;

  bindRemoteCameraTrack(video, track, () => { endedUpdates += 1; }, createStream);
  assert.equal(bindRemoteCameraTrack.clear(video), true);
  assert.equal(video.srcObject, null, "clearing a selected layer should detach its stream");
  track.end();
  assert.equal(endedUpdates, 0, "a cleared layer must not run stale ended cleanup");
}

function testSelectLayerFallsBackToActiveQuality() {
  const medium = createTrack();
  const high = createTrack();
  high.muted = true;
  const tracks = new Map([["medium", medium], ["high", high]]);

  assert.equal(bindRemoteCameraTrack.selectLayer(tracks, "high"), medium,
    "use the active medium layer while the preferred high layer has no packets");
  high.muted = false;
  assert.equal(bindRemoteCameraTrack.selectLayer(tracks, "high"), high,
    "switch to the preferred layer when it starts receiving packets");
}

// B12: the SFU forwards one layer per receiver; the layer actually taking
// packets wins over the lagging muted flag, nearest to the preference first.
function testSelectLayerFollowsTheFlowingLayer() {
  const low = createTrack();
  const medium = createTrack();
  const high = createTrack();
  const tracks = new Map([["low", low], ["medium", medium], ["high", high]]);
  let flowing = new Set([low]);
  const isFlowing = (track) => flowing.has(track);
  assert.equal(bindRemoteCameraTrack.selectLayer(tracks, "high", isFlowing), low,
    "show the layer the SFU forwards even while the unmuted preferred layer has no packets");
  flowing = new Set([low, medium]);
  assert.equal(bindRemoteCameraTrack.selectLayer(tracks, "high", isFlowing), medium,
    "between two flowing layers the one nearest the preference wins");
  flowing = new Set();
  medium.muted = true;
  high.muted = true;
  assert.equal(bindRemoteCameraTrack.selectLayer(tracks, "high", isFlowing), low,
    "with nothing flowing, fall back to the nearest unmuted layer");
}

testPlaybackStartsAndRetriesWhenCameraBecomesReady();
testStaleCameraTrackCannotClearReplacement();
testClearingCameraDetachesOldTrack();
testSelectLayerFallsBackToActiveQuality();
testSelectLayerFollowsTheFlowingLayer();

const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
assert.match(appSource, /bindRemoteCameraTrack\(video, track, \(\) => updateParticipantVideoVisibility\(element\)\)/);
assert.match(appSource, /bindRemoteCameraTrack\(element\.cameraVideo, track, \(\) => updateParticipantVideoVisibility\(element\)\)/);
assert.match(appSource, /remoteCameraLayerTracks\.get\(participantID\) !== tracks \|\| tracks\.get\(layer\) !== track/);
assert.match(appSource, /bindRemoteCameraTrack\.selectLayer\(tracks, cameraLayer,\n\s+\(candidate\) => flowingRemoteVideoTrackIDs\.has\(candidate\.id\)\)/);
assert.match(appSource, /if \(previousStats\) updateFlowingCameraLayers\(flowingVideoTrackIDs\);/);
// Helper modules only need to load in this relative order before app.js.
const scriptOrder = ["remote-camera-video.js", "screen-share-adaptation.js", "connection-methods.js", "app.js"]
  .map((name) => pageSource.indexOf(`/js/${name}`));
assert.ok(scriptOrder.every((index) => index > 0), "expected helper scripts to be referenced from index.html");
assert.deepEqual(scriptOrder, [...scriptOrder].sort((a, b) => a - b), "helper scripts must load before app.js");
console.log("remote camera video tests passed");
