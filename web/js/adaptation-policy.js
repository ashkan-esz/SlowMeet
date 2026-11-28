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

const climbBaseSamples = 5;
const climbMaxSamples = 60;
const failedClimbWindowSamples = 15;

function chooseAdaptationLevel(level, poorSamples, goodSamples, profileCount, climbSamples = climbBaseSamples) {
  if (poorSamples >= 2 && level > 0) {
    return { level: level - 1, reset: "poor" };
  }
  if (goodSamples >= climbSamples && level < profileCount - 1) {
    return { level: level + 1, reset: "good" };
  }
  return { level, reset: null };
}

// How many healthy samples the next climb needs. A link whose real capacity
// lies between two levels looks healthy at the lower one (the sender is not
// saturating it) and congested at the higher one, so a fixed threshold flips
// between them every few seconds, and each flip re-applies sender parameters
// and capture constraints (a resolution change costs a keyframe). A climb
// that is stepped back down within failedClimbWindowSamples doubles the
// threshold for the next attempt, up to climbMaxSamples; a climb that holds
// past that window restores the base threshold.
//
// A climb only raises what this participant sends, so it fails on the send
// path: its own uplink loses packets or the round trip grows as the queue
// fills (also on a link whose up and down directions share one queue). A
// step-down on inbound loss or jitter alone — remote senders' uplinks, or
// their reports arriving late — is not a failed climb, and doubling there
// kept a participant on a fast link below the top level long after the
// remote damage was discounted. noteStepDown(onSendPath) says which it was.
function createClimbBackoff() {
  let samples = climbBaseSamples;
  let sinceClimb = null;

  return {
    threshold: () => samples,
    // Once per classified network sample.
    tick() {
      if (sinceClimb === null) return;
      sinceClimb += 1;
      if (sinceClimb > failedClimbWindowSamples) {
        samples = climbBaseSamples;
        sinceClimb = null;
      }
    },
    noteClimb() {
      sinceClimb = 0;
    },
    noteStepDown(onSendPath = true) {
      if (sinceClimb === null) return;
      if (onSendPath) samples = Math.min(climbMaxSamples, samples * 2);
      sinceClimb = null;
    },
    reset() {
      samples = climbBaseSamples;
      sinceClimb = null;
    }
  };
}

