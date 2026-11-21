// Room-level network scenarios for the Auto quality ladder: a fast link that
// must reach and hold the top Auto tier, and a four-person room in which the
// participants' links differ (one good link among three bad ones, and the
// other mixes). test-adaptation.js covers each policy function on its own;
// this script drives them together, tick by tick, the way the diagnostics
// loop in web/js/app.js wires them.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  packetLossPercentFromDeltas,
  selectOwnLinkMeasurements,
  classifyParticipantQuality,
  stabilizeParticipantQuality,
  chooseAdaptationLevel,
  createClimbBackoff,
  countLadderRecoverySamples,
  shouldRecoverVideo,
  chooseCameraLayer,
  classifyNetworkSample,
  createRTTBaseline,
  shouldPauseVideo
} = require("../web/js/adaptation-policy.js");

// Auto walks very-slow, slow, normal, high: four levels, top level 3.
const automaticProfileCount = 4;
const topLevel = automaticProfileCount - 1;
// The app starts a session at "normal".
const initialAdaptationLevel = 2;
const localBadge = "local";

// The harness below is a copy of the app's wiring, so it is only worth
// anything while the app still wires the policy the same way. Fail loudly
// when the mirrored statements change instead of testing a stale copy.
{
  const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
  const profilesStart = appSource.indexOf("const profiles = [");
  const profilesEnd = appSource.indexOf("];", profilesStart);
  const profileNames = [...appSource.slice(profilesStart, profilesEnd).matchAll(/name: "([^"]+)"/g)]
    .map((match) => match[1]);
  assert.ok(profilesStart >= 0 && profilesEnd > profilesStart, "the profile table must be readable from app.js");
  assert.equal(profileNames.indexOf("very-good"), automaticProfileCount,
    "the Auto ladder must still end below very-good (four automatic levels)");
  assert.equal(profileNames[topLevel], "high", "the top Auto level must still be the high profile");
  for (const statement of [
    `let adaptationLevel = ${initialAdaptationLevel};`,
    'let cameraLayer = "medium";',
    "const ownLink = selectOwnLinkMeasurements(streamLossSamples, {",
    "values.packetLoss = ownLink.lossPct;",
    "if (ownLink.jitterMs !== null) values.jitterMs = ownLink.jitterMs;",
    "if (stat.jitter != null && !videoSuspended) values.jitterMs = Math.round(stat.jitter * 1000);",
    "if (stat.jitter != null && values.jitterMs == null) values.jitterMs = Math.round(stat.jitter * 1000);",
    "const lossKnown = values.packetLoss != null;",
    "const packetLoss = values.packetLoss ?? 0;",
    "rttBaselineMs: rttBaseline.observe(values.rttMs),",
    "packetLoss: lossKnown ? packetLoss : undefined,",
    "criticalSamples = critical ? criticalSamples + 1 : 0;",
    "const uplinkPoor = uplinkLossPct != null && uplinkLossPct > 5;",
    "poorSamples = poor || uplinkPoor ? poorSamples + 1 : 0;",
    "goodSamples = countLadderRecoverySamples(goodSamples, { transportHealthy, uplinkPoor });",
    "climbBackoff.tick();",
    "climbBackoff.threshold()",
    "climbBackoff.noteStepDown();",
    "climbBackoff.noteClimb();",
    'const atFloorProfile = profile.value === "auto" && adaptationLevel === 0;',
    "const suspendedHealthy = videoSuspended && transportHealthy && !critical;",
    "const recoverable = good || (atFloorProfile && !poor && !critical) || suspendedHealthy;",
    "recoverySamples = recoverable ? recoverySamples + 1 : 0;",
    "const decodeDropsNotNetwork = lossKnown && packetLoss === 0;",
    "decodeDropsNotNetwork ? 0 : values.cameraDroppedFramesPct",
    'if (shouldPauseVideo(profile.value === "auto", adaptationLevel, criticalSamples)) {',
    "} else if (!critical && videoSuspended && shouldRecoverVideo(recoverySamples, recoverable)) {",
    "hasData: values.rttMs != null,",
    "setParticipantQualityFromSample(element, id, classifyParticipantQuality(remoteStats, values.rttMs));"
  ]) {
    assert.ok(appSource.includes(statement),
      `the ladder harness mirrors app.js wiring that has changed: ${statement}`);
  }
}

// The inbound-rtp windows of one tick. A sample either lists them, or gives
// one `packetLoss` percentage (and `jitterMs`) that stands for a single
// measurable camera stream; with neither, no stream is measurable and loss
// and jitter are unknown (the app has no jitter source besides inbound-rtp).
function inboundWindows(sample) {
  if (Array.isArray(sample.streams)) return sample.streams;
  if (!Number.isFinite(sample.packetLoss)) return [];
  const lost = Math.round(sample.packetLoss * 10);
  return [{ kind: "camera", lost, received: 1000 - lost, jitterMs: sample.jitterMs }];
}

