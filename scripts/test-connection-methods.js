const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {filterICEServers, requiresConfiguredICEServers} = require("../web/js/connection-methods.js");

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
assert.match(appSource, /function armDirectPathWatchdog\(targetPeer, targetSocket, generation\) \{[\s\S]*?effectiveConnectionMethod\(\)\.startsWith\("turn-"\) \|\| !turnTcpMethodEnabled\(\)[\s\S]*?directPathPromptDelayMs/,
  "the watchdog only arms for direct-led connections when the TURN/TCP method is enabled");
assert.match(appSource, /if \(turnTcpMethodEnabled\(\) && hasFreshDirectUdpFailure\(\)\) \{\s*return "turn-tcp";/,
  "a fresh remembered failure shortcuts \"Automatic\" joins onto TURN/TCP");
assert.match(appSource, /recordDirectUdpFailure\(\);\s*hidePathFallbackBanner\(\);\s*selectConnectionMethod\("turn-tcp"\);/,
  "the banner switch button records the failure and reconnects as TURN/TCP");
assert.match(appSource, /values\.icePath = `Direct\/\$\{values\.iceTransport\.toUpperCase\(\)\}`;[\s\S]*?clearDirectUdpFailure\(\);/,
  "a live direct pair clears the remembered failure");
assert.match(appSource, /const directUdpFailureStorageKey = "meeting\.directUdpFailAt";/,
  "the remembered failure is stored under the meeting.directUdpFailAt key");

const indexSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");
assert.match(indexSource, /<div id="path-fallback-banner" class="meeting-alert path-fallback-banner" role="status" aria-live="polite" hidden>/,
  "the meeting stage must contain the stalled-direct prompt banner");
const pathMemoryScriptAt = indexSource.indexOf('<script defer src="/js/path-memory.js"></script>');
const appScriptAt = indexSource.indexOf('<script defer src="/js/app.js"></script>');
assert.ok(pathMemoryScriptAt !== -1, "index.html must load path-memory.js");
assert.ok(appScriptAt > pathMemoryScriptAt, "path-memory.js must load before app.js");
console.log("Connection method tests passed");
