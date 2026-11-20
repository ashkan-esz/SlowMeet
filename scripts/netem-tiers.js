// Shared per-participant network-shaping machinery for the netns e2e/soak
// harnesses. A disposable network namespace loopback carries an htb root
// with a large clean default class plus one impaired class per tier; each
// participant's UDP port is matched into its tier so different participants
// see different link qualities in the same room. Everything here touches
// `tc` directly and MUST only run inside scripts/*-netns.sh wrappers —
// shaping the host loopback is forbidden.
//
// Consumers: scripts/test-four-person-e2e.js, scripts/test-soak.js.

"use strict";

const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

// One link quality per tier. Loss values sit above the client's reaction
// thresholds (poor > 5%, critical > 10%) so the adaptation machinery engages
// deterministically on any machine — a fast CI runner encodes the fake
// camera efficiently enough that rate shaping alone leaves the severe tier
// barely degraded.
const tiers = {
  // Moderate shapes both directions, so the participant's own camera shares
  // its 200 kbit queue with the forwarded mix on the downlink — the same
  // oversubscription the capped tier documents. The shallow limit keeps the
  // queue from bufferbloating: netem's 1000-packet default grows delay until
  // ICE consent starves (~20–40 s horizon, invisible to short scenarios —
  // the soak's second exposure caught it), while a bounded queue turns the
  // overflow into drops the encoder adapts to.
  moderate: { classID: "1:20", handle: "20:", rate: "200kbit", delay: "200ms", loss: "8%", limit: "20" },
  // Severe shapes both directions, and its downlink is oversubscribed the
  // same way the capped tier is (~182 kbps of forwarded mix into 100 kbit),
  // so the queue needs the same shallow limit: netem's 1000-packet default
  // bufferbloats delay until ICE consent starves and the peer dies whole
  // (~20–40 s horizon — invisible to short scenarios, fatal on a real thin
  // link). A bounded queue turns the overflow into drops the adaptation
  // machinery can absorb instead of delay the consent timer cannot.
  severe: { classID: "1:30", handle: "30:", rate: "100kbit", delay: "300ms", loss: "12%", limit: "20" },
  // A pure bandwidth cap: rate shaping with no injected loss, the way a thin
  // link congests without any random corruption. The class carries only the
  // participant's DOWNLINK (see applyParticipantTier — every capped assertion
  // is about receiving; stacking the participant's own camera on the same
  // queue starves ICE consent on slow encoders), so the ~182 kbps forwarded
  // mix oversubscribes the 150 kbit pipe by ~20%: a moderately bounded queue
  // (20 packets) drops that overflow the way a real thin pipe does, instead
  // of ballooning delay until SFU-side consent collapses and the peer
  // rebuilds mid-window (the rebuild resets every receiver's audio counters
  // and fails the deltas). The earlier limit-30-attempt starved consent only
  // because the queue then also carried the saturated uplink. Fast runners
  // encode the fake camera efficiently, so scenarios assert this tier
  // qualitatively (audio survives, capped video trails the clean pair)
  // instead of exact thresholds.
  capped: { classID: "1:40", handle: "40:", rate: "150kbit", delay: "50ms", loss: "0%", downlinkOnly: true, limit: "20" },
  // A total media outage: every packet on this port is dropped, the way a
  // dead radio or a NAT timeout severs the path while the WebSocket (TCP,
  // outside these classes) stays up. Scenarios use it for a short window to
  // exercise the client's own recovery once the path returns.
  blackout: { classID: "1:50", handle: "50:", rate: "10gbit", delay: "50ms", loss: "100%" },
  // Pure latency: 175 ms one-way in BOTH directions ⇒ measured RTT ≈ 350 ms
  // — above the client's 250 ms poor bar, below its 500 ms critical bar, so
  // interactivity degrades without protect-audio ever engaging. No rate cap
  // and no loss: throughput is fully preserved (video decodes at full rate),
  // which is the guarantee this tier exists to prove — delay hurts
  // interactivity, not capacity — and delay-only shaping never accumulates a
  // queue, so ICE consent cannot starve.
  latency: { classID: "1:60", handle: "60:", rate: "10gbit", delay: "175ms", loss: "0%" },
  // Jitter-only: a small base delay with ±180 ms of per-packet variation
  // (explicit zero correlation). Measured reality: the excursions cross the
  // client's poor bar (250 ms RTT) in regular bursts — mostly through RTT
  // excursions, since the RFC-3550-smoothed jitter stat stays modest — so
  // the ladder steps down in bursts without the 500 ms critical bar ever
  // being reached (worst-case RTT ≈ 420 ms). No rate cap, no loss: audio
  // and video keep flowing throughout.
  jitter: { classID: "1:70", handle: "70:", rate: "10gbit", delay: "30ms 180ms 0", loss: "0%" },
  // A shaped-but-fast link: 20 mbit with 10 ms one-way delay in BOTH
  // directions (measured RTT ≈ 20 ms) and no loss — fibre or good office
  // Wi-Fi rather than the unshaped namespace loopback, whose ~0 ms RTT and
  // unbounded rate no real participant ever sees. It exists so the good end
  // of the ladder is exercised on a link that still passes through the
  // classifier: scenarios assert that a participant on it reaches and holds
  // the top Auto level, and that it stays the room's one good link while the
  // others are impaired. It is named `fast`, not `clean`, because
  // armParticipantTiers skips the `clean` name outright (those participants
  // stay unclassified on the 10 gbit default class). The class is one shared
  // queue, but four participants at the top Auto level offer ~12 mbit in
  // total (4 uplinks plus 12 forwarded streams at ≤ 650 kbit video + audio),
  // so the 20 mbit rate never becomes the bottleneck.
  fast: { classID: "1:80", handle: "80:", rate: "20mbit", delay: "10ms", loss: "0%" }
};