// How the ladder accumulates climbing samples from one classified network
// sample: every transport-healthy sample without a degraded uplink counts
// toward the climb. The `good` bar alone cannot gate the climb, because the
// estimate is starved by the sender itself — each profile below the bar
// sends less than the bar demands (very-slow ~114 kbps, slow ~200 kbps vs
// the 350 kbps bar), and once the estimate dips under the 220 kbps *poor*
// bar the sample reads poor forever (observed: 102 consecutive poor samples
// on a fully healed link, BWE 191 kbps, level frozen at 0).
// `transportHealthy` — clean RTT/loss/jitter, ignoring the starved estimate
// — is the decidable signal for exactly that state (mirroring the
// video-resume allowance). A degraded uplink counts as nothing: the sender
// is saturating its own path and the climb must wait for the back-off to
// take effect. Samples with real transport damage or no measurable signal
// also count as nothing, and a congesting upgrade steps back down through
// the existing hysteresis.
function countLadderRecoverySamples(goodSamples, { transportHealthy, uplinkPoor }) {
  if (uplinkPoor) return 0;
  if (transportHealthy) return goodSamples + 1;
  return 0;
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

// planCameraSimulcast fits the camera's three simulcast encodings (rids low,
// medium, high) to the capture size. Chrome caps the number of simulcast
// layers by input resolution (three from 960x540, two from 480x270, one
// below that) and keeps the LOWEST encodings: with fixed 4/2/1 scale factors,
// a 360x240 capture became a single 90x60 layer carrying 15% of the bitrate
// for every receiver (B12 in docs/network-testing.md). The plan keeps the
// same cap so every browser sends the same layers, scales the top active
// layer to the full capture size, and gives the active layers the whole
// bitrate.
function planCameraSimulcast(width, height) {
  const pixels = Number(width) * Number(height);
  let count = 1;
  if (Number.isFinite(pixels) && pixels >= 960 * 540) count = 3;
  else if (Number.isFinite(pixels) && pixels >= 480 * 270) count = 2;
  const sharesByCount = { 1: [1], 2: [0.3, 0.7], 3: [0.15, 0.3, 0.55] };
  const shares = sharesByCount[count];
  return {
    count,
    active: [0, 1, 2].map((index) => index < count),
    scales: [0, 1, 2].map((index) => index < count ? 2 ** (count - 1 - index) : 1),
    shares: [0, 1, 2].map((index) => shares[index] || 0)
  };
}

// fitCameraSimulcastEncodings writes one planCameraSimulcast plan to a
// simulcast camera's encodings: which layers run, their scales and their
// bitrates together. The writers used to split this: the profile pass wrote
// the whole plan, while the post-negotiation reconcile and the pause/resume
// write recomputed the plan but wrote only `active`. When the capture size
// changed between the two (a 360x240 `slow` capture going to 640x360), a
// resume or reconcile switched on the medium layer of a one-layer plan,
// leaving two full-size layers: low at the whole bitrate and medium at the
// 0.15 fallback share, 60 kbit/s at 400 kbit/s (B12). A capture with no
// known size keeps the size of the last fit (`fallback`). Returns whether
// any field changed.
function fitCameraSimulcastEncodings(encodings, { width, height, bitrate, fps, sending, fallback } = {}) {
  if (!Array.isArray(encodings)) return false;
  const known = (value) => Number.isFinite(Number(value)) && Number(value) > 0;
  const size = known(width) && known(height)
    ? { width: Number(width), height: Number(height) }
    : { width: fallback?.width, height: fallback?.height };
  const plan = planCameraSimulcast(size.width, size.height);
  let changed = false;
  encodings.forEach((encoding, index) => {
    const wanted = {
      active: Boolean(sending && plan.active[index]),
      scaleResolutionDownBy: plan.scales[index]
    };
    if (known(bitrate)) wanted.maxBitrate = Math.max(30000, Math.floor(bitrate * (plan.shares[index] || 0.15)));
    if (known(fps)) wanted.maxFramerate = fps;
    for (const [key, value] of Object.entries(wanted)) {
      if (encoding[key] !== value) {
        encoding[key] = value;
        changed = true;
      }
    }
  });
  return changed;
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

// RTT bands are judged against the path's own floor, not only against fixed
// numbers. A relayed or long-distance path can sit at 150-250 ms while
// perfectly healthy; with fixed bands such a path could step quality down but
// never climb back, and an automatic video pause could never lift. The fixed
// values stay as the minimum of each band, so a short path behaves exactly as
// before, and the floor is capped so a path that was already congested when
// its floor was learned cannot excuse itself.
const rttBaselineCapMs = 300;

function rttThresholds(baselineMs) {
  const baseline = Number.isFinite(baselineMs) && baselineMs > 0 ? Math.min(baselineMs, rttBaselineCapMs) : 0;
  return {
    healthyBelowMs: Math.max(120, baseline + 60),
    poorAboveMs: Math.max(250, baseline + 150),
    criticalAboveMs: Math.max(500, baseline + 400)
  };
}

// Tracks the lowest RTT seen recently as the path's floor. Two rotating
// buckets give a window of one to two bucket lengths without storing every
// sample: a path change to a longer route is learned after the old bucket
// rotates out, and a shorter route is learned at once.
function createRTTBaseline(bucketSamples = 60) {
  let currentMin = null;
  let previousMin = null;
  let count = 0;

  function value() {
    if (currentMin === null) return previousMin;
    return previousMin === null ? currentMin : Math.min(currentMin, previousMin);
  }

  function observe(rttMs) {
    if (!Number.isFinite(rttMs) || rttMs < 0) return value();
    if (count >= bucketSamples) {
      previousMin = currentMin;
      currentMin = null;
      count = 0;
    }
    currentMin = currentMin === null ? rttMs : Math.min(currentMin, rttMs);
    count += 1;
    return value();
  }

  function reset() {
    currentMin = null;
    previousMin = null;
    count = 0;
  }

  return { observe, value, reset };
}

function classifyNetworkSample({ rttMs, packetLoss, jitterMs, availableOutgoingKbps, rttBaselineMs } = {}) {
  const { healthyBelowMs, poorAboveMs, criticalAboveMs } = rttThresholds(rttBaselineMs);
  const rttKnown = Number.isFinite(rttMs) && rttMs >= 0;
  const lossKnown = Number.isFinite(packetLoss) && packetLoss >= 0;
  const jitterKnown = Number.isFinite(jitterMs) && jitterMs >= 0;
  // Browsers report zero while the bandwidth estimate is still warming up.
  const capacityKnown = Number.isFinite(availableOutgoingKbps) && availableOutgoingKbps > 0;
  const hasSignal = rttKnown || lossKnown || jitterKnown || capacityKnown;
  const poor = (rttKnown && rttMs > poorAboveMs) || (lossKnown && packetLoss > 5) ||
    (jitterKnown && jitterMs > 50) || (capacityKnown && isBelowBitrate(availableOutgoingKbps, 220));
  // Capacity estimates can briefly under-report while a sender starts or resumes.
  // Use measured transport impairment to decide when video must be suspended.
  const critical = (rttKnown && rttMs > criticalAboveMs) || (lossKnown && packetLoss > 10) ||
    (jitterKnown && jitterMs > 120);
  const good = hasSignal && !poor && !critical && (!rttKnown || rttMs < healthyBelowMs) && (!lossKnown || packetLoss < 1) &&
    (!jitterKnown || jitterMs < 30) && (!capacityKnown || availableOutgoingKbps >= 350);
  // While video is suspended almost nothing is sent, so the bandwidth
  // estimate starves below every capacity bar and can no longer distinguish
  // congestion from idleness. Recovery from an automatic pause must therefore
  // also be able to key on transport health alone (RTT/loss/jitter in the
  // good band), ignoring the starved capacity estimate. At least one transport
  // metric must be measured — capacity alone cannot vouch for health.
  const transportHealthy = (rttKnown || lossKnown || jitterKnown) && !critical &&
    (!rttKnown || rttMs < healthyBelowMs) && (!lossKnown || packetLoss < 1) && (!jitterKnown || jitterMs < 30);
  // The part of `poor` that this participant's own sending can cause: a
  // queue building on its path (round trip) or a starved send estimate. Loss
  // and jitter here are inbound, measured on what the others send.
  const sendPathPoor = (rttKnown && rttMs > poorAboveMs) || (capacityKnown && isBelowBitrate(availableOutgoingKbps, 220));
  return { poor, critical, good, transportHealthy, sendPathPoor };
}

function shouldPauseVideo(isAutomaticProfile, adaptationLevel, criticalSamples, threshold = 3) {
  return criticalSamples >= threshold && (!isAutomaticProfile || adaptationLevel === 0);
}

// Estimate the receiver's own-link loss and jitter from per-stream
// measurements. Both metrics measured on one inbound stream mix the sender's
// uplink with the shared downlink, so pooling every stream blames the
// receiver's link for a remote sender's congestion — in a mixed-quality room
// that suspends video room-wide. A stream can only arrive with LOW loss and
// LOW jitter if the receiver's own path delivers it intact, so the minimum
// per-stream values are the best own-link estimate. Streams with too few
// packets in the window are too noisy to trust (and suspended streams report
// none at all), so they are skipped; with no qualifying stream, fall back to
// the pooled loss / the caller's previous jitter signal.
//
// The minimum still blames the receiver when every remote sender is on a bad
// uplink (B1 in docs/network-testing.md). senderUplink(participantID, stream),
// when given, returns what that sender's stream loses and queues before it
// leaves the SFU ({ lossPct, jitterMs }, relayed by the server as
// source_quality; the loss is per stream kind) or null; each stream is then
// discounted by its sender's share before the minimum is taken: the loss the
// receiver's own path adds is 1 - (1 - observed) / (1 - senderUplinkLoss),
// and its jitter is what remains above the sender's uplink jitter. Streams
// without a sender report are taken as they are.
//
// A stream whose sender already loses maxSenderLossPct or more says almost
// nothing about the receiver's own link: its few surviving packets are noise,
// and the discount divides by what is left, so a 2-point gap between a
// sender's report and its stream reads as 7-10 % own loss at 70-85 %, while a
// receiver's real 12 % hides inside the report's own variation. Such streams
// are skipped; when only they remain the own link is unmeasurable from the
// streams (lossPct and jitterMs null, unmeasurable true), not the pooled
// value they would pollute. The round trip and the send path still judge
// the link.
function selectOwnLinkMeasurements(streams, {
  pooledLossPct = null,
  fallbackJitterMs = null,
  minimumPackets = 5,
  senderUplink = null,
  maxSenderLossPct = 50,
  minimumPooledPackets = 20
} = {}) {
  // Streams with a sender report are pooled: every packet the receiver got
  // against every packet its own path was handed (each stream's expected
  // packets after its sender's reported loss). The minimum over discounted
  // streams was biased toward zero: a video stream with five packets in a
  // second reads 0 % about a third of the time at 20 % loss, and over-stated
  // reports cancel more on some streams than others, so a receiver's own
  // 12 % download loss read as 0 % (bad-downlink-among-bad-senders). Streams
  // without a report keep the minimum: a clean one proves the receiver's path.
  // A pool of fewer than minimumPooledPackets is noise (at the onset of a
  // sender's outage only a few late video packets remain: 6 packets read as
  // 13-31 % own loss on a clean link), so it counts as unmeasurable.
  let unreportedBestLoss = null;
  let reportedReceived = 0;
  let reportedExpectedOwnPath = 0;
  let bestJitter = null;
  let unmeasuredStreams = false;
  for (const stream of Array.isArray(streams) ? streams : []) {
    if (!stream || !Number.isFinite(stream.receivedDelta) || stream.receivedDelta < minimumPackets) continue;
    const uplink = typeof senderUplink === "function" && stream.participantID
      ? senderUplink(stream.participantID, stream)
      : null;
    const reported = Number.isFinite(uplink?.lossPct) && uplink.lossPct >= 0;
    if (reported && uplink.lossPct >= maxSenderLossPct) {
      unmeasuredStreams = true;
      continue;
    }
    const lossPct = stream.lossPct;
    if (Number.isFinite(lossPct) && lossPct >= 0 && lossPct < 100) {
      if (reported) {
        const expected = stream.receivedDelta / (1 - lossPct / 100);
        reportedReceived += stream.receivedDelta;
        reportedExpectedOwnPath += expected * (1 - uplink.lossPct / 100);
      } else if (unreportedBestLoss === null || lossPct < unreportedBestLoss) {
        unreportedBestLoss = lossPct;
      }
    }
    let jitterMs = stream.jitterMs;
    if (Number.isFinite(jitterMs) && jitterMs >= 0 && Number.isFinite(uplink?.jitterMs) && uplink.jitterMs > 0) {
      jitterMs = Math.max(0, jitterMs - uplink.jitterMs);
    }
    if (Number.isFinite(jitterMs) && jitterMs >= 0 &&
        (bestJitter === null || jitterMs < bestJitter)) {
      bestJitter = jitterMs;
    }
  }
  const pooledEnough = reportedReceived >= minimumPooledPackets;
  if (reportedExpectedOwnPath > 0 && !pooledEnough) unmeasuredStreams = true;
  const reportedLoss = reportedExpectedOwnPath > 0 && pooledEnough
    ? Math.max(0, Math.round((1 - reportedReceived / reportedExpectedOwnPath) * 1000) / 10)
    : null;
  const bestLoss = reportedLoss === null ? unreportedBestLoss
    : (unreportedBestLoss === null ? reportedLoss : Math.min(reportedLoss, unreportedBestLoss));
  if (bestLoss === null && bestJitter === null && unmeasuredStreams) {
    return { lossPct: null, jitterMs: null, unmeasurable: true };
  }
  // Streams that could not be measured (near-outage senders, a pool too
  // small) must not fall back to the pooled loss they would pollute.
  return {
    lossPct: bestLoss !== null ? bestLoss
      : (!unmeasuredStreams && Number.isFinite(pooledLossPct) && pooledLossPct >= 0 ? pooledLossPct : null),
    jitterMs: bestJitter !== null ? bestJitter
      : (Number.isFinite(fallbackJitterMs) && fallbackJitterMs >= 0 ? fallbackJitterMs : null)
  };
}

// The receiver's own-link loss and jitter: the SFU's measurement of this
// participant's download when it has a recent one, otherwise the estimate
// from the inbound streams (selectOwnLinkMeasurements). The SFU measures the
// download from this browser's transport-cc feedback about the SFU's own
// packets (downlink_quality), with nothing of any sender's uplink in it, so
// it holds where the estimate fails: every sender near an outage leaves the
// estimate unmeasurable, and over-stated sender reports cancel real download
// loss (B1, B14 in docs/network-testing.md). `server` is the last
// downlink_quality ({ lossPct, jitterMs, at }) or null; the server re-sends it
// about once a second, so one older than maxAgeMs is stale (an older server,
// a connection without transport-cc, or the first seconds of a call). It drives
// the ladder; the video pause stays on the estimate (pauseCondition in app.js),
// because the server's loss is counted before NACK repairs it.
function chooseOwnLinkQuality(server, estimate, nowMs, { maxAgeMs = 3000 } = {}) {
  const fresh = server && Number.isFinite(server.at) && nowMs - server.at <= maxAgeMs &&
    Number.isFinite(server.lossPct) && server.lossPct >= 0 &&
    Number.isFinite(server.jitterMs) && server.jitterMs >= 0;
  if (fresh) {
    return { lossPct: server.lossPct, jitterMs: server.jitterMs, unmeasurable: false, source: "server" };
  }
  return { ...estimate, unmeasurable: Boolean(estimate?.unmeasurable), source: "estimate" };
}

// What one remote sender's stream loses and queues before it leaves the SFU,
// for selectOwnLinkMeasurements' senderUplink: `source` is the sender's last
// source_quality ({ videoLossPct, audioLossPct, jitterMs, audioJitterMs }, each
// null when unknown) and `stream` the inbound window being discounted. Each
// stream kind takes its own report: a sender that pauses its camera on a bad
// uplink reports no camera jitter, yet its microphone still crosses the same
// queue, and charging that queueing to the receiver's link kept a participant
// on a fast link below the top level. An audio stream without its own jitter
// report falls back to the camera's, as before audio jitter was reported.
function senderUplinkForStream(source, stream) {
  if (!source) return null;
  const audio = stream?.kind === "audio";
  return {
    lossPct: audio ? source.audioLossPct : source.videoLossPct,
    jitterMs: audio && Number.isFinite(source.audioJitterMs) ? source.audioJitterMs : source.jitterMs
  };
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
    selectOwnLinkMeasurements,
    chooseOwnLinkQuality,
    senderUplinkForStream,
    classifyParticipantQuality,
    stabilizeParticipantQuality,
    chooseAdaptationLevel,
    createClimbBackoff,
    shouldRecoverVideo,
    chooseCameraLayer,
    planCameraSimulcast,
    fitCameraSimulcastEncodings,
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
    rttThresholds,
    createRTTBaseline,
    countLadderRecoverySamples,
    shouldPauseVideo,
    chooseParticipantLayout
  };
}
