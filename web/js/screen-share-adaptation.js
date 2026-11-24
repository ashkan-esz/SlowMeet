(function (root) {
  const sampleIntervalMs = 5000;
  const minimumFrameRate = 5;
  const maximumResolutionScale = 3;
  // Consecutive within-budget samples before one recovery step up. Mirrors
  // the camera ladder's asymmetric 2-down / N-up hysteresis so a share that
  // was degraded by transient congestion steps back up instead of staying at
  // the floor forever.
  const underLimitSamplesToRecover = 5;
  // An encoder held at full resolution on a small budget can starve: it uses
  // the budget and still makes a frame every few seconds. Measured at
  // 180 kbps with a 1920x1080 screen: VP9 2 frames in 12 s and VP8 12, against
  // 87 and 90 at 960x540. Its bitrate stays inside the cap, so the over-limit
  // rule above never sees it.
  const starvationFrameRate = 2;
  const starvationSourceFrameRate = 4;
  const starvationSamples = 2;
  const starvationScales = [1, 1.5, 2, 3];
  // Samples (of 5 s) a starved resolution stays ruled out before recovery may
  // try it again.
  const starvationHoldSamples = 36;

  // Whether the encoder is starving. Where the browser reports the frames its
  // video source delivers, it is what the screen offers against what the
  // encoder makes: a screen that does not change offers nothing and is never
  // starving. Without that report, only an encoder that spends half its
  // budget on less than a frame a second counts.
  function screenShareStarving({ encodedFrameRate, sourceFrameRate, bitrate, maxBitrate }) {
    if (!Number.isFinite(encodedFrameRate)) return false;
    if (Number.isFinite(sourceFrameRate)) {
      return sourceFrameRate >= starvationSourceFrameRate && encodedFrameRate < starvationFrameRate;
    }
    return encodedFrameRate < 1 && Number.isFinite(bitrate) && maxBitrate > 0 && bitrate >= maxBitrate / 2;
  }

  function createScreenShareAdaptation(sender) {
    let timer;
    let stopped = false;
    let maxBitrate = 0;
    let maxFrameRate = 0;
    let frameRate = 0;
    let resolutionScale = 1;
    let previousBytes;
    let previousTimestamp;
    let lastMeasuredBitrate;
    let overLimitSamples = 0;
    let underLimitSamples = 0;
    let sampleInProgress = false;
    let generation = 0;
    let previousFrames;
    let previousSourceFrames;
    let starvedSamples = 0;
    // The smallest scale recovery may return to; above 1 while a resolution
    // that starved the encoder is ruled out (holdSamples counts that down).
    let minimumScale = 1;
    let holdSamples = 0;
    // The codec the sender was last seen sending, and for each codec the size
    // that starved it. A size that starves VP9 is fine for AV1: without this a
    // share that shrank in one codec stayed small for minutes after the room
    // moved to another.
    let sentCodec = "";
    const starvedScales = new Map();

    // Moves what starvation taught to the codec now in use. Returns whether
    // the sender's parameters changed.
    function noteSentCodec(codec) {
      if (codec === sentCodec) return false;
      const first = sentCodec === "";
      if (minimumScale > 1) starvedScales.set(sentCodec, minimumScale);
      else starvedScales.delete(sentCodec);
      sentCodec = codec;
      if (first) return false;
      const learned = starvedScales.get(codec) || 1;
      const previousScale = resolutionScale;
      // Without the size starvation forced for the previous codec, the scale
      // the bitrate rule reached on its own stays.
      resolutionScale = Math.max(learned, minimumScale > 1 ? 1 : resolutionScale);
      minimumScale = learned;
      holdSamples = learned > 1 ? starvationHoldSamples : 0;
      starvedSamples = 0;
      overLimitSamples = 0;
      underLimitSamples = 0;
      return resolutionScale !== previousScale;
    }

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

    function ensureSampling() {
      if (!timer) timer = root.setInterval(sample, sampleIntervalMs);
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
      let source;
      stats.forEach((stat) => {
        if (stat.type === "media-source" && stat.kind === "video" && Number.isFinite(stat.frames)) source = stat;
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
      const codec = String(stats.get?.(outbound.codecId)?.mimeType || "").toLowerCase();
      if (codec && codec !== sentCodec) {
        const first = sentCodec === "";
        const changed = noteSentCodec(codec);
        if (!first) {
          // This window holds frames of both codecs: it starts a new baseline
          // instead of giving a verdict.
          previousBytes = undefined;
          previousTimestamp = undefined;
          if (changed) await applyParameters();
        }
      }
      // A counter that starts again (a replaced stream) gives a negative
      // difference, which says nothing about the encoder.
      const rate = (current, previous, elapsedMs) =>
        Number.isFinite(current) && Number.isFinite(previous) && current >= previous
          ? (current - previous) * 1000 / elapsedMs
          : NaN;
      if (Number.isFinite(previousBytes) && Number.isFinite(previousTimestamp)) {
        const elapsedMs = outbound.timestamp - previousTimestamp;
        if (elapsedMs > 0 && outbound.bytesSent >= previousBytes) {
          const bitrate = ((outbound.bytesSent - previousBytes) * 8 * 1000) / elapsedMs;
          lastMeasuredBitrate = bitrate;
          const encodedFrameRate = rate(outbound.framesEncoded, previousFrames, elapsedMs);
          const sourceFrameRate = rate(source?.frames, previousSourceFrames, elapsedMs);
          if (holdSamples > 0 && --holdSamples === 0) minimumScale = 1;
          if (screenShareStarving({ encodedFrameRate, sourceFrameRate, bitrate, maxBitrate })) starvedSamples++;
          else starvedSamples = 0;
          const starved = starvedSamples >= starvationSamples && resolutionScale < maximumResolutionScale;
          if (bitrate > maxBitrate * 1.1) {
            overLimitSamples++;
            underLimitSamples = 0;
          } else {
            overLimitSamples = 0;
            // Full quality already: nothing to step up into.
            if (frameRate < maxFrameRate || resolutionScale > minimumScale) underLimitSamples++;
            else underLimitSamples = 0;
          }
          if (starved) {
            // A smaller picture is the only thing that feeds a starving
            // encoder; step straight to the next size and keep the starved
            // one ruled out for a while, or recovery would walk back into it.
            starvedSamples = 0;
            overLimitSamples = 0;
            underLimitSamples = 0;
            resolutionScale = starvationScales.find((scale) => scale > resolutionScale) ?? maximumResolutionScale;
            minimumScale = resolutionScale;
            holdSamples = starvationHoldSamples;
            await applyParameters();
          } else if (overLimitSamples >= 2) {
            overLimitSamples = 0;
            underLimitSamples = 0;
            if (frameRate > minimumFrameRate) {
              frameRate = Math.max(minimumFrameRate, Math.floor(frameRate * 0.8));
            } else if (resolutionScale < maximumResolutionScale) {
              resolutionScale = Math.min(maximumResolutionScale, resolutionScale + 0.25);
            }
            await applyParameters();
          } else if (underLimitSamples >= underLimitSamplesToRecover) {
            underLimitSamples = 0;
            // Mirror of the down-step: frame rate recovers first (readability
            // of moving content), then resolution.
            if (frameRate < maxFrameRate) {
              frameRate = Math.min(maxFrameRate, Math.ceil(frameRate * 1.25));
            } else if (resolutionScale > minimumScale) {
              resolutionScale = Math.max(minimumScale, resolutionScale - 0.25);
            }
            await applyParameters();
          }
        }
      }
      previousBytes = outbound.bytesSent;
      previousTimestamp = outbound.timestamp;
      previousFrames = outbound.framesEncoded;
      previousSourceFrames = source?.frames;
      sampleInProgress = false;
    }

    return {
      async update(bitrate, fps) {
        if (stopped) return;
        generation++;
        const nextBitrate = Math.max(1, Math.floor(bitrate));
        const nextFrameRate = Math.max(1, Math.floor(fps));
        if (nextBitrate === maxBitrate && nextFrameRate === maxFrameRate) {
          // The same budget (a profile or config refresh): keep the adaptation
          // the sampler has already learned for this sender.
          previousBytes = undefined;
          previousTimestamp = undefined;
          await applyParameters();
          ensureSampling();
          return;
        }
        const previousBitrate = maxBitrate;
        maxBitrate = nextBitrate;
        maxFrameRate = nextFrameRate;
        if (nextBitrate > previousBitrate) {
          // A larger budget may feed the resolution that starved before.
          minimumScale = 1;
          holdSamples = 0;
          starvedScales.clear();
        }
        starvedSamples = 0;
        // A changed budget used to reset the learned stepping to full quality,
        // which overspends for two sampling windows right after a camera
        // up-step and can re-trigger congestion. Keep the learned adaptation
        // (clamped to the new budget) — the recovery up-step reopens quality
        // once the measured bitrate stays under the new cap.
        if (frameRate > 0) {
          frameRate = Math.min(maxFrameRate, frameRate);
        } else {
          frameRate = maxFrameRate;
        }
        if (nextBitrate < previousBitrate && Number.isFinite(lastMeasuredBitrate) && lastMeasuredBitrate > 0) {
          // A budget cut: seed the frame rate roughly in proportion to the
          // measured share of the old cap so the sender starts near the link.
          frameRate = Math.max(minimumFrameRate, Math.min(frameRate,
            Math.ceil(maxFrameRate * Math.min(1, lastMeasuredBitrate / nextBitrate))));
        }
        resolutionScale = Math.min(maximumResolutionScale, Math.max(1, resolutionScale));
        previousBytes = undefined;
        previousTimestamp = undefined;
        overLimitSamples = 0;
        underLimitSamples = 0;
        await applyParameters();
        ensureSampling();
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
    module.exports = { createScreenShareAdaptation, screenShareStarving };
  }
})(typeof window !== "undefined" ? window : globalThis);