// Runs `ticks` diagnostics samples through the Auto ladder exactly as
// web/js/app.js does (the block from the own-link estimate to the video
// pause/resume gates), calling the real policy exports. `sampleAt(tick, view)`
// returns that tick's measurements: rttMs, jitterMs, availableOutgoingKbps,
// packetLoss or streams, and optionally uplinkLossPct, cameraPacketLossPct and
// cameraDroppedFramesPct. Ticks are numbered from 1.
function runLadder(ticks, sampleAt, {
  startLevel = initialAdaptationLevel,
  uplinkLossPct: defaultUplinkLossPct = null,
  simulcastEnabled = false,
  startLayer = "medium"
} = {}) {
  let adaptationLevel = startLevel;
  let poorSamples = 0;
  let goodSamples = 0;
  let criticalSamples = 0;
  let recoverySamples = 0;
  let videoSuspended = false;
  let cameraLayer = startLayer;
  let cameraLayerPoorSamples = 0;
  let cameraLayerGoodSamples = 0;
  const climbBackoff = createClimbBackoff();
  const rttBaseline = createRTTBaseline();
  const badges = new Map();
  const result = {
    climbs: [],
    stepDowns: [],
    pauses: [],
    resumes: [],
    levels: [],
    thresholds: [],
    layers: [],
    samples: []
  };

  for (let tick = 1; tick <= ticks; tick += 1) {
    const sample = sampleAt(tick, { level: adaptationLevel, videoSuspended }) || {};
    const uplinkLossPct = sample.uplinkLossPct !== undefined ? sample.uplinkLossPct : defaultUplinkLossPct;
    const values = {
      rttMs: sample.rttMs ?? null,
      jitterMs: null,
      availableOutgoingKbps: sample.availableOutgoingKbps ?? null
    };

    // Per-stream windows, pooled totals, and per-participant totals, as the
    // stats loop collects them from inbound-rtp counter deltas.
    const streamLossSamples = [];
    const participantStats = new Map();
    let lostPacketsSincePreviousSample = 0;
    let receivedPacketsSincePreviousSample = 0;
    let cameraLostSincePreviousSample = 0;
    let cameraReceivedSincePreviousSample = 0;
    for (const stream of inboundWindows(sample)) {
      lostPacketsSincePreviousSample += stream.lost;
      receivedPacketsSincePreviousSample += stream.received;
      streamLossSamples.push({
        lossPct: packetLossPercentFromDeltas(stream.lost, stream.received),
        receivedDelta: stream.received,
        jitterMs: stream.jitterMs ?? null,
        participantID: stream.participantID
      });
      if (stream.kind === "camera") {
        cameraLostSincePreviousSample += stream.lost;
        cameraReceivedSincePreviousSample += stream.received;
      }
      // The in-loop fallback as app.js builds it: an inbound video stream's
      // jitter overwrites (ignored while this sender's own video is
      // suspended), an audio stream's only fills a missing value.
      if (stream.jitterMs != null) {
        if (stream.kind === "audio") {
          if (values.jitterMs == null) values.jitterMs = stream.jitterMs;
        } else if (!videoSuspended) {
          values.jitterMs = stream.jitterMs;
        }
      }
      if (stream.participantID) {
        const stats = participantStats.get(stream.participantID) || {
          hasData: false, lostPackets: 0, receivedPackets: 0
        };
        stats.hasData = true;
        stats.lostPackets += stream.lost;
        stats.receivedPackets += stream.received;
        participantStats.set(stream.participantID, stats);
      }
    }

    const ownLink = selectOwnLinkMeasurements(streamLossSamples, {
      pooledLossPct: packetLossPercentFromDeltas(
        lostPacketsSincePreviousSample,
        receivedPacketsSincePreviousSample
      ),
      fallbackJitterMs: values.jitterMs,
      // What the server's source_quality relay delivers: each remote
      // sender's own reported uplink (absent for an older server).
      senderUplink: (participantID) => sample.senderUplinks?.get(participantID) || null
    });
    values.packetLoss = ownLink.lossPct;
    if (ownLink.jitterMs !== null) values.jitterMs = ownLink.jitterMs;
    values.cameraPacketLossPct = sample.cameraPacketLossPct !== undefined
      ? sample.cameraPacketLossPct
      : packetLossPercentFromDeltas(cameraLostSincePreviousSample, cameraReceivedSincePreviousSample);
    values.cameraDroppedFramesPct = sample.cameraDroppedFramesPct ?? null;
    const lossKnown = values.packetLoss != null;

    // Tile badges: the local tile is judged on RTT alone, each remote tile on
    // the loss of that participant's own streams.
    const badgeCandidates = new Map([[localBadge, classifyParticipantQuality(
      { hasData: values.rttMs != null, packetLossPct: null }, values.rttMs
    )]]);
    for (const [participantID, stats] of participantStats) {
      badgeCandidates.set(participantID, classifyParticipantQuality({
        hasData: stats.hasData,
        packetLossPct: packetLossPercentFromDeltas(stats.lostPackets, stats.receivedPackets)
      }, values.rttMs));
    }
    for (const [participantID, candidate] of badgeCandidates) {
      const previous = badges.get(participantID) || { quality: "unknown", poorSamples: 0, goodSamples: 0 };
      badges.set(participantID, stabilizeParticipantQuality(
        previous.quality, candidate, previous.poorSamples, previous.goodSamples
      ));
    }

    const packetLoss = values.packetLoss ?? 0;
    const networkCondition = classifyNetworkSample({
      rttMs: values.rttMs,
      rttBaselineMs: rttBaseline.observe(values.rttMs),
      packetLoss: lossKnown ? packetLoss : undefined,
      jitterMs: values.jitterMs,
      availableOutgoingKbps: values.availableOutgoingKbps
    });
    const { poor, critical, good, transportHealthy } = networkCondition;
    criticalSamples = critical ? criticalSamples + 1 : 0;

    const uplinkPoor = uplinkLossPct != null && uplinkLossPct > 5;
    poorSamples = poor || uplinkPoor ? poorSamples + 1 : 0;
    goodSamples = countLadderRecoverySamples(goodSamples, { transportHealthy, uplinkPoor });
    climbBackoff.tick();
    const transition = chooseAdaptationLevel(
      adaptationLevel,
      poorSamples,
      goodSamples,
      automaticProfileCount,
      climbBackoff.threshold()
    );
    if (transition.reset === "poor") {
      result.stepDowns.push({ tick, from: adaptationLevel, to: transition.level });
      adaptationLevel = transition.level;
      poorSamples = 0;
      goodSamples = 0;
      climbBackoff.noteStepDown();
    } else if (transition.reset === "good") {
      result.climbs.push({ tick, from: adaptationLevel, to: transition.level });
      adaptationLevel = transition.level;
      poorSamples = 0;
      goodSamples = 0;
      climbBackoff.noteClimb();
    }

    const atFloorProfile = adaptationLevel === 0;
    const suspendedHealthy = videoSuspended && transportHealthy && !critical;
    const recoverable = good || (atFloorProfile && !poor && !critical) || suspendedHealthy;
    recoverySamples = recoverable ? recoverySamples + 1 : 0;
    if (simulcastEnabled) {
      const decodeDropsNotNetwork = lossKnown && packetLoss === 0;
      const layerDecision = chooseCameraLayer(
        cameraLayer, cameraLayerPoorSamples, cameraLayerGoodSamples,
        values.cameraPacketLossPct,
        decodeDropsNotNetwork ? 0 : values.cameraDroppedFramesPct
      );
      cameraLayerPoorSamples = layerDecision.poorSamples;
      cameraLayerGoodSamples = layerDecision.goodSamples;
      cameraLayer = layerDecision.layer;
    }
    if (shouldPauseVideo(true, adaptationLevel, criticalSamples)) {
      criticalSamples = 0;
      recoverySamples = 0;
      if (!videoSuspended) {
        videoSuspended = true;
        result.pauses.push(tick);
      }
    } else if (!critical && videoSuspended && shouldRecoverVideo(recoverySamples, recoverable)) {
      recoverySamples = 0;
      videoSuspended = false;
      result.resumes.push(tick);
    }

    result.levels.push(adaptationLevel);
    result.thresholds.push(climbBackoff.threshold());
    result.layers.push(cameraLayer);
    result.samples.push({
      tick,
      packetLoss: values.packetLoss,
      jitterMs: values.jitterMs,
      poor,
      critical,
      good,
      transportHealthy,
      videoSuspended,
      badgeCandidates: Object.fromEntries(badgeCandidates),
      badges: Object.fromEntries([...badges].map(([id, badge]) => [id, badge.quality]))
    });
  }

  result.level = adaptationLevel;
  result.threshold = climbBackoff.threshold();
  result.videoSuspended = videoSuspended;
  result.cameraLayer = cameraLayer;
  return result;
}

