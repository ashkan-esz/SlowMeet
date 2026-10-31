'use strict';

// SlowMeetChatHistory tracks which chat-history entries have already been
// rendered so a replayed server snapshot (for example after a WebSocket
// reconnect) never duplicates messages, toasts, or unread counts.
(function (global) {
  function normalizeHistoryEntry(entry) {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return null;
    return {
      id: typeof entry.id === 'string' && entry.id ? entry.id : null,
      author: typeof entry.author === 'string' && entry.author ? entry.author : 'Participant',
      text: entry.text,
      participantId: typeof entry.participant_id === 'string' ? entry.participant_id : '',
      timestamp: typeof entry.timestamp === 'string' && entry.timestamp ? entry.timestamp : null
    };
  }

  function newChatHistoryTracker() {
    const applied = new Set();
    return {
      reset() {
        applied.clear();
      },
      // apply returns the normalized entries that have not been applied
      // before. Entries without an id are passed through every time.
      apply(entries) {
        const fresh = [];
        (Array.isArray(entries) ? entries : []).forEach((entry) => {
          const normalized = normalizeHistoryEntry(entry);
          if (!normalized) return;
          if (normalized.id) {
            if (applied.has(normalized.id)) return;
            applied.add(normalized.id);
          }
          fresh.push(normalized);
        });
        return fresh;
      }
    };
  }

  const api = { newChatHistoryTracker, normalizeHistoryEntry };
  global.SlowMeetChatHistory = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
