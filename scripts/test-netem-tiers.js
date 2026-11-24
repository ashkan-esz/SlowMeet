// Checks scripts/netem-tiers.js without a network namespace: every tc
// command goes through the module's test hook. The default room and the
// per-participant filters are pinned to the exact argv the module issued
// before it gained opt-in tiers, so the CI netns scenarios keep running the
// same tc commands.
"use strict";

const assert = require("node:assert/strict");
const netem = require("./netem-tiers");

const calls = [];
let classShow = "";
netem.__setTcRunner((args) => calls.push(args.join(" ")), () => classShow);
const take = () => calls.splice(0);

const defaultTiers = [
  ["20", "200kbit", "delay 200ms loss 8% limit 20"],
  ["30", "100kbit", "delay 300ms loss 12% limit 20"],
  ["40", "150kbit", "delay 50ms loss 0% limit 20"],
  ["50", "10gbit", "delay 50ms loss 100%"],
  ["60", "10gbit", "delay 175ms loss 0%"],
  ["70", "10gbit", "delay 30ms 180ms 0 loss 0%"],
  ["80", "20mbit", "delay 10ms loss 0%"],
  ["21", "200kbit", "delay 200ms loss 8% limit 20"],
  ["22", "200kbit", "delay 200ms loss 8% limit 20"],
  ["23", "200kbit", "delay 200ms loss 8% limit 20"]
];
const expectedInstall = [
  "qdisc replace dev lo root handle 1: htb default 10",
  "class add dev lo parent 1: classid 1:10 htb rate 10gbit ceil 10gbit",
  ...defaultTiers.flatMap(([minor, rate, params]) => [
    `class add dev lo parent 1: classid 1:${minor} htb rate ${rate} ceil ${rate}`,
    `qdisc add dev lo parent 1:${minor} handle ${minor}: netem ${params}`
  ])
];

// installRoomQdisc() with no arguments: byte-identical to the original.
netem.installRoomQdisc();
assert.deepEqual(take(), expectedInstall);
assert.deepEqual([...netem.defaultTierNames],
  ["moderate", "severe", "capped", "blackout", "latency", "jitter", "fast", "moderate-2", "moderate-3", "moderate-4"]);

// Per-participant filters for every default tier: byte-identical.
const both = (classID) => [
  `filter add dev lo protocol ip u32 match ip sport 50123 0xffff flowid ${classID}`,
  `filter add dev lo protocol ip u32 match ip dport 50123 0xffff flowid ${classID}`,
  `filter add dev lo protocol ipv6 u32 match u16 50123 0xffff at 40 flowid ${classID}`,
  `filter add dev lo protocol ipv6 u32 match u16 50123 0xffff at 42 flowid ${classID}`
];
const expectedFilters = {
  moderate: both("1:20"), severe: both("1:30"),
  capped: [
    "filter add dev lo protocol ip u32 match ip dport 50123 0xffff flowid 1:40",
    "filter add dev lo protocol ipv6 u32 match u16 50123 0xffff at 42 flowid 1:40"
  ],
  blackout: both("1:50"), latency: both("1:60"), jitter: both("1:70"), fast: both("1:80"),
  "moderate-2": both("1:21"), "moderate-3": both("1:22"), "moderate-4": both("1:23")
};
for (const [name, expected] of Object.entries(expectedFilters)) {
  netem.applyParticipantTier(50123, name);
  assert.deepEqual(take(), expected, `${name} filters`);
}
netem.clearRoomProfiles();
assert.deepEqual(take(), ["qdisc del dev lo root"]);
assert.throws(() => netem.applyParticipantTier(1, "nope"), /unknown participant tier nope/);

