const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { nextReconnectStep, reconnectSchedule } = require("../web/js/reconnect-policy.js");

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(root, "web/index.html"), "utf8");

function createManualTimers() {
  let nextID = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++nextID;
      timers.set(id, { callback, delay });
      return id;
    },
    count() {
      return timers.size;
    },
    delays() {
      return [...timers.values()].map(({ delay }) => delay);
    },
    fireAll() {
      const callbacks = [...timers.values()].map(({ callback }) => callback);
      timers.clear();
      callbacks.forEach((callback) => callback());
    }
  };
}

// The same decisions app.js makes in its signaling socket close handler and
// its media-connected handler, driven by manual timers.
function createClient(timers, maxAttempts = 5) {
  const client = { attempts: 0, offline: false, redials: 0, statuses: [] };
  client.socketClosed = () => {
    client.attempts++;
    const step = nextReconnectStep(client.attempts, maxAttempts);
    if (step.offline) {
      client.offline = true;
      client.statuses.push("Offline. Select Leave to try again.");
      return;
    }
    client.statuses.push(`Reconnecting in ${Math.ceil(step.delayMs / 1000)}s...`);
    timers.setTimer(() => {
      client.redials++;
    }, step.delayMs);
  };
  client.mediaConnected = () => {
    client.attempts = 0;
  };
  return client;
}

// Backoff: 2, 4, 8, 16 s, then capped at 30 s.
assert.deepEqual([1, 2, 3, 4, 5].map((attempts) => nextReconnectStep(attempts).delayMs),
  [2000, 4000, 8000, 16000, 30000]);
assert.deepEqual(reconnectSchedule(), [2000, 4000, 8000, 16000, 30000],
  "the default budget is five retries over 60 s before the client goes Offline");
assert.equal(reconnectSchedule().reduce((sum, delay) => sum + delay, 0), 60000);

// The sixth consecutive failure goes Offline; so does every later one.
assert.deepEqual(nextReconnectStep(6), { offline: true });
assert.deepEqual(nextReconnectStep(60), { offline: true });

// The cap holds for a larger budget.
assert.deepEqual(reconnectSchedule(8), [2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
assert.deepEqual(reconnectSchedule(0), []);

// Six closes without connected media: five redials are scheduled with
// growing delays, the sixth close goes Offline and schedules nothing.
{
  const timers = createManualTimers();
  const client = createClient(timers);
  const delays = [];
  for (let close = 1; close <= 6; close++) {
    client.socketClosed();
    if (client.offline) break;
    delays.push(...timers.delays());
    timers.fireAll();
  }
  assert.deepEqual(delays, [2000, 4000, 8000, 16000, 30000]);
  assert.equal(client.redials, 5);
  assert.equal(client.offline, true);
  assert.equal(timers.count(), 0, "no seventh timer may be scheduled once Offline");
  assert.equal(client.statuses.at(-1), "Offline. Select Leave to try again.");
  assert.equal(client.statuses[0], "Reconnecting in 2s...");
  assert.equal(client.statuses[4], "Reconnecting in 30s...");
}

// Connected media between closes resets the budget back to a 2 s retry.
{
  const timers = createManualTimers();
  const client = createClient(timers);
  for (let close = 1; close <= 4; close++) {
    client.socketClosed();
    timers.fireAll();
  }
  client.mediaConnected();
  client.socketClosed();
  assert.deepEqual(timers.delays(), [2000]);
  assert.equal(client.offline, false);
}

// Wiring: app.js uses the policy in its socket close handler with the
// existing budget, and the policy script loads before app.js.
assert.match(appSource, /const maxReconnectAttempts = 5;/);
assert.match(appSource,
  /reconnectAttempts\+\+;\s*setConnection\("fair", "Reconnecting"\);\s*const reconnectStep = nextReconnectStep\(reconnectAttempts, maxReconnectAttempts\);\s*if \(reconnectStep\.offline\) \{/,
  "the socket close handler must take its decision from nextReconnectStep");
assert.match(appSource, /const delay = reconnectStep\.delayMs;\s*showStatus\(`Reconnecting in \$\{Math\.ceil\(delay \/ 1000\)\}s\.\.\.`\);/);
assert.doesNotMatch(appSource, /2000 \* 2 \*\* Math\.min\(reconnectAttempts/,
  "the backoff formula must live only in reconnect-policy.js");
const policyAt = indexSource.indexOf('<script defer src="/js/reconnect-policy.js"></script>');
const appAt = indexSource.indexOf('<script defer src="/js/app.js"></script>');
assert.ok(policyAt > 0 && appAt > policyAt, "reconnect-policy.js must load before app.js");

console.log("Reconnect policy checks passed");