const ticksOf = (events) => events.map((event) => event.tick);
const levelAt = (result, tick) => result.levels[tick - 1];
const sampleOf = (result, tick) => result.samples[tick - 1];

const fastLink = { rttMs: 5, packetLoss: 0, jitterMs: 1, availableOutgoingKbps: 50000 };
const poorLink = { rttMs: 400, packetLoss: 8, jitterMs: 20, availableOutgoingKbps: 300 };

// Fast steady state: a link at the good end of every metric climbs from the
// starting level to the top Auto level on the first five samples and then
// stays there. Nothing may step it down, lengthen the climb, or pause video.
{
  const steady = runLadder(300, () => fastLink, { uplinkLossPct: 0 });
  assert.deepEqual(steady.climbs, [{ tick: 5, from: 2, to: 3 }],
    "a fast link must make exactly one climb, on its fifth sample, from the starting level to the top");
  assert.deepEqual(steady.stepDowns, [], "a fast link must never step down");
  assert.equal(steady.level, topLevel, "a fast link must finish at the top Auto level");
  assert.ok(steady.levels.slice(4).every((level) => level === topLevel),
    "a fast link must hold the top Auto level on every sample after the climb");
  assert.ok(steady.thresholds.every((threshold) => threshold === 5),
    "a fast link must never lengthen the climb threshold");
  assert.equal(steady.threshold, 5, "the climb threshold must rest at its base on a fast link");
  assert.deepEqual(steady.pauses, [], "a fast link must never pause video");
  assert.equal(steady.videoSuspended, false, "a fast link must keep sending video");
  assert.ok(
    steady.samples.every((sample) => sample.good && sample.transportHealthy && !sample.poor && !sample.critical),
    "every sample of a fast link must classify good and transport-healthy"
  );

  // Wherever the ladder starts, five samples per level take it to the top.
  for (const [startLevel, climbTicks] of [[0, [5, 10, 15]], [1, [5, 10]], [2, [5]], [3, []]]) {
    const fromLevel = runLadder(120, () => fastLink, { startLevel, uplinkLossPct: 0 });
    assert.deepEqual(ticksOf(fromLevel.climbs), climbTicks,
      `a fast link starting at level ${startLevel} must climb one level every five samples`);
    assert.equal(fromLevel.level, topLevel, `a fast link starting at level ${startLevel} must reach the top`);
    assert.deepEqual(fromLevel.stepDowns, [], `a fast link starting at level ${startLevel} must never step down`);
    assert.deepEqual(fromLevel.pauses, [], `a fast link starting at level ${startLevel} must never pause video`);
  }

  // A fast link is still fast while a metric is not reported yet: browsers
  // omit jitter and loss before the first inbound window, report a zero
  // bandwidth estimate while it warms up, and round a LAN round trip to zero.
  // The sender's own uplink loss is also unknown until the SFU's first
  // receiver report.
  for (const [name, overrides, options] of [
    ["jitter not reported", { jitterMs: undefined }],
    ["bandwidth estimate still zero", { availableOutgoingKbps: 0 }],
    ["bandwidth estimate not reported", { availableOutgoingKbps: undefined }],
    ["inbound loss not measurable", { packetLoss: undefined }],
    ["round trip reported as zero", { rttMs: 0 }],
    ["round trip not reported", { rttMs: undefined }],
    ["only the round trip reported", { packetLoss: undefined, jitterMs: undefined, availableOutgoingKbps: undefined }],
    // A zero round trip is a measurement, not a missing one: alone, it must
    // still carry the climb.
    ["only a zero round trip reported",
      { rttMs: 0, packetLoss: undefined, jitterMs: undefined, availableOutgoingKbps: undefined }],
    ["own uplink loss not reported", {}, { uplinkLossPct: null }]
  ]) {
    const partial = runLadder(300, () => ({ ...fastLink, ...overrides }), { uplinkLossPct: 0, ...options });
    assert.ok(partial.samples.every((sample) => sample.transportHealthy && !sample.poor && !sample.critical),
      `a fast link with ${name} must stay transport-healthy`);
    assert.deepEqual(partial.climbs, [{ tick: 5, from: 2, to: 3 }],
      `a fast link with ${name} must still climb to the top on its fifth sample`);
    assert.deepEqual(partial.stepDowns, [], `a fast link with ${name} must never step down`);
    assert.equal(partial.level, topLevel, `a fast link with ${name} must hold the top Auto level`);
    assert.deepEqual(partial.pauses, [], `a fast link with ${name} must never pause video`);
  }

  // With no measurable signal at all there is nothing to climb on.
  const silent = runLadder(60, () => ({}));
  assert.deepEqual(silent.climbs, [], "samples without any measurement must not climb the ladder");
  assert.deepEqual(silent.stepDowns, [], "samples without any measurement must not step the ladder down");
  assert.equal(silent.level, initialAdaptationLevel, "samples without any measurement must hold the level");
  assert.ok(
    silent.samples.every((sample) => !sample.good && !sample.transportHealthy && !sample.poor && !sample.critical),
    "samples without any measurement must classify as neither good nor poor"
  );

  // A bandwidth estimate alone cannot vouch for the link either: no transport
  // metric is measured, so nothing counts toward the climb.
  const estimateOnly = runLadder(60, () => ({ availableOutgoingKbps: 50000 }));
  assert.deepEqual(estimateOnly.climbs, [], "a bandwidth estimate without any transport metric must not climb the ladder");
  assert.equal(estimateOnly.level, initialAdaptationLevel, "a bandwidth estimate alone must hold the level");

  // A fast link over a long path (a relay, another continent): the round trip
  // sits at 180 ms, above the fixed 120 ms healthy bar, but it is the path's
  // own floor, so the link still climbs to the top on its fifth sample.
  const longPath = runLadder(300, () => ({ ...fastLink, rttMs: 180 }), { uplinkLossPct: 0 });
  assert.deepEqual(longPath.climbs, [{ tick: 5, from: 2, to: 3 }],
    "a clean link whose round-trip floor is 180 ms must still climb to the top on its fifth sample");
  assert.deepEqual(longPath.stepDowns, [], "a clean long-path link must never step down");
  assert.ok(longPath.levels.slice(4).every((level) => level === topLevel), "a clean long-path link must hold the top level");

  // The same 180 ms as a rise on a short path is not a floor: the link neither
  // climbs nor steps down while the round trip sits between the healthy and
  // the poor bar.
  const risen = runLadder(120, (tick) => ({ ...fastLink, rttMs: tick <= 5 ? 20 : 180 }),
    { startLevel: 1, uplinkLossPct: 0 });
  assert.deepEqual(risen.climbs, [{ tick: 5, from: 1, to: 2 }],
    "a round trip that rose from 20 ms to 180 ms must stop the climb");
  assert.deepEqual(risen.stepDowns, [], "a 180 ms round trip is not poor and must not step down");
  assert.equal(risen.level, 2, "a link whose round trip rose above the healthy bar must hold its level");
}

