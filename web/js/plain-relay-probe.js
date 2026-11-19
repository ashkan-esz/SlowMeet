// Plain-relay probe for "Automatic" sessions that fell back to a rotating TURN
// method.
//
// Rotation (relay-rotation.js) exists for networks that degrade a long-lived
// real-time TCP flow about 20 s after it starts. Where the network does not do
// that, a plain relay is the better path: no periodic ICE restarts and far
// fewer TURN allocations. The probe answers "would a plain relay hold up
// here?" without risking the call: app.js sends a steady low-rate echo stream
// through the relay on throwaway connections that never rotate, and this
// module judges the part of the stream that outlives the degradation window.
//
// This module is pure decision logic; app.js owns the connections and timers.
(function exposePlainRelayProbe(root) {
  const probe = Object.freeze({
    // Let the call settle before spending bandwidth on a probe.
    startDelayMs: 10000,
    durationMs: 40000,
    // 50 packets/s of 160 bytes is about 64 kbps: shaped like a voice stream,
    // which is enough to trigger the flow degradation, and cheap next to a call.
    packetIntervalMs: 20,
    packetBytes: 160,
    // With framing the probe is close to 100 kbps for its whole run. It only
    // starts when the bandwidth estimate shows at least this much room above
    // what the call is sending, so it never takes bitrate from a thin link.
    headroomKbps: 150,
    // Only echoes sent after this point are judged: the degradation starts
    // around 20 s into a flow, and the first seconds are always clean.
    judgeFromMs: 25000,
    minJudgedPackets: 300,
    maxLossRatio: 0.02,
    maxEchoMs: 400
  });
  const passTtlMs = 60 * 60 * 1000;
  const failTtlMs = 6 * 60 * 60 * 1000;
  // After a pass suspends rotation, the live call's own round-trip time is the
  // safety net: this many slow samples within the window resumes rotation.
  const guard = Object.freeze({slowRttMs: 500, windowSamples: 10, slowSamples: 3});

  // samples: [{sentAtMs, echoMs}] with sentAtMs relative to the probe start
  // and echoMs null for an echo that never came back.
  // Returns "pass", "fail", or "inconclusive" (too little data to judge).
  function evaluateProbe(samples) {
    const judged = (Array.isArray(samples) ? samples : [])
      .filter((sample) => sample && Number.isFinite(sample.sentAtMs) && sample.sentAtMs >= probe.judgeFromMs);
    if (judged.length < probe.minJudgedPackets) return "inconclusive";
    const lost = judged.filter((sample) => !Number.isFinite(sample.echoMs)).length;
    if (lost / judged.length > probe.maxLossRatio) return "fail";
    if (judged.some((sample) => Number.isFinite(sample.echoMs) && sample.echoMs > probe.maxEchoMs)) return "fail";
    return "pass";
  }

  // Verdicts persist as "pass:<epoch ms>" / "fail:<epoch ms>".
  function encodeVerdict(verdict, nowMs) {
    return verdict === "pass" || verdict === "fail" ? `${verdict}:${Math.round(nowMs)}` : "";
  }

  // Returns the remembered "pass"/"fail" while it is still fresh, else null.
  // Anything unparsable, from the future, or expired is treated as unknown.
  function freshVerdict(raw, nowMs) {
    if (typeof raw !== "string") return null;
    const match = /^(pass|fail):(\d{1,16})$/.exec(raw);
    if (!match || !Number.isFinite(nowMs)) return null;
    const age = nowMs - Number(match[2]);
    if (age < 0) return null;
    return age <= (match[1] === "pass" ? passTtlMs : failTtlMs) ? match[1] : null;
  }

  // Tracks the live call's round-trip time while rotation is suspended.
  // observe(rttMs) returns true when the plain relay has started degrading.
  function createSuspensionGuard() {
    const recent = [];
    return Object.freeze({
      observe(rttMs) {
        if (!Number.isFinite(rttMs)) return false;
        recent.push(rttMs > guard.slowRttMs);
        if (recent.length > guard.windowSamples) recent.shift();
        return recent.filter(Boolean).length >= guard.slowSamples;
      },
      reset() {
        recent.length = 0;
      }
    });
  }

  // Whether the link has room for the probe next to the call. An unknown
  // estimate counts as no room: not probing only means rotation continues.
  function hasHeadroom({availableOutgoingKbps, outgoingVideoKbps, outgoingAudioKbps} = {}) {
    if (!Number.isFinite(availableOutgoingKbps) || availableOutgoingKbps <= 0) return false;
    const sending = [outgoingVideoKbps, outgoingAudioKbps]
      .reduce((total, kbps) => total + (Number.isFinite(kbps) && kbps > 0 ? kbps : 0), 0);
    return availableOutgoingKbps - sending >= probe.headroomKbps;
  }

  const utilities = Object.freeze({
    probe, guard, passTtlMs, failTtlMs, evaluateProbe, encodeVerdict, freshVerdict, createSuspensionGuard,
    hasHeadroom
  });
  root.SlowMeetPlainRelayProbe = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
