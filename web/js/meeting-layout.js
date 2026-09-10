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

/**
 * @param {{width: number, height: number, count: number, orientation?: 'vertical'|'horizontal', gap?: number, minTileWidth?: number, minTileHeight?: number, aspectRatio?: number}} options
 */
function chooseFilmstripLayout({
  width,
  height,
  count,
  orientation = "vertical",
  gap = 12,
  minTileWidth = 160,
  minTileHeight = 90,
  aspectRatio = 16 / 9
}) {
  const participantCount = Math.max(0, Math.floor(Number(count) || 0));
  const stripWidth = Math.max(0, Number(width) || 0);
  const stripHeight = Math.max(0, Number(height) || 0);
  if (participantCount === 0 || stripWidth === 0 || stripHeight === 0) {
    return { columns: 0, rows: 0, tileWidth: 0, tileHeight: 0, overflow: false };
  }

  if (orientation === "horizontal") {
    const tileWidth = Math.min(Math.floor(stripWidth), minTileWidth);
    const tileHeight = Math.min(minTileHeight, Math.floor(tileWidth / aspectRatio));
    return {
      columns: participantCount,
      rows: 1,
      tileWidth,
      tileHeight,
      overflow: tileWidth * participantCount + gap * (participantCount - 1) > stripWidth
    };
  }

  const availableHeight = (stripHeight - gap * (participantCount - 1)) / participantCount;
  const tileHeight = Math.max(minTileHeight, Math.floor(availableHeight));
  return {
    columns: 1,
    rows: participantCount,
    tileWidth: Math.floor(stripWidth),
    tileHeight,
    overflow: tileHeight * participantCount + gap * (participantCount - 1) > stripHeight
  };
}

if (typeof module !== "undefined") {
  module.exports = {
    deriveMeetingLayoutMode,
    visibleParticipantIds,
    formatMetric,
    chooseActiveSpeaker,
    speakerDebounce,
    chooseFilmstripLayout
  };
}