// A single blip at the ceiling: an isolated lossy sample every twenty seconds
// on an otherwise fast link must not cost the top level, because a step down
// needs two consecutive poor samples.
{
  const lossBlip = { ...fastLink, packetLoss: 6 };
  const blips = runLadder(300, (tick) => (tick % 20 === 0 ? lossBlip : fastLink),
    { startLevel: topLevel, uplinkLossPct: 0 });
  assert.equal(blips.samples.filter((sample) => sample.poor).length, 15,
    "the scenario must contain fifteen isolated poor samples");
  assert.deepEqual(blips.stepDowns, [], "an isolated poor sample must not step the top level down");
  assert.deepEqual(blips.climbs, [], "the ladder must have nothing to climb back from");
  assert.ok(blips.levels.every((level) => level === topLevel), "isolated blips must leave the top level untouched");
  assert.deepEqual(blips.pauses, [], "isolated blips must never pause video");

  // The same blip on the sender's own uplink behaves the same way.
  const uplinkBlips = runLadder(300, (tick) => ({ ...fastLink, uplinkLossPct: tick % 20 === 0 ? 6 : 0 }),
    { startLevel: topLevel });
  assert.deepEqual(uplinkBlips.stepDowns, [], "an isolated uplink-loss sample must not step the top level down");
  assert.equal(uplinkBlips.level, topLevel, "isolated uplink blips must leave the top level untouched");

  // Below the ceiling an uplink blip does cost something: it restarts the
  // climb streak, so the climb lands five samples after the blip.
  const climbingUplinkBlip = runLadder(60, (tick) => ({ ...fastLink, uplinkLossPct: tick === 3 ? 6 : 0 }));
  assert.deepEqual(climbingUplinkBlip.climbs, [{ tick: 8, from: 2, to: 3 }],
    "one uplink-loss sample must restart the climb streak");
  assert.deepEqual(climbingUplinkBlip.stepDowns, [], "one uplink-loss sample must not step down");

  // A sender whose own uplink keeps losing 8 % walks to the floor although
  // everything it receives is clean, never climbs, and (uplink loss being
  // poor, not critical) keeps sending video.
  const lossyUplink = runLadder(120, () => fastLink, { startLevel: topLevel, uplinkLossPct: 8 });
  assert.ok(lossyUplink.samples.every((sample) => sample.good && sample.packetLoss === 0),
    "the inbound side of a sender with a lossy uplink must still read clean");
  assert.deepEqual(ticksOf(lossyUplink.stepDowns), [2, 4, 6], "a sustained lossy uplink must walk the sender to the floor");
  assert.deepEqual(lossyUplink.climbs, [], "a sustained lossy uplink must not climb");
  assert.equal(lossyUplink.level, 0, "a sustained lossy uplink must rest at the floor");
  assert.deepEqual(lossyUplink.pauses, [], "a lossy uplink alone must not pause video");

  // Two poor samples in a row are what a step down takes: exactly one level,
  // regained after five clean samples, and (not following a climb) without
  // lengthening the next climb.
  const doubleBlip = runLadder(60, (tick) => (tick === 20 || tick === 21 ? lossBlip : fastLink),
    { startLevel: topLevel, uplinkLossPct: 0 });
  assert.deepEqual(doubleBlip.stepDowns, [{ tick: 21, from: 3, to: 2 }],
    "two consecutive poor samples must step the top level down exactly once");
  assert.deepEqual(doubleBlip.climbs, [{ tick: 26, from: 2, to: 3 }],
    "five clean samples after a double blip must restore the top level");
  assert.ok(doubleBlip.thresholds.every((threshold) => threshold === 5),
    "a step down that does not follow a climb must not lengthen the next climb");
}

