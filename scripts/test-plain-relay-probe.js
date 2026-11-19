const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  probe, guard, passTtlMs, failTtlMs, evaluateProbe, encodeVerdict, freshVerdict, createSuspensionGuard
} = require("../web/js/plain-relay-probe.js");

// A probe run: one sample per packet interval; echoFor(sentAtMs) gives the
// echo delay in ms, or null for a lost packet.
function run(echoFor, durationMs = probe.durationMs) {
  const samples = [];
  for (let sentAtMs = 0; sentAtMs < durationMs; sentAtMs += probe.packetIntervalMs) {
    samples.push({sentAtMs, echoMs: echoFor(sentAtMs)});
  }
  return samples;
}

assert.ok(probe.judgeFromMs > 20000 && probe.durationMs - probe.judgeFromMs >= 10000,
  "the judged window must lie past the ~20 s degradation point and be long enough to see it");
assert.ok(probe.packetBytes * 8 * (1000 / probe.packetIntervalMs) <= 100000,
  "the probe must stay cheap next to a call (at most 100 kbps)");

assert.equal(evaluateProbe(run(() => 80)), "pass", "a steady echo stream passes");
assert.equal(evaluateProbe(run((t) => (t < 20000 ? 2000 : 80))), "pass",
  "trouble before the judged window (e.g. connection setup) does not fail the path");
assert.equal(evaluateProbe(run((t) => (t >= 30000 && t < 30100 ? 1500 : 80))), "fail",
  "a single multi-hundred-ms stall in the judged window is the degradation signature");
assert.equal(evaluateProbe(run((t) => (t >= 26000 && t % 400 === 0 ? null : 80))), "fail",
  "sustained loss in the judged window fails (5% here)");
assert.equal(evaluateProbe(run((t) => (t === 30000 ? null : 80))), "pass", "one stray lost packet is tolerated");
assert.equal(evaluateProbe(run((t) => (t >= 25000 ? null : 80))), "fail", "a flow that goes dead fails");
assert.equal(evaluateProbe(run(() => 80, 26000)), "inconclusive",
  "a probe cut short (or timer-throttled in a hidden tab) must not produce a verdict");
assert.equal(evaluateProbe([]), "inconclusive");
assert.equal(evaluateProbe(null), "inconclusive");

// Remembered verdicts.
const now = 1800000000000;
assert.equal(encodeVerdict("pass", now), `pass:${now}`);
assert.equal(encodeVerdict("fail", now + 0.4), `fail:${now}`);
assert.equal(encodeVerdict("inconclusive", now), "", "only real verdicts are stored");
assert.equal(freshVerdict(`pass:${now}`, now + passTtlMs), "pass");
assert.equal(freshVerdict(`pass:${now}`, now + passTtlMs + 1), null, "a pass expires so the path is re-tested");
assert.equal(freshVerdict(`fail:${now}`, now + failTtlMs), "fail");
assert.equal(freshVerdict(`fail:${now}`, now + failTtlMs + 1), null);
assert.ok(failTtlMs > passTtlMs, "a failed path is retried less often than a passing one is re-checked");
assert.equal(freshVerdict(`pass:${now + 5000}`, now), null, "a timestamp from the future is not trusted");
for (const garbage of [null, undefined, "", "pass", "pass:", "pass:abc", "maybe:123", "fail:-5", 42, {}]) {
  assert.equal(freshVerdict(garbage, now), null, `garbage ${JSON.stringify(garbage)} is unknown`);
}
assert.equal(freshVerdict(`pass:${now}`, NaN), null);

// Suspension guard: slowSamples slow round trips within windowSamples resume rotation.
{
  const suspension = createSuspensionGuard();
  for (let i = 0; i < 50; i++) assert.equal(suspension.observe(90), false, "a healthy path never trips");
  assert.equal(suspension.observe(guard.slowRttMs + 1), false);
  assert.equal(suspension.observe(90), false);
  assert.equal(suspension.observe(guard.slowRttMs + 400), false);
  assert.equal(suspension.observe(null), false, "a missing sample is ignored, not counted as healthy or slow");
  assert.equal(suspension.observe(guard.slowRttMs + 900), true, "the third slow sample in the window trips");
  suspension.reset();
  assert.equal(suspension.observe(guard.slowRttMs + 900), false, "reset forgets earlier samples");
}
{
  const suspension = createSuspensionGuard();
  let tripped = false;
  for (let i = 0; i < 40; i++) tripped = suspension.observe(i % guard.windowSamples === 0 ? 2000 : 90) || tripped;
  assert.equal(tripped, false, "isolated spikes spread across windows do not trip");
  assert.equal(suspension.observe(guard.slowRttMs), false, "exactly the threshold is not slow");
}

