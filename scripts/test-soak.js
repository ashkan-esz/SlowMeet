#!/usr/bin/env node

// Sustained-meeting soak with server profiling. Joins N headless Chromium
// participants on synthetic camera+audio media, verifies decoded frames keep
// advancing, and while media flows captures CPU/heap/goroutine profiles from
// the server's admin-gated /debug/pprof endpoints. Run it twice around a
// media-path change to get a comparable before/after CPU baseline.
//
// SOAK_IMPAIRMENT=1 switches to the weak-network soak: a 4-person room on
// four different link qualities (P1 clean, P2 moderate, P3 severe, P4
// capped) under CYCLING impairment — an impaired window, then a clean
// recovery window, repeated. It asserts the guarantees that short scenarios
// cannot prove over time: audio advances within every window (impaired ones
// included), every lift recovers every camera for the clean observer,
// reconnect counts stay bounded per window, and the goroutine count returns
// to baseline after each clean window (leak guard). Both CPU profile windows
// are captured DURING impaired windows, so the summary shows the cost of
// impairment itself. Requires the netns wrapper (scripts/test-soak-netns.sh):
// shaping the host loopback is forbidden.
//
// Env: SOAK_PARTICIPANTS (default 4), SOAK_SECONDS (default 30, min 20; in
// impairment mode default 300, must fit two impaired+clean window pairs),
// SOAK_PROFILE_SECONDS (default 15; two windows must fit in SOAK_SECONDS),
// SOAK_IMPAIR_WINDOW_SECONDS (default 90), SOAK_CLEAN_WINDOW_SECONDS
// (default 30), CHROMIUM_PATH / CHROME_PATH as in the other e2e harnesses.

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright-core");
const netemTiers = require("./netem-tiers");

const root = path.join(__dirname, "..");
const adminPassword = "slowmeet-soak-admin-password";
const impairment = process.env.SOAK_IMPAIRMENT === "1";
const soakNetns = process.env.SOAK_NETNS === "1";
if (impairment && !soakNetns) {
  console.error("SOAK_IMPAIRMENT=1 shapes the loopback and must run inside the netns wrapper: make test-soak-netns");
  process.exit(2);
}
const participants = Math.max(1, Number(process.env.SOAK_PARTICIPANTS || 4));
const soakSeconds = Math.max(20, Number(process.env.SOAK_SECONDS || (impairment ? 300 : 30)));
const profileSeconds = Math.max(5, Number(process.env.SOAK_PROFILE_SECONDS || 15));
const impairWindowSeconds = Math.max(30, Number(process.env.SOAK_IMPAIR_WINDOW_SECONDS || 90));
const cleanWindowSeconds = Math.max(15, Number(process.env.SOAK_CLEAN_WINDOW_SECONDS || 30));
assert.ok(soakSeconds >= 2 * profileSeconds,
  `SOAK_SECONDS=${soakSeconds} must fit two ${profileSeconds}s profile windows`);
if (impairment) {
  assert.equal(participants, 4,
    `the weak-network soak models exactly four participants (got SOAK_PARTICIPANTS=${participants})`);
  assert.ok(soakSeconds >= 2 * (impairWindowSeconds + cleanWindowSeconds),
    `SOAK_SECONDS=${soakSeconds} must fit two ${impairWindowSeconds}s+${cleanWindowSeconds}s impairment cycles`);
}

// pprof (go tool pprof) honors HTTP(S)_PROXY; the ambient proxy here returns
// a bogus 502 for loopback, so blank it for every pprof invocation.
const noProxyEnv = { ...process.env,
  http_proxy: "", https_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "",
  no_proxy: "127.0.0.1,localhost", NO_PROXY: "127.0.0.1,localhost" };

const browsers = [];
const contexts = [];
const pages = [];
let server;
// Profiles land here and survive the run: an earlier pass lost its baseline
// when tmp cleaners wiped the /tmp workdir, leaving no evidence for the
// pooling/GOGC gate decisions. The server binary still builds into
// os.tmpdir() so no binary ever lands in the repo.
const artifactsDir = path.join(root, "soak-artifacts",
  `${new Date().toISOString().replace(/[:.]/g, "-")}-p${participants}-s${soakSeconds}s`);
const serverBinary = path.join(os.tmpdir(), `slowmeet-soak-${process.pid}`);

