const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const bindRemoteScreenTrack = require("../web/js/remote-screen-video.js");

function createTrack() {
  const listeners = new Map();
  return {
    addEventListener(type, callback, options) {
      listeners.set(type, { callback, once: options?.once });
    },
    end() {
      const listener = listeners.get("ended");
      if (!listener) return;
      if (listener.once) listeners.delete("ended");
      listener.callback();
    }
  };
}

function createVideo() {
  return { srcObject: null };
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
const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const pageSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
assert.match(appSource, /bindRemoteScreenTrack\(video, track, \(\) => \{/);
assert.match(appSource, /bindRemoteScreenTrack\.clear\([\s\S]*previousBinding\.stream/);
assert.match(pageSource, /<script src="\/js\/remote-screen-video\.js"><\/script>\s*<script src="\/js\/app\.js"><\/script>/);
console.log("remote screen video tests passed");