// Opt-in tiers are never installed by default, and are added after the
// default ones when named.
for (const name of ["thin-uplink", "bursty", "relay-lossy", "flap"]) {
  assert.equal(netem.tiers[name].optIn, true);
  assert.ok(!netem.defaultTierNames.includes(name));
}
// The fast replicas copy `fast` on classes of their own, opt-in like the
// impairment tiers.
for (const [name, minor] of [["fast-2", "81"], ["fast-3", "82"], ["fast-4", "83"]]) {
  assert.equal(netem.tiers[name].optIn, true);
  assert.ok(!netem.defaultTierNames.includes(name));
  assert.equal(netem.tiers[name].classID, `1:${minor}`);
  assert.equal(netem.tiers[name].rate, netem.tiers.fast.rate);
  assert.equal(netem.tiers[name].delay, netem.tiers.fast.delay);
}
netem.installRoomQdisc({ include: ["thin-uplink", "bursty"] });
const withOptIn = take();
assert.deepEqual(withOptIn.slice(0, expectedInstall.length), expectedInstall);
assert.deepEqual(withOptIn.slice(expectedInstall.length), [
  "class add dev lo parent 1: classid 1:90 htb rate 300kbit ceil 300kbit",
  "qdisc add dev lo parent 1:90 handle 90: netem delay 50ms loss 8% limit 20",
  "class add dev lo parent 1: classid 1:a0 htb rate 10gbit ceil 10gbit",
  "qdisc add dev lo parent 1:a0 handle a0: netem delay 40ms loss gemodel 1% 10% 70% 0.1% reorder 25% 50%"
]);
assert.throws(() => netem.installRoomQdisc({ include: ["nope"] }), /unknown participant tier/);
assert.equal(take().length, 0, "an unknown tier must fail before any tc call");

// A tc failure mid-install tears the half-built tree down.
netem.__setTcRunner((args) => {
  calls.push(args.join(" "));
  if (args.includes("1:30") && args[0] === "qdisc") throw new Error("netem refused");
}, () => classShow);
assert.throws(() => netem.installRoomQdisc(), /netem refused/);
assert.equal(take().at(-1), "qdisc del dev lo root");
netem.__setTcRunner((args) => calls.push(args.join(" ")), () => classShow);

// Uplink-only shapes only what the participant sends.
netem.applyParticipantTier(4000, "thin-uplink");
assert.deepEqual(take(), [
  "filter add dev lo protocol ip u32 match ip sport 4000 0xffff flowid 1:90",
  "filter add dev lo protocol ipv6 u32 match u16 4000 0xffff at 40 flowid 1:90"
]);

// TCP ports: protocol 6 plus the port in each direction, v4 and v6.
netem.applyTcpPortTier(3478, "relay-lossy");
assert.deepEqual(take(), [
  "filter add dev lo protocol ip u32 match ip protocol 6 0xff match ip sport 3478 0xffff flowid 1:b0",
  "filter add dev lo protocol ip u32 match ip protocol 6 0xff match ip dport 3478 0xffff flowid 1:b0",
  "filter add dev lo protocol ipv6 u32 match u8 6 0xff at 6 match u16 3478 0xffff at 40 flowid 1:b0",
  "filter add dev lo protocol ipv6 u32 match u8 6 0xff at 6 match u16 3478 0xffff at 42 flowid 1:b0"
]);

// Link changes in place: netem only, or htb rate first when a rate is given.
netem.setTierLink("flap", { loss: "100%" });
assert.deepEqual(take(), ["qdisc change dev lo parent 1:c0 handle c0: netem delay 20ms loss 100%"]);
netem.setTierLink("flap", { rate: "64kbit", delay: "300ms" });
assert.deepEqual(take(), [
  "class change dev lo parent 1: classid 1:c0 htb rate 64kbit ceil 64kbit",
  "qdisc change dev lo parent 1:c0 handle c0: netem delay 300ms loss 0%"
]);

// Isolation: prio-1 allowlist to the clean class, prio-60000 UDP catch-all.
assert.deepEqual(netem.isolationAllowCommands(5000).map((args) => args.join(" ")), [
  "filter add dev lo protocol ip prio 1 u32 match ip sport 5000 0xffff flowid 1:10",
  "filter add dev lo protocol ip prio 1 u32 match ip dport 5000 0xffff flowid 1:10",
  "filter add dev lo protocol ipv6 prio 2 u32 match u16 5000 0xffff at 40 flowid 1:10",
  "filter add dev lo protocol ipv6 prio 2 u32 match u16 5000 0xffff at 42 flowid 1:10"
]);
assert.deepEqual(netem.isolationAllowCommands(20480, "0xffc0").map((args) => args.join(" ")).slice(0, 2), [
  "filter add dev lo protocol ip prio 1 u32 match ip sport 20480 0xffc0 flowid 1:10",
  "filter add dev lo protocol ip prio 1 u32 match ip dport 20480 0xffc0 flowid 1:10"
]);
assert.deepEqual(netem.isolationCatchAllCommands("blackout").map((args) => args.join(" ")), [
  "filter add dev lo protocol ip prio 60000 u32 match ip protocol 17 0xff flowid 1:50",
  "filter add dev lo protocol ipv6 prio 60001 u32 match u8 17 0xff at 6 flowid 1:50"
]);

