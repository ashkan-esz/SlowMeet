const { parseSignalingMessage } = require("../web/js/protocol.js");

const valid = parseSignalingMessage('{"version":1,"type":"participant"}');
if (!valid || valid.type !== "participant") throw new Error("valid message rejected");

const validReaction = parseSignalingMessage('{"version":1,"type":"emoji_reaction","participant_id":"p1","emoji":"🎉"}');
if (!validReaction || validReaction.emoji !== "🎉") throw new Error("valid reaction rejected");

for (const value of [
  "{",
  "null",
  '{"version":2,"type":"participant"}',
  '{"version":1}',
  '{"version":1,"type":""}',
  '{"version":1,"type":7}',
  '{"version":1,"type":"emoji_reaction","participant_id":"p1","emoji":"🦄"}',
  '{"version":1,"type":"emoji_reaction","emoji":"🎉"}'
]) {
  if (parseSignalingMessage(value) !== null) throw new Error(`invalid message accepted: ${value}`);
}

console.log("Protocol tests passed");