// A tier's class is ONE queue. Every other tier is held by at most one
// participant per scenario, but rooms with several moderate links need each
// participant on a link of their own: two participants classified into
// `moderate` would split a single 200 kbit pipe (their two uplinks plus six
// forwarded streams — audio alone is ~360 kbit), which is a shared-bottleneck
// outage, not two moderate links. The replicas carry exactly the moderate
// link quality on their own classes and netem queues.
for (const [name, minor] of [["moderate-2", "21"], ["moderate-3", "22"], ["moderate-4", "23"]]) {
  tiers[name] = { ...tiers.moderate, classID: `1:${minor}`, handle: `${minor}:` };
}

// The tiers installRoomQdisc() creates with no arguments. The opt-in tiers
// below are installed only when a scenario names them, so the CI scenarios
// keep issuing exactly the tc commands they always have (pinned by
// scripts/test-netem-tiers.js) and never need netem features such as
// gemodel or reorder from the CI kernel.
const defaultTierNames = Object.freeze(Object.keys(tiers));

const optInTiers = {
  // A thin, lossy UPLOAD with a clean download (ADSL, a phone on a busy
  // cell): only packets leaving the participant's port are shaped. 8% loss
  // keeps the client's uplink-loss signal (> 5%) clearly above its bar.
  "thin-uplink": { classID: "1:90", handle: "90:", rate: "300kbit", delay: "50ms", loss: "8%", limit: "20", uplinkOnly: true },
  // Bursty loss (Gilbert-Elliott: ~1% chance to enter a bad state that drops
  // 70% while it lasts, ~10% chance per packet to leave it) with 25%
  // reordering and 2% duplication, the way congested Wi-Fi misbehaves.
  bursty: { classID: "1:a0", handle: "a0:", rate: "10gbit", delay: "40ms", loss: "gemodel 1% 10% 70% 0.1%",
    extra: ["reorder", "25%", "50%", "duplicate", "2%"] },
  // Loss and delay on a TCP path (the TURN/TCP relay leg), applied with
  // applyTcpPortTier.
  "relay-lossy": { classID: "1:b0", handle: "b0:", rate: "10gbit", delay: "50ms", loss: "2%" },
  // A link whose state a scenario switches at run time with setTierLink and
  // flapTier; it starts up (no loss).
  flap: { classID: "1:c0", handle: "c0:", rate: "10gbit", delay: "20ms", loss: "0%" }
};
for (const [name, tier] of Object.entries(optInTiers)) {
  tiers[name] = { ...tier, optIn: true };
}

let tcRunner = (args) => execFileSync("tc", args, { stdio: ["ignore", "pipe", "pipe"] });
let tcReader = (args) => execFileSync("tc", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });

// Test hook: route every tc call through run (and reads through read) so
// scripts/test-netem-tiers.js can pin the exact argv without a namespace.
function __setTcRunner(run, read = () => "") {
  tcRunner = run;
  tcReader = read;
}

