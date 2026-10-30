const assert = require("node:assert/strict");
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

console.log("Connection method tests passed");
