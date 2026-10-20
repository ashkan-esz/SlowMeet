"use strict";

const assert = require("node:assert/strict");
const { validateCameraQualityReports } = require("./media-e2e/camera-quality");

function qualityReports({ baselineMoving, resumeMoving, resumeFrameGapMs = 100 }) {
  return ["A", "B"].map((pageRole) => {
    const expectedView = pageRole === "A" ? "local" : "remote";
    const liveRole = "B";
    const frame = {
      latencyMs: 100,
      confirmationLatencyMs: 150,
      frameAdvanced: true,
      frameReady: true,
      visible: true,
      paused: false,
      width: 640,
      height: 480
    };
    const visualSummary = (moving) => ({
      sampleCount: 10,
      comparisonCount: 9,
      changedSampleCount: moving ? 8 : 0,
      changedSampleFraction: moving ? 8 / 9 : 0,
      firstChangeMs: moving ? 100 : null,
      meaningfulMotionSampleCount: moving ? 6 : 0,
      firstMeaningfulChangeMs: moving ? 100 : null,
      maxChangedPixelFraction: moving ? 0.2 : 0,
      maxMeanLumaDelta: moving ? 4 : 0,
      frameCount: 30,
      firstFrameMs: 100,
      maxFrameGapMs: resumeFrameGapMs,
      mediaTimeAdvanceSeconds: 0.9,
      presentedFrameAdvance: 27
    });
    const tiles = [
      { role: "A", view: pageRole === "A" ? "local" : "remote" },
      { role: "B", view: pageRole === "B" ? "local" : "remote" }
    ].map(({ role, view }) => ({
      key: `${role}/${view}`,
      participantRole: role,
      view,
      elementsSeen: 1,
      stableFrameCount: 30,
      stableMaxFrameGapMs: 100,
      stableLeadingFrameGapMs: 50,
      stableTrailingFrameGapMs: 50,
      maxOnFrameGapMs: 100,
      baselineVisual: visualSummary(baselineMoving),
      visual: visualSummary(resumeMoving),
      resumeVisual: role === "A" ? [visualSummary(resumeMoving)] : [],
      stableMarkerValidFraction: 0,
      stableMaxMarkerAgeMs: null,
      playbackRate: 1,
      sourceRate: null,
      playbackRateWindows: Array.from({ length: 10 }, () => ({ rate: 1 })),
      rateWindowMs: 1000,
      latest: { cameraState: "on", visible: true, paused: false, width: 640, height: 480 }
    }));

    return {
      pageRole,
      maxHeartbeatGapMs: 100,
      finalStates: { A: "on", B: "on" },
      stateEvents: [
        { role: "A", previous: null, current: "on", at: 0 },
        { role: "A", previous: "on", current: "off", at: 1000 },
        { role: "A", previous: "off", current: "on", at: 2000 }
      ],
      resumeEvents: [{ role: "A", firstFrames: { [`A/${expectedView}`]: frame } }],
      tiles
    };
  });
}

const commonOptions = {
  label: "pixel-motion quality rule",
  toggledRoles: ["A"],
  liveRoles: ["B"],
  requireMarkers: false,
  requireVisualMotion: true
};

assert.throws(() => validateCameraQualityReports(qualityReports({ baselineMoving: false, resumeMoving: true }), commonOptions),
  /baseline picture did not show moving content/);
assert.throws(() => validateCameraQualityReports(qualityReports({ baselineMoving: true, resumeMoving: false }), commonOptions),
  /resumed frames did not show moving picture content/);
assert.throws(() => validateCameraQualityReports(qualityReports({
  baselineMoving: true,
  resumeMoving: true,
  resumeFrameGapMs: 501
}), commonOptions), /resumed frames did not show moving picture content/);
assert.doesNotThrow(() => validateCameraQualityReports(qualityReports({ baselineMoving: true, resumeMoving: true }), commonOptions));
console.log("[pass] camera quality rejects unstimulated baselines, frozen pictures, and resume frame gaps");
