"use strict";

(function exposeCameraReadiness(root, createAPI) {
  const api = createAPI();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.SlowMeetCameraReadiness = api;
})(typeof window !== "undefined" ? window : globalThis, function createCameraReadinessAPI() {
  function waitForAdvancingVideoFrames(video, { minimumAdvances = 2, timeoutMs = 900 } = {}) {
    if (!video || typeof video.requestVideoFrameCallback !== "function") {
      return Promise.reject(new Error("Camera frame callbacks are unavailable"));
    }
    if (!Number.isInteger(minimumAdvances) || minimumAdvances < 1 || timeoutMs <= 0) {
      return Promise.reject(new TypeError("Invalid camera frame readiness limits"));
    }

    return new Promise((resolve, reject) => {
      const startedAt = performance.now();
      let previousMediaTime = null;
      let advancingFrames = 0;
      let presentedFrames = 0;
      let latestMediaTime = null;
      let callbackID;
      let timer;
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        if (callbackID !== undefined) {
          try {
            video.cancelVideoFrameCallback(callbackID);
          } catch (_) {
            // The callback may already be running.
          }
        }
      };

      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve(result);
      };

      const observe = (_now, metadata = {}) => {
        if (settled) return;
        const mediaTime = Number.isFinite(metadata.mediaTime)
          ? metadata.mediaTime
          : video.currentTime;
        if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0 &&
            Number.isFinite(mediaTime)) {
          if (previousMediaTime !== null && mediaTime > previousMediaTime) advancingFrames += 1;
          if (previousMediaTime === null || mediaTime > previousMediaTime) previousMediaTime = mediaTime;
          latestMediaTime = mediaTime;
          presentedFrames = Number.isFinite(metadata.presentedFrames)
            ? metadata.presentedFrames
            : presentedFrames + 1;
          if (advancingFrames >= minimumAdvances) {
            finish(null, {
              advancingFrames,
              presentedFrames,
              mediaTime: latestMediaTime,
              width: video.videoWidth,
              height: video.videoHeight,
              elapsedMs: performance.now() - startedAt
            });
            return;
          }
        }
        try {
          callbackID = video.requestVideoFrameCallback(observe);
        } catch (error) {
          finish(error);
        }
      };

      timer = setTimeout(() => {
        finish(new Error(`Camera source did not produce advancing video frames within ${timeoutMs}ms`));
      }, timeoutMs);
      try {
        callbackID = video.requestVideoFrameCallback(observe);
      } catch (error) {
        finish(error);
      }
    });
  }

  return { waitForAdvancingVideoFrames };
});
