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
console.log("Connection method tests passed");
