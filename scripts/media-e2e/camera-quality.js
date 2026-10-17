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
          resumeEvents.push({ role: participantRole, at, baselineMarkers, firstFrames: {} });
        }
      } else {
        const baselineFrames = Object.fromEntries(roleTiles.map((tile) => [tile.key, tile.lastOnFrame]));
        if (Object.values(baselineFrames).some(Boolean)) {
          resumeEvents.push({ role: participantRole, at, baselineFrames, pendingFrames: {}, firstFrames: {} });
        }
      }
    }
    if (next !== "on") {
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
      const sample = {
        at,
        mediaTime: Number.isFinite(metadata.mediaTime) ? metadata.mediaTime : null,
        presentedFrames: Number.isFinite(metadata.presentedFrames) ? metadata.presentedFrames : null,
        currentTime: Number.isFinite(video.currentTime) ? video.currentTime : null,
        width: video.videoWidth,
        height: video.videoHeight,
        readyState: video.readyState,
        frameReady,
        paused: video.paused,
        visible: video.getClientRects().length > 0 && !currentRow.hidden &&
          getComputedStyle(video).visibility !== "hidden",
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
        if (candidate.role === currentRole && at >= candidate.at && !candidate.firstFrames[tile.key] && hasBaseline) {
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
              mediaTime: sample.mediaTime
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
              baselinePresentedFrames: baselineFrame?.presentedFrames ?? null
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
      "#participants li.is-local video.camera-video, #participants video[data-media-role='camera']")) ensureVideo(video);
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
  requireMarkers = true
}) {
  assert.equal(reports.length, 2, `${label}: quality capture must include both Chromium pages`);
  const fail = (message, extra) => {
    throw new Error(`${label}: ${message}; camera quality report=${JSON.stringify(extra)}`);
  };

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
