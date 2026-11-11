const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createScreenShareAdaptation } = require("../web/js/screen-share-adaptation.js");

// A fake sender with controllable outbound-rtp counters. The test moves
// `report` between samples to script the measured bitrate.
function makeSenderHarness() {
  const harness = { parameters: { encodings: [{}] }, report: { bytesSent: 0, timestamp: 0 }, statsReads: 0 };
  harness.sender = {
    getParameters() {
      return structuredClone(harness.parameters);
    },
    async setParameters(next) {
      harness.parameters = next;
    },
    async getStats() {
      harness.statsReads++;
      return new Map([["outbound", {
        type: "outbound-rtp",
        kind: "video",
        bytesSent: harness.report.bytesSent,
        timestamp: harness.report.timestamp
      }]]);
    }
  };
  harness.adaptation = createScreenShareAdaptation(harness.sender);
  return harness;
}

// bitrate over one sampling window in bits per second.
function overWindow(harness, bytes, elapsedMs) {
  return bytes * 8 * 1000 / elapsedMs;
}

async function main() {
  let parameters = { encodings: [{}] };
  let report = { bytesSent: 0, timestamp: 0 };
  const sender = {
    getParameters() {
      return structuredClone(parameters);
    },
    async setParameters(next) {
      parameters = next;
    },
    async getStats() {
      return new Map([["outbound", {
        type: "outbound-rtp",
        kind: "video",
        bytesSent: report.bytesSent,
        timestamp: report.timestamp
      }]]);
    }
  };

  const adaptation = createScreenShareAdaptation(sender);
  const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
  const indexSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
  try {
    assert.match(appSource, /screenShareAdaptation = createScreenShareAdaptation\(screenSender\)/);
    assert.match(appSource, /await applyProfile\(profile\.value, sharePeer, screenStream\)/);
    assert.match(indexSource, /screen-share-adaptation\.js/);
    await adaptation.update(500_000, 30);
    assert.equal(parameters.encodings[0].maxBitrate, 500_000);
    assert.equal(parameters.encodings[0].maxFramerate, 30);
    assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1);
    assert.equal(parameters.degradationPreference, "maintain-resolution");

    await adaptation.sample();
    report = { bytesSent: 400_000, timestamp: 5_000 };
    await adaptation.sample();
    report = { bytesSent: 800_000, timestamp: 10_000 };
    await adaptation.sample();
    assert.equal(adaptation.state().frameRate, 24, "lower frame rate before resolution");
    assert.equal(adaptation.state().resolutionScale, 1);

    await adaptation.update(500_000, 5);
    await adaptation.sample();
    report = { bytesSent: 1_200_000, timestamp: 15_000 };
    await adaptation.sample();
    report = { bytesSent: 1_600_000, timestamp: 20_000 };
    await adaptation.sample();
    assert.equal(adaptation.state().frameRate, 5);
    assert.equal(adaptation.state().resolutionScale, 1.25, "reduce resolution after reaching the minimum frame rate");
    assert.equal(parameters.encodings[0].scaleResolutionDownBy, 1.25);
  } finally {
    adaptation.stop();
  }

  // Recovery: after congestion steps the share down, consecutive within-budget
  // samples must step it back up — frame rate first (×1.25), then resolution
  // — so a transient congestion spike does not degrade a share forever.
  {
    const harness = makeSenderHarness();
    try {
      await harness.adaptation.update(500_000, 30);
      // Baseline sample, then two over-limit windows (>110% of 500 kbps):
      // 500 kB over 1 s = 4 Mbps, then 800 kB over 1 s = 6.4 Mbps.
      await harness.adaptation.sample();
      harness.report = { bytesSent: 500_000, timestamp: 1_000 };
      await harness.adaptation.sample();
      harness.report = { bytesSent: 1_300_000, timestamp: 2_000 };
      await harness.adaptation.sample();
      assert.equal(harness.adaptation.state().frameRate, 24, "congestion stepped the frame rate down");

      // Five within-budget windows (40 kB over 1 s = 320 kbps) must open one
      // recovery step: 24 → ceil(24 × 1.25) = 30.
      for (let step = 0; step < 5; step++) {
        harness.report = {
          bytesSent: 1_300_000 + (step + 1) * 40_000,
          timestamp: 3_000 + (step + 1) * 1_000
        };
        await harness.adaptation.sample();
      }
      assert.equal(harness.adaptation.state().frameRate, 30, "five within-budget samples recovered the frame rate");
      assert.equal(harness.adaptation.state().resolutionScale, 1);
      assert.equal(harness.parameters.encodings[0].maxFramerate, 30);
      assert.equal(harness.parameters.encodings[0].scaleResolutionDownBy, 1);

      // Recovery of a resolution-degraded share must raise the frame rate
      // before shrinking the scale, mirroring the down-step order. Drive the
      // share all the way down: every 800 kbps window is over-limit, so each
      // pair of samples steps once — 7 steps to the 5 fps floor, then one
      // more pair steps the resolution.
      const window = { bytes: 0, timestamp: 10_000 };
      const sampleOverLimit = async () => {
        window.bytes += 100_000;
        window.timestamp += 1_000;
        harness.report = { bytesSent: window.bytes, timestamp: window.timestamp };
        await harness.adaptation.sample();
      };
      const sampleUnderLimit = async () => {
        window.bytes += 40_000;
        window.timestamp += 1_000;
        harness.report = { bytesSent: window.bytes, timestamp: window.timestamp };
        await harness.adaptation.sample();
      };
      for (let i = 0; i < 20 && harness.adaptation.state().resolutionScale < 1.25; i++) {
        await sampleOverLimit();
      }
      assert.equal(harness.adaptation.state().frameRate, 5, "the ladder bottoms out at the 5 fps floor");
      assert.equal(harness.adaptation.state().resolutionScale, 1.25, "resolution stepped down after the frame rate floor");

      for (let step = 0; step < 5; step++) {
        await sampleUnderLimit();
      }
      assert.equal(harness.adaptation.state().frameRate, 7, "frame rate recovered before resolution");
      assert.equal(harness.adaptation.state().resolutionScale, 1.25);
      for (let i = 0; i < 50 && harness.adaptation.state().resolutionScale > 1; i++) {
        await sampleUnderLimit();
      }
      assert.equal(harness.adaptation.state().frameRate, 30, "full frame rate recovered first");
      assert.equal(harness.adaptation.state().resolutionScale, 1, "resolution recovered last");
    } finally {
      harness.adaptation.stop();
    }
  }

  // Budget cuts must seed the frame rate from the last measured bitrate so a
  // degraded share does not overspend the new cap for two sampling windows.
  {
    const harness = makeSenderHarness();
    try {
      await harness.adaptation.update(500_000, 30);
      await harness.adaptation.sample();
      // 100 kB over 1 s = 800 kbps measured.
      harness.report = { bytesSent: 100_000, timestamp: 1_000 };
      await harness.adaptation.sample();

      // Cut to 200 kbps: measured share saturates the cap, so the frame rate
      // seeds at the new maximum rather than staying at 30.
      await harness.adaptation.update(200_000, 15);
      assert.equal(harness.adaptation.state().frameRate, 15, "a saturated budget cut seeds the frame rate at the new cap");
      assert.equal(harness.parameters.encodings[0].maxFramerate, 15);
      assert.equal(harness.parameters.encodings[0].maxBitrate, 200_000);
    } finally {
      harness.adaptation.stop();
    }
  }
  {
    const harness = makeSenderHarness();
    try {
      await harness.adaptation.update(500_000, 30);
      await harness.adaptation.sample();
      // 50 kB over 4 s = 100 kbps measured: well under the new 200 kbps cap.
      harness.report = { bytesSent: 50_000, timestamp: 4_000 };
      await harness.adaptation.sample();
      await harness.adaptation.update(200_000, 15);
      // ceil(15 × 100/200) = 8, floored at the 5 fps minimum by the ladder.
      assert.equal(harness.adaptation.state().frameRate, 8, "a cut below the measured bitrate seeds proportionally");
    } finally {
      harness.adaptation.stop();
    }
  }

  // A same-budget update (profile or config refresh) must keep the learned
  // adaptation instead of resetting the share to full quality.
  {
    const harness = makeSenderHarness();
    try {
      await harness.adaptation.update(500_000, 30);
      await harness.adaptation.sample();
      harness.report = { bytesSent: 500_000, timestamp: 1_000 };
      await harness.adaptation.sample();
      harness.report = { bytesSent: 1_300_000, timestamp: 2_000 };
      await harness.adaptation.sample();
      assert.equal(harness.adaptation.state().frameRate, 24);

      await harness.adaptation.update(500_000, 30);
      assert.equal(harness.adaptation.state().frameRate, 24, "a same-budget refresh keeps the learned frame rate");
      assert.equal(harness.parameters.encodings[0].maxFramerate, 24, "the learned frame rate is reapplied to the sender");
    } finally {
      harness.adaptation.stop();
    }
  }

  // An in-flight sample from before an update belongs to the old generation
  // and must not feed the new generation's counters.
  {
    let statsProvider = () => Promise.resolve(new Map());
    const parameters = { encodings: [{}] };
    const sender = {
      getParameters() {
        return structuredClone(parameters);
      },
      async setParameters(next) {
        parameters = next;
      },
      getStats() {
        return statsProvider();
      }
    };
    const adaptation = createScreenShareAdaptation(sender);
    try {
      await adaptation.update(600_000, 30);
      const outbound = (bytesSent, timestamp) => new Map([["outbound", {
        type: "outbound-rtp", kind: "video", bytesSent, timestamp
      }]]);
      statsProvider = () => Promise.resolve(outbound(0, 0));
      await adaptation.sample(); // baseline: previous window recorded

      // Park a sample inside getStats, then move the sampler to a new
      // generation before releasing it with a stale over-limit delta.
      let releaseStats;
      statsProvider = () => new Promise((resolve) => { releaseStats = resolve; });
      const parked = adaptation.sample();
      await adaptation.update(600_000, 30);
      releaseStats(outbound(10_000_000, 1_000));
      await parked;

      // With the guard working, the stale sample left nothing behind — and
      // the same-budget update cleared the baseline — so the first live
      // window re-baselines and two more over-limit windows are needed. A
      // broken guard would leak the stale delta in and step down one window
      // early.
      statsProvider = () => Promise.resolve(outbound(20_000_000, 2_000));
      await adaptation.sample();
      statsProvider = () => Promise.resolve(outbound(30_000_000, 3_000));
      await adaptation.sample();
      assert.equal(adaptation.state().frameRate, 30, "the stale generation's sample did not leak into the counters");
      statsProvider = () => Promise.resolve(outbound(40_000_000, 4_000));
      await adaptation.sample();
      assert.equal(adaptation.state().frameRate, 24, "two evaluated over-limit windows step down exactly once");
      assert.equal(adaptation.state().resolutionScale, 1);
    } finally {
      adaptation.stop();
    }
  }

  // stop() must silence the sampler: no further stats reads or writes.
  {
    const harness = makeSenderHarness();
    await harness.adaptation.update(500_000, 30);
    const readsAtStop = harness.statsReads;
    harness.adaptation.stop();
    harness.report = { bytesSent: 10_000_000, timestamp: 60_000 };
    await harness.adaptation.sample();
    assert.equal(harness.statsReads, readsAtStop, "sample after stop must not read stats");
    assert.equal(harness.adaptation.state().frameRate, 30, "stop freezes the learned state");
    await harness.adaptation.update(400_000, 20);
    assert.equal(harness.adaptation.state().maxFrameRate, 30, "update after stop is ignored");
    assert.equal(harness.parameters.encodings[0].maxBitrate, 500_000, "update after stop does not touch the sender");
  }

  console.log("Screen-share adaptation tests passed");
}

main().then(() => {
  console.log("Screen-share adaptation tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
