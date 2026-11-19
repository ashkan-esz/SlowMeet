const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {createRelayRotation, rotatableRelayProtocol} = require("../web/js/relay-rotation.js");

// rotatableRelayProtocol: only a selected TURN relay over TCP or TLS rotates.
function report(localCandidate, pairState = "succeeded") {
  return new Map([
    ["T1", {id: "T1", type: "transport", selectedCandidatePairId: "P1"}],
    ["P1", {id: "P1", type: "candidate-pair", localCandidateId: "L1", state: pairState}],
    ["L1", {id: "L1", type: "local-candidate", ...localCandidate}]
  ]);
}
assert.equal(rotatableRelayProtocol(report({candidateType: "relay", relayProtocol: "tcp"})), "tcp");
assert.equal(rotatableRelayProtocol(report({candidateType: "relay", relayProtocol: "TLS"})), "tls");
assert.equal(rotatableRelayProtocol(report({candidateType: "relay", relayProtocol: "tls"}, "in-progress")), "tls",
  "Chrome marks the selected pair in-progress while a check is outstanding; it is still the media path");
assert.equal(rotatableRelayProtocol(report({candidateType: "relay", relayProtocol: "udp"})), null,
  "TURN/UDP is not a long-lived TCP flow and must not rotate");
assert.equal(rotatableRelayProtocol(report({candidateType: "host", protocol: "udp"})), null,
  "direct paths never rotate");
assert.equal(rotatableRelayProtocol(new Map()), null, "no selected pair means no rotation");
assert.equal(rotatableRelayProtocol(new Map([
  ["P1", {id: "P1", type: "candidate-pair", localCandidateId: "L1", state: "succeeded", nominated: true}],
  ["L1", {id: "L1", type: "local-candidate", candidateType: "relay", relayProtocol: "tcp"}]
])), "tcp", "a nominated pair stands in when no transport reports a selection");

// Scheduling: one rotation per interval while on a TCP/TLS relay.
const live = {rotatable: true, connected: true, busy: false};
{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  assert.equal(rotation.observe({...live, nowMs: 0}), false, "the first sample only starts the window");
  assert.equal(rotation.observe({...live, nowMs: 14000}), false);
  assert.equal(rotation.observe({...live, nowMs: 15000}), true, "rotate once the interval elapses");
  rotation.rotationSent(15000);
  assert.equal(rotation.isPending(), true);
  assert.equal(rotation.observe({...live, nowMs: 16000}), false, "no second restart while one is pending");
  assert.equal(rotation.rotationSettled(16500), true);
  assert.equal(rotation.observe({...live, nowMs: 31000}), false, "the new window starts when the restart settles");
  assert.equal(rotation.observe({...live, nowMs: 31500}), true);
}

{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(0);
  assert.equal(rotation.observe({...live, nowMs: 0}), false);
  assert.equal(rotation.observe({...live, nowMs: 600000}), false, "interval 0 disables rotation");
  rotation.setIntervalSeconds(Number(undefined));
  assert.equal(rotation.observe({...live, nowMs: 900000}), false, "a server without the field disables rotation");
}

{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  rotation.observe({...live, nowMs: 0});
  for (const nowMs of [10000, 11000, 12000, 13000]) {
    assert.equal(rotation.observe({...live, rotatable: false, nowMs}), false);
  }
  assert.equal(rotation.observe({...live, nowMs: 14000}), false,
    "after leaving the relay for longer than the grace, returning starts a fresh window");
  assert.equal(rotation.observe({...live, nowMs: 28000}), false);
  assert.equal(rotation.observe({...live, nowMs: 29000}), true);
}

{
  // One-tick gaps (a pair momentarily without a selection) must not keep
  // restarting the clock, or rotation would never fire on a live call.
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(12);
  rotation.observe({...live, nowMs: 0});
  for (let nowMs = 1000; nowMs < 12000; nowMs += 1000) {
    assert.equal(rotation.observe({...live, rotatable: nowMs % 4000 !== 0, nowMs}), false);
  }
  assert.equal(rotation.observe({...live, nowMs: 12000}), true, "brief gaps keep the rotation on schedule");
}

{
  // While the browser moves media to the fresh pair, stats can briefly show
  // no selected TCP/TLS relay; the rotation clock must keep running.
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  rotation.observe({...live, nowMs: 0});
  assert.equal(rotation.observe({...live, nowMs: 15000}), true);
  rotation.rotationSent(15000);
  assert.equal(rotation.observe({...live, rotatable: false, nowMs: 15500}), false);
  rotation.rotationSettled(15600);
  assert.equal(rotation.observe({...live, rotatable: false, nowMs: 16600}), false);
  assert.equal(rotation.observe({...live, rotatable: false, nowMs: 17600}), false);
  assert.equal(rotation.observe({...live, nowMs: 18600}), false);
  assert.equal(rotation.observe({...live, nowMs: 30600}), true,
    "a transient gap during the switch must not push the next rotation back");
}