function tcRun(args) {
  tcRunner(args);
}

// Read-only tc introspection: returns the command's stdout (or a placeholder
// on failure) so harnesses can capture per-class drop/backlog counters as
// evidence — e.g. whether a silent participant's tier queue was starving
// them (Drops climbing) or forwarding was paused server-side (queue idle).
function tcOut(args) {
  try {
    return tcReader(args);
  } catch (error) {
    return `tc ${args.join(" ")} failed: ${error.message}`;
  }
}

function snapshotTierStats() {
  return `# tc -s class show dev lo\n${tcOut(["-s", "class", "show", "dev", "lo"])}\n# tc -s qdisc show dev lo\n${tcOut(["-s", "qdisc", "show", "dev", "lo"])}`;
}

function tierNamed(tierName) {
  const tier = tiers[tierName];
  assert.ok(tier, `unknown participant tier ${tierName}`);
  return tier;
}

// The netem parameters of a tier (or of a link override for it): a delay or
// loss spec may be multi-token ("30ms 180ms 0", "gemodel 1% 10% 70% 0.1%");
// execFileSync does not split on spaces, so split them here.
function netemParamsFor(tier) {
  const params = ["delay", ...tier.delay.split(" "), "loss", ...tier.loss.split(" ")];
  if (tier.limit) params.push("limit", tier.limit);
  if (tier.extra) params.push(...tier.extra);
  return params;
}

// Pure argv builders: the tc commands installRoomQdisc issues for a set of
// tier names, in order.
function roomQdiscCommands(tierNames = defaultTierNames) {
  const commands = [
    ["qdisc", "replace", "dev", "lo", "root", "handle", "1:", "htb", "default", "10"],
    ["class", "add", "dev", "lo", "parent", "1:", "classid", "1:10", "htb", "rate", "10gbit", "ceil", "10gbit"]
  ];
  for (const name of tierNames) {
    const tier = tierNamed(name);
    commands.push(["class", "add", "dev", "lo", "parent", "1:", "classid", tier.classID, "htb", "rate", tier.rate, "ceil", tier.rate]);
    commands.push(["qdisc", "add", "dev", "lo", "parent", tier.classID, "handle", tier.handle, "netem", ...netemParamsFor(tier)]);
  }
  return commands;
}

// installRoomQdisc() installs exactly the default tiers; a scenario that
// needs opt-in tiers names them: installRoomQdisc({ include: ["bursty"] }).
function installRoomQdisc({ include = [] } = {}) {
  for (const name of include) tierNamed(name);
  const names = [...defaultTierNames, ...include.filter((name) => !defaultTierNames.includes(name))];
  for (const command of roomQdiscCommands(names)) tcRun(command);
}

// IPv4: u32 ip sport/dport selectors. IPv6: the UDP ports sit at byte 40
// (source) and 42 (destination) of the packet, matched with u16 at 40/42.
// The capped tier shapes only the participant's downlink: every capped
// assertion is about receiving under a cap (frames trickle, degradation
// reaction, audio advances), and stacking the participant's own camera on
// the same tail-drop queue starves ICE consent itself on slow encoders —
// a 150 kbit uplink cannot carry a camera, so the peer dies instead of
// degrading (CI-only: fast machines encode the fake camera lightly enough
// to skate under the cap). An uplinkOnly tier shapes only what the
// participant sends.
function participantFilterCommands(port, tierName) {
  const tier = tierNamed(tierName);
  const p = String(port);
  const uplink = [
    ["protocol", "ip", "u32", "match", "ip", "sport", p, "0xffff"],
    ["protocol", "ipv6", "u32", "match", "u16", p, "0xffff", "at", "40"]
  ];
  const downlink = [
    ["protocol", "ip", "u32", "match", "ip", "dport", p, "0xffff"],
    ["protocol", "ipv6", "u32", "match", "u16", p, "0xffff", "at", "42"]
  ];
  let selectors;
  if (tier.downlinkOnly) selectors = downlink;
  else if (tier.uplinkOnly) selectors = uplink;
  else selectors = [uplink[0], downlink[0], uplink[1], downlink[1]];
  return selectors.map((selector) => ["filter", "add", "dev", "lo", ...selector, "flowid", tier.classID]);
}

function applyParticipantTier(port, tierName) {
  for (const command of participantFilterCommands(port, tierName)) tcRun(command);
}

