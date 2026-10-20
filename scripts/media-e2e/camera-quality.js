"use strict";

const assert = require("node:assert/strict");

function installCameraQualityRecorder({ label, pageRole, requireMarkers = true, includeFrameObservations = false }) {
  const markerModulo = 16777216;
  const rateWindowMs = 1000;
  const rateWindowStepMs = 250;
  const test = window.__slowMeetTest;
  if (!test) throw new Error("camera quality recorder requires the E2E browser hooks");
  if (test.cameraQualityCapture?.active) throw new Error("camera quality capture is already active");

  const otherRole = pageRole === "A" ? "B" : "A";
  const roleStates = Object.create(null);
  const stateEvents = [];
  const resumeEvents = [];
  const tiles = Object.create(null);
  const videoTiles = new WeakMap();
  const visualCanvas = document.createElement("canvas");
  visualCanvas.width = 32;
  visualCanvas.height = 18;
  const visualContext = visualCanvas.getContext("2d", { willReadFrequently: true });
  const markerCanvas = requireMarkers ? document.createElement("canvas") : null;
  if (markerCanvas) {
    markerCanvas.width = 640;
    markerCanvas.height = 480;
  }
  const markerContext = markerCanvas?.getContext("2d", { willReadFrequently: true }) || null;
  const capture = {
    label,
    pageRole,
    requireMarkers,
    active: true,
    startedAt: performance.now(),
    stableStartedAt: null,
    endedAt: null,
    maxHeartbeatGapMs: 0,
    heartbeatGaps: [],
    timer: null,
    observer: null,
    tiles,
    stateEvents,
    resumeEvents,
    lastSummary: null
  };

  function roleForRow(row) {
    return row?.classList.contains("is-local") ? pageRole : otherRole;
  }

  function recordState(row, at = performance.now()) {
    const participantRole = roleForRow(row);
    const next = row.dataset.camera || "unknown";
    const previous = roleStates[participantRole];
    if (previous === undefined) {
      roleStates[participantRole] = next;
      stateEvents.push({ role: participantRole, previous: null, current: next, at });
      return;
    }
    if (previous === next) return;

    roleStates[participantRole] = next;
    stateEvents.push({ role: participantRole, previous, current: next, at });
    if (previous === "off" && next === "on") {
      const roleTiles = Object.values(tiles).filter((tile) => tile.participantRole === participantRole);
      if (requireMarkers) {
        const baselineMarkers = Object.fromEntries(roleTiles.map((tile) => [tile.key, tile.lastOnMarkerValue]));
        const expectedView = participantRole === pageRole ? "local" : "remote";
        if (Number.isFinite(baselineMarkers[`${participantRole}/${expectedView}`])) {
          resumeEvents.push({ role: participantRole, at, endAt: null, baselineMarkers, firstFrames: {} });
        }
      } else {
        const baselineFrames = Object.fromEntries(roleTiles.map((tile) => [tile.key, tile.lastOnFrame]));
        if (Object.values(baselineFrames).some(Boolean)) {
          resumeEvents.push({ role: participantRole, at, endAt: null, baselineFrames, pendingFrames: {}, firstFrames: {} });
        }
      }
    }
    if (next !== "on") {
      for (const resume of resumeEvents) {
        if (resume.role === participantRole && resume.endAt === null) resume.endAt = at;
      }
      for (const tile of Object.values(tiles)) {
        if (tile.participantRole === participantRole) tile.lastOnFrameAt = null;
      }
    }
  }

  function decodeMarker(video, participantRole) {
    if (!requireMarkers || !markerContext || video.videoWidth < 320 || video.videoHeight < 200) {
      return { valid: false, ageMs: null, marker: null, roleMatches: false };
    }
    try {
      markerContext.imageSmoothingEnabled = false;
      markerContext.drawImage(video, 0, 0, markerCanvas.width, markerCanvas.height);
      const bits = [];
      const pixels = markerContext.getImageData(20, 240, 561, 1).data;
      for (let index = 0; index < 29; index += 1) {
        const offset = index * 20 * 4;
        const luminance = 0.299 * pixels[offset] + 0.587 * pixels[offset + 1] + 0.114 * pixels[offset + 2];
        bits.push(luminance >= 128 ? 1 : 0);
      }
      const headerValid = bits[0] === 1 && bits[1] === 0 && bits[2] === 1 && bits[3] === 0;
      const roleMatches = bits[4] === (participantRole === "B" ? 1 : 0);
      let marker = 0;
      for (let index = 5; index < 29; index += 1) marker = marker * 2 + bits[index];
      let ageMs = ((Date.now() % markerModulo) - marker + markerModulo) % markerModulo;
      if (ageMs > markerModulo / 2) ageMs -= markerModulo;
      return { valid: headerValid && roleMatches, ageMs, marker, roleMatches };
    } catch (_) {
      return { valid: false, ageMs: null, marker: null, roleMatches: false };
    }
  }

  function sampleVisual(video, tile, at, cameraState) {
    if (!visualContext || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const last = tile.visualSamples.at(-1);
    if (last && at - last.at < 100) return null;
    try {
      visualContext.drawImage(video, 0, 0, visualCanvas.width, visualCanvas.height);
      const rgba = visualContext.getImageData(0, 0, visualCanvas.width, visualCanvas.height).data;
      const luminance = new Uint8Array(visualCanvas.width * visualCanvas.height);
      let hash = 2166136261;
      let deltaTotal = 0;
      let changedPixels = 0;
      const previous = tile.previousVisual && tile.previousVisual.cameraState === cameraState &&
        at - tile.previousVisual.at <= 500 ? tile.previousVisual : null;
      for (let index = 0; index < luminance.length; index += 1) {
        const offset = index * 4;
        const value = Math.round(0.299 * rgba[offset] + 0.587 * rgba[offset + 1] + 0.114 * rgba[offset + 2]);
        luminance[index] = value;
        hash = Math.imul(hash ^ value, 16777619) >>> 0;
        if (previous) {
          const delta = Math.abs(value - previous.luminance[index]);
          deltaTotal += delta;
          if (delta >= 4) changedPixels += 1;
        }
      }
      const sample = {
        at,
        cameraState,
        hash,
        identical: previous ? hash === previous.hash : null,
        meanLumaDelta: previous ? deltaTotal / luminance.length : null,
        changedPixelFraction: previous ? changedPixels / luminance.length : null
      };
      tile.visualSamples.push(sample);
      tile.previousVisual = { hash, luminance, at, cameraState };
      return sample;
    } catch (_) {
      return null;
    }
  }

  function ensureVideo(video) {
    const row = video.closest("li[data-participant-id]");
    if (!row) return;
    const view = row.classList.contains("is-local") ? "local" : "remote";
    if (view === "local" ? !video.classList.contains("camera-video") : video.dataset.mediaRole !== "camera") return;
    const stream = video.srcObject;
    const previousRegistration = videoTiles.get(video);
    if (previousRegistration?.stream === stream) return;
    const participantRole = roleForRow(row);
    const key = `${participantRole}/${view}`;
    const tile = previousRegistration?.tile || tiles[key] || (tiles[key] = {
      key,
      participantRole,
      view,
      frames: [],
      visualSamples: [],
      previousVisual: null,
      elementsSeen: 0,
      maxOnFrameGapMs: 0,
      lastOnFrameAt: null,
      lastOnMarkerValue: null,
      lastOnFrame: null,
      latest: null
    });
    if (!previousRegistration) tile.elementsSeen += 1;
    const generation = (previousRegistration?.generation || 0) + 1;
    videoTiles.set(video, { tile, stream, generation });
    if (!stream) return;

    if (typeof video.requestVideoFrameCallback !== "function") {
      throw new Error("Chromium does not support requestVideoFrameCallback for camera quality checks");
    }
    const onVideoFrame = (at, metadata) => {
      const registration = videoTiles.get(video);
      if (!capture.active || !video.isConnected || registration?.generation !== generation) return;
      const currentRow = video.closest("li[data-participant-id]");
      if (!currentRow) return;
      const currentRole = roleForRow(currentRow);
      const cameraState = currentRow.dataset.camera || "unknown";
      const marker = decodeMarker(video, currentRole);
      const frameReady = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 && video.videoHeight > 0;
      const visible = video.getClientRects().length > 0 && !currentRow.hidden &&
        getComputedStyle(video).visibility !== "hidden";
      if (frameReady && visible) sampleVisual(video, tile, at, cameraState);
      const sample = {
        at,
        mediaTime: Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : null,
        presentedFrames: Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : null,
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
        sourceVideoTracks: (video.srcObject?.getVideoTracks?.() || []).map((track) => ({
          id: track.id,
          readyState: track.readyState,
          enabled: track.enabled
        })),
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState,
        frameReady,
        paused: video.paused,
        visible,
        cameraState,
        markerValid: marker.valid,
        markerAgeMs: marker.ageMs,
        markerValue: marker.marker,
        markerRoleMatches: marker.roleMatches
      };
      tile.frames.push(sample);
      tile.latest = sample;

      if (cameraState === "on") {
        if (tile.lastOnFrameAt !== null) {
          tile.maxOnFrameGapMs = Math.max(tile.maxOnFrameGapMs, at - tile.lastOnFrameAt);
        }
        tile.lastOnFrameAt = at;
        if (marker.valid && Number.isFinite(marker.marker)) tile.lastOnMarkerValue = marker.marker;
        if (frameReady && !video.paused) {
          tile.lastOnFrame = {
            at,
            mediaTime: sample.mediaTime,
            presentedFrames: sample.presentedFrames
          };
        }
      } else {
        tile.lastOnFrameAt = null;
      }

      let pendingResume;
      for (let index = resumeEvents.length - 1; index >= 0; index -= 1) {
        const candidate = resumeEvents[index];
        const hasBaseline = requireMarkers
          ? Number.isFinite(candidate.baselineMarkers?.[tile.key])
          : Boolean(candidate.baselineFrames?.[tile.key]);
        const resumeStillActive = candidate.endAt === null || at <= candidate.endAt;
        if (candidate.role === currentRole && cameraState === "on" && at >= candidate.at && resumeStillActive &&
            !candidate.firstFrames[tile.key] && hasBaseline) {
          pendingResume = candidate;
          break;
        }
      }
      if (pendingResume) {
        const resume = pendingResume;
        if (requireMarkers) {
          const baselineMarkerValue = resume.baselineMarkers[tile.key];
          if (Number.isFinite(baselineMarkerValue) && marker.valid && Number.isFinite(marker.ageMs) &&
              marker.ageMs >= -250 && marker.ageMs <= 1000 && marker.marker !== baselineMarkerValue) {
            resume.firstFrames[tile.key] = {
              key: tile.key,
              at,
              latencyMs: at - resume.at,
              markerValid: marker.valid,
              markerAgeMs: marker.ageMs,
              markerRoleMatches: marker.roleMatches,
              markerValue: marker.marker,
              baselineMarkerValue,
              markerAdvanced: marker.marker !== baselineMarkerValue,
              mediaTime: sample.mediaTime,
              sourceVideoTracks: sample.sourceVideoTracks
            };
          }
        } else if (sample.frameReady && sample.visible && !sample.paused) {
          const baselineFrame = resume.baselineFrames?.[tile.key];
          const pendingFrame = resume.pendingFrames?.[tile.key];
          const advances = (next, previous) =>
            (Number.isFinite(next?.presentedFrames) && Number.isFinite(previous?.presentedFrames) &&
              next.presentedFrames > previous.presentedFrames) ||
            (Number.isFinite(next?.mediaTime) && Number.isFinite(previous?.mediaTime) &&
              next.mediaTime > previous.mediaTime + 0.001);
          let firstFrame;
          if (advances(sample, baselineFrame)) firstFrame = sample;
          else if (pendingFrame && advances(sample, pendingFrame)) firstFrame = pendingFrame;

          if (firstFrame) {
            resume.firstFrames[tile.key] = {
              key: tile.key,
              at: firstFrame.at,
              latencyMs: firstFrame.at - resume.at,
              confirmationLatencyMs: at - resume.at,
              frameAdvanced: true,
              frameReady: firstFrame.frameReady,
              visible: firstFrame.visible,
              paused: firstFrame.paused,
              width: firstFrame.width,
              height: firstFrame.height,
              readyState: firstFrame.readyState,
              mediaTime: firstFrame.mediaTime,
              presentedFrames: firstFrame.presentedFrames,
              baselineMediaTime: baselineFrame?.mediaTime ?? null,
              baselinePresentedFrames: baselineFrame?.presentedFrames ?? null,
              sourceVideoTracks: firstFrame.sourceVideoTracks
            };
          } else if (!pendingFrame) {
            resume.pendingFrames[tile.key] = sample;
          }
        }
      }

      if (capture.active && video.isConnected) video.requestVideoFrameCallback(onVideoFrame);
    };
    video.requestVideoFrameCallback(onVideoFrame);
  }

  function scan() {
    for (const row of document.querySelectorAll("#participants li[data-participant-id]")) recordState(row);
    for (const video of document.querySelectorAll(
      "#participants li.is-local video.camera-video, #participants video[data-media-role='camera']")) {
      ensureVideo(video);
      const registration = videoTiles.get(video);
      const row = video.closest("li[data-participant-id]");
      const frameReady = video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        video.videoWidth > 0 && video.videoHeight > 0;
      const visible = video.getClientRects().length > 0 && !row?.hidden &&
        getComputedStyle(video).visibility !== "hidden";
      if (registration && row && frameReady && visible) {
        sampleVisual(video, registration.tile, performance.now(), row.dataset.camera || "unknown");
      }
    }
  }

  function snapshot() {
    const endedAt = capture.endedAt ?? performance.now();
    const stableStart = capture.stableStartedAt;
    const slope = (points, key) => {
      if (points.length < 3) return null;
      const firstAt = points[0].at;
      const xs = points.map((point) => (point.at - firstAt) / 1000);
      const ys = points.map((point) => point[key]);
      const meanX = xs.reduce((sum, value) => sum + value, 0) / xs.length;
      const meanY = ys.reduce((sum, value) => sum + value, 0) / ys.length;
      let numerator = 0;
      let denominator = 0;
      for (let index = 0; index < xs.length; index += 1) {
        numerator += (xs[index] - meanX) * (ys[index] - meanY);
        denominator += (xs[index] - meanX) ** 2;
      }
      return denominator > 0 ? numerator / denominator : null;
    };
    const rollingRates = (points, key, scale = 1) => {
      if (stableStart === null || endedAt - stableStart < rateWindowMs) return [];
      const rates = [];
      for (let startAt = stableStart; startAt + rateWindowMs <= endedAt; startAt += rateWindowStepMs) {
        const endAt = startAt + rateWindowMs;
        const windowPoints = points.filter((point) => point.at >= startAt && point.at <= endAt);
        const rate = slope(windowPoints, key);
        if (Number.isFinite(rate)) rates.push({ startAt, endAt, rate: rate * scale });
      }
      return rates;
    };
    const gap = (samples) => {
      let maximum = 0;
      for (let index = 1; index < samples.length; index += 1) {
        maximum = Math.max(maximum, samples[index].at - samples[index - 1].at);
      }
      return maximum;
    };

    const tileReports = Object.values(tiles).map((tile) => {
      const stableFrames = stableStart === null
        ? []
        : tile.frames.filter((frame) => frame.at >= stableStart && frame.at <= endedAt && frame.cameraState === "on" &&
          (requireMarkers || (frame.frameReady && frame.visible && !frame.paused)));
      const stableLeadingFrameGapMs = stableStart === null || !stableFrames.length
        ? Infinity
        : Math.max(0, stableFrames[0].at - stableStart);
      const stableTrailingFrameGapMs = stableFrames.length
        ? Math.max(0, endedAt - stableFrames[stableFrames.length - 1].at)
        : Infinity;
      const summarizeVisual = (samples, startAt = samples[0]?.at) => {
        const comparisons = samples.filter((sample) => Number.isFinite(sample.changedPixelFraction));
        const changed = comparisons.filter((sample) => sample.changedPixelFraction >= 0.01);
        const meaningfulMotion = comparisons.filter((sample) =>
          sample.changedPixelFraction >= 0.05 && sample.meanLumaDelta >= 1);
        const firstChange = changed[0];
        const firstMeaningfulMotion = meaningfulMotion[0];
        return {
          sampleCount: samples.length,
          comparisonCount: comparisons.length,
          changedSampleCount: changed.length,
          changedSampleFraction: comparisons.length ? changed.length / comparisons.length : 0,
          firstChangeMs: firstChange && Number.isFinite(startAt) ? Math.round(firstChange.at - startAt) : null,
          meaningfulMotionSampleCount: meaningfulMotion.length,
          firstMeaningfulChangeMs: firstMeaningfulMotion && Number.isFinite(startAt)
            ? Math.round(firstMeaningfulMotion.at - startAt)
            : null,
          maxChangedPixelFraction: comparisons.length
            ? Math.max(...comparisons.map((sample) => sample.changedPixelFraction))
            : null,
          maxMeanLumaDelta: comparisons.length
            ? Math.max(...comparisons.map((sample) => sample.meanLumaDelta))
            : null
        };
      };
      const stableVisualSamples = tile.visualSamples.filter((sample) => stableStart !== null &&
        sample.at >= stableStart && sample.at <= endedAt && sample.cameraState === "on");
      const visual = summarizeVisual(stableVisualSamples, stableStart);
      const firstCameraOff = stateEvents.find((event) => event.role === tile.participantRole &&
        event.previous === "on" && event.current === "off");
      const baselineVisualSamples = tile.visualSamples.filter((sample) => sample.cameraState === "on" &&
        (!firstCameraOff || sample.at < firstCameraOff.at));
      const baselineVisual = summarizeVisual(baselineVisualSamples, capture.startedAt);
      const resumeVisual = resumeEvents.filter((resume) => resume.role === tile.participantRole).map((resume) => {
        const windowEndAt = Math.min(resume.at + 1000, resume.endAt ?? Infinity);
        const samples = tile.visualSamples.filter((sample) => sample.at >= resume.at && sample.at <= windowEndAt);
        const frames = tile.frames.filter((frame) => frame.at >= resume.at && frame.at <= windowEndAt &&
          frame.cameraState === "on");
        let previousAt = resume.at;
        const frameGaps = frames.map((frame) => {
          const frameGap = frame.at - previousAt;
          previousAt = frame.at;
          return frameGap;
        });
        frameGaps.push(Math.max(0, windowEndAt - previousAt));
        const firstFrame = frames[0];
        const lastFrame = frames.at(-1);
        return {
          windowMs: windowEndAt - resume.at,
          ...summarizeVisual(samples, resume.at),
          frameCount: frames.length,
          firstFrameMs: firstFrame ? Math.round(firstFrame.at - resume.at) : null,
          maxFrameGapMs: frames.length ? Math.max(...frameGaps) : null,
          mediaTimeAdvanceSeconds: Number.isFinite(firstFrame?.mediaTime) && Number.isFinite(lastFrame?.mediaTime)
            ? lastFrame.mediaTime - firstFrame.mediaTime
            : null,
          presentedFrameAdvance: Number.isFinite(firstFrame?.presentedFrames) && Number.isFinite(lastFrame?.presentedFrames)
            ? lastFrame.presentedFrames - firstFrame.presentedFrames
            : null,
          ...(includeFrameObservations ? {
            frameObservations: frames.map((frame) => ({
              atMs: Math.round(frame.at - resume.at),
              mediaTime: frame.mediaTime,
              presentedFrames: frame.presentedFrames,
              currentTime: frame.currentTime,
              width: frame.width,
              height: frame.height,
              readyState: frame.readyState,
              paused: frame.paused,
              visible: frame.visible,
              sourceVideoTracks: frame.sourceVideoTracks
            })),
            visualObservations: samples.map((sample) => ({
              atMs: Math.round(sample.at - resume.at),
              identical: sample.identical,
              changedPixelFraction: sample.changedPixelFraction,
              meanLumaDelta: sample.meanLumaDelta
            }))
          } : {})
        };
      });
      const stableValidMarkers = stableFrames.filter((frame) => frame.markerValid && Number.isFinite(frame.markerAgeMs));
      const markerPoints = stableValidMarkers.map((frame) => ({ at: frame.at, markerValue: frame.markerValue }));
      let markerOffset = 0;
      let previousMarker = null;
      const unwrappedMarkers = markerPoints.map((point) => {
        if (previousMarker !== null) {
          const difference = point.markerValue - previousMarker;
          if (difference < -(markerModulo / 2)) markerOffset += markerModulo;
          else if (difference > markerModulo / 2) markerOffset -= markerModulo;
        }
        previousMarker = point.markerValue;
        return { at: point.at, unwrappedMarker: point.markerValue + markerOffset };
      });
      const mediaPoints = stableFrames.filter((frame) => Number.isFinite(frame.mediaTime));
      const ageValues = stableValidMarkers.map((frame) => frame.markerAgeMs);
      const markerValues = new Set(stableValidMarkers.map((frame) => frame.markerValue));
      const markerRateMsPerSecond = slope(unwrappedMarkers, "unwrappedMarker");
      const playbackRateWindows = rollingRates(mediaPoints, "mediaTime");
      const sourceRateWindows = rollingRates(unwrappedMarkers, "unwrappedMarker", 1 / 1000);
      return {
        key: tile.key,
        participantRole: tile.participantRole,
        view: tile.view,
        elementsSeen: tile.elementsSeen,
        frameCount: tile.frames.length,
        maxOnFrameGapMs: tile.maxOnFrameGapMs,
        latest: tile.latest,
        stableFrameCount: stableFrames.length,
        stableMaxFrameGapMs: Math.max(gap(stableFrames), stableLeadingFrameGapMs, stableTrailingFrameGapMs),
        stableLeadingFrameGapMs,
        stableTrailingFrameGapMs,
        stableMarkerValidFraction: stableFrames.length ? stableValidMarkers.length / stableFrames.length : 0,
        stableMarkerCount: stableValidMarkers.length,
        stableUniqueMarkerCount: markerValues.size,
        baselineVisual,
        visual,
        resumeVisual,
        stableMaxMarkerAgeMs: ageValues.length ? Math.max(...ageValues) : null,
        stableMinMarkerAgeMs: ageValues.length ? Math.min(...ageValues) : null,
        playbackRate: slope(mediaPoints, "mediaTime"),
        sourceRate: markerRateMsPerSecond === null ? null : markerRateMsPerSecond / 1000,
        rateWindowMs,
        playbackRateWindows,
        sourceRateWindows,
        frameObservations: includeFrameObservations ? stableFrames.map((frame) => ({
          atMs: Math.round(frame.at - stableStart),
          mediaTime: frame.mediaTime,
          presentedFrames: frame.presentedFrames,
          currentTime: frame.currentTime,
          width: frame.width,
          height: frame.height,
          readyState: frame.readyState,
          paused: frame.paused,
          visible: frame.visible
        })) : undefined
      };
    });

    return {
      label: capture.label,
      pageRole,
      elapsedMs: endedAt - capture.startedAt,
      stableWindowMs: stableStart === null ? 0 : endedAt - stableStart,
      maxHeartbeatGapMs: capture.maxHeartbeatGapMs,
      heartbeatGapsOver250Ms: capture.heartbeatGaps.filter((gapMs) => gapMs > 250).slice(-20),
      stateEvents: [...stateEvents],
      finalStates: { ...roleStates },
      resumeEvents: [...resumeEvents],
      tiles: tileReports
    };
  }

  let previousHeartbeatAt = performance.now();
  capture.timer = setInterval(() => {
    const now = performance.now();
    const heartbeatGap = now - previousHeartbeatAt;
    capture.maxHeartbeatGapMs = Math.max(capture.maxHeartbeatGapMs, heartbeatGap);
    if (heartbeatGap > 250) capture.heartbeatGaps.push(heartbeatGap);
    previousHeartbeatAt = now;
    scan();
  }, 50);
  capture.observer = new MutationObserver(() => scan());
  capture.observer.observe(document.querySelector("#participants") || document.body, {
    attributes: true,
    attributeFilter: ["data-camera"],
    childList: true,
    subtree: true
  });
  capture.snapshot = snapshot;
  capture.baselineReadiness = (roles) => roles.map((role) => {
    const view = role === pageRole ? "local" : "remote";
    const tile = tiles[`${role}/${view}`];
    const latest = tile?.latest;
    const markerAgeMs = latest?.markerAgeMs;
    const frameReady = latest?.frameReady && latest.visible && !latest.paused &&
      latest.width > 0 && latest.height > 0;
    return {
      role,
      view,
      ready: requireMarkers
        ? roleStates[role] === "on" && Number.isFinite(tile?.lastOnMarkerValue) &&
          latest?.cameraState === "on" && latest.markerValid && latest.markerRoleMatches &&
          Number.isFinite(markerAgeMs) && markerAgeMs >= -250 && markerAgeMs <= 1000 &&
          performance.now() - latest.at <= 500
        : roleStates[role] === "on" && latest?.cameraState === "on" && frameReady &&
          Number.isFinite(latest.mediaTime) && performance.now() - latest.at <= 500,
      marker: tile?.lastOnMarkerValue ?? null,
      latestAt: latest?.at ?? null,
      markerAgeMs: Number.isFinite(markerAgeMs) ? markerAgeMs : null,
      frameReady: Boolean(frameReady),
      mediaTime: Number.isFinite(latest?.mediaTime) ? latest.mediaTime : null,
      presentedFrames: Number.isFinite(latest?.presentedFrames) ? latest.presentedFrames : null
    };
  });
  capture.markStableStart = () => { capture.stableStartedAt = performance.now(); };
  capture.finish = () => {
    scan();
    capture.endedAt = performance.now();
    capture.lastSummary = snapshot();
    return capture.lastSummary;
  };
  capture.stop = () => {
    capture.active = false;
    clearInterval(capture.timer);
    capture.observer.disconnect();
  };
  scan();
  test.cameraQualityCapture = capture;
}

function validateCameraQualityReports(reports, {
  label,
  toggledRoles,
  liveRoles,
  expectedResumeCycles = 1,
  maxHeartbeatGapMs = 500,
  maxFrameGapMs = 500,
  maxMarkerAgeMs = 1000,
  maxResumeFrameMs = 1000,
  allowAdditionalResumeCycles = false,
  minPlaybackRate = 0.9,
  maxPlaybackRate = 1.1,
  requireMarkers = true,
  requireVisualMotion = false
}) {
  assert.equal(reports.length, 2, `${label}: quality capture must include both Chromium pages`);
  const fail = (message, extra) => {
    throw new Error(`${label}: ${message}; camera quality report=${JSON.stringify(extra)}`);
  };
  if (requireVisualMotion) {
    const evidence = reports.map((report) => ({
      pageRole: report.pageRole,
      maxHeartbeatGapMs: report.maxHeartbeatGapMs,
      cameras: [...new Set([...toggledRoles, ...liveRoles])].map((role) => {
        const view = report.pageRole === role ? "local" : "remote";
        const tile = report.tiles.find((entry) => entry.key === `${role}/${view}`);
        return {
          key: tile?.key,
          stableFrames: tile?.stableFrameCount,
          maxFrameGapMs: tile?.stableMaxFrameGapMs,
          playbackRate: tile?.playbackRate,
          resumeFrames: report.resumeEvents.filter((event) => event.role === role).map((event) =>
            event.firstFrames?.[`${role}/${view}`] || null),
          baselineMotion: tile?.baselineVisual?.meaningfulMotionSampleCount,
          resumeMotion: tile?.resumeVisual?.map((visual) => ({
            samples: visual.sampleCount,
            meaningfulSamples: visual.meaningfulMotionSampleCount,
            firstMeaningfulChangeMs: visual.firstMeaningfulChangeMs,
            frameCount: visual.frameCount,
            firstFrameMs: visual.firstFrameMs,
            maxFrameGapMs: visual.maxFrameGapMs,
            mediaTimeAdvanceSeconds: visual.mediaTimeAdvanceSeconds,
            presentedFrameAdvance: visual.presentedFrameAdvance
          }))
        };
      })
    }));
    console.log(`[real-camera quality evidence] ${JSON.stringify(evidence)}`);
  }
  for (const report of reports) {
    if (report.maxHeartbeatGapMs > maxHeartbeatGapMs) {
      fail(`page ${report.pageRole} heartbeat gap ${report.maxHeartbeatGapMs.toFixed(1)}ms exceeds ${maxHeartbeatGapMs}ms`, report);
    }
    for (const role of liveRoles) {
      if (report.finalStates[role] !== "on" || report.stateEvents.some((event) =>
        event.role === role && event.current === "off")) {
        fail(`${report.pageRole} did not keep live camera ${role} on throughout the transition`, report.stateEvents);
      }
    }
    for (const role of toggledRoles) {
      const observedResumes = report.resumeEvents.filter((event) => event.role === role);
      if (allowAdditionalResumeCycles
        ? observedResumes.length < expectedResumeCycles
        : observedResumes.length !== expectedResumeCycles) {
        const requirement = allowAdditionalResumeCycles
          ? `at least ${expectedResumeCycles}`
          : `exactly ${expectedResumeCycles}`;
        fail(`${report.pageRole} observed ${observedResumes.length} resumes for ${role}; expected ${requirement}`, report.stateEvents);
      }
      const expectedView = report.pageRole === role ? "local" : "remote";
      const deliveredResumes = observedResumes.filter((resume) => resume.firstFrames?.[`${role}/${expectedView}`]);
      if (allowAdditionalResumeCycles && deliveredResumes.length < expectedResumeCycles) {
        fail(`${report.pageRole} observed only ${deliveredResumes.length} delivered resumes for ${role}; expected at least ${expectedResumeCycles}`, {
          observedResumes,
          deliveredResumes
        });
      }
      if (!allowAdditionalResumeCycles && deliveredResumes.length !== observedResumes.length) {
        fail(`${report.pageRole} did not observe a fresh resumed frame for every ${role} resume`, observedResumes);
      }
      const resumesToValidate = allowAdditionalResumeCycles ? deliveredResumes : observedResumes;
      for (const resume of resumesToValidate) {
        const firstFrame = resume.firstFrames?.[`${role}/${expectedView}`];
        if (requireMarkers) {
          if (!firstFrame || firstFrame.latencyMs > maxResumeFrameMs || !firstFrame.markerAdvanced || !firstFrame.markerValid ||
              firstFrame.markerAgeMs === null || firstFrame.markerAgeMs < -250 ||
              firstFrame.markerAgeMs > maxMarkerAgeMs || !firstFrame.markerRoleMatches) {
            fail(`${report.pageRole} ${role}/${expectedView} did not show a fresh, advancing, correctly routed frame within ${maxResumeFrameMs}ms`, {
              resume,
              limits: { maxResumeFrameMs, maxMarkerAgeMs }
            });
          }
        } else if (!firstFrame || firstFrame.latencyMs > maxResumeFrameMs ||
            firstFrame.confirmationLatencyMs > maxResumeFrameMs || !firstFrame.frameAdvanced || !firstFrame.frameReady ||
            !firstFrame.visible || firstFrame.paused || firstFrame.width <= 0 || firstFrame.height <= 0) {
          fail(`${report.pageRole} ${role}/${expectedView} did not present a visible camera frame within ${maxResumeFrameMs}ms`, {
            resume,
            limits: { maxResumeFrameMs }
          });
        }
      }
      if (requireVisualMotion) {
        const tile = report.tiles.find((entry) => entry.key === `${role}/${expectedView}`);
        const baselineVisual = tile?.baselineVisual;
        if (!Number.isFinite(baselineVisual?.sampleCount) || baselineVisual.sampleCount < 5 ||
            !Number.isFinite(baselineVisual.meaningfulMotionSampleCount) ||
            baselineVisual.meaningfulMotionSampleCount < 2) {
          fail(`${report.pageRole} ${role}/${expectedView} baseline picture did not show moving content before the toggle`, {
            baselineVisual,
            stimulus: "Aim the camera at a changing scene or move in front of it during the test."
          });
        }
        for (const resume of resumesToValidate) {
          const resumeIndex = observedResumes.indexOf(resume);
          const visual = tile.resumeVisual?.[resumeIndex];
          if (!Number.isFinite(visual?.sampleCount) || visual.sampleCount < 5 ||
              !Number.isFinite(visual.meaningfulMotionSampleCount) || visual.meaningfulMotionSampleCount < 2 ||
              !Number.isFinite(visual.firstMeaningfulChangeMs) || visual.firstMeaningfulChangeMs > maxResumeFrameMs ||
              !Number.isFinite(visual.frameCount) || visual.frameCount < 5 ||
              !Number.isFinite(visual.maxFrameGapMs) || visual.maxFrameGapMs > maxFrameGapMs) {
            fail(`${report.pageRole} ${role}/${expectedView} resumed frames did not show moving picture content within ${maxResumeFrameMs}ms`, {
              visual,
              limits: { maxResumeFrameMs, maxFrameGapMs, minimumMeaningfulMotionSamples: 2, minimumResumeFrames: 5 },
              stimulus: "Sweep a bright, high-contrast object across the physical camera view continuously, including the first second after resume."
            });
          }
        }
      }
    }
  }

  const tiles = reports.flatMap((report) => report.tiles);
  const summaryTiles = [];
  for (const role of ["A", "B"]) {
    for (const view of ["local", "remote"]) {
      const matches = tiles.filter((tile) => tile.participantRole === role && tile.view === view);
      if (matches.length !== 1) fail(`expected exactly one ${role}/${view} camera view across the two browsers`, matches);
      const tile = matches[0];
      const latest = tile.latest;
      const evidence = {
        key: tile.key,
        role,
        view,
        elementsSeen: tile.elementsSeen,
        stableFrameCount: tile.stableFrameCount,
        stableMaxFrameGapMs: tile.stableMaxFrameGapMs,
        stableLeadingFrameGapMs: tile.stableLeadingFrameGapMs,
        stableTrailingFrameGapMs: tile.stableTrailingFrameGapMs,
        maxOnFrameGapMs: tile.maxOnFrameGapMs,
        baselineVisual: tile.baselineVisual,
        visual: tile.visual,
        resumeVisual: tile.resumeVisual,
        ...(tile.frameObservations ? { frameObservations: tile.frameObservations } : {}),
        stableMarkerValidFraction: tile.stableMarkerValidFraction,
        stableMaxMarkerAgeMs: tile.stableMaxMarkerAgeMs,
        playbackRate: tile.playbackRate,
        sourceRate: tile.sourceRate,
        playbackRateWindowRange: rateRange(tile.playbackRateWindows),
        sourceRateWindowRange: rateRange(tile.sourceRateWindows),
        rateWindowCount: requireMarkers
          ? Math.min(tile.playbackRateWindows.length, tile.sourceRateWindows.length)
          : tile.playbackRateWindows.length,
        width: latest?.width,
        height: latest?.height,
        paused: latest?.paused,
        visible: latest?.visible,
        cameraState: latest?.cameraState
      };
      summaryTiles.push(evidence);

      if (!latest || latest.cameraState !== "on" || !latest.visible || latest.paused ||
          latest.width <= 0 || latest.height <= 0) {
        fail(`${role}/${view} camera tile is not visibly playing at the end of the stable window`, evidence);
      }
      if (tile.stableFrameCount < 20) fail(`${role}/${view} had too few decoded frames in the 5s stable window`, evidence);
      if (tile.stableMaxFrameGapMs > maxFrameGapMs || tile.maxOnFrameGapMs > maxFrameGapMs) {
        fail(`${role}/${view} frame gap exceeds ${maxFrameGapMs}ms while the camera is on`, evidence);
      }
      if (requireMarkers && (tile.stableMarkerValidFraction < 0.95 || tile.stableUniqueMarkerCount < 10 ||
          tile.stableMaxMarkerAgeMs === null || tile.stableMinMarkerAgeMs < -250 ||
          tile.stableMaxMarkerAgeMs > maxMarkerAgeMs)) {
        fail(`${role}/${view} time-coded camera frames are stale or could not be decoded`, evidence);
      }
      if (!Number.isFinite(tile.playbackRate) || tile.playbackRate < minPlaybackRate || tile.playbackRate > maxPlaybackRate ||
          (requireMarkers && (!Number.isFinite(tile.sourceRate) || tile.sourceRate < minPlaybackRate ||
            tile.sourceRate > maxPlaybackRate))) {
        fail(`${role}/${view} ${requireMarkers ? "playback/source" : "playback"} rate is outside ${minPlaybackRate}–${maxPlaybackRate}x`, evidence);
      }
      const playbackRateWindows = tile.playbackRateWindows || [];
      const sourceRateWindows = tile.sourceRateWindows || [];
      const rateWindows = requireMarkers ? [...playbackRateWindows, ...sourceRateWindows] : playbackRateWindows;
      const outOfRangeRates = rateWindows.filter(({ rate }) =>
        !Number.isFinite(rate) || rate < minPlaybackRate || rate > maxPlaybackRate);
      if (evidence.rateWindowCount < 10 || outOfRangeRates.length) {
        fail(`${role}/${view} has fewer than 10 valid rolling rate windows or a ${requireMarkers ? "playback/source" : "playback"} rate outside ` +
          `${minPlaybackRate}–${maxPlaybackRate}x in a ${tile.rateWindowMs || 1000}ms window`, {
          ...evidence,
          outOfRangeRates
        });
      }
    }
  }
  return {
    label,
    pages: reports.map((report) => ({
      pageRole: report.pageRole,
      elapsedMs: report.elapsedMs,
      maxHeartbeatGapMs: report.maxHeartbeatGapMs,
      stateEvents: report.stateEvents,
      resumes: report.resumeEvents.map((resume) => ({
        role: resume.role,
        firstFrames: Object.fromEntries(Object.entries(resume.firstFrames).map(([key, frame]) => [key, {
          latencyMs: frame.latencyMs,
          frameReady: frame.frameReady,
          visible: frame.visible,
          paused: frame.paused,
          width: frame.width,
          height: frame.height,
          mediaTime: frame.mediaTime,
          presentedFrames: frame.presentedFrames,
          baselineMediaTime: frame.baselineMediaTime,
          baselinePresentedFrames: frame.baselinePresentedFrames,
          frameAdvanced: frame.frameAdvanced,
          confirmationLatencyMs: frame.confirmationLatencyMs,
          markerAgeMs: frame.markerAgeMs,
          markerAdvanced: frame.markerAdvanced,
          markerRoleMatches: frame.markerRoleMatches
        }]))
      }))
    })),
    tiles: summaryTiles
  };
}

function rateRange(windows = []) {
  const rates = windows.map(({ rate }) => rate).filter(Number.isFinite);
  return rates.length ? { min: Math.min(...rates), max: Math.max(...rates) } : null;
}

module.exports = { installCameraQualityRecorder, validateCameraQualityReports };
