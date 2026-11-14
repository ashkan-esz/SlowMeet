const assert = require("node:assert/strict");
const {parseStoredTimestamp, isFreshFailure} = require("../web/js/path-memory.js");

// The remembered direct-UDP failure is stored as a bare epoch string; every
// malformed value must degrade to "no memory" instead of throwing or reading
// as a fresh failure.
assert.equal(parseStoredTimestamp("1700000000000"), 1700000000000, "a stored epoch string parses to its number");
assert.equal(parseStoredTimestamp(" 1700000000000 "), 1700000000000, "surrounding whitespace is tolerated");
assert.equal(parseStoredTimestamp(""), null, "an empty string is not a timestamp");
assert.equal(parseStoredTimestamp("garbage"), null, "garbage is not a timestamp");
assert.equal(parseStoredTimestamp("NaN"), null, "NaN text is not a timestamp");
assert.equal(parseStoredTimestamp(null), null, "null input is not a timestamp");
assert.equal(parseStoredTimestamp(undefined), null, "undefined input is not a timestamp");
assert.equal(parseStoredTimestamp({}), null, "an object input is not a timestamp");

const now = 1000000000000;
const day = 86400000;
assert.equal(isFreshFailure(now, now, day), true, "a failure recorded right now is fresh");
assert.equal(isFreshFailure(now - day + 1000, now, day), true, "a failure within the TTL is fresh");
assert.equal(isFreshFailure(now - day, now, day), true, "a failure exactly at the TTL boundary is still fresh");
assert.equal(isFreshFailure(now - day - 1, now, day), false, "a failure past the TTL is stale");
assert.equal(isFreshFailure(now + 5000, now, day), true, "a future timestamp (clock skew) is tolerated as fresh");
assert.equal(isFreshFailure(null, now, day), false, "no stored timestamp is never fresh");
assert.equal(isFreshFailure(NaN, now, day), false, "a NaN timestamp is never fresh");
assert.equal(isFreshFailure(now, NaN, day), false, "a non-finite clock read is never fresh");
assert.equal(isFreshFailure(now - 1, now, 0), false, "a zero TTL accepts nothing");

assert.equal(typeof globalThis.SlowMeetPathMemory.parseStoredTimestamp, "function",
  "the module also exposes itself on globalThis for the browser");
console.log("Path memory tests passed");
