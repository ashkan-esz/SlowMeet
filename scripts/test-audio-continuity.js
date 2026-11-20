// Checks the pure analysis in scripts/audio-continuity.js.
"use strict";

const assert = require("node:assert/strict");
const { longestGap, gapsOver, pooledGap, minActive, summarize } = require("./audio-continuity");

const every = (from, to, step) => {
  const times = [];
  for (let at = from; at <= to; at += step) times.push(at);
  return times;
};

// A steady stream every 100 ms has a 100 ms longest gap.
assert.equal(longestGap(every(0, 10000, 100), 0, 10000), 100);
// The window edges count: nothing arrives for the first and last second.
assert.equal(longestGap(every(1000, 9000, 100), 0, 10000), 1000);
// Arrivals outside the window are ignored.
assert.equal(longestGap([...every(0, 2000, 100), ...every(5000, 9000, 100)], 3000, 9000), 2000);
// A stream that never arrives is silent for the whole window.
assert.equal(longestGap([], 2000, 7000), 5000);
assert.equal(longestGap(undefined, 0, 500), 500);

// A 3 s hole in the middle.
const holed = [...every(0, 4000, 100), ...every(7000, 10000, 100)];
assert.equal(longestGap(holed, 0, 10000), 3000);
assert.deepEqual(gapsOver(holed, 1500, 0, 10000), [{ from: 4000, to: 7000, ms: 3000 }]);
assert.deepEqual(gapsOver(holed, 3000, 0, 10000), []);
assert.deepEqual(gapsOver([], 1000, 0, 2500), [{ from: 0, to: 2500, ms: 2500 }]);

// Pooled: the room is silent only when nobody is heard.
const byOwner = { a: holed, b: every(0, 10000, 100) };
assert.equal(pooledGap(byOwner, 0, 10000), 100);
assert.equal(pooledGap({ a: every(0, 3000, 100), b: every(6000, 10000, 100) }, 0, 10000), 3000);

// minActive: how many owners were heard in every 1 s window.
assert.equal(minActive(byOwner, 0, 10000), 1, "a's hole leaves only b audible for a while");
assert.equal(minActive({ a: every(0, 10000, 100), b: every(0, 10000, 100), c: every(0, 10000, 100) }, 0, 10000), 3);
assert.equal(minActive({ a: every(0, 10000, 100) }, 0, 10000, { owners: ["a", "ghost"] }), 1,
  "an owner that never arrived is never active");

// summarize: per-owner gaps, worst, pooled and minActive for a set of owners.
const summary = summarize({ arrivals: byOwner, peers: 2 }, { from: 0, to: 10000, owners: ["a", "b", "missing"] });
assert.deepEqual(summary.perOwnerGapMs, { a: 3000, b: 100, missing: 10000 });
assert.equal(summary.worstGapMs, 10000);
assert.equal(summary.pooledGapMs, 100);
assert.equal(summary.minActive, 1);
assert.equal(summary.peers, 2);
assert.equal(summarize(null, { from: 0, to: 1000 }).worstGapMs, 0);

console.log("audio continuity checks passed");
