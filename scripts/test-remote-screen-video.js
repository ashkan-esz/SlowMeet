const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bindRemoteScreenTrack = require("../web/js/remote-screen-video.js");

function createTrack() {
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
    },
    end() {
      this.emit("ended");
    }
  };
}

function createVideo() {
  const listeners = new Map();
  let attachedSettings;
  const video = {
    autoplay: false,
    muted: false,
    playsInline: false,
    playCalls: 0,
    pauseCalls: 0,
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
    },
    play() {
      this.playCalls += 1;
      return Promise.resolve();
    },
    pause() {
      this.pauseCalls += 1;
    },
    get attachedSettings() {
      return attachedSettings;
    }
  };
  Object.defineProperty(video, "srcObject", {
    get() { return this._srcObject || null; },
    set(stream) {
      this._srcObject = stream;
      if (stream) {
        attachedSettings = {
          autoplay: this.autoplay,
          muted: this.muted,
          playsInline: this.playsInline
        };
      }
    }
  });
  return video;
}

function createStream(track) {
  return { track, getTracks: () => [track] };
}

function testOldTrackEndDoesNotClearRestartedShare() {
  const video = createVideo();
  const oldTrack = createTrack();
  const newTrack = createTrack();
  let endedUpdates = 0;

  const oldStream = bindRemoteScreenTrack(video, oldTrack, () => { endedUpdates += 1; }, createStream);
  const newStream = bindRemoteScreenTrack(video, newTrack, () => { endedUpdates += 1; }, createStream);
  assert.equal(video.srcObject, newStream);
  oldTrack.end();
  assert.equal(video.srcObject, newStream, "an old share ending must preserve the restarted share");
  assert.equal(endedUpdates, 0, "stale track cleanup must not update current video visibility");
  assert.notEqual(oldStream, newStream);
}

function testCurrentTrackEndClearsVideo() {
  const video = createVideo();
  const track = createTrack();
  let endedUpdates = 0;

  const stream = bindRemoteScreenTrack(video, track, () => { endedUpdates += 1; }, createStream);
  assert.equal(video.srcObject, stream);
  track.end();
  assert.equal(video.srcObject, null, "the current share must clear when its track ends");
  assert.equal(endedUpdates, 1);
  track.end();
  assert.equal(endedUpdates, 1, "ended cleanup should run once");
}

function testScreenVideoStartsMutedInlinePlaybackBeforeBinding() {
  const video = createVideo();
  const track = createTrack();

  bindRemoteScreenTrack(video, track, () => {}, createStream);

  assert.deepEqual(video.attachedSettings, {
    autoplay: true,
    muted: true,
    playsInline: true
  }, "autoplay properties must be configured before attaching the stream");
  assert.equal(video.playCalls, 1, "binding should attempt playback immediately");
}

function testScreenVideoRetriesPlaybackWhenTrackAndMetadataBecomeReady() {
  const video = createVideo();
  const track = createTrack();

  bindRemoteScreenTrack(video, track, () => {}, createStream);
  track.emit("unmute");
  video.emit("loadedmetadata");

  assert.equal(video.playCalls, 3, "playback should retry on track unmute and loaded metadata");
}

function testStaleTrackEventsCannotRestartCurrentPlayback() {
  const video = createVideo();
  const oldTrack = createTrack();
  const newTrack = createTrack();

  bindRemoteScreenTrack(video, oldTrack, () => {}, createStream);
  const currentStream = bindRemoteScreenTrack(video, newTrack, () => {}, createStream);
  const playCallsAfterRestart = video.playCalls;
  oldTrack.emit("unmute");

  assert.equal(video.srcObject, currentStream);
  assert.equal(video.playCalls, playCallsAfterRestart, "a stale track must not restart the new share's video");
}

function testShareStateCleanupCannotClearNewBinding() {
  const video = createVideo();
  const oldTrack = createTrack();
  const newTrack = createTrack();
  let endedUpdates = 0;
  const oldStream = bindRemoteScreenTrack(video, oldTrack, () => { endedUpdates += 1; }, createStream);
  const newStream = bindRemoteScreenTrack(video, newTrack, () => { endedUpdates += 1; }, createStream);

  assert.equal(bindRemoteScreenTrack.clear(video, oldStream, () => { endedUpdates += 1; }), false);
  assert.equal(video.srcObject, newStream, "inactive state for an old stream must preserve a newer share");
  assert.equal(bindRemoteScreenTrack.clear(video, newStream, () => { endedUpdates += 1; }), true);
  assert.equal(video.srcObject, null, "inactive state must clear the current share");
  assert.equal(endedUpdates, 1);
}

testOldTrackEndDoesNotClearRestartedShare();
testCurrentTrackEndClearsVideo();
testShareStateCleanupCannotClearNewBinding();
testScreenVideoStartsMutedInlinePlaybackBeforeBinding();
testScreenVideoRetriesPlaybackWhenTrackAndMetadataBecomeReady();
testStaleTrackEventsCannotRestartCurrentPlayback();
const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
assert.match(appSource, /bindRemoteScreenTrack\(video, track, \(\) => \{/);
assert.match(appSource, /bindRemoteScreenTrack\.clear\([\s\S]*previousBinding\.stream/);
assert.doesNotMatch(appSource, /recoverRemoteScreenVideo|screenRecoveryChain|remoteScreenRecoveryGuard/);
assert.match(pageSource, /<script src="\/js\/remote-screen-video\.js"><\/script>\s*<script src="\/js\/screen-share-adaptation\.js"><\/script>\s*<script src="\/js\/app\.js"><\/script>/);
console.log("remote screen video tests passed");