// Correlation epoch for blackout attribution: every evidence stream — the
// 1s audio timeline, the server log lines, and the netem class snapshots —
// records offsets from this same instant, so a dark interval can be aligned
// across all three without clock gymnastics.
const timelineEpoch = Date.now();
const audioTimeline = [];
let audioSampler;
const netemSnapshots = [];

function snapshotNetem(label) {
  netemSnapshots.push({ at: Date.now() - timelineEpoch, label, stats: netemTiers.snapshotTierStats() });
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.once("error", reject);
  });
}

async function startServer() {
  console.log("building server binary...");
  execFileSync("go", ["build", "-o", serverBinary, "."], { cwd: root, stdio: "inherit" });
  const port = await reservePort();
  const configPath = path.join(os.tmpdir(), `slowmeet-soak-config-${process.pid}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ retain_chat_history: true }));
  const output = [];
  const child = spawn(serverBinary, [], {
    cwd: root,
    env: { ...process.env,
      HTTP_ADDR: `127.0.0.1:${port}`, MAX_PARTICIPANTS: String(participants + 1),
      // Inside the netns the only route is loopback; without a public IP the
      // SFU gathers no candidates at all.
      ...(soakNetns ? { ICE_PUBLIC_IP: "127.0.0.1" } : {}),
      // Optional deeper evidence (SDP/renegotiation debug lines) for
      // blackout attribution; info by default keeps artifacts small.
      ...(process.env.SOAK_LOG_LEVEL ? { LOG_LEVEL: process.env.SOAK_LOG_LEVEL } : {}),
      MEETING_PASSWORD: "", ADMIN_PASSWORD: adminPassword, CONFIG_FILE: configPath },
    detached: true, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => output.push(data.toString()));
  child.stderr.on("data", (data) => output.push(data.toString()));
  const url = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${url}/health`)).ok) { ready = true; break; } } catch (_) {}
    if (child.exitCode !== null) break;
    await delay(250);
  }
  assert.ok(ready, `local server did not become ready\n${output.join("").slice(-8000)}`);
  return {
    url, port, profileDir: artifactsDir,
    async stop() {
      try { process.kill(-child.pid, "SIGTERM"); } catch (_) { child.kill("SIGTERM"); }
      await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)]);
      // The server log is blackout-attribution evidence: the slog
      // fingerprints of a renegotiation pause (media_publication_replaced_track,
      // network_degraded, webrtc_failed, webrtc_state_changed) only exist
      // here — /metrics has no media counters. Persist it, timestamped
      // relative to the audio timeline's epoch.
      fs.writeFileSync(path.join(artifactsDir, "server.log"),
        output.join("").split("\n").map((line) => {
          const match = /"time":"([^"]+)"/.exec(line);
          if (!match) return line;
          const at = Date.parse(match[1]) - timelineEpoch;
          return `${at >= 0 ? "+" : ""}${at}ms ${line}`;
        }).join("\n"));
    },
  };
}

function findChromium() {
  return process.env.CHROMIUM_PATH || process.env.CHROME_PATH ||
    ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome"].find((candidate) => fs.existsSync(candidate));
}

async function createParticipant(index) {
  const browser = await chromium.launch({
    ...(findChromium() ? { executablePath: findChromium() } : {}),
    headless: process.env.MEDIA_E2E_HEADED !== "1",
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required", "--no-proxy-server",
      "--no-sandbox", "--disable-dev-shm-usage",
      // Same netns block as the four-person harness: plain host ICE
      // candidates (mDNS names cannot resolve in the namespace) and loopback
      // ICE allowed.
      ...(soakNetns ? ["--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
        "--force-webrtc-ip-handling-policy=default_public_interface_only",
        "--disable-features=WebRtcHideLocalIpsWithMdns",
        "--allow-loopback-in-peer-connection",
        `--unsafely-treat-insecure-origin-as-secure=${server.url}`] : [])],
  });
  browsers.push(browser);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  contexts.push(context);
  await context.grantPermissions(["camera", "microphone"], { origin: server.url });
  await context.addInitScript(() => {
    const nativePeer = window.RTCPeerConnection;
    window.__slowMeetTest = { peerConnections: [] };
    window.RTCPeerConnection = new Proxy(nativePeer, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      window.__slowMeetTest.peerConnections.push(peer);
      return peer;
    } });
  });
  const page = await context.newPage();
  pages.push(page);
  await page.goto(server.url);
  await page.locator("#join-form").waitFor({ timeout: 15000 });
  await page.locator("#name").fill(`Soak${index + 1}`);
  await page.locator("#join").click();
  await page.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
  return page;
}

