function normalizePacketCounter(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(0, count) : 0;
}

function normalizePacketLoss10(packetLoss) {
  if (packetLoss === null || packetLoss === undefined ||
      !Number.isFinite(packetLoss) || packetLoss < 0) {
    return -1;
  }
  return Math.min(1000, Math.round(packetLoss * 10));
}

function packetLossPercentFromDeltas(lostPackets, receivedPackets) {
  if (!Number.isFinite(lostPackets) || lostPackets < 0 ||
      !Number.isFinite(receivedPackets) || receivedPackets < 0) {
    return null;
  }
  const totalPackets = lostPackets + receivedPackets;
  if (totalPackets <= 0) return null;
  return Number((lostPackets / totalPackets * 100).toFixed(1));
}

function packetCounterDeltas(previous, current) {
  if (!previous || !current ||
      !Number.isFinite(previous.lost) || previous.lost < 0 ||
      !Number.isFinite(previous.received) || previous.received < 0 ||
      !Number.isFinite(current.lost) || current.lost < 0 ||
      !Number.isFinite(current.received) || current.received < 0 ||
      current.lost < previous.lost || current.received < previous.received) {
    return null;
  }
  return {
    lost: current.lost - previous.lost,
    received: current.received - previous.received
  };
}

function classifyParticipantQuality(stats, rttMs) {
  if (!stats || !stats.hasData) return "unknown";
  const loss = Number.isFinite(stats.packetLossPct) && stats.packetLossPct >= 0
    ? stats.packetLossPct
    : null;
  if ((loss != null && loss > 5) || (rttMs != null && rttMs > 300)) return "poor";
  if ((loss != null && loss >= 2) || (rttMs != null && rttMs >= 150)) return "degraded";
  if (loss != null || rttMs != null) return "good";
  return "unknown";
}

function stabilizeParticipantQuality(current, candidate, poorSamples = 0, goodSamples = 0) {
  const quality = ["good", "degraded", "poor", "unknown"].includes(current) ? current : "unknown";
  if (candidate === "unknown") {
    return { quality, poorSamples: 0, goodSamples: 0 };
  }
  if (candidate === "good") {
    const nextGoodSamples = goodSamples + 1;
    return {
      quality: nextGoodSamples >= 5 ? "good" : quality,
      poorSamples: 0,
      goodSamples: nextGoodSamples
    };
  }
  if (candidate !== "degraded" && candidate !== "poor") {
    return { quality, poorSamples: 0, goodSamples: 0 };
  }
  const nextPoorSamples = poorSamples + 1;
  return {
    quality: nextPoorSamples >= 2 ? candidate : quality,
    poorSamples: nextPoorSamples,
    goodSamples: 0
  };
}

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

function sampleMinimumJitterBufferTarget(previous, stat) {
  const emittedCount = stat?.jitterBufferEmittedCount;
  const minimumDelay = stat?.jitterBufferMinimumDelay;
  const id = stat?.id;
  if (typeof id !== "string" || !Number.isFinite(emittedCount) || emittedCount < 0 ||
      !Number.isFinite(minimumDelay) || minimumDelay < 0) {
    return { state: previous || null, targetMs: null };
  }

  const state = previous && previous.id === id
    ? { ...previous, recent: [...previous.recent] }
    : { id, emittedCount, minimumDelay, recent: [] };
  if (previous && previous.id === id) {
    const emittedDelta = emittedCount - state.emittedCount;
    const delayDelta = minimumDelay - state.minimumDelay;
    if (emittedDelta < 0 || delayDelta < 0) {
      return { state: { id, emittedCount, minimumDelay, recent: [] }, targetMs: null };
    }
    state.emittedCount = emittedCount;
    state.minimumDelay = minimumDelay;
    if (emittedDelta > 0) {
      state.recent.push(delayDelta / emittedDelta * 1000);
      if (state.recent.length > 3) state.recent.shift();
    }
  }

  if (state.recent.length === 0) return { state, targetMs: null };
  const sorted = [...state.recent].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
  return { state, targetMs: Math.min(4000, Math.max(0, Math.round(median))) };
}

function setVideoJitterBufferTarget(receiver, targetMs) {
  if (!receiver || !("jitterBufferTarget" in receiver) ||
      !Number.isFinite(targetMs) || targetMs < 0) return false;
  const boundedTarget = Math.min(4000, Math.max(0, Math.round(targetMs)));
  try {
    if (receiver.jitterBufferTarget === boundedTarget) return true;
    receiver.jitterBufferTarget = boundedTarget;
    return receiver.jitterBufferTarget === boundedTarget;
  } catch (_) {
    return false;
  }
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
  // Browsers report zero while the bandwidth estimate is still warming up.
  const capacityKnown = Number.isFinite(availableOutgoingKbps) && availableOutgoingKbps > 0;
  const hasSignal = rttKnown || lossKnown || jitterKnown || capacityKnown;
  const poor = (rttKnown && rttMs > 250) || (lossKnown && packetLoss > 5) ||
    (jitterKnown && jitterMs > 50) || (capacityKnown && isBelowBitrate(availableOutgoingKbps, 220));
  // Capacity estimates can briefly under-report while a sender starts or resumes.
  // Use measured transport impairment to decide when video must be suspended.
  const critical = (rttKnown && rttMs > 500) || (lossKnown && packetLoss > 10) ||
    (jitterKnown && jitterMs > 120);
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
    normalizePacketCounter,
    normalizePacketLoss10,
    packetCounterDeltas,
    packetLossPercentFromDeltas,
    classifyParticipantQuality,
    stabilizeParticipantQuality,
    chooseAdaptationLevel,
    shouldRecoverVideo,
    chooseCameraLayer,
    applyServerDefaults,
    resolveCodecName,
    profileNameForQuality,
    isBelowBitrate,
    selectedCandidatePair,
    selectedCandidatePairRTT,
    sampleMinimumJitterBufferTarget,
    setVideoJitterBufferTarget,
    formatRTT,
    classifyNetworkSample,
    shouldPauseVideo,
    chooseParticipantLayout
  };
}
