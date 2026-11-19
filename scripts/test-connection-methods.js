const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  filterICEServers, requiresConfiguredICEServers, isRotatingMethod, baseMethod, rotatingMethodForProtocol,
  rotatingVariant, narrowICEServersToURL,
  autoRelayFallback, autoRelayFallbackOrder, sharesPeerConfiguration
} = require("../web/js/connection-methods.js");

// narrowICEServersToURL: a rotation re-gathers only on the TURN URL that
// already carries the call. Browsers report that URL in their own spelling.
{
  const configured = [
    {urls: ["stun:stun.example.com:3478"]},
    {urls: ["turns:turn.example.com:443?transport=tcp", "turn:192.0.2.1:3478?transport=tcp",
      "turns:meet.example.com?transport=tcp", "turn:192.0.2.1"], username: "user", credential: "secret"}
  ];
  assert.deepEqual(narrowICEServersToURL(configured, "turns:turn.example.com:443?transport=tcp"),
    [{urls: ["turns:turn.example.com:443?transport=tcp"], username: "user", credential: "secret"}],
    "the matching URL is kept alone, with its credentials");
  assert.deepEqual(narrowICEServersToURL(configured, "TURNS:Meet.Example.com:5349?transport=TCP")?.[0].urls,
    ["turns:meet.example.com?transport=tcp"], "the default TURNS port and letter case must not prevent a match");
  assert.deepEqual(narrowICEServersToURL(configured, "turn:192.0.2.1:3478?transport=udp")?.[0].urls, ["turn:192.0.2.1"],
    "a URL without port or transport means UDP on 3478");
  assert.deepEqual(narrowICEServersToURL(configured, "turn:192.0.2.1:3478?transport=tcp")?.[0].urls,
    ["turn:192.0.2.1:3478?transport=tcp"], "transport distinguishes two URLs on one host and port");
  for (const unknown of ["turn:198.51.100.9:3478?transport=tcp", "turns:turn.example.com:5349?transport=tcp",
    "stun:stun.example.com:3478", "", null, undefined, "not a url"]) {
    assert.equal(narrowICEServersToURL(configured, unknown), null, `${unknown} names no configured TURN URL`);
  }
  assert.equal(configured[1].urls.length, 4, "the configured list must not be modified");
}

const servers = [
  {urls: ["stun:stun.example.com:3478"]},
  {urls: [
    "turn:relay.example.com:3478?transport=udp",
    "turn:relay.example.com:3478?transport=tcp",
    "turn:relay.example.com:3478",
    "turns:relay.example.com:443?transport=tcp"
  ], username: "temporary-user", credential: "temporary-credential"}
];

assert.deepEqual(filterICEServers(servers, "auto"), servers);
assert.deepEqual(filterICEServers(servers, "direct"), [{urls: ["stun:stun.example.com:3478"]}]);
assert.deepEqual(filterICEServers(servers, "turn-udp"), [{
  urls: ["turn:relay.example.com:3478?transport=udp", "turn:relay.example.com:3478"],
  username: "temporary-user",
  credential: "temporary-credential"
}]);
assert.deepEqual(filterICEServers(servers, "turn-tcp"), [{
  urls: ["turn:relay.example.com:3478?transport=tcp"],
  username: "temporary-user",
  credential: "temporary-credential"
}]);
assert.deepEqual(filterICEServers(servers, "turn-tls"), [{
  urls: ["turns:relay.example.com:443?transport=tcp"],
  username: "temporary-user",
  credential: "temporary-credential"
}]);
assert.deepEqual(filterICEServers(servers, "unknown"), []);

