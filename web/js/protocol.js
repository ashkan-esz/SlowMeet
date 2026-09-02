function parseSignalingMessage(data) {
  try {
    const message = typeof data === "string" ? JSON.parse(data) : data;
    if (!message || typeof message !== "object" ||
        message.version !== 1 || typeof message.type !== "string" || message.type === "") {
      return null;
    }
    return message;
  } catch (_) {
    return null;
  }
}

if (typeof module !== "undefined") module.exports = { parseSignalingMessage };
