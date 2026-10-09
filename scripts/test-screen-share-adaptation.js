const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createScreenShareAdaptation } = require("../web/js/screen-share-adaptation.js");

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
}

main().then(() => {
  console.log("Screen-share adaptation tests passed");
}).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