// Rotating methods are their base TURN method plus rotation.
assert.deepEqual(filterICEServers(servers, "turn-tcp-rotate"), filterICEServers(servers, "turn-tcp"));
assert.deepEqual(filterICEServers(servers, "turn-tls-rotate"), filterICEServers(servers, "turn-tls"));
assert.equal(isRotatingMethod("turn-tcp-rotate"), true);
assert.equal(isRotatingMethod("turn-tls-rotate"), true);
for (const plain of ["auto", "direct", "turn-udp", "turn-tcp", "turn-tls", "toString", "", undefined]) {
  assert.equal(isRotatingMethod(plain), false, `${plain} is not a rotating method`);
}
assert.equal(baseMethod("turn-tls-rotate"), "turn-tls");
assert.equal(baseMethod("turn-tcp"), "turn-tcp");
assert.equal(baseMethod("auto"), "auto");
assert.equal(rotatingMethodForProtocol("tcp"), "turn-tcp-rotate");
assert.equal(rotatingMethodForProtocol("TLS"), "turn-tls-rotate");
assert.equal(rotatingMethodForProtocol("udp"), null, "TURN/UDP has no rotating variant");
assert.equal(rotatingMethodForProtocol(null), null);
assert.equal(rotatingVariant("turn-tcp"), "turn-tcp-rotate");
assert.equal(rotatingVariant("turn-tls"), "turn-tls-rotate");
for (const methodID of ["auto", "direct", "turn-udp", "turn-tcp-rotate", "turn-tls-rotate", "", undefined]) {
  assert.equal(rotatingVariant(methodID), null, `${methodID} has no rotating variant to offer`);
}
assert.equal(requiresConfiguredICEServers("turn-tls-rotate"), true);

// "Automatic" relay fallback: rotating TCP, rotating TLS, TCP, TLS — first enabled.
assert.deepEqual([...autoRelayFallbackOrder], ["turn-tcp-rotate", "turn-tls-rotate", "turn-tcp", "turn-tls"]);
const enabledSet = (...ids) => (id) => ids.includes(id);
assert.equal(autoRelayFallback(enabledSet("turn-tcp", "turn-tls", "turn-tcp-rotate", "turn-tls-rotate")), "turn-tcp-rotate");
assert.equal(autoRelayFallback(enabledSet("turn-tcp", "turn-tls", "turn-tls-rotate")), "turn-tls-rotate",
  "a rotating method beats a plain one even when the plain one is TCP");
assert.equal(autoRelayFallback(enabledSet("turn-tcp", "turn-tls")), "turn-tcp");
assert.equal(autoRelayFallback(enabledSet("turn-tls", "turn-udp", "direct")), "turn-tls");
assert.equal(autoRelayFallback(enabledSet("turn-udp", "direct")), null,
  "TURN/UDP is never the fallback: it dies with direct UDP on policed paths");
assert.equal(autoRelayFallback(() => undefined), null);

// Switching plain <-> rotating of one transport needs no new peer configuration.
assert.equal(sharesPeerConfiguration("turn-tls", "turn-tls-rotate"), true);
assert.equal(sharesPeerConfiguration("turn-tcp-rotate", "turn-tcp"), true);
assert.equal(sharesPeerConfiguration("turn-tcp", "turn-tls"), false);
assert.equal(sharesPeerConfiguration("turn-tcp-rotate", "turn-tls-rotate"), false);
assert.equal(sharesPeerConfiguration("direct", "turn-tcp"), false);
assert.equal(sharesPeerConfiguration("auto", "auto"), false,
  "Automatic resolves to different configurations over time, so it never counts as shared");
assert.equal(requiresConfiguredICEServers("direct"), false,
  "direct mode can gather host candidates without configured ICE servers");
assert.equal(requiresConfiguredICEServers("auto"), false,
  "automatic mode can use browser host candidates without configured ICE servers");
assert.equal(requiresConfiguredICEServers("turn-udp"), true,
  "TURN modes require a configured TURN server");
assert.equal(requiresConfiguredICEServers("turn-tcp"), true,
  "TURN modes require a configured TURN server");
assert.equal(requiresConfiguredICEServers("turn-tls"), true,
  "TURN modes require a configured TURN server");
assert.deepEqual(servers[1].urls.length, 4, "filtering should not mutate the server configuration");

// The Live status card shows the transport actually in use, which can differ
// from the chosen method once "Automatic" fails over to the relay.
const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
assert.match(appSource, /const connectionActivePath = document\.querySelector\("#connection-active-path"\);/,
  "the Live status card must have an active-path line");
