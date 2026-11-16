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
  jitter: { classID: "1:70", handle: "70:", rate: "10gbit", delay: "30ms 180ms 0", loss: "0%" }
};

function tcRun(args) {
  execFileSync("tc", args, { stdio: ["ignore", "pipe", "pipe"] });
}

// Read-only tc introspection: returns the command's stdout (or a placeholder
// on failure) so harnesses can capture per-class drop/backlog counters as
// evidence — e.g. whether a silent participant's tier queue was starving
// them (Drops climbing) or forwarding was paused server-side (queue idle).
function tcOut(args) {
  try {
    return execFileSync("tc", args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
  } catch (error) {
    return `tc ${args.join(" ")} failed: ${error.message}`;
  }
}

function snapshotTierStats() {
  return `# tc -s class show dev lo\n${tcOut(["-s", "class", "show", "dev", "lo"])}\n# tc -s qdisc show dev lo\n${tcOut(["-s", "qdisc", "show", "dev", "lo"])}`;
}

function installRoomQdisc() {
  tcRun(["qdisc", "replace", "dev", "lo", "root", "handle", "1:", "htb", "default", "10"]);
  tcRun(["class", "add", "dev", "lo", "parent", "1:", "classid", "1:10", "htb", "rate", "10gbit", "ceil", "10gbit"]);
  for (const tier of Object.values(tiers)) {
    tcRun(["class", "add", "dev", "lo", "parent", "1:", "classid", tier.classID, "htb", "rate", tier.rate, "ceil", tier.rate]);
    // A delay spec may be multi-token ("30ms 160ms" — base plus jitter);
    // execFileSync does not split on spaces, so split it here.
    const netemArgs = ["qdisc", "add", "dev", "lo", "parent", tier.classID, "handle",
      tier.handle, "netem", "delay", ...tier.delay.split(" "), "loss", tier.loss];
    if (tier.limit) netemArgs.push("limit", tier.limit);
    tcRun(netemArgs);
  }
}

function applyParticipantTier(port, tierName) {
  const tier = tiers[tierName];
  assert.ok(tier, `unknown participant tier ${tierName}`);
  // IPv4: u32 ip sport/dport selectors. IPv6: the UDP ports sit at byte 40
  // (source) and 42 (destination) of the packet, matched with u16 at 40/42.
  // The capped tier shapes only the participant's downlink: every capped
  // assertion is about receiving under a cap (frames trickle, degradation
  // reaction, audio advances), and stacking the participant's own camera on
  // the same tail-drop queue starves ICE consent itself on slow encoders —
  // a 150 kbit uplink cannot carry a camera, so the peer dies instead of
  // degrading (CI-only: fast machines encode the fake camera lightly enough
  // to skate under the cap).
  const selectors = tier.downlinkOnly ? [
    ["protocol", "ip", "u32", "match", "ip", "dport", String(port), "0xffff"],
    ["protocol", "ipv6", "u32", "match", "u16", String(port), "0xffff", "at", "42"]
  ] : [
    ["protocol", "ip", "u32", "match", "ip", "sport", String(port), "0xffff"],
    ["protocol", "ip", "u32", "match", "ip", "dport", String(port), "0xffff"],
    ["protocol", "ipv6", "u32", "match", "u16", String(port), "0xffff", "at", "40"],
    ["protocol", "ipv6", "u32", "match", "u16", String(port), "0xffff", "at", "42"]
  ];
  for (const selector of selectors) {
    tcRun(["filter", "add", "dev", "lo", ...selector, "flowid", tier.classID]);
  }
}

function clearRoomProfiles() {
  try {
    execFileSync("tc", ["qdisc", "del", "dev", "lo", "root"], { stdio: "ignore" });
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
function armParticipantTiers(tierByRole, pages, readPorts = pageLocalIcePorts, log = console.log) {
  const applied = new Map();
  const stop = { stopped: false };
  (async () => {
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
              log(`[netem] ${role} -> ${tier} tier on port ${port}`);
            }
          }
        } catch (_) {}
      }
      await delay(2000);
    }
  })();
  return stop;
}

module.exports = {
  tiers, tcRun, tcOut, snapshotTierStats, installRoomQdisc, applyParticipantTier,
  clearRoomProfiles, pageLocalIcePorts, pageGatheredIcePorts, armParticipantTiers,
};