// Shapes a TCP port in both directions (the participant's TURN/TCP or
// signaling connection) into a tier. IPv6 matches next-header 6 at byte 6.
function tcpPortFilterCommands(port, tierName) {
  const tier = tierNamed(tierName);
  const p = String(port);
  const v4 = ["protocol", "ip", "u32", "match", "ip", "protocol", "6", "0xff"];
  const v6 = ["protocol", "ipv6", "u32", "match", "u8", "6", "0xff", "at", "6"];
  return [
    [...v4, "match", "ip", "sport", p, "0xffff"],
    [...v4, "match", "ip", "dport", p, "0xffff"],
    [...v6, "match", "u16", p, "0xffff", "at", "40"],
    [...v6, "match", "u16", p, "0xffff", "at", "42"]
  ].map((selector) => ["filter", "add", "dev", "lo", ...selector, "flowid", tier.classID]);
}

function applyTcpPortTier(port, tierName) {
  for (const command of tcpPortFilterCommands(port, tierName)) tcRun(command);
}

// Changes a tier's link in place (its netem qdisc, and its htb rate when
// given): link fields override the tier's own. Used to flap a link without
// reclassifying anybody.
function tierLinkCommands(tierName, link = {}) {
  const tier = tierNamed(tierName);
  const merged = { ...tier, ...link };
  const commands = [["qdisc", "change", "dev", "lo", "parent", tier.classID, "handle", tier.handle, "netem", ...netemParamsFor(merged)]];
  if (link.rate) {
    commands.unshift(["class", "change", "dev", "lo", "parent", "1:", "classid", tier.classID, "htb", "rate", link.rate, "ceil", link.rate]);
  }
  return commands;
}

function setTierLink(tierName, link = {}) {
  for (const command of tierLinkCommands(tierName, link)) tcRun(command);
}

// Flaps a tier's link through a schedule of {link, ms} steps, `cycles` times
// or until `untilMs` has passed. onMs/offMs is shorthand for "up for onMs,
// fully down (100% loss) for offMs". The tier's own link is restored at the
// end. Returns {transitions, errors, done, stop}.
function flapTier(tierName, { schedule, onMs, offMs, cycles, untilMs, sleep = delay, now = Date.now } = {}) {
  tierNamed(tierName);
  const steps = schedule || [{ link: {}, ms: onMs }, { link: { loss: "100%" }, ms: offMs }];
  assert.ok(steps.length > 0 && steps.every((step) => step.ms > 0), "flapTier needs steps with positive durations");
  assert.ok(cycles > 0 || untilMs > 0, "flapTier needs cycles or untilMs");
  const state = { transitions: [], errors: [], stopped: false };
  const startedAt = now();
  state.done = (async () => {
    for (let cycle = 0; !state.stopped; cycle++) {
      if (cycles > 0 && cycle >= cycles) break;
      for (const step of steps) {
        if (state.stopped || (untilMs > 0 && now() - startedAt >= untilMs)) break;
        try {
          setTierLink(tierName, step.link);
          state.transitions.push({ at: now(), link: step.link });
        } catch (error) {
          state.errors.push(error.message);
        }
        await sleep(step.ms);
      }
      if (untilMs > 0 && now() - startedAt >= untilMs) break;
    }
    try {
      setTierLink(tierName, {});
      state.transitions.push({ at: now(), link: {} });
    } catch (error) {
      state.errors.push(error.message);
    }
    return state;
  })();
  state.stop = () => {
    state.stopped = true;
    return state.done;
  };
  return state;
}

