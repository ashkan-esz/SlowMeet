function chooseAdaptationLevel(level, poorSamples, goodSamples, profileCount) {
  if (poorSamples >= 2 && level > 0) {
    return { level: level - 1, reset: "poor" };
  }
  if (goodSamples >= 5 && level < profileCount - 1) {
    return { level: level + 1, reset: "good" };
  }
  return { level, reset: null };
}

function shouldRecoverVideo(goodSamples, isGood, threshold = 5) {
  return isGood && goodSamples >= threshold;
}

function applyServerDefaults(profile, defaults, enabled) {
  if (!enabled || !profile) return profile;
  return {
    ...profile,
    fps: defaults.videoFPS,
    audioBitrate: defaults.audioBitrate
  };
}

function resolveCodecName(codecById, codecId) {
  if (!codecId) return null;
  return codecById.get(codecId) || codecId;
}

function profileNameForQuality(quality) {
  return {
    low: "slow",
    medium: "normal",
    high: "high",
    "very-good": "very-good",
    ultra: "ultra"
  }[quality] || "high";
}

function isBelowBitrate(value, threshold) {
  return Number.isFinite(value) && value >= 0 && value < threshold;
}

function chooseParticipantLayout({
  width,
  height,
  count,
  gap = 12,
  aspectRatio = 16 / 9,
  minTileWidth = 144,
  minTileHeight = 88,
  maxTileWidth = 720,
  preferredColumns = 0,
  maxColumns = 0
}) {
  const participantCount = Math.max(0, Math.floor(Number(count) || 0));
  const stageWidth = Math.max(0, Number(width) || 0);
  const stageHeight = Math.max(0, Number(height) || 0);
  if (participantCount === 0 || stageWidth === 0 || stageHeight === 0) {
    return { columns: 1, rows: 0, tileWidth: 0, tileHeight: 0, rowCounts: [] };
  }

  const candidates = [];
  const twoColumnWidth = minTileWidth * 2 + gap;
  const participantColumnLimit = maxColumns > 0
    ? Math.min(participantCount, Math.floor(maxColumns))
    : participantCount < 9
    ? (stageWidth < twoColumnWidth ? 1 : Math.min(2, participantCount))
    : participantCount;
  for (let columns = 1; columns <= participantColumnLimit; columns += 1) {
    const rows = Math.ceil(participantCount / columns);
    const availableWidth = (stageWidth - gap * (columns - 1)) / columns;
    const availableHeight = (stageHeight - gap * (rows - 1)) / rows;
    if (availableWidth <= 0 || availableHeight <= 0) continue;
    const tileWidth = Math.min(availableWidth, availableHeight * aspectRatio, maxTileWidth);
    const tileHeight = tileWidth / aspectRatio;
    const belowMinimum = tileWidth < minTileWidth || tileHeight < minTileHeight;
    const area = tileWidth * tileHeight * participantCount;
    const wastedWidth = Math.max(0, stageWidth - (tileWidth * columns + gap * (columns - 1)));
    const wastedHeight = Math.max(0, stageHeight - (tileHeight * rows + gap * (rows - 1)));
    const stabilityBonus = preferredColumns === columns ? 0.06 : 0;
    const rowCounts = Array.from({ length: rows }, (_, row) =>
      Math.min(columns, participantCount - row * columns));
    candidates.push({
      columns,
      rows,
      tileWidth,
      tileHeight,
      rowCounts,
      score: (belowMinimum ? area * 0.2 : area) -
        (wastedWidth * wastedHeight * 0.08) + area * stabilityBonus
    });
  }

  const fallback = { columns: 1, rows: participantCount, tileWidth: 0, tileHeight: 0, rowCounts: [participantCount] };
  const usableCandidates = candidates.filter((candidate) => !candidate.belowMinimum);
  if (participantCount < 9 && usableCandidates.length > 0) {
    const widestUsable = usableCandidates.reduce((best, candidate) =>
      candidate.columns > best.columns ? candidate : best);
    return widestUsable;
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0] || fallback;
}

if (typeof module !== "undefined") {
  module.exports = {
    chooseAdaptationLevel,
    shouldRecoverVideo,
    applyServerDefaults,
    resolveCodecName,
    profileNameForQuality,
    isBelowBitrate,
    chooseParticipantLayout
  };
}
