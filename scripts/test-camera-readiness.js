"use strict";

const assert = require("node:assert/strict");
const { waitForAdvancingVideoFrames } = require("../web/js/camera-readiness.js");

function createVideo(mediaTimes, intervalMs = 5) {
  let frameIndex = 0;
  let callbackID = 0;
  const pending = new Map();
  return {
    readyState: 2,
    videoWidth: 640,
    videoHeight: 480,
    requestVideoFrameCallback(callback) {
      const id = ++callbackID;
      const timer = setTimeout(() => {
        pending.delete(id);
        const mediaTime = mediaTimes[Math.min(frameIndex, mediaTimes.length - 1)];
        frameIndex += 1;
        callback(performance.now(), { mediaTime, presentedFrames: frameIndex });
      }, intervalMs);
      pending.set(id, timer);
      return id;
    },
    cancelVideoFrameCallback(id) {
      const timer = pending.get(id);
      if (timer) clearTimeout(timer);
      pending.delete(id);
    }
  };
}

async function main() {
  const moving = createVideo([0, 0.033, 0.066]);
  const ready = await waitForAdvancingVideoFrames(moving, { minimumAdvances: 2, timeoutMs: 100 });
  assert.equal(ready.advancingFrames, 2);
  assert.equal(ready.presentedFrames, 3);

  const frozen = createVideo([0]);
  await assert.rejects(
    waitForAdvancingVideoFrames(frozen, { minimumAdvances: 2, timeoutMs: 40 }),
    /did not produce advancing video frames/
  );

  const singleFrame = createVideo([0, 0, 0]);
  await assert.rejects(
    waitForAdvancingVideoFrames(singleFrame, { minimumAdvances: 2, timeoutMs: 40 }),
    /did not produce advancing video frames/
  );

  console.log("camera readiness checks passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