// Recovery to the top: a poor phase walks the ladder to the floor, one climb
// attempt fails (stepped back down inside the failure window), and then the
// link turns fast for good. The one failed climb doubles the threshold, so
// the way back up takes ten samples per level instead of five; it must still
// be monotonic, and the threshold returns to its base once a climb has held.
{
  const fastFrom = 28;
  const phaseAt = (tick) => {
    if (tick <= 10) return fastLink;          // established at the top
    if (tick <= 20) return poorLink;          // walks 3 -> 0
    if (tick <= 25) return fastLink;          // five clean samples: climb to 1
    if (tick <= 27) return poorLink;          // the climb fails
    return fastLink;                          // fast for good
  };
  const recovery = runLadder(120, phaseAt, { startLevel: topLevel, uplinkLossPct: 0 });
  assert.deepEqual(recovery.stepDowns, [
    { tick: 12, from: 3, to: 2 },
    { tick: 14, from: 2, to: 1 },
    { tick: 16, from: 1, to: 0 },
    { tick: 27, from: 1, to: 0 }
  ], "the poor phase must walk to the floor and the failed climb must step back down");
  assert.equal(levelAt(recovery, 20), 0, "the poor phase must end at the floor");
  assert.equal(recovery.thresholds[25], 5, "a climb that has not failed yet must not lengthen the threshold");
  assert.equal(recovery.thresholds[26], 10, "exactly one failed climb must double the threshold once");
  assert.equal(Math.max(...recovery.thresholds), 10, "one failed climb must not lengthen the threshold past ten");
  assert.deepEqual(recovery.climbs, [
    { tick: 25, from: 0, to: 1 },
    { tick: 37, from: 0, to: 1 },
    { tick: 47, from: 1, to: 2 },
    { tick: 57, from: 2, to: 3 }
  ], "after one failed climb a fast link must climb one level every ten samples");
  const reachedTopAt = recovery.levels.findIndex((level, index) => index + 1 >= fastFrom && level === topLevel) + 1;
  assert.equal(reachedTopAt - fastFrom + 1, 30, "the fast link must be back at the top after thirty samples");
  assert.ok(reachedTopAt - fastFrom + 1 <= 60, "the fast link must be back at the top within sixty samples");
  const recoveryLevels = recovery.levels.slice(fastFrom - 1);
  assert.ok(recoveryLevels.every((level, index) => index === 0 || level >= recoveryLevels[index - 1]),
    "the climb back on a fast link must never step down");
  assert.equal(recovery.level, topLevel, "the recovered link must hold the top level");
  // The last climb is at tick 57; it has held for more than fifteen samples
  // from tick 73 on.
  assert.equal(recovery.thresholds[71], 10, "the threshold must stay lengthened while the last climb is on probation");
  assert.equal(recovery.thresholds[72], 5, "a climb that has held for more than fifteen samples must restore the base threshold");
  assert.equal(recovery.threshold, 5, "the recovered link must end with the base climb threshold");
  assert.deepEqual(recovery.pauses, [], "a poor but not critical phase must not pause video");
}

// One remote sender as one tick of the stats loop sees it: a camera and an
// audio inbound-rtp window that lost `uplinkLossPct` on the sender's uplink
// and `ownDownlinkLossPct` on the receiver's own downlink.
function remoteSender(participantID, uplinkLossPct, { ownDownlinkLossPct = 0, jitterMs = 3 } = {}) {
  const delivered = (1 - uplinkLossPct / 100) * (1 - ownDownlinkLossPct / 100);
  return [["camera", 200], ["audio", 100]].map(([kind, packets]) => {
    const received = Math.round(packets * delivered);
    return { participantID, kind, lost: packets - received, received, jitterMs };
  });
}

// The inbound side of a four-person room for one participant: three remote
// senders, each with its own uplink: either a loss percentage, or
// { lossPct, jitterMs } for an uplink that also queues.
function roomStreams(uplinks, options) {
  return uplinks.flatMap((uplink, index) => {
    const { lossPct, jitterMs } = typeof uplink === "number" ? { lossPct: uplink } : uplink;
    return remoteSender(`remote-${index + 1}`, lossPct, jitterMs === undefined ? options : { ...options, jitterMs });
  });
}

// The senders' own uplink reports, keyed like roomStreams' participants, as
// each sender measures its uplink and the server relays it (source_quality).
// A stream's jitter in this model is the sender's uplink queueing plus the
// receiver's own path (ownPathJitterMs, remoteSender's default 3 ms), so a
// queueing sender reports the part above the receiver's path.
function senderReports(uplinks, ownPathJitterMs = 3) {
  return new Map(uplinks.map((uplink, index) => {
    const { lossPct, jitterMs } = typeof uplink === "number" ? { lossPct: uplink } : uplink;
    return [`remote-${index + 1}`, { lossPct, jitterMs: jitterMs === undefined ? 0 : Math.max(0, jitterMs - ownPathJitterMs) }];
  }));
}

