const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bindRemoteCameraTrack = require("../web/js/remote-camera-video.js");

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

testPlaybackStartsAndRetriesWhenCameraBecomesReady();
testStaleCameraTrackCannotClearReplacement();
testClearingCameraDetachesOldTrack();

const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
assert.match(appSource, /bindRemoteCameraTrack\(video, track, \(\) => updateParticipantVideoVisibility\(element\)\)/);
assert.match(appSource, /bindRemoteCameraTrack\(element\.cameraVideo, track, \(\) => updateParticipantVideoVisibility\(element\)\)/);
assert.match(appSource, /remoteCameraLayerTracks\.get\(participantID\) !== tracks \|\| tracks\.get\(layer\) !== track/);
assert.match(pageSource, /<script src="\/js\/remote-camera-video\.js"><\/script>\s*<script src="\/js\/screen-share-adaptation\.js"><\/script>\s*<script src="\/js\/app\.js"><\/script>/);
console.log("remote camera video tests passed");
