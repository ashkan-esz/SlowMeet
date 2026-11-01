const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { hashName, initialsFor } = require("../web/js/participant-identity.js");

// Characterize the existing participant identity helpers before extracting
// them from app.js.
assert.equal(hashName("Ada"), 65662, "name hashing should retain its stable 31-based result");
assert.equal(hashName(""), 0, "an empty name should retain the zero seed");

assert.equal(initialsFor("Ada Lovelace"), "AL");
assert.equal(initialsFor("Grace Brewster Murray Hopper"), "GB", "only the first two initials are shown");
assert.equal(initialsFor("  alan   turing  "), "AT", "surrounding and repeated whitespace is ignored");
assert.equal(initialsFor(""), "?", "a blank name should use the fallback initial");

const helperSource = fs.readFileSync(require.resolve("../web/js/participant-identity.js"), "utf8");
const browserWindow = {};
vm.runInNewContext(helperSource, { window: browserWindow });
assert.equal(browserWindow.SlowMeetParticipantIdentity.hashName("Ada"), 65662, "the browser build should expose the same hashing API");
assert.equal(browserWindow.SlowMeetParticipantIdentity.initialsFor("Ada Lovelace"), "AL");

const indexHTML = fs.readFileSync(require.resolve("../web/index.html"), "utf8");
assert.ok(
  indexHTML.indexOf('/js/participant-identity.js') < indexHTML.indexOf('/js/app.js'),
  "the identity helper must load before the app consumes it"
);

console.log("Participant identity tests passed");