{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  rotation.observe({...live, nowMs: 0});
  rotation.observe({...live, nowMs: 15000});
  rotation.rotationSent(15000);
  rotation.rotationSettled(15500);
  for (const nowMs of [31000, 32000, 33000, 34000]) {
    assert.equal(rotation.observe({...live, rotatable: false, nowMs}), false,
      "a path that stays off the relay past the interval and the grace");
  }
  assert.equal(rotation.observe({...live, nowMs: 35000}), false, "starts a fresh window when it returns");
  assert.equal(rotation.observe({...live, nowMs: 50000}), true);
}

{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  rotation.observe({...live, nowMs: 0});
  assert.equal(rotation.observe({...live, connected: false, nowMs: 5000}), false);
  assert.equal(rotation.observe({...live, nowMs: 6000}), false, "a disconnect restarts the window");
  assert.equal(rotation.observe({...live, nowMs: 21000}), true);
}

{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  rotation.observe({...live, nowMs: 0});
  assert.equal(rotation.observe({...live, busy: true, nowMs: 20000}), false, "recovery restarts take precedence");
  assert.equal(rotation.observe({...live, nowMs: 21000}), true, "rotation resumes once recovery finishes");
}

{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  rotation.observe({...live, nowMs: 0});
  rotation.rotationSent(15000);
  assert.equal(rotation.rotationFailed(15200), true);
  assert.equal(rotation.observe({...live, nowMs: 19000}), false);
  assert.equal(rotation.observe({...live, nowMs: 20200}), true, "a refused rotation retries after a short delay");
}

{
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(15);
  rotation.observe({...live, nowMs: 0});
  rotation.rotationSent(15000);
  assert.equal(rotation.observe({...live, nowMs: 24000}), false);
  assert.equal(rotation.observe({...live, nowMs: 25000}), true, "an unanswered rotation times out instead of blocking forever");
  rotation.rotationSent(25000);
  rotation.reset();
  assert.equal(rotation.isPending(), false);
  assert.equal(rotation.rotationSettled(2), false, "an unrelated restart offer settles nothing");
}

{
  // expedite(): a suspended rotation that must resume rotates on the next tick.
  const rotation = createRelayRotation();
  rotation.setIntervalSeconds(12);
  rotation.observe({...live, nowMs: 0});
  assert.equal(rotation.observe({...live, nowMs: 3000}), false);
  rotation.expedite(3000);
  assert.equal(rotation.observe({...live, nowMs: 4000}), true);
  const disabled = createRelayRotation();
  disabled.expedite(1000);
  assert.equal(disabled.observe({...live, nowMs: 2000}), false, "expedite cannot enable a disabled rotation");
}

// Wiring: the browser loads the module before app.js, and app.js keeps the
// rotation separate from bounded recovery restarts.
const index = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
const moduleAt = index.indexOf('src="/js/relay-rotation.js"');
const policyAt = index.indexOf('src="/js/adaptation-policy.js"');
const appAt = index.indexOf('src="/js/app.js"');
assert.ok(moduleAt > 0 && policyAt > 0 && moduleAt < appAt, "relay-rotation.js must load before app.js");

const app = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const check = app.slice(app.indexOf("async function checkRelayRotation()"), app.indexOf("function requestIceRestart("));
assert.ok(check.includes('type: "ice_restart", reason: "rotate"'),
  "rotation asks the server for an ICE restart and labels it as planned");
assert.match(check, /shared && shared\.peer === targetPeer && Date\.now\(\) - shared\.atMs < sharedStatsMaxAgeMs\s*\? shared\.report\s*: await targetPeer\.getStats\(\)/,
  "the rotation check reuses a fresh diagnostics report for the same peer and reads its own otherwise");
assert.match(app, /lastDiagnosticsStats = \{ report, peer: currentPeer, atMs: Date\.now\(\) \};/,
  "the diagnostics loop publishes its stats report for reuse");
assert.match(check, /const wanted = relayProtocol !== null && relayRotationWanted\(relayProtocol\);/,
  "rotation is gated on the connection method, not only on the relay protocol");
assert.ok(!check.includes("iceRestartAttempts"), "rotation must not consume recovery restart attempts");
assert.ok(!check.includes("restartRequested ="), "rotation must not latch the recovery restart flag");
assert.ok(!/status\.textContent|setConnection\(/.test(check), "rotation must not change the visible connection status");
assert.match(app, /relayRotation\?\.setIntervalSeconds\(Number\(config\.turn_tcp_rotate_seconds\)\)/,
  "the interval comes from /ice-config");
assert.match(app, /if \(iceRestartOffer\) \{\n\s+methodSwitchSettled = true;\n\s+relayRotation\?\.rotationSettled\(Date\.now\(\)\);/,
  "an answered restart offer settles the pending rotation");
assert.match(app, /startRelayRotation\(\);\n\s+clearInterval\(statsTimer\);\n\s+previousStats = undefined;\n\s+statsTimer = setInterval\(updateDiagnostics, 1000\);/,
  "rotation starts with the media session");

console.log("relay rotation tests passed");
