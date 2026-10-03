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

function chooseCameraLayer(layer, poorSamples, goodSamples, packetLossPct, droppedFramesPct) {
  const layers = ["low", "medium", "high"];
  const current = layers.includes(layer) ? layer : "medium";
  const measurements = [packetLossPct, droppedFramesPct]
    .filter((value) => Number.isFinite(value) && value >= 0);
  const poor = measurements.some((value) => value >= 5);
  const good = measurements.length > 0 && measurements.every((value) => value < 1);
  if (poor) {
    const nextPoorSamples = poorSamples + 1;
    return {
      layer: nextPoorSamples >= 2 && current !== "low" ? layers[layers.indexOf(current) - 1] : current,
      poorSamples: nextPoorSamples >= 2 ? 0 : nextPoorSamples,
      goodSamples: 0
    };
  }
  if (good) {
    const nextGoodSamples = goodSamples + 1;
    return {
      layer: nextGoodSamples >= 5 && current !== "high" ? layers[layers.indexOf(current) + 1] : current,
      poorSamples: 0,
      goodSamples: nextGoodSamples >= 5 ? 0 : nextGoodSamples
    };
  }
  return { layer: current, poorSamples: 0, goodSamples: 0 };
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

function selectedCandidatePair(report) {
  const stats = Array.isArray(report) ? report : Array.from(report?.values?.() || []);
  const pairs = new Map(stats
    .filter((stat) => stat.type === "candidate-pair" && stat.state === "succeeded")
    .map((stat) => [stat.id, stat]));

  for (const stat of stats) {
    if (stat.type !== "transport" || !stat.selectedCandidatePairId) continue;
    const selected = pairs.get(stat.selectedCandidatePairId);
    if (selected) return selected;
  }

  return stats.find((stat) => stat.type === "candidate-pair" && stat.state === "succeeded" &&
    (stat.selected === true || stat.nominated === true)) || null;
}

function selectedCandidatePairRTT(report) {
  const seconds = selectedCandidatePair(report)?.currentRoundTripTime;
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function formatRTT(rttMs) {
  if (!Number.isFinite(rttMs) || rttMs < 0) return null;
  if (rttMs < 1) return "<1 ms";
  return `${Number(rttMs.toFixed(1))} ms`;
}

function classifyNetworkSample({ rttMs, packetLoss, jitterMs, availableOutgoingKbps } = {}) {
  const rttKnown = Number.isFinite(rttMs) && rttMs >= 0;
  const lossKnown = Number.isFinite(packetLoss) && packetLoss >= 0;
  const jitterKnown = Number.isFinite(jitterMs) && jitterMs >= 0;
  const capacityKnown = Number.isFinite(availableOutgoingKbps) && availableOutgoingKbps >= 0;
  const hasSignal = rttKnown || lossKnown || jitterKnown || capacityKnown;
  const poor = (rttKnown && rttMs > 250) || (lossKnown && packetLoss > 5) ||
    (jitterKnown && jitterMs > 50) || isBelowBitrate(availableOutgoingKbps, 220);
  const critical = (rttKnown && rttMs > 500) || (lossKnown && packetLoss > 10) ||
    (jitterKnown && jitterMs > 120) || isBelowBitrate(availableOutgoingKbps, 120);
  const good = hasSignal && !poor && !critical && (!rttKnown || rttMs < 120) && (!lossKnown || packetLoss < 1) &&
    (!jitterKnown || jitterMs < 30) && (!capacityKnown || availableOutgoingKbps >= 350);
  return { poor, critical, good };
}

function shouldPauseVideo(isAutomaticProfile, adaptationLevel, criticalSamples, threshold = 3) {
  return criticalSamples >= threshold && (!isAutomaticProfile || adaptationLevel === 0);
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
    return { columns: 1, rows: 0, tileWidth: 0, tileHeight: 0, rowCounts: [], overflow: false };
  }

  const candidates = [];
  const participantColumnLimit = maxColumns > 0
    ? Math.min(participantCount, Math.floor(maxColumns))
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
    const stabilityBonus = preferredColumns === columns ? 0.06 : 0;
    const rowCounts = Array.from({ length: rows }, (_, row) =>
      Math.min(columns, participantCount - row * columns));
    candidates.push({
      columns,
      rows,
      tileWidth,
      tileHeight,
      rowCounts,
      belowMinimum,
      overflow: false,
      score: (belowMinimum ? area * 0.2 : area) + area * stabilityBonus
    });
  }

  const fallback = { columns: 1, rows: participantCount, tileWidth: 0, tileHeight: 0, rowCounts: [participantCount], overflow: false };
  const usableCandidates = candidates.filter((candidate) => !candidate.belowMinimum);
  if (participantCount === 3) {
    const balancedCandidate = usableCandidates.find((candidate) => candidate.columns === 2);
    if (balancedCandidate) return balancedCandidate;
  }
  const rankedCandidates = usableCandidates.length > 0 ? usableCandidates : candidates;
  rankedCandidates.sort((left, right) =>
    right.score - left.score || left.columns - right.columns);
  return rankedCandidates[0] || fallback;
}

if (typeof module !== "undefined") {
  module.exports = {
    chooseAdaptationLevel,
    shouldRecoverVideo,
    chooseCameraLayer,
    applyServerDefaults,
    resolveCodecName,
    profileNameForQuality,
    isBelowBitrate,
    selectedCandidatePair,
    selectedCandidatePairRTT,
    formatRTT,
    classifyNetworkSample,
    shouldPauseVideo,
    chooseParticipantLayout
  };
}
