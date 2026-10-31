const assert = require("node:assert/strict");
const { newChatHistoryTracker, normalizeHistoryEntry } = require("../web/js/chat-history.js");

const snapshot = [
  { id: "a", author: "Ashkan", text: "hello", participant_id: "p1", timestamp: "2026-01-01T00:00:00Z" },
  { id: "b", author: "Ali", text: "hi there", participant_id: "p2", timestamp: "2026-01-01T00:00:01Z" }
];

// A fresh tracker applies the whole snapshot once.
const tracker = newChatHistoryTracker();
let applied = tracker.apply(snapshot);
assert.equal(applied.length, 2, "a fresh tracker should apply the full snapshot");
assert.equal(applied[0].author, "Ashkan");
assert.equal(applied[0].participantId, "p1", "participant_id should be normalized");
assert.equal(applied[0].timestamp, "2026-01-01T00:00:00Z");

// A replayed snapshot after reconnect applies nothing.
applied = tracker.apply(snapshot);
assert.equal(applied.length, 0, "replayed history must not be applied twice");

// New entries append; duplicates inside one snapshot are dropped.
applied = tracker.apply([
  { id: "b", author: "Ali", text: "hi there" },
  { id: "c", author: "Ali", text: "again", participant_id: "p2" }
]);
assert.equal(applied.length, 1, "only unseen entries should be applied");
assert.equal(applied[0].id, "c");

// reset clears the applied set so a rebuilt rail can re-apply the snapshot.
tracker.reset();
applied = tracker.apply(snapshot);
assert.equal(applied.length, 2, "reset should allow the snapshot to be applied again");

// Entries without text are skipped entirely.
const empty = newChatHistoryTracker().apply([
  { id: "d", author: "Ashkan", text: "" },
  { id: "e", author: "Ashkan", text: "  " },
  null,
  { author: "Ashkan" },
  { id: "f", author: "Ashkan", text: "kept" }
]);
assert.equal(empty.length, 1, "blank and malformed entries should be skipped");
assert.equal(empty[0].id, "f");

// Entries without an id pass through every time (legacy snapshots).
const tracker2 = newChatHistoryTracker();
const idless = { author: "Ashkan", text: "no id" };
assert.equal(tracker2.apply([idless]).length, 1, "idless entries should apply");
assert.equal(tracker2.apply([idless]).length, 1, "idless entries should apply again after a replay");

// Non-array input is tolerated.
assert.deepEqual(newChatHistoryTracker().apply(undefined), [], "undefined history should apply nothing");

// Normalization defaults.
assert.equal(normalizeHistoryEntry(null), null, "null entries normalize to null");
const defaulted = normalizeHistoryEntry({ text: "x" });
assert.equal(defaulted.author, "Participant", "missing author should default to Participant");
assert.equal(defaulted.id, null, "missing id should normalize to null");
assert.equal(defaulted.participantId, "", "missing participant_id should normalize to empty");

console.log("chat history tests passed");
