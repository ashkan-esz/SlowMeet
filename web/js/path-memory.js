// Remembered network-path facts are stored in localStorage as bare epoch
// millisecond strings. Both helpers tolerate anything a user (or a blocked
// storage policy) might have left behind: garbage parses to null and a
// null timestamp is never treated as a fresh failure.
(function exposePathMemoryUtilities(root) {
  function parseStoredTimestamp(raw) {
    if (typeof raw !== "string" || raw.trim() === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }

  function isFreshFailure(timestamp, nowMs, ttlMs) {
    if (timestamp === null || !Number.isFinite(timestamp)) return false;
    if (!Number.isFinite(nowMs) || !Number.isFinite(ttlMs) || ttlMs < 0) return false;
    return nowMs - timestamp <= ttlMs;
  }

  const utilities = Object.freeze({parseStoredTimestamp, isFreshFailure});
  root.SlowMeetPathMemory = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