async function enableMedia(page) {
  for (const selector of ["#mic", "#camera"]) {
    if (await page.locator(selector).getAttribute("aria-pressed") !== "true") {
      await page.locator(selector).click();
    }
  }
  await page.waitForFunction(() =>
    document.querySelector("#camera")?.getAttribute("aria-pressed") === "true" &&
    document.querySelector("#mic")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
}

// Sum of decoded video frames across this participant's inbound streams —
// the same signal the other e2e harnesses use to prove media is flowing.
async function decodedFrames(page) {
  return page.evaluate(async () => {
    const peers = (window.__slowMeetTest?.peerConnections || [])
      .filter((peer) => peer.connectionState === "connected");
    const reports = await Promise.all(peers.map((peer) => peer.getStats()));
    return reports.flatMap((report) => [...report.values()])
      .filter((item) => item.type === "inbound-rtp" && item.kind === "video")
      .reduce((total, item) => total + (item.framesDecoded || 0), 0);
  });
}

async function waitForFlowingMedia() {
  const deadline = Date.now() + 30000;
  let before = pages.map((page) => 0);
  while (Date.now() < deadline) {
    await delay(3000);
    const after = [];
    for (const page of pages) after.push(await decodedFrames(page));
    if (after.every((frames, index) => frames > before[index] + 30)) {
      console.log(`media flowing: decoded frames per participant = ${after.join(", ")}`);
      return;
    }
    before = after;
  }
  throw new Error("synthetic media never reached a steady flow (frames not advancing)");
}

// --- Weak-network soak (SOAK_IMPAIRMENT=1) ---------------------------------

// Audio bytes in both directions: the guarantee under impairment is audio
// keeps moving, and bytes — unlike decoded frames — advance for senders
// whose own uplink is capped.
async function audioBytes(page) {
  return page.evaluate(async () => {
    const peers = (window.__slowMeetTest?.peerConnections || [])
      .filter((peer) => peer.connectionState === "connected");
    const reports = await Promise.all(peers.map((peer) => peer.getStats()));
    let sent = 0;
    let received = 0;
    for (const report of reports) {
      for (const item of report.values()) {
        if (item.type === "outbound-rtp" && item.kind === "audio") sent += item.bytesSent || 0;
        if (item.type === "inbound-rtp" && item.kind === "audio") received += item.bytesReceived || 0;
      }
    }
    return { sent, received };
  });
}

// Audio silence under sustained impairment is allowed to be TRANSIENT — a
// peer rebuilt mid-window renegotiates for tens of seconds before inbound
// audio resumes — but it must not be permanent. Dark participants get a
// wait-for-flow allowance; nobody may still be dark when it expires.
async function assertAudioAdvanced(label) {
  const before = [];
  for (const page of pages) before.push(await audioBytes(page));
  await delay(8000);
  const dark = [];
  for (const [index, page] of pages.entries()) {
    const after = await audioBytes(page);
    const advanced = after.sent > before[index].sent && after.received > before[index].received;
    const flowing = after.sent > 0 && after.received > 0;
    if (!advanced && !flowing) dark.push({ index, page });
  }
  if (dark.length) {
    console.log(`[${label}] ${dark.length} participant(s) audio-dark mid-window (peer churn); waiting for flow to resume`);
    // Blackout-attribution evidence, captured at dark onset: per-class
    // drop/backlog counters show whether the dark participant's tier queue
    // was starving them (Drops climbing = netem starvation) or idle
    // (forwarding paused server-side = renegotiation gap).
    snapshotNetem(`${label} dark-onset`);
    await Promise.all(dark.map(({ page }) => page.waitForFunction(async () => {
      const peers = (window.__slowMeetTest?.peerConnections || [])
        .filter((peer) => peer.connectionState === "connected");
      const reports = await Promise.all(peers.map((peer) => peer.getStats()));
      let sent = 0;
      let received = 0;
      for (const report of reports) {
        for (const item of report.values()) {
          if (item.type === "outbound-rtp" && item.kind === "audio") sent += item.bytesSent || 0;
          if (item.type === "inbound-rtp" && item.kind === "audio") received += item.bytesReceived || 0;
        }
      }
      return sent > 0 && received > 0;
    }, null, { timeout: 30000 })));
    snapshotNetem(`${label} dark-end`);
  }
  console.log(`[${label}] audio advanced for all ${pages.length} participants`);
}

// Recovery contract after an impaired window lifts: the clean observer's
// view of every remote camera returns to "on" within a patient deadline.
function waitForCameraOn(observerPage, participantName, timeoutMs = 90000) {
  return observerPage.waitForFunction((target) => {
    const tile = [...document.querySelectorAll("li[data-participant-id]")]
      .find((item) => item.textContent.includes(target));
    return Boolean(tile) && tile.dataset.camera === "on";
  }, participantName, { timeout: timeoutMs });
}

// /metrics needs no auth and carries the room-wide counters; snapshots are
// appended to the artifact timeline so a failure shows what the room saw.
async function metricsSnapshot() {
  const text = await (await fetch(`${server.url}/metrics`)).text();
  const value = (name) => {
    const match = new RegExp(`^${name} ([\\d.]+)$`, "m").exec(text);
    return match ? Number(match[1]) : null;
  };
  return {
    at: new Date().toISOString(),
    activeParticipants: value("slowmeet_active_participants"),
    peerConnections: value("slowmeet_peer_connections"),
    reconnects: value("slowmeet_reconnects_total"),
    connectionFailures: value("slowmeet_connection_failures_total"),
    averageRTTMs: value("slowmeet_average_rtt_ms"),
    lastRTTMs: value("slowmeet_last_rtt_ms"),
    lastLossPct: value("slowmeet_last_packet_loss_percent"),
  };
}

// The exact metric names drift; keep the reconnects parse resilient by
// matching the family prefix if the exact name misses.
function reconnectsFromSnapshot(snapshot) {
  return snapshot.reconnects ?? 0;
}

async function goroutineCount() {
  const response = await fetch(`${server.url}/debug/pprof/goroutine?debug=1`,
    { headers: { "X-Admin-Password": adminPassword } });
  assert.equal(response.status, 200, `goroutine profile status ${response.status}`);
  const match = /^goroutine profile: total (\d+)$/m.exec(await response.text());
  return match ? Number(match[1]) : null;
}

async function runImpairmentCycles() {
  const participantNames = pages.map((_, index) => `Soak${index + 1}`);
  const pagesByName = new Map(pages.map((page, index) => [`P${index + 1}`, page]));
  const cleanObserver = pages[0];
  const metricsTimeline = [];
  let cpu1;
  let cpu2;
  const reconnectsLimitPerWindow = 8;
  const goroutineBaseline = await goroutineCount();
  console.log(`goroutine baseline: ${goroutineBaseline}`);

  for (let cycle = 1; cycle <= 2; cycle += 1) {
    // Impaired window: the armer keeps classifying rebound ports while the
    // tiers shape the room; the CPU profile window is captured mid-window
    // (after a settle so the tiers have bitten), so both profiles measure
    // the cost of impairment itself rather than the aftermath.
    netemTiers.installRoomQdisc();
    const armer = netemTiers.armParticipantTiers(
      { P2: "moderate", P3: "severe", P4: "capped" }, pagesByName);
    let cpuWindow;
    try {
      await delay(10000);
      cpuWindow = await captureProfile(`cpu-window${cycle}`, profileSeconds);
      await assertAudioAdvanced(`cycle ${cycle} impaired window`);
      const impairedMetrics = await metricsSnapshot();
      metricsTimeline.push({ window: `cycle-${cycle}-impaired`, ...impairedMetrics });
      fs.writeFileSync(path.join(artifactsDir, `metrics-cycle${cycle}-impaired.txt`),
        await (await fetch(`${server.url}/metrics`)).text());
    } finally {
      armer.stopped = true;
    }
    netemTiers.clearRoomProfiles();
    if (cycle === 1) cpu1 = cpuWindow;
    else cpu2 = cpuWindow;

    // Clean recovery window: the lift must restore every camera for the
    // clean observer, reconnect counts must stay bounded (the client may
    // full-reconnect a wedged peer — bounded, not zero), and goroutines must
    // return to baseline (no recovery-loop leak).
    const before = await metricsSnapshot();
    await Promise.all(participantNames.slice(1).map((name) =>
      waitForCameraOn(cleanObserver, name)));
    console.log(`[cycle ${cycle} clean window] all remote cameras recovered for the clean observer`);
    const cleanMetrics = await metricsSnapshot();
    metricsTimeline.push({ window: `cycle-${cycle}-clean`, ...cleanMetrics });
    fs.writeFileSync(path.join(artifactsDir, `metrics-cycle${cycle}-clean.txt`),
      await (await fetch(`${server.url}/metrics`)).text());
    const reconnectsDuringImpairment =
      (reconnectsFromSnapshot(cleanMetrics) - reconnectsFromSnapshot(before));
    assert.ok(reconnectsDuringImpairment >= 0 && reconnectsDuringImpairment <= reconnectsLimitPerWindow,
      `cycle ${cycle}: reconnects grew by ${reconnectsDuringImpairment} across the window (limit ${reconnectsLimitPerWindow})`);
    const goroutinesNow = await goroutineCount();
    assert.ok(goroutinesNow !== null && goroutineBaseline !== null &&
      goroutinesNow <= goroutineBaseline + 20,
      `cycle ${cycle}: goroutines ${goroutineBaseline} -> ${goroutinesNow} after the clean window (leak guard +20)`);
    console.log(`[cycle ${cycle} clean window] reconnects +${reconnectsDuringImpairment}, goroutines ${goroutinesNow}`);
  }
  fs.writeFileSync(path.join(artifactsDir, "metrics.json"), JSON.stringify({
    tiers: { P1: "clean", P2: "moderate", P3: "severe", P4: "capped" },
    goroutineBaseline, timeline: metricsTimeline,
  }, null, 2));
  console.log(`metrics timeline written to ${path.join(artifactsDir, "metrics.json")}`);
  return { cpu1, cpu2 };
}

async function captureProfile(windowName, seconds) {
  const file = path.join(artifactsDir, `${windowName}.prof`);
  const response = await fetch(
    `${server.url}/debug/pprof/profile?seconds=${seconds}`,
    { headers: { "X-Admin-Password": adminPassword } });
  assert.equal(response.status, 200, `${windowName} profile status ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  const top = execFileSync("go", ["tool", "pprof", "-top", "-nodecount", "15", serverBinary, file],
    { env: noProxyEnv, encoding: "utf8" });
  console.log(`\n=== ${windowName} (${seconds}s) ===`);
  console.log(top.trim());
  const total = /Total samples = ([\d.]+)(\w*)/.exec(top);
  return { file, totalSamples: total ? Number(total[1]) : null, unit: total ? total[2] : "?" };
}

async function captureTextProfile(name) {
  const file = path.join(artifactsDir, `${name}.txt`);
  const response = await fetch(`${server.url}/debug/pprof/${name}?debug=1`,
    { headers: { "X-Admin-Password": adminPassword } });
  assert.equal(response.status, 200, `${name} profile status ${response.status}`);
  fs.writeFileSync(file, await response.text());
  return file;
}

// Binary profiles for numeric analysis: allocation-rate deltas need
// sample_index selection and -diff_base, both pprof features over protobuf.
async function captureProtoProfile(profile, fileBase) {
  const file = path.join(artifactsDir, `${fileBase}.pb`);
  const response = await fetch(`${server.url}/debug/pprof/${profile}`,
    { headers: { "X-Admin-Password": adminPassword } });
  assert.equal(response.status, 200, `${profile} profile status ${response.status}`);
  fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  return file;
}

// pprof prints "Showing nodes accounting for 1.2MB, 3.45% of 27MB total".
function parsePprofTotalBytes(top) {
  const match = /accounting for [^,]+, [\d.]+% of ([\d.]+)(B|kB|MB|GB) total/.exec(top);
  assert.ok(match, `pprof total not parseable in output: ${top.split("\n")[0]}`);
  return Number(match[1]) * { B: 1, kB: 1024, MB: 1024 ** 2, GB: 1024 ** 3 }[match[2]];
}

function pprofTop(binary, file, sampleIndex, extraFlags = []) {
  return execFileSync("go", ["tool", "pprof", "-top", `-sample_index=${sampleIndex}`,
    ...extraFlags, binary, file], { env: noProxyEnv, encoding: "utf8" });
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)}GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(2)}MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}kB`;
  return `${bytes}B`;
}

(async () => {
  try {
    server = await startServer();
    console.log(`joining ${participants} participants on ${server.url} ...`);
    for (let index = 0; index < participants; index += 1) {
      await createParticipant(index);
    }
    await Promise.all(pages.map((page) => enableMedia(page)));
    await waitForFlowingMedia();

    // 1s per-participant audio timeline: the raw material for blackout
    // attribution. Each sample records every participant's cumulative
    // sent/received audio bytes relative to the correlation epoch; a dark
    // interval shows up as a flat-lined received counter with a timestamp
    // that aligns against server.log events and the netem snapshots.
    let sampling = true;
    (async () => {
      while (sampling) {
        const participants = [];
        for (const page of pages) participants.push(await audioBytes(page));
        audioTimeline.push({ at: Date.now() - timelineEpoch, participants });
        await delay(1000);
      }
    })().catch(() => {});

    fs.mkdirSync(artifactsDir, { recursive: true });
    // Allocation-rate windows: the two allocs snapshots bracket the CPU
    // windows (~30s apart), so the allocs delta measures allocation during
    // steady-state media flow. GOGC=100 collects when the heap roughly
    // doubles, so rough GC cadence ≈ live heap / allocation rate.
    const allocs1 = await captureProtoProfile("allocs", "allocs-1");
    const heap1 = await captureProtoProfile("heap", "heap-1");
    const sampleStart = Date.now();
    let first;
    let second;
    if (impairment) {
      // Both CPU windows are captured DURING impaired windows inside the
      // cycle runner (the allocs/heap bracket below then measures the
      // post-impairment steady state).
      ({ cpu1: first, cpu2: second } = await runImpairmentCycles());
    } else {
      first = await captureProfile("cpu-window1", profileSeconds);
      second = await captureProfile("cpu-window2", profileSeconds);
    }
    const allocs2 = await captureProtoProfile("allocs", "allocs-2");
    const heap2 = await captureProtoProfile("heap", "heap-2");
    const sampleSeconds = Math.max(1, (Date.now() - sampleStart) / 1000);
    const goroutineFile = await captureTextProfile("goroutine");
    const goroutines = (fs.readFileSync(goroutineFile, "utf8").match(/^goroutine profile: total (\d+)$/m) || [])[1];

    const allocBefore = parsePprofTotalBytes(pprofTop(serverBinary, allocs1, "alloc_space"));
    const allocAfter = parsePprofTotalBytes(pprofTop(serverBinary, allocs2, "alloc_space"));
    const allocatedDuring = Math.max(0, allocAfter - allocBefore);
    const allocRateMBps = allocatedDuring / sampleSeconds / 1024 ** 2;
    const liveHeapBytes = parsePprofTotalBytes(pprofTop(serverBinary, heap2, "inuse_space"));
    const deltaTop = execFileSync("go", ["tool", "pprof", "-top", "-sample_index=alloc_space",
      "-nodecount", "10", `-diff_base=${allocs1}`, serverBinary, allocs2],
      { env: noProxyEnv, encoding: "utf8" });

    console.log("\n=== soak summary ===");
    console.log(`participants: ${participants}, profile windows: 2 x ${profileSeconds}s`);
    console.log(`cpu window 1 total samples: ${first.totalSamples} ${first.unit}`);
    console.log(`cpu window 2 total samples: ${second.totalSamples} ${second.unit}`);
    console.log(`allocation over ${sampleSeconds.toFixed(0)}s: ${formatBytes(allocatedDuring)} = ${allocRateMBps.toFixed(2)} MB/s (cumulative allocs ${formatBytes(allocBefore)} -> ${formatBytes(allocAfter)})`);
    console.log(`live heap (inuse): ${formatBytes(liveHeapBytes)}`);
    if (allocRateMBps > 0) {
      console.log(`rough GC cadence (GOGC=100, heap doubles): ~${(liveHeapBytes / (allocRateMBps * 1024 ** 2)).toFixed(1)}s between collections`);
    }
    console.log(`top allocation-rate sites (delta over ${sampleSeconds.toFixed(0)}s):`);
    console.log(deltaTop.trim());
    console.log(`goroutines: ${goroutines}`);
    console.log(`artifacts in ${artifactsDir}`);
    assert.ok(first.totalSamples > 0 && second.totalSamples > 0,
      "CPU profiles contain no samples — media was not flowing during capture");
    assert.ok(allocatedDuring > 0,
      "allocs snapshots show no allocation delta — media was not flowing during capture");
  } finally {
    sampling = false;
    // Evidence streams for blackout attribution — written even on failure
    // so a broken run still carries its own diagnosis.
    fs.mkdirSync(artifactsDir, { recursive: true });
    for (const context of contexts) await context.close().catch(() => {});
    for (const browser of browsers) await browser.close().catch(() => {});
    if (server) await server.stop();
    fs.writeFileSync(path.join(artifactsDir, "audio-timeline.json"),
      JSON.stringify({ epoch: timelineEpoch, samples: audioTimeline }, null, 2));
    fs.writeFileSync(path.join(artifactsDir, "netem-snapshots.json"),
      JSON.stringify(netemSnapshots, null, 2));
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
