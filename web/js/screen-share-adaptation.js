(function (root) {
  const sampleIntervalMs = 5000;
  const minimumFrameRate = 5;
  const maximumResolutionScale = 3;

  function createScreenShareAdaptation(sender) {
    let timer;
    let stopped = false;
    let maxBitrate = 0;
    let maxFrameRate = 0;
    let frameRate = 0;
    let resolutionScale = 1;
    let previousBytes;
    let previousTimestamp;
    let overLimitSamples = 0;
    let sampleInProgress = false;
    let generation = 0;

    async function applyParameters() {
      if (stopped || !sender) return;
      const parameters = sender.getParameters();
      parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
      const encoding = parameters.encodings[0];
      encoding.maxBitrate = maxBitrate;
      encoding.maxFramerate = frameRate;
      encoding.scaleResolutionDownBy = resolutionScale;
      parameters.degradationPreference = "maintain-resolution";
      await sender.setParameters(parameters).catch(() => {});
    }

    async function sample() {
      if (stopped || sampleInProgress || !sender?.getStats || maxBitrate <= 0) return;
      sampleInProgress = true;
      const sampleGeneration = generation;
      let stats;
      try {
        stats = await sender.getStats();
      } catch (_) {
        sampleInProgress = false;
        return;
      }
      if (stopped || sampleGeneration !== generation) {
        sampleInProgress = false;
        return;
      }
      let outbound;
      stats.forEach((stat) => {
        if (stat.type === "outbound-rtp" &&
            (stat.kind === "video" || stat.mediaType === "video") &&
            Number.isFinite(stat.bytesSent) && Number.isFinite(stat.timestamp)) {
          outbound = stat;
        }
      });
      if (!outbound) {
        sampleInProgress = false;
        return;
      }
      if (Number.isFinite(previousBytes) && Number.isFinite(previousTimestamp)) {
        const elapsedMs = outbound.timestamp - previousTimestamp;
        if (elapsedMs > 0) {
          const bitrate = ((outbound.bytesSent - previousBytes) * 8 * 1000) / elapsedMs;
          if (bitrate > maxBitrate * 1.1) overLimitSamples++;
          else overLimitSamples = 0;
          if (overLimitSamples >= 2) {
            overLimitSamples = 0;
            if (frameRate > minimumFrameRate) {
              frameRate = Math.max(minimumFrameRate, Math.floor(frameRate * 0.8));
            } else if (resolutionScale < maximumResolutionScale) {
              resolutionScale = Math.min(maximumResolutionScale, resolutionScale + 0.25);
            }
            await applyParameters();
          }
        }
      }
      previousBytes = outbound.bytesSent;
      previousTimestamp = outbound.timestamp;
      sampleInProgress = false;
    }

    return {
      async update(bitrate, fps) {
        if (stopped) return;
        generation++;
        maxBitrate = Math.max(1, Math.floor(bitrate));
        maxFrameRate = Math.max(1, Math.floor(fps));
        frameRate = maxFrameRate;
        resolutionScale = 1;
        previousBytes = undefined;
        previousTimestamp = undefined;
        overLimitSamples = 0;
        await applyParameters();
        if (!timer) timer = root.setInterval(sample, sampleIntervalMs);
      },
      sample,
      stop() {
        stopped = true;
        generation++;
        if (timer) root.clearInterval(timer);
        timer = undefined;
      },
      state() {
        return { maxBitrate, maxFrameRate, frameRate, resolutionScale };
      }
    };
  }

  root.createScreenShareAdaptation = createScreenShareAdaptation;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = { createScreenShareAdaptation };
  }
})(typeof window !== "undefined" ? window : globalThis);