// Wiring in the app.
const index = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
assert.ok(index.indexOf('src="/js/plain-relay-probe.js"') > 0 &&
  index.indexOf('src="/js/plain-relay-probe.js"') < index.indexOf('src="/js/app.js"'),
  "plain-relay-probe.js must load before app.js");
const app = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const manage = app.slice(app.indexOf("function managePlainRelayProbe("), app.indexOf("function startPlainRelayProbe("));
assert.match(manage, /if \(!plainRelayProbe \|\| !wanted \|\| connectionMethod !== "auto"\) \{/,
  "only Automatic second-guesses rotation; an explicit rotating choice always rotates");
assert.match(manage, /if \(plainRelayGuard\.observe\(rttMs\)\) \{[\s\S]*?plainRelaySuspended = false;[\s\S]*?encodeVerdict\("fail", nowMs\)[\s\S]*?relayRotation\.expedite\(nowMs\);/,
  "a degrading plain relay resumes rotation at once and is remembered as failed");
assert.match(manage, /document\.hidden/, "the probe does not start in a hidden tab (timers are throttled there)");
assert.match(manage, /if \(remembered === "fail"\) return;/, "a remembered failure skips the probe");
assert.match(manage, /if \(!plainRelayProbe\.hasHeadroom\(connectionMetrics\)\) \{[\s\S]{0,300}plainRelayProbeChecked = false;\s*return;\s*\}\s*startPlainRelayProbe\(relayProtocol, targetPeer\);/,
  "the probe waits for bandwidth headroom and is reconsidered on a later tick");

// hasHeadroom: the probe needs room above what the call is already sending.
{
  const {hasHeadroom, probe} = require("../web/js/plain-relay-probe.js");
  assert.equal(probe.headroomKbps, 150);
  assert.equal(hasHeadroom({availableOutgoingKbps: 600, outgoingVideoKbps: 400, outgoingAudioKbps: 32}), true);
  assert.equal(hasHeadroom({availableOutgoingKbps: 300, outgoingVideoKbps: 114, outgoingAudioKbps: 32}), true,
    "a low video profile on a link with room still probes");
  assert.equal(hasHeadroom({availableOutgoingKbps: 250, outgoingVideoKbps: 114, outgoingAudioKbps: 32}), false,
    "a thin link must not carry the probe on top of the call");
  assert.equal(hasHeadroom({availableOutgoingKbps: 180, outgoingVideoKbps: null, outgoingAudioKbps: 32}), false);
  assert.equal(hasHeadroom({availableOutgoingKbps: 182, outgoingVideoKbps: null, outgoingAudioKbps: 32}), true,
    "missing or paused video counts as nothing sent");
  for (const unknown of [{}, undefined, {availableOutgoingKbps: null}, {availableOutgoingKbps: 0},
    {availableOutgoingKbps: NaN, outgoingAudioKbps: 32}]) {
    assert.equal(hasHeadroom(unknown), false, "an unknown estimate counts as no headroom");
  }
}
const runner = app.slice(app.indexOf("function startPlainRelayProbe("), app.indexOf("async function checkRelayRotation()"));
assert.match(runner, /filteredICEServers\(`turn-\$\{relayProtocol\}`\)/, "the probe uses the plain method's servers");
assert.match(runner, /iceTransportPolicy: "relay"/, "the probe must not leak onto a direct path");
assert.match(runner, /ordered: false, maxRetransmits: 0/, "probe packets are never retransmitted, so loss stays visible");
assert.match(runner, /if \(verdict && peer === forPeer\) applyPlainRelayVerdict\(/,
  "a verdict from a probe that outlived its peer is discarded");
assert.match(app, /const rotatable = wanted && !plainRelaySuspended;/, "a passed probe suspends rotation");
assert.match(app, /function resetPlainRelayProbe\(\) \{\s*plainRelayProbeRun\?\.cancel\(\);/,
  "resetting cancels a probe in flight");

console.log("plain relay probe tests passed");
