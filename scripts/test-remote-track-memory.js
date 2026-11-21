// Checks web/js/remote-track-memory.js: the record app.js uses to bind a
// resumed participant's existing tracks to its tile again (B11, B9).
"use strict";

const assert = require("node:assert/strict");
const { createRemoteTrackMemory } = require("../web/js/remote-track-memory.js");

const track = (id, readyState = "live") => ({ id, readyState });
const event = (trackValue, receiver = {}) => ({ streams: [], track: trackValue, receiver });

const memory = createRemoteTrackMemory();
const audio = track("a");
const camera = track("c");
memory.remember("P2", event(audio));
memory.remember("P2", event(camera));
assert.equal(memory.size("P2"), 2);

// Binding the same track again (a rebind, or a renegotiated ontrack) keeps
// one entry for it.
memory.remember("P2", event(audio));
assert.equal(memory.size("P2"), 2, "a rebound track is not remembered twice");

// take returns what is still bindable and forgets the participant.
const taken = memory.take("P2", (entry) => entry.track !== camera);
assert.deepEqual(taken.map((entry) => entry.track.id), ["a"]);
assert.equal(memory.size("P2"), 0, "take forgets the participant");
assert.deepEqual(memory.take("P2"), []);

// Ended tracks are pruned when the participant's next track is remembered.
const ended = track("old", "ended");
memory.remember("P3", event(ended));
memory.remember("P3", event(track("new")));
assert.deepEqual(memory.take("P3").map((entry) => entry.track.id), ["new"]);

// Participants are independent; forget and clear drop them.
memory.remember("P4", event(track("x")));
memory.remember("P5", event(track("y")));
memory.forget("P4");
assert.equal(memory.size("P4"), 0);
assert.equal(memory.size("P5"), 1);
memory.clear();
assert.equal(memory.size("P5"), 0);

// Events without a participant or a track are ignored.
memory.remember("", event(track("z")));
memory.remember("P6", { streams: [] });
assert.equal(memory.size(""), 0);
assert.equal(memory.size("P6"), 0);

console.log("remote track memory checks passed");