assert.match(appSource, /function describeActivePath\(icePath\) \{[\s\S]*?if \(!icePath\) return "measuring…";[\s\S]*?relay — TURN over \$\{protocol\}/,
  "the active path should describe relay usage from the selected candidate pair");
assert.match(appSource, /Object\.assign\(connectionMetrics, next\);\s*updateConnectionActivePath\(\);/,
  "the active path line must refresh with every diagnostics sample");
  assert.doesNotMatch(appSource, /if \(selectedCandidatePair\) \{\s*const localCandidate = candidatesById\.get\(selectedCandidatePair\.localCandidateId\)/,    "the path derivation must read the extracted selected pair, not the helper function");  assert.match(appSource, /if \(selectedPair\) \{\s*const localCandidate = candidatesById\.get\(selectedPair\.localCandidateId\)/,    "icePath derives from the selected pair actually extracted from getStats");

// A stalled direct-led connection gets a user-facing prompt offering the
// enabled TURN/TCP method, and confirmed direct failures are remembered so
// the next "Automatic" join skips the doomed direct attempt entirely.
assert.match(appSource, /const pathFallbackBanner = document\.querySelector\("#path-fallback-banner"\);/,
  "the stalled-direct prompt banner must be wired from the meeting stage");
assert.match(appSource, /function armDirectPathWatchdog\(targetPeer, targetSocket, generation\) \{[\s\S]*?effectiveConnectionMethod\(\)\.startsWith\("turn-"\) \|\| !autoRelayFallbackMethod\(\)[\s\S]*?directPathPromptDelayMs/,
  "the watchdog only arms for direct-led connections when a relay fallback is enabled");
assert.match(appSource, /if \(relayFallback && hasFreshDirectUdpFailure\(\)\) \{\s*return relayFallback;/,
  "a fresh remembered failure shortcuts \"Automatic\" joins onto the relay fallback");
assert.match(appSource, /recordDirectUdpFailure\(\);\s*hidePathFallbackBanner\(\);\s*selectConnectionMethod\(autoRelayFallbackMethod\(\) \|\| "turn-tcp"\);/,
  "the banner switch button records the failure and switches to the relay fallback");
assert.match(appSource, /values\.icePath = `Direct\/\$\{values\.iceTransport\.toUpperCase\(\)\}`;[\s\S]*?noteStableDirectPath\(\);/,
  "a live direct pair on a connected peer feeds the sustained-health gate");
assert.match(appSource, /function noteStableDirectPath\(\) \{[\s\S]*?directPathStableSamples < directPathStableResetSeconds[\s\S]*?clearDirectUdpFailure\(\);/,
  "the remembered failure clears only after sustained direct health (a momentary connect on a flapping path must not)");
assert.match(appSource, /const directUdpFailureStorageKey = "meeting\.directUdpFailAt";/,
  "the remembered failure is stored under the meeting.directUdpFailAt key");

const indexSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
assert.match(indexSource, /<div id="path-fallback-banner" class="meeting-alert path-fallback-banner" role="status" aria-live="polite" hidden>/,
  "the meeting stage must contain the stalled-direct prompt banner");
// An explicit plain TURN/TCP or TURN/TLS choice that keeps stalling is offered
// its rotating variant; the choice itself is never changed without the click.
assert.match(indexSource, /<div id="rotation-suggest-banner" class="meeting-alert path-fallback-banner" role="status" aria-live="polite" hidden>/,
  "the meeting stage must contain the rotating-relay suggestion banner");
assert.match(appSource, /function manageRotationSuggestion\(relayProtocol, rttMs\) \{[\s\S]*?rotationSuggestDismissed\) return;[\s\S]*?connectionMethod === appliedConnectionMethod[\s\S]*?rotatingVariant\(appliedConnectionMethod\)[\s\S]*?\.enabled !== true[\s\S]*?rotationSuggestGuard\.observe\(rttMs\)[\s\S]*?rotationSuggestBanner\.hidden = false;/,
  "the suggestion needs an explicit plain relay method, an enabled rotating variant, and a tripped RTT guard");
assert.match(appSource, /rotationSuggestSwitch\?\.addEventListener\("click", \(\) => \{[\s\S]*?rotatingVariant\(connectionMethod\);[\s\S]*?selectConnectionMethod\(rotatingMethod\);/,
  "accepting the suggestion switches to the rotating variant through the normal method selection");
assert.match(appSource, /rotationSuggestDismiss\?\.addEventListener\("click", \(\) => \{[\s\S]*?rotationSuggestDismissed = true;/,
  "declining the suggestion must not ask again for the same method choice");
assert.match(appSource, /connectionMethod = methodID;[\s\S]{0,120}rotationSuggestDismissed = false;/,
  "a new method choice may be offered the suggestion again");
assert.match(appSource, /manageRotationSuggestion\(relayProtocol, rttMs\);/,
  "the rotation check must feed the suggestion once per tick");
// Rotation suspended on a healthy-looking plain relay must resume when that
// flow dies outright; the RTT guard cannot see a dead pair.
assert.match(appSource, /if \(!connected && plainRelaySuspended &&[\s\S]{0,160}"disconnected"[\s\S]{0,400}plainRelaySuspended = false;[\s\S]{0,300}encodeVerdict\("fail", nowMs\)/,
  "an ICE disconnect while rotation is suspended must end the suspension and record the failure");
// One failed /ice-config request must not erase the saved connection type:
// the fallback shows Automatic without writing storage, and the next server
// response restores the saved choice before validating it.
assert.match(appSource, /\} catch \(_\) \{[\s\S]{0,400}refreshConnectionMethodSelectors\(\{ authoritative: false \}\);/,
  "the failure fallback must refresh the selectors as non-authoritative");
assert.match(appSource, /if \(!selectedMethod\?\.enabled\) \{\s*connectionMethod = "auto";\s*if \(authoritative\) writeStoredValue\("meeting\.connectionMethod", connectionMethod\);\s*else connectionMethodSetAside = true;/,
  "only a server-provided method list may replace the saved method in storage");
assert.match(appSource, /if \(connectionMethodSetAside\) \{\s*connectionMethodSetAside = false;\s*connectionMethod = readStoredValue\("meeting\.connectionMethod"\) \|\| "auto";\s*\}\s*refreshConnectionMethodSelectors\(\);\s*return true;/,
  "a successful response must bring the set-aside method back before the selectors are validated");

// A rotation gathers only on the selected relay's TURN URL; a recovery
// restart and a method switch go back to the method's full list.
assert.match(appSource, /narrowRotationServers\(targetPeer, relayServerURL\);\s*targetSocket\.send\(JSON\.stringify\(\{ version: 1, type: "ice_restart", reason: "rotate" \}\)\);/,
  "the server list is narrowed just before a rotation restart is requested");
assert.match(appSource, /function narrowRotationServers\(targetPeer, relayServerURL\) \{[\s\S]{0,400}narrowICEServersToURL\(\s*filteredICEServers\(appliedConnectionMethod\), relayServerURL\);[\s\S]{0,300}rotationNarrowedPeer = targetPeer;/,
  "narrowing starts from the applied method's servers and is remembered per peer");
assert.match(appSource, /restoreRotationServers\(targetPeer\);\s*targetSocket\.send\(JSON\.stringify\(\{ version: 1, type: "ice_restart" \}\)\);/,
  "a recovery restart must gather on every configured server again");
assert.match(appSource, /type: "ice_restart", reason: "switch" \}\)\);\s*rotationNarrowedPeer = null;/,
  "a method switch replaces the server list, so the narrowed state is dropped");
const pathMemoryScriptAt = indexSource.indexOf('<script defer src="/js/path-memory.js"></script>');
const appScriptAt = indexSource.indexOf('<script defer src="/js/app.js"></script>');
assert.ok(pathMemoryScriptAt !== -1, "index.html must load path-memory.js");
assert.ok(appScriptAt > pathMemoryScriptAt, "path-memory.js must load before app.js");

// Connection-method changes apply to the live peer instead of rejoining.
const switchSource = appSource.slice(appSource.indexOf("function switchConnectionMethodInPlace()"),
  appSource.indexOf("function startRelayRotation()"));
assert.match(appSource, /if \(!meeting\.hidden\) \{\s*if \(switchConnectionMethodInPlace\(\)\) \{[\s\S]*?return true;\s*\}\s*connectionMethodSwitchRequested = true;/,
  "a method change first tries the in-place switch and only then falls back to the rejoin path");
assert.match(switchSource, /if \(nextMethod === appliedConnectionMethod\) return true;/);
assert.match(switchSource, /if \(!methods\.sharesPeerConfiguration\(appliedConnectionMethod, nextMethod\)\) \{[\s\S]*?targetPeer\.setConfiguration\(\{ iceServers: servers, iceTransportPolicy: icePolicyForMethod\(nextMethod\) \}\);\s*targetSocket\.send\(JSON\.stringify\(\{ version: 1, type: "ice_restart", reason: "switch" \}\)\);/,
  "a different configuration is applied with setConfiguration and a planned ICE restart");
assert.doesNotMatch(switchSource, /iceRestartAttempts/, "a planned switch must not consume recovery restart attempts");
assert.match(switchSource, /if \(methodSwitchSettled && isPeerConnectionConnected\(targetPeer\)\) return;\s*connectionMethodSwitchRequested = true;[\s\S]*?targetSocket\.close\(\);/,
  "a switch that has not settled and connected in time falls back to the rejoin path");
assert.match(switchSource, /appliedConnectionMethod = nextMethod;\s*relayRotation\?\.reset\(\);\s*resetPlainRelayProbe\(\);/,
  "every switch restarts the rotation clock and discards probe state from the old method");
assert.match(appSource, /function relayRotationWanted\(relayProtocol\) \{[\s\S]*?if \(methods\.isRotatingMethod\(appliedConnectionMethod\)\) return true;\s*if \(appliedConnectionMethod !== "auto"\) return false;/,
  "plain TURN methods never rotate; rotating methods always do; Automatic follows the server's rotating methods");
assert.match(appSource, /peerFirstConnectedAtMs !== null && Date\.now\(\) - peerFirstConnectedAtMs <= earlyDirectDeathWindowMs &&\s*autoRelayFallbackMethod\(\)/,
  "a direct path that dies right after first connecting fills the failover latch at once");
assert.match(appSource, /appliedConnectionMethod = effectiveMethod;\s*peerFirstConnectedAtMs = null;/,
  "a rebuilt peer records the method it was built for and restarts the early-death window");
assert.match(indexSource, /<option value="turn-tcp-rotate">TURN over TCP \(rotating\)<\/option>\s*<option value="turn-tls-rotate">TURN over TLS \(rotating\)<\/option>/);

// The join page offers the same connection types as in-meeting Settings, as a
// visible field between the password and the device check.
const joinField = indexSource.match(/<div class="form-field" id="join-connection-method-field"([^>]*)>([\s\S]*?)<\/div>/);
assert.ok(joinField, "the join form must contain the connection-type field");
assert.doesNotMatch(joinField[1], /hidden/, "the join connection-type field must be visible");
assert.match(joinField[2], /<label for="join-connection-method">Connection type<\/label>/);
const optionValues = (markup) => [...markup.matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
const settingsSelect = indexSource.match(/<select id="settings-connection-method"[\s\S]*?<\/select>/);
assert.ok(settingsSelect, "the in-meeting settings selector must exist");
assert.deepEqual(optionValues(joinField[2]), optionValues(settingsSelect[0]),
  "the join page and Settings must offer the same connection types");
assert.equal(optionValues(joinField[2]).length, 7);
assert.ok(indexSource.indexOf('id="password-field"') < indexSource.indexOf('id="join-connection-method-field"') &&
  indexSource.indexOf('id="join-connection-method-field"') < indexSource.indexOf('class="device-test"'),
  "the connection type sits after the password and before the device check");

console.log("Connection method tests passed");
