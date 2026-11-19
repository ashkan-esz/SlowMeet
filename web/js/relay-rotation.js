// Relay rotation for TURN/TCP and TURN/TLS paths.
//
// Some access networks degrade a long-lived real-time TCP flow roughly 20 s
// after it starts: uplink packets on that one connection begin to drop, TCP
// head-of-line blocking turns the loss into multi-second media stalls, and a
// brand-new connection is clean again for the same window. A periodic ICE
// restart makes the browser allocate fresh TURN connections and move media
// onto them before the window closes; Chrome keeps the old pair live until
// the new one is selected, so the switch does not interrupt media.
//
// This module only decides *when* to rotate; app.js sends the ice_restart.
(function exposeRelayRotation(root) {
  const rotatingRelayProtocols = new Set(["tcp", "tls"]);
  // A rotation whose offer never settles must not block later rotations.
  const pendingTimeoutMs = 10000;
  // After a refused rotation (e.g. the server's restart rate limit), retry
  // this long later instead of waiting for a whole interval.
  const failureRetryMs = 5000;
  // Chrome briefly reports the selected pair as "in-progress" while a
  // connectivity check is outstanding, and the stats can momentarily lack a
  // selected pair; only a path that stays off the TCP/TLS relay this long
  // restarts the rotation clock.
  const offRelayGraceMs = 3000;

  // The transport's selected pair in any check state, else a nominated pair.
  function selectedPairAnyState(report) {
    const stats = Array.from(report?.values?.() || []);
    for (const stat of stats) {
      if (stat.type !== "transport" || !stat.selectedCandidatePairId) continue;
      const pair = report.get(stat.selectedCandidatePairId);
      if (pair) return pair;
    }
    return stats.find((stat) => stat.type === "candidate-pair" &&
      (stat.selected === true || (stat.nominated === true && stat.state === "succeeded"))) || null;
  }

  // Returns "tcp"/"tls" when the report's selected pair (an RTCStatsReport or
  // Map) is a TURN relay over TCP or TLS, otherwise null. The pair's check
  // state is deliberately ignored: see offRelayGraceMs.
  function rotatableRelayProtocol(report) {
    const pair = selectedPairAnyState(report);
    if (!pair) return null;
    const local = report.get(pair.localCandidateId);
    if (!local || local.candidateType !== "relay") return null;
    const protocol = String(local.relayProtocol || "").toLowerCase();
    return rotatingRelayProtocols.has(protocol) ? protocol : null;
  }

  // The TURN server URL of the selected local relay candidate, as the browser
  // reports it, or null. A rotation only needs a fresh connection to the
  // server that already works, not one to every configured server.
  function selectedRelayServerURL(report) {
    const pair = selectedPairAnyState(report);
    if (!pair) return null;
    const local = report.get(pair.localCandidateId);
    if (!local || local.candidateType !== "relay") return null;
    return typeof local.url === "string" && local.url !== "" ? local.url : null;
  }

  function createRelayRotation() {
    let intervalMs = 0;
    let anchorMs = null;
    let pendingSinceMs = null;
    // When the last rotation settled. While the browser switches to the fresh
    // pair the stats can briefly show no selected TCP/TLS relay; that gap must
    // not restart the clock, or every cycle would drift by the switch time.
    let settledAtMs = null;
    let offRelaySinceMs = null;

    function setIntervalSeconds(seconds) {
      intervalMs = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
    }

    function reset() {
      anchorMs = null;
      pendingSinceMs = null;
      settledAtMs = null;
      offRelaySinceMs = null;
    }

    // Called once per second. Returns true when the caller should send an
    // ice_restart now (and then call rotationSent).
    function observe({rotatable, connected, busy, nowMs}) {
      if (!intervalMs || !connected) {
        reset();
        return false;
      }
      if (!rotatable) {
        // A brief gap or a switch in progress (pending, or settled within the
        // interval) keeps the clock; otherwise the path really left the
        // TCP/TLS relay and the next relay pair starts a fresh window.
        if (offRelaySinceMs === null) offRelaySinceMs = nowMs;
        const switching = pendingSinceMs !== null ||
          (settledAtMs !== null && nowMs - settledAtMs < intervalMs);
        if (!switching && nowMs - offRelaySinceMs >= offRelayGraceMs) {
          anchorMs = null;
          settledAtMs = null;
        }
        return false;
      }
      offRelaySinceMs = null;
      if (anchorMs === null) {
        anchorMs = nowMs;
        return false;
      }
      if (pendingSinceMs !== null) {
        if (nowMs - pendingSinceMs < pendingTimeoutMs) return false;
        pendingSinceMs = null;
      }
      if (busy) return false;
      return nowMs - anchorMs >= intervalMs;
    }

    function rotationSent(nowMs) {
      pendingSinceMs = nowMs;
    }

    // The restart offer was answered: the fresh connections' window starts now.
    function rotationSettled(nowMs) {
      if (pendingSinceMs === null) return false;
      pendingSinceMs = null;
      anchorMs = nowMs;
      settledAtMs = nowMs;
      return true;
    }

    function rotationFailed(nowMs) {
      if (pendingSinceMs === null) return false;
      pendingSinceMs = null;
      if (intervalMs) anchorMs = nowMs - Math.max(0, intervalMs - failureRetryMs);
      return true;
    }

    function isPending() {
      return pendingSinceMs !== null;
    }

    // Makes the next observe() on a live TCP/TLS relay rotate at once, e.g.
    // when a suspended rotation must resume on a flow that is already old.
    function expedite(nowMs) {
      if (intervalMs) anchorMs = nowMs - intervalMs;
    }

    return Object.freeze({
      setIntervalSeconds, reset, observe, rotationSent, rotationSettled, rotationFailed, isPending, expedite
    });
  }

  const utilities = Object.freeze({createRelayRotation, rotatableRelayProtocol, selectedRelayServerURL});
  root.SlowMeetRelayRotation = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