const goodParticipantLink = { rttMs: 20, availableOutgoingKbps: 5000 };
const goodParticipantSample = (uplinkLossPcts) => ({
  ...goodParticipantLink,
  streams: roomStreams(uplinkLossPcts),
  senderUplinks: senderReports(uplinkLossPcts)
});
// The same room seen without the senders' reports (an older server or
// clients): the receiver can only take the cleanest stream as its own link.
const goodParticipantSampleWithoutReports = (uplinkLossPcts) => ({
  ...goodParticipantLink,
  streams: roomStreams(uplinkLossPcts)
});

// Room mixes, seen from the participant with the good link (20 ms round trip,
// 5 Mbps estimate, clean own uplink). As long as one remote sender's stream
// arrives clean, the minimum per-stream loss proves the good participant's
// own path and the ladder holds the top level whatever the others' uplinks do.
for (const [name, uplinkLossPcts] of [
  ["4 good", [0, 0, 0]],
  ["3 good / 1 bad", [0, 0, 12]],
  ["2 good / 2 bad", [0, 8, 12]],
  ["2 good / 2 bad, critical uplinks", [0, 40, 60]],
  // Bad uplinks queue as well as drop: the bad senders' streams arrive with
  // poor (90 ms) and critical (150 ms) jitter.
  ["2 good / 2 bad, lossy and jittery uplinks", [0, { lossPct: 8, jitterMs: 90 }, { lossPct: 12, jitterMs: 150 }]],
  ["2 good / 2 bad, jittery uplinks without loss", [{ lossPct: 0, jitterMs: 150 }, 0, { lossPct: 0, jitterMs: 90 }]]
]) {
  const mix = runLadder(300, () => goodParticipantSample(uplinkLossPcts), { startLevel: topLevel, uplinkLossPct: 0 });
  assert.ok(mix.samples.every((sample) => sample.packetLoss === 0 && sample.jitterMs === 3 && sample.good),
    `${name}: one clean inbound stream must keep the good participant's own-link sample good`);
  assert.deepEqual(mix.stepDowns, [], `${name}: the good participant must never step down`);
  assert.ok(mix.levels.every((level) => level === topLevel), `${name}: the good participant must hold the top level`);
  assert.deepEqual(mix.pauses, [], `${name}: the good participant must never pause video`);

  const joining = runLadder(60, () => goodParticipantSample(uplinkLossPcts), { uplinkLossPct: 0 });
  assert.deepEqual(joining.climbs, [{ tick: 5, from: 2, to: 3 }],
    `${name}: a good participant joining the room must reach the top on its fifth sample`);
}

// 1 good / 3 bad: every remote sender has a lossy uplink, so the good
// participant has no clean inbound stream at all.
//
// Loss and queueing on the three senders' uplinks reach the good participant
// exactly as its own downlink's would. Each sender now reports its own uplink
// and the server relays it (source_quality), so the good participant
// discounts it: its own-link sample stays good, it holds level 3 and keeps
// sending video. Before (B1), and still without the reports, it read its own
// perfect link as poor, walked 3 -> 0, and paused its camera once the
// cleanest remote uplink lost more than 10 %.
{
  // Three lossy remote uplinks seen over a clean own link, and three clean
  // senders seen over an own downlink that really loses 8 %, now get
  // different verdicts: stepping down is right for the second only. Without
  // the senders' reports the two remain indistinguishable.
  const verdictOf = (run) => ({
    stepDowns: run.stepDowns,
    levels: run.levels,
    samples: run.samples.map(({ packetLoss, poor, critical, good }) => ({ packetLoss, poor, critical, good }))
  });
  const lossyRemoteUplinks = runLadder(30, () => goodParticipantSample([8, 12, 9]),
    { startLevel: topLevel, uplinkLossPct: 0 });
  const lossyOwnDownlink = runLadder(30, () => ({
    ...goodParticipantLink,
    streams: roomStreams([0, 0, 0], { ownDownlinkLossPct: 8 })
  }), { startLevel: topLevel, uplinkLossPct: 0 });
  assert.equal(lossyOwnDownlink.level, 0, "an own downlink that loses 8 % must walk the ladder to the floor");
  assert.notDeepEqual(verdictOf(lossyRemoteUplinks), verdictOf(lossyOwnDownlink),
    "with the senders' reports, remote uplink loss must not read as own downlink loss");
  assert.equal(lossyRemoteUplinks.level, topLevel, "lossy remote uplinks must leave the good participant at the top level");
  const unreportedRemoteUplinks = runLadder(30, () => goodParticipantSampleWithoutReports([8, 12, 9]),
    { startLevel: topLevel, uplinkLossPct: 0 });
  assert.deepEqual(verdictOf(unreportedRemoteUplinks), verdictOf(lossyOwnDownlink),
    "without the senders' reports remote uplink loss still reads as own downlink loss");

  const healAt = 61;
  // With the senders' reports every row holds: the own-link sample stays good,
  // nothing steps down or pauses, and the good participant stays at the top
  // through a minute of bad remote uplinks and their healing.
  const allBadUplinkRows = [
    { name: "moderate bad uplinks (8/12/9 %)", uplinkLossPcts: [8, 12, 9] },
    { name: "severe bad uplinks (11/12/14 %)", uplinkLossPcts: [11, 12, 14] },
    {
      // Uplinks that queue without dropping anything: the jitter estimate
      // discounts the senders' reported uplink jitter the same way.
      name: "queueing bad uplinks (no loss, jitter 60/90/70 ms)",
      uplinkLossPcts: [{ lossPct: 0, jitterMs: 60 }, { lossPct: 0, jitterMs: 90 }, { lossPct: 0, jitterMs: 70 }]
    }
  ];
  for (const row of allBadUplinkRows) {
    // The bad uplinks hold for a minute, then heal.
    const run = runLadder(120, (tick) => goodParticipantSample(tick < healAt ? row.uplinkLossPcts : [0, 0, 0]),
      { startLevel: topLevel, uplinkLossPct: 0 });
    const whileBad = run.samples.slice(0, healAt - 1);
    assert.ok(whileBad.every((sample) => sample.packetLoss === 0),
      `${row.name}: once the senders' uplink loss is discounted the own-link loss reads 0`);
    assert.ok(whileBad.every((sample) => sample.jitterMs === 3),
      `${row.name}: once the senders' uplink jitter is discounted the own-link jitter is the own path's`);
    assert.ok(whileBad.every((sample) => !sample.poor && !sample.critical),
      `${row.name}: the good participant's own-link sample stays good`);
    assert.deepEqual(run.stepDowns, [], `${row.name}: the good participant never steps down`);
    assert.ok(run.levels.every((level) => level === topLevel), `${row.name}: the good participant holds the top level`);
    assert.deepEqual(run.pauses, [], `${row.name}: the good participant never pauses its video`);
    assert.deepEqual(run.resumes, [], `${row.name}: there is nothing to resume`);
    assert.deepEqual(run.climbs, [], `${row.name}: there is nothing to climb back`);
    assert.equal(run.videoSuspended, false, `${row.name}: the good participant ends with video sending`);
  }

  // A good participant already at the floor when the remote uplinks turn
  // critical keeps its camera too; without the reports it used to lose it on
  // the third sample.
  const atFloor = runLadder(10, () => goodParticipantSample([11, 12, 14]), { startLevel: 0, uplinkLossPct: 0 });
  assert.deepEqual(atFloor.pauses, [],
    "at the floor, critical remote uplink loss must not pause the good participant's video");
  const atFloorUnreported = runLadder(10, () => goodParticipantSampleWithoutReports([11, 12, 14]),
    { startLevel: 0, uplinkLossPct: 0 });
  assert.deepEqual(atFloorUnreported.pauses, [3],
    "without the senders' reports, three critical samples of remote uplink loss still pause the video");
}