// Parses `tc -s class show dev lo` into {classID: {sentBytes, sentPackets,
// dropped}}. An htb class's dropped counter includes its netem child's
// random-loss and queue-limit drops.
function parseClassCounters(text) {
  const counters = {};
  let classID;
  for (const line of String(text).split("\n")) {
    const header = line.match(/^class \S+ (\S+)/);
    if (header) {
      classID = header[1];
      continue;
    }
    const sent = line.match(/^\s*Sent (\d+) bytes (\d+) pkt \(dropped (\d+)/);
    if (sent && classID) {
      counters[classID] = { sentBytes: Number(sent[1]), sentPackets: Number(sent[2]), dropped: Number(sent[3]) };
      classID = undefined;
    }
  }
  return counters;
}

function tierClassCounters() {
  return parseClassCounters(tcOut(["-s", "class", "show", "dev", "lo"]));
}

// Packets and drops a class gained between two tierClassCounters() reads.
function classCounterDelta(before, after, classID) {
  const a = after[classID] || { sentBytes: 0, sentPackets: 0, dropped: 0 };
  const b = before[classID] || { sentBytes: 0, sentPackets: 0, dropped: 0 };
  return { sentBytes: a.sentBytes - b.sentBytes, sentPackets: a.sentPackets - b.sentPackets, dropped: a.dropped - b.dropped };
}

// The filters armRoleUdpIsolation installs. Allowlist entries sit at prio 1
// (evaluated first) and send the other roles' ports to the clean default
// class; the catch-all at prio 60000 (evaluated after every auto-prio tier
// filter, which start at 49152 and count down) sends any other UDP — the
// isolated participant's, on whatever port it rebinds to — into the tier.
function isolationAllowCommands(port) {
  const p = String(port);
  return [
    ["protocol", "ip", "u32", "match", "ip", "sport", p, "0xffff"],
    ["protocol", "ip", "u32", "match", "ip", "dport", p, "0xffff"],
    ["protocol", "ipv6", "u32", "match", "u16", p, "0xffff", "at", "40"],
    ["protocol", "ipv6", "u32", "match", "u16", p, "0xffff", "at", "42"]
  ].map(([proto, family, ...rest]) => ["filter", "add", "dev", "lo", proto, family, "prio", "1", ...rest, "flowid", "1:10"]);
}

function isolationCatchAllCommands(tierName) {
  const tier = tierNamed(tierName);
  return [
    ["filter", "add", "dev", "lo", "protocol", "ip", "prio", "60000", "u32", "match", "ip", "protocol", "17", "0xff", "flowid", tier.classID],
    ["filter", "add", "dev", "lo", "protocol", "ipv6", "prio", "60000", "u32", "match", "u8", "17", "0xff", "at", "6", "flowid", tier.classID]
  ];
}

function isolationLiftCommands() {
  return [
    ["filter", "del", "dev", "lo", "protocol", "ip", "prio", "60000"],
    ["filter", "del", "dev", "lo", "protocol", "ipv6", "prio", "60000"]
  ];
}

// Puts ALL of one participant's UDP into a tier, including ports it has not
// opened yet (a rebuilt peer, an ICE restart): every other role's live ports
// are allowlisted every intervalMs, and everything else that is UDP falls
// into the tier. allowRoles limits the allowlist (roles with tiers of their
// own must not be allowlisted, or they would be shaped clean). lift()
// removes the catch-all; the allowlist entries are harmless leftovers that
// clearRoomProfiles removes with the root.
function armRoleUdpIsolation(targetRole, tierName, pages, { allowRoles, readPorts = pageGatheredIcePorts, intervalMs = 250, log = console.log } = {}) {
  const roles = (allowRoles || [...pages.keys()]).filter((role) => role !== targetRole);
  const state = { stopped: false, allowed: new Map(), errors: [], events: [] };
  const allow = async () => {
    for (const role of roles) {
      try {
        for (const port of await readPorts(pages.get(role))) {
          if (state.allowed.get(role)?.has(port)) continue;
          for (const command of isolationAllowCommands(port)) tcRun(command);
          if (!state.allowed.has(role)) state.allowed.set(role, new Set());
          state.allowed.get(role).add(port);
          state.events.push({ at: Date.now(), role, port });
        }
      } catch (error) {
        state.errors.push(`${role}: ${error.message}`);
      }
    }
  };
  state.ready = (async () => {
    await allow();
    for (const command of isolationCatchAllCommands(tierName)) tcRun(command);
    log(`[netem] isolated ${targetRole}'s UDP into the ${tierName} tier; allowlisted ${roles.join(", ")}`);
    state.isolatedAt = Date.now();
    state.loop = (async () => {
      while (!state.stopped) {
        await delay(intervalMs);
        if (!state.stopped) await allow();
      }
    })();
    return state;
  })();
  state.lift = async () => {
    state.stopped = true;
    await state.ready.catch(() => {});
    for (const command of isolationLiftCommands()) {
      try { tcRun(command); } catch (error) { state.errors.push(error.message); }
    }
    state.liftedAt = Date.now();
    log(`[netem] lifted ${targetRole}'s UDP isolation`);
  };
  return state;
}

function clearRoomProfiles() {
  try {
    tcRunner(["qdisc", "del", "dev", "lo", "root"]);
  } catch (_) {}
}

// The page's local ICE port, so per-participant classifiers can match its
// flows in both directions (its sport on send, its dport on receive).
// Every distinct local ICE port across the page's connected peer
// connections: join churn can leave a superseded-but-connected PC behind, so
// the classifier arms all of the page's live ports.
async function pageLocalIcePorts(page) {
  return page.evaluate(async () => {
    const peers = [...(window.__slowMeetTest?.peerConnections || [])]
      .filter((item) => item.connectionState === "connected");
    const ports = new Set();
    for (const peer of peers) {
      if (typeof peer.getStats !== "function") continue;
      const report = await peer.getStats();
      report.forEach((stat) => {
        // Port 9 is the tcptype "active" placeholder, never a real socket.
        if (stat.type === "local-candidate" && stat.candidateType === "host" &&
          stat.port && stat.port !== 9) {
          ports.add(Number(stat.port));
        }
      });
    }
    // An empty set is normal while a peer connection is being replaced; the
    // caller's verification loop re-captures on its next pass.
    return [...ports];
  });
}

// Every local ICE host port the page has gathered regardless of connection
// state. A cold join must be classified while its handshake is still in
// flight — the connected-only reader would shape only the aftermath, and the
// whole point of a cold-join scenario is that establishment itself happens
// under impairment.
async function pageGatheredIcePorts(page) {
  return page.evaluate(async () => {
    const peers = [...(window.__slowMeetTest?.peerConnections || [])]
      .filter((peer) => peer.connectionState !== "closed" && peer.connectionState !== "failed");
    const ports = new Set();
    for (const peer of peers) {
      if (typeof peer.getStats !== "function") continue;
      try {
        const report = await peer.getStats();
        report.forEach((stat) => {
          if (stat.type === "local-candidate" && stat.candidateType === "host" &&
            stat.port && stat.port !== 9) {
            ports.add(Number(stat.port));
          }
        });
      } catch (_) {}
    }
    return [...ports];
  });
}

// The app can replace a participant's peer connection mid-room ("restarting
// media"), which rebinds its ICE port; a one-shot classification would then
// miss the media. The armer keeps re-reading every impaired participant's
// live ports and classifying new ones until the profiles are lifted. The
// port reader is injectable: cold-join scenarios classify ports that have
// not connected yet (see pageGatheredIcePorts), the default reads live
// ports. `pages` maps role -> Playwright page for the named participants.
//
// The returned object is the stop handle (set .stopped = true) and also the
// evidence of what was classified: applied maps role -> Set of ports,
// appliedAt maps "role:port" -> time, events lists every classification in
// order, and errors keeps every failed read or tc call instead of dropping
// it. intervalMs (default 2000) is how often the ports are re-read.
function armParticipantTiers(tierByRole, pages, readPorts = pageLocalIcePorts, log = console.log, { intervalMs = 2000, sleep = delay } = {}) {
  const applied = new Map();
  const stop = { stopped: false, applied, appliedAt: new Map(), events: [], errors: [] };
  stop.done = (async () => {
    while (!stop.stopped) {
      for (const [role, tier] of Object.entries(tierByRole)) {
        if (tier === "clean") continue;
        try {
          const ports = await readPorts(pages.get(role));
          for (const port of ports) {
            if (!applied.get(role)?.has(port)) {
              if (!applied.has(role)) applied.set(role, new Set());
              applyParticipantTier(port, tier);
              applied.get(role).add(port);
              const at = Date.now();
              stop.appliedAt.set(`${role}:${port}`, at);
              stop.events.push({ at, role, port, tier });
              log(`[netem] ${role} -> ${tier} tier on port ${port}`);
            }
          }
        } catch (error) {
          stop.errors.push(`${role}: ${error.message}`);
        }
      }
      await sleep(intervalMs);
    }
  })();
  return stop;
}

module.exports = {
  tiers, defaultTierNames, tcRun, tcOut, snapshotTierStats, installRoomQdisc, applyParticipantTier,
  clearRoomProfiles, pageLocalIcePorts, pageGatheredIcePorts, armParticipantTiers,
  roomQdiscCommands, participantFilterCommands, applyTcpPortTier, tcpPortFilterCommands,
  setTierLink, tierLinkCommands, flapTier, parseClassCounters, tierClassCounters, classCounterDelta,
  armRoleUdpIsolation, isolationAllowCommands, isolationCatchAllCommands, isolationLiftCommands,
  __setTcRunner,
};
