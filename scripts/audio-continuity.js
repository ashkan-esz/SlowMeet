// Per-remote audio continuity for the browser e2e suites.
//
// An in-page monitor samples the page's current meeting peer connection every
// intervalMs and records, for each remote participant, the times at which
// that participant's inbound audio packet count advanced. It re-selects the
// newest peer connection on every tick, so a rebuilt peer (reconnect, ICE
// restart, method switch) keeps feeding the same per-owner history instead of
// silently freezing the monitor on a dead connection.
//
// The analysis is pure and runs in Node on the recorded times: the longest
// silence per remote, pooled across remotes, how many remotes were audible at
// once, and every gap over a budget.
//
// Consumers: scripts/test-four-person-e2e.js, scripts/test-soak.js.

"use strict";

// Runs inside the page. Idempotent: a second install keeps the first
// monitor (and its history).
function installInPage(intervalMs) {
  if (window.__audioContinuity) return window.__audioContinuity.installedAt;
  const monitor = {
    installedAt: Date.now(),
    intervalMs,
    arrivals: {},
    ticks: [],
    peers: 0,
    errors: 0
  };
  window.__audioContinuity = monitor;
  const baselines = new WeakMap();
  let lastPeer;
  const ownerOf = (stat) => {
    const identifier = stat.trackIdentifier || "";
    // SFU egress tracks are named "<participant>|<role>".
    if (identifier.includes("|")) return identifier.split("|")[0];
    for (const audio of document.querySelectorAll("li[data-participant-id] audio")) {
      const track = audio.srcObject?.getAudioTracks?.()[0];
      if (track && track.id === identifier) return audio.closest("li").dataset.participantId;
    }
    return identifier ? `track:${identifier}` : `ssrc:${stat.ssrc}`;
  };
  const tick = async () => {
    const peers = [...(window.__slowMeetTest?.peerConnections || [])];
    const peer = peers.filter((pc) => pc.connectionState !== "closed").at(-1) || peers.at(-1);
    const now = Date.now();
    monitor.ticks.push(now);
    if (monitor.ticks.length > 20000) monitor.ticks.splice(0, 5000);
    if (!peer || typeof peer.getStats !== "function") return;
    if (peer !== lastPeer) {
      lastPeer = peer;
      monitor.peers++;
    }
    let previous = baselines.get(peer);
    if (!previous) {
      previous = new Map();
      baselines.set(peer, previous);
    }
    try {
      const report = await peer.getStats();
      report.forEach((stat) => {
        if (stat.type !== "inbound-rtp" || stat.kind !== "audio") return;
        const key = String(stat.ssrc);
        const packets = stat.packetsReceived || 0;
        const before = previous.get(key);
        previous.set(key, packets);
        if (before === undefined || packets <= before) return;
        const owner = ownerOf(stat);
        const times = monitor.arrivals[owner] || (monitor.arrivals[owner] = []);
        times.push(now);
        if (times.length > 20000) times.splice(0, 5000);
      });
    } catch (_) {
      monitor.errors++;
    }
  };
  monitor.timer = setInterval(tick, intervalMs);
  return monitor.installedAt;
}

function readInPage() {
  const monitor = window.__audioContinuity;
  if (!monitor) return null;
  return {
    installedAt: monitor.installedAt, intervalMs: monitor.intervalMs, arrivals: monitor.arrivals,
    ticks: monitor.ticks, peers: monitor.peers, errors: monitor.errors
  };
}

async function installAudioContinuity(page, { intervalMs = 100 } = {}) {
  return page.evaluate(installInPage, intervalMs);
}

async function readAudioContinuity(page) {
  return page.evaluate(readInPage);
}

// Longest stretch inside [from, to] with no arrival: the edges count, so a
// stream that never arrives in the window has a gap of the whole window.
function longestGap(times, from, to) {
  let previous = from;
  let longest = 0;
  for (const at of times || []) {
    if (at < from) continue;
    if (at > to) break;
    longest = Math.max(longest, at - previous);
    previous = at;
  }
  return Math.max(longest, to - previous);
}

// Every silence longer than ms inside [from, to], as {from, to, ms}.
function gapsOver(times, ms, from, to) {
  const gaps = [];
  let previous = from;
  const consider = (at) => {
    if (at - previous > ms) gaps.push({ from: previous, to: at, ms: at - previous });
    previous = at;
  };
  for (const at of times || []) {
    if (at < from) continue;
    if (at > to) break;
    consider(at);
  }
  consider(to);
  return gaps;
}

// The longest stretch with no audio from anybody at all.
function pooledGap(timesByOwner, from, to) {
  const pooled = Object.values(timesByOwner || {}).flat().sort((a, b) => a - b);
  return longestGap(pooled, from, to);
}

// The fewest owners heard within any windowMs-long window that starts in
// [from + windowMs, to] (sampled every stepMs): 3 means all three remotes of
// a four-person room were audible throughout.
function minActive(timesByOwner, from, to, { windowMs = 1000, stepMs = 100, owners } = {}) {
  const keys = owners || Object.keys(timesByOwner || {});
  let fewest = keys.length;
  for (let end = from + windowMs; end <= to; end += stepMs) {
    const start = end - windowMs;
    let active = 0;
    for (const key of keys) {
      if ((timesByOwner[key] || []).some((at) => at > start && at <= end)) active++;
    }
    fewest = Math.min(fewest, active);
  }
  return fewest;
}

// Summarises a page's history over [from, to]. owners (participant IDs)
// restricts the report and reports owners that never arrived as one gap of
// the whole window.
function summarize(history, { from, to, owners } = {}) {
  const arrivals = history?.arrivals || {};
  const keys = owners || Object.keys(arrivals);
  const perOwner = {};
  for (const key of keys) perOwner[key] = longestGap(arrivals[key], from, to);
  const subset = Object.fromEntries(keys.map((key) => [key, arrivals[key] || []]));
  return {
    perOwnerGapMs: perOwner,
    worstGapMs: Math.max(0, ...Object.values(perOwner)),
    pooledGapMs: pooledGap(subset, from, to),
    minActive: minActive(subset, from, to, { owners: keys }),
    peers: history?.peers || 0
  };
}

module.exports = {
  installAudioContinuity, readAudioContinuity, installInPage, readInPage,
  longestGap, gapsOver, pooledGap, minActive, summarize
};