// 4 bad: here the observed participant's own link really is lossy (8 % each
// way, 120 ms round trip), so stepping down to the floor is the right answer.
//
// Each inbound stream compounds the sender's uplink loss with the observer's
// own 8 % downlink loss (about 15 %, critical). With the senders' reports the
// observer discounts their share and reads its own 8 %: poor, at the floor,
// and not paused. Before (B1) the compounded estimate paused its camera.
{
  const badParticipantSample = {
    rttMs: 120,
    availableOutgoingKbps: 400,
    uplinkLossPct: 8,
    streams: roomStreams([8, 12, 9], { ownDownlinkLossPct: 8, jitterMs: 12 }),
    senderUplinks: senderReports([8, 12, 9])
  };
  const allBad = runLadder(120, () => badParticipantSample, { startLevel: topLevel });
  assert.deepEqual(ticksOf(allBad.stepDowns), [2, 4, 6], "4 bad: a participant on a lossy link must walk to the floor");
  assert.ok(allBad.levels.slice(5).every((level) => level === 0), "4 bad: a participant on a lossy link must stay at the floor");
  assert.deepEqual(allBad.climbs, [], "4 bad: a participant on a lossy link must not attempt a climb");
  assert.ok(allBad.samples.every((sample) => sample.packetLoss >= 7 && sample.packetLoss <= 9 && !sample.critical),
    "4 bad: with the senders' uplink loss discounted the own-link estimate reads the own link's 8 %");
  assert.deepEqual(allBad.pauses, [], "4 bad: an own link losing 8 % rests at the floor without pausing video");
  assert.equal(allBad.videoSuspended, false, "4 bad: video keeps sending at the floor");
  const allBadUnreported = runLadder(120, () => ({ ...badParticipantSample, senderUplinks: undefined }),
    { startLevel: topLevel });
  assert.deepEqual(allBadUnreported.pauses, [6],
    "4 bad without the senders' reports: the compounded estimate still pauses video on reaching the floor");

  // The own link alone at the same 8 % (clean remote senders): poor, at the
  // floor, and not paused, which is what the row above now reads too.
  const ownLinkOnly = runLadder(120, () => ({
    ...badParticipantSample,
    streams: roomStreams([0, 0, 0], { ownDownlinkLossPct: 8, jitterMs: 12 }),
    senderUplinks: senderReports([0, 0, 0])
  }), { startLevel: topLevel });
  assert.ok(ownLinkOnly.samples.every((sample) => sample.packetLoss === 8 && sample.poor && !sample.critical),
    "an 8 % own link alone reads poor, not critical");
  assert.deepEqual(ticksOf(ownLinkOnly.stepDowns), [2, 4, 6], "an 8 % own link alone walks to the floor");
  assert.deepEqual(ownLinkOnly.pauses, [], "an 8 % own link alone must not pause video");
}

