const { parseSignalingMessage } = require("../web/js/protocol.js");

const valid = parseSignalingMessage('{"version":1,"type":"participant"}');
if (!valid || valid.type !== "participant") throw new Error("valid message rejected");

for (const value of [
  "{",
  "null",
  '{"version":2,"type":"participant"}',
  '{"version":1}',
  '{"version":1,"type":""}',
  '{"version":1,"type":7}'
]) {
  if (parseSignalingMessage(value) !== null) throw new Error(`invalid message accepted: ${value}`);
}

console.log("Protocol tests passed");
