const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const {createConnectionHistory} = require("../web/js/connection-history.js");

const history = createConnectionHistory();
assert.equal(history.get(), null, "history starts empty");
history.start(1000, {connection: "connecting", ice: "checking", participantId: "private-id"});
assert.equal(history.isRecording(), true, "starting enables recording");
history.addTransition("connection", "connected", 1100);
history.addTransition("connection", "connected", 1200);
history.addTransition("ice", "connected", 1300);
history.addSample({
  at: 2000, rttMs: 35, jitterMs: 4, packetLossPct: 0.5,
  inboundVideoKbps: 800, outboundVideoKbps: 600,
  inboundAudioKbps: 48, outboundAudioKbps: 40,
  participantId: "private-id", name: "Private Name"
});
let recording = history.get();
assert.equal(recording.schemaVersion, 1, "recording has a versioned schema");
assert.equal(recording.startedAt, 1000, "recording start timestamp is kept");
assert.deepEqual(recording.stateTransitions.map((event) => [event.state, event.value]), [
  ["connection", "connecting"], ["ice", "checking"],
  ["connection", "connected"], ["ice", "connected"]
], "initial and changed connection states are retained without duplicate transitions");
assert.deepEqual(recording.samples[0], {
  at: 2000, rttMs: 35, jitterMs: 4, packetLossPct: 0.5,
  inboundVideoKbps: 800, outboundVideoKbps: 600,
  inboundAudioKbps: 48, outboundAudioKbps: 40
}, "quality samples retain only approved timestamped metric fields");
history.stop(2500);
history.addSample({at: 3000, rttMs: 20});
assert.equal(history.isRecording(), false, "stopping disables recording");
recording = history.exportJSON();
assert.equal(recording.endedAt, 2500, "recording stop timestamp is kept");
assert.equal(recording.samples.length, 1, "samples after stop are ignored");
assert.equal(JSON.stringify(recording).includes("Private Name"), false, "export excludes participant identity");
assert.equal(JSON.stringify(recording).includes("private-id"), false, "export excludes participant IDs");

const root = path.join(__dirname, "..");
const html = fs.readFileSync(path.join(root, "web/index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
assert.match(html, /id="show-connection-history"[^>]*aria-controls="connection-history"/);
assert.match(html, /id="connection-history-chart"[^>]*role="img"/);
assert.match(html, /id="connection-history-legend"/);
assert.match(html, /<table class="connection-history__table">/);
assert.match(html, /id="ended-show-connection-history"/);
assert.match(app, /function renderConnectionHistory\(\)/, "history has a view renderer");
assert.match(app, /meetingSidebar\.append\(connectionHistoryPanel\)/, "history is revealed inside the scrollable in-meeting sidebar");
assert.match(app, /meetingEnded\.after\(connectionHistoryPanel\)/, "history remains reachable after leaving");
assert.match(app, /function exportRecordedConnectionHistory\(\)/, "history has a JSON download action");
assert.match(app, /connectionHistoryModel\?\.addSample\(/, "one-second diagnostics feed the recording");
assert.ok(/leave\.addEventListener\("click", \(\) => \{\n  connectionHistoryModel\?\.stop\(\);/.test(app), "leaving closes the active recording");

history.clear();
assert.equal(history.get(), null, "clearing for a new meeting removes the previous recording");
console.log("Connection history recording, sampling, lifecycle, display, and export checks passed.");
