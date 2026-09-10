/** @typedef {'grid'|'pinned'|'screen-share'} MeetingLayoutMode */
/** @typedef {'none'|'settings'|'chat'|'people'} MeetingPanel */
/** @typedef {'audio'|'camera'|'screen'} MediaRole */

/** @param {{activeScreenShareId?: string|null, pinnedParticipantId?: string|null}} state */
function deriveMeetingLayoutMode(state) {
  return state?.activeScreenShareId
    ? "screen-share"
    : state?.pinnedParticipantId
      ? "pinned"
      : "grid";
}

function visibleParticipantIds(participantOrder, localParticipantId, showSelfView) {
  return (participantOrder || []).filter((id) => showSelfView || id !== localParticipantId);
}

function formatMetric(value, unit = "", placeholder = "No sample") {
  if (value === null || value === undefined || value === "") return placeholder;
  if (typeof value === "number" && !Number.isFinite(value)) return placeholder;
  return `${value}${unit}`;
}

function chooseActiveSpeaker(levels, mutedIds = new Set()) {
  return [...(levels instanceof Map ? levels : new Map())]
    .filter(([id, level]) => !mutedIds.has(id) && Number.isFinite(level))
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))[0]?.[0] || null;
}

function speakerDebounce(previous = {}, level, now, startMs = 300, holdMs = 1000) {
  const speakingNow = Number.isFinite(level) && level > 0;
  const next = { ...previous, since: previous.since ?? now, quietSince: previous.quietSince ?? now };
  if (speakingNow) {
    next.quietSince = now;
    if (!previous.speaking && now - next.since >= startMs) next.speaking = true;
  } else {
    next.since = now;
    if (previous.speaking && now - next.quietSince >= holdMs) next.speaking = false;
  }
  return next;
}

if (typeof module !== "undefined") {
  module.exports = { deriveMeetingLayoutMode, visibleParticipantIds, formatMetric, chooseActiveSpeaker, speakerDebounce };
}