// Remote badges against the own verdict, on the same ticks: each remote tile
// is judged on that sender's own streams, while the ladder is judged on the
// own-link estimate. A bad sender must wear the warning without dragging the
// good participant down, as long as one clean stream exists.
{
  const badgesFor = (uplinkLossPcts, ticks = 5) =>
    runLadder(ticks, () => goodParticipantSample(uplinkLossPcts), { startLevel: topLevel, uplinkLossPct: 0 });

  // Four-person room, one clean sender among two bad ones.
  const twoBad = badgesFor([0, 8, 12]);
  assert.deepEqual(sampleOf(twoBad, 1).badgeCandidates,
    { local: "good", "remote-1": "good", "remote-2": "poor", "remote-3": "poor" },
    "each sample must judge every remote sender on its own streams");
  assert.deepEqual(sampleOf(twoBad, 1).badges,
    { local: "unknown", "remote-1": "unknown", "remote-2": "unknown", "remote-3": "unknown" },
    "one sample must not mark any tile yet");
  assert.deepEqual(sampleOf(twoBad, 2).badges,
    { local: "unknown", "remote-1": "unknown", "remote-2": "poor", "remote-3": "poor" },
    "two consecutive poor samples must mark the bad senders' tiles poor");
  assert.deepEqual(sampleOf(twoBad, 4).badges,
    { local: "unknown", "remote-1": "unknown", "remote-2": "poor", "remote-3": "poor" },
    "four healthy samples must not mark the local and the clean sender's tiles good yet");
  assert.deepEqual(sampleOf(twoBad, 5).badges,
    { local: "good", "remote-1": "good", "remote-2": "poor", "remote-3": "poor" },
    "five healthy samples must mark the local and the clean sender's tiles good");
  assert.ok(twoBad.samples.every((sample) => sample.good && !sample.poor),
    "the own-link verdict must stay good on the very samples that mark two senders poor");
  assert.equal(twoBad.level, topLevel, "bad senders' badges must not cost the good participant its level");

  // Three bad senders and one clean one: a fourth remote stream, so a
  // five-person room (in a four-person room three bad senders leave no clean
  // stream; that is the pinned case below).
  const threeBadOneClean = badgesFor([8, 12, 9, 0]);
  assert.deepEqual(sampleOf(threeBadOneClean, 5).badges,
    { local: "good", "remote-1": "poor", "remote-2": "poor", "remote-3": "poor", "remote-4": "good" },
    "three bad senders must wear the warning while the clean sender and the local tile stay good");
  assert.ok(threeBadOneClean.samples.every((sample) => sample.good && !sample.poor && sample.packetLoss === 0),
    "one clean stream must keep the own-link verdict good while three senders are marked poor");
  assert.equal(threeBadOneClean.level, topLevel, "one clean stream must keep the good participant at the top level");

  // Degraded, not poor: a 3 % uplink marks its sender degraded only.
  assert.equal(sampleOf(badgesFor([0, 3, 12]), 2).badges["remote-2"], "degraded",
    "a sender losing 3 % must be marked degraded, not poor");

  // Four-person room, all three remote senders bad: the badges mark the three
  // senders poor and the local tile good, and with the senders' reports the
  // ladder's own-link verdict agrees with the local tile (B1: it used to read
  // poor and step the good participant down twice in five samples).
  const threeBad = badgesFor([8, 12, 9]);
  assert.deepEqual(sampleOf(threeBad, 5).badges,
    { local: "good", "remote-1": "poor", "remote-2": "poor", "remote-3": "poor" },
    "three bad senders must wear the warning while the local tile reads good");
  assert.ok(threeBad.samples.every((sample) => !sample.poor),
    "with no clean stream but the senders' reports, the own-link verdict must not read poor");
  assert.equal(threeBad.level, topLevel, "with the senders' reports the good participant holds the top level");
}

// The simulcast layer on a perfect link: the requested camera layer starts at
// medium, reaches high on the fifth clean sample, and holds.
{
  const perfect = runLadder(300, () => fastLink, { uplinkLossPct: 0, simulcastEnabled: true });
  assert.equal(perfect.layers[3], "medium", "four clean samples must not raise the camera layer yet");
  assert.equal(perfect.layers[4], "high", "the fifth clean sample must raise the camera layer to high");
  assert.ok(perfect.layers.slice(4).every((layer) => layer === "high"),
    "a perfect link must hold the high camera layer");
  assert.equal(perfect.cameraLayer, "high", "a perfect link must finish on the high camera layer");

  const fromLow = runLadder(300, () => fastLink, { uplinkLossPct: 0, simulcastEnabled: true, startLayer: "low" });
  assert.deepEqual([fromLow.layers[3], fromLow.layers[4], fromLow.layers[8], fromLow.layers[9]],
    ["low", "medium", "medium", "high"], "a perfect link must raise the camera layer one step every five samples");
  assert.ok(fromLow.layers.slice(9).every((layer) => layer === "high"),
    "a perfect link must hold the high camera layer after climbing from low");

  // A slow decoder on a perfect link drops frames without any packet loss.
  // With measured loss at zero the app leaves those drops out of the layer
  // decision, so the layer still reaches high and holds.
  const slowDecoder = runLadder(300, () => ({ ...fastLink, cameraDroppedFramesPct: 30 }),
    { uplinkLossPct: 0, simulcastEnabled: true });
  assert.equal(slowDecoder.layers[4], "high", "decode-only frame drops must not delay the high camera layer");
  assert.ok(slowDecoder.layers.slice(4).every((layer) => layer === "high"),
    "decode-only frame drops on a perfect link must not lower the camera layer");

  // The allowance is tied to a measured loss of exactly zero (app.js:
  // `lossKnown && packetLoss === 0`). With any measured loss, here 0.5 %,
  // which by itself still counts as a good camera sample, the same frame
  // drops are charged to the network and lower the layer. This contrast
  // shows the harness applies the app's rule and not a blanket exemption.
  const lossyDecoder = runLadder(20, () => ({ ...fastLink, packetLoss: 0.5, cameraDroppedFramesPct: 30 }),
    { uplinkLossPct: 0, simulcastEnabled: true, startLayer: "high" });
  assert.ok(lossyDecoder.samples.every((sample) => sample.packetLoss === 0.5 && sample.good),
    "0.5 % loss must still classify as a good link");
  assert.deepEqual([lossyDecoder.layers[0], lossyDecoder.layers[1], lossyDecoder.layers[3]],
    ["high", "medium", "low"], "frame drops alongside any measured packet loss lower the camera layer");
  assert.equal(lossyDecoder.cameraLayer, "low", "frame drops alongside measured packet loss hold the low camera layer");
}

console.log("Room network scenario tests passed");