// Class counters.
classShow = `class htb 1:10 root prio 0 rate 10Gbit ceil 10Gbit burst 0b cburst 0b
 Sent 905188 bytes 1735 pkt (dropped 0, overlimits 0 requeues 0)
 backlog 0b 0p requeues 0
class htb 1:20 root leaf 20: prio 0 rate 200Kbit ceil 200Kbit burst 1600b cburst 1600b
 Sent 330720 bytes 412 pkt (dropped 37, overlimits 50 requeues 0)
 backlog 0b 0p requeues 0
`;
const counters = netem.tierClassCounters();
assert.deepEqual(counters, {
  "1:10": { sentBytes: 905188, sentPackets: 1735, dropped: 0 },
  "1:20": { sentBytes: 330720, sentPackets: 412, dropped: 37 }
});
assert.deepEqual(netem.classCounterDelta({ "1:20": { sentBytes: 100, sentPackets: 2, dropped: 1 } }, counters, "1:20"),
  { sentBytes: 330620, sentPackets: 410, dropped: 36 });
assert.deepEqual(netem.classCounterDelta({}, {}, "1:30"), { sentBytes: 0, sentPackets: 0, dropped: 0 });

(async () => {
  // The armer: same classification as before, now with evidence. A port
  // read that throws is recorded instead of dropped silently.
  const pages = new Map([["P1", "page-1"], ["P2", "page-2"], ["P3", "page-3"]]);
  const reads = { "page-1": [[], [7001], [7001, 7002]], "page-3": [new Error("page closed"), [9001]] };
  const readPorts = async (page) => {
    const next = reads[page].length > 1 ? reads[page].shift() : reads[page][0];
    if (next instanceof Error) throw next;
    return next;
  };
  let ticks = 0;
  let armer;
  const sleep = async () => {
    ticks++;
    if (ticks >= 3) armer.stopped = true;
  };
  armer = netem.armParticipantTiers({ P1: "moderate", P2: "clean", P3: "severe" }, pages, readPorts, () => {}, { sleep });
  await armer.done;
  assert.deepEqual([...armer.applied.get("P1")], [7001, 7002]);
  assert.deepEqual([...armer.applied.get("P3")], [9001]);
  assert.ok(!armer.applied.has("P2"), "clean roles are never classified");
  assert.deepEqual(armer.events.map((event) => `${event.role}:${event.port}`), ["P1:7001", "P3:9001", "P1:7002"]);
  assert.ok(armer.appliedAt.has("P1:7001"));
  assert.deepEqual(armer.errors, ["P3: page closed"]);
  const filters = take();
  assert.equal(filters.filter((call) => call.includes("flowid 1:20")).length, 8, "two P1 ports, four filters each");
  assert.equal(filters.filter((call) => call.includes("flowid 1:30")).length, 4, "one P3 port");

  // A flap schedule toggles the link and restores the tier at the end.
  const flap = netem.flapTier("flap", { onMs: 2, offMs: 3, cycles: 2, sleep: async () => {} });
  await flap.done;
  assert.deepEqual(flap.transitions.map((step) => step.link.loss || "base"), ["base", "100%", "base", "100%", "base"]);
  assert.deepEqual(flap.errors, []);
  assert.equal(take().at(-1), "qdisc change dev lo parent 1:c0 handle c0: netem delay 20ms loss 0%");
  assert.throws(() => netem.flapTier("flap", { onMs: 1, offMs: 1 }), /cycles or untilMs/);

  console.log("netem tier checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
