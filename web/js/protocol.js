const approvedReactionEmojis = new Set(["👍", "👎", "❤️", "😂", "🎉", "😮", "👏", "🙌", "🔥", "💯", "😢", "🤔"]);

function parseSignalingMessage(data) {
  try {
    const message = typeof data === "string" ? JSON.parse(data) : data;
    if (!message || typeof message !== "object" ||
        message.version !== 1 || typeof message.type !== "string" || message.type === "") {
      return null;
    }
    if (message.type === "emoji_reaction" &&
        (typeof message.participant_id !== "string" ||
         !approvedReactionEmojis.has(message.emoji))) {
      return null;
    }
    return message;
  } catch (_) {
    return null;
  }
}

if (typeof module !== "undefined") module.exports = { parseSignalingMessage, approvedReactionEmojis };
