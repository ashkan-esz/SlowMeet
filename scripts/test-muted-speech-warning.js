const assert = require("node:assert/strict");
const { advance } = require("../web/js/muted-speech-warning.js");

const activationDelay = 200;
const deactivationHold = 300;
const repeatInterval = 10000;
let state;

let result = advance(state, true, 100, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, false, "speech warning should be delayed");

result = advance(state, true, 299, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, false, "speech before the activation delay should stay quiet");

result = advance(state, true, 300, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, true, "sustained muted speech should trigger a warning");

result = advance(state, true, 500, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, false, "continuous speech should not repeat the warning");

result = advance(state, true, 10299, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, false, "repeat should wait for the full interval");

result = advance(state, true, 10300, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, true, "continuous muted speech should repeat after 10 seconds");

result = advance(state, true, 10301, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, false, "there should be no immediate third alert");

result = advance(state, true, 20300, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(result.shouldWarn, false, "a speech episode should stop after two total alerts");
assert.equal(state.alertCount, 2, "the alert cap should include the initial warning and one repeat");

result = advance(state, false, 10400, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(state.lastWarnAt, 10300, "brief pauses should not reset the repeat timer");

result = advance(state, false, 10700, activationDelay, deactivationHold, repeatInterval);
state = result.state;
assert.equal(state.lastWarnAt, 0, "silence should reset the warning state");
assert.equal(state.alertCount, 0, "silence should reset the per-episode alert cap");

result = advance(state, true, 11000, activationDelay, deactivationHold, repeatInterval);
state = result.state;
result = advance(state, true, 11200, activationDelay, deactivationHold, repeatInterval);
assert.equal(result.shouldWarn, true, "a later muted speech turn should warn again");

result = advance(undefined, false, 13000, activationDelay, deactivationHold, repeatInterval);
assert.equal(result.shouldWarn, false, "unmuted or quiet input should not warn");

console.log("muted speech warning tests passed");
