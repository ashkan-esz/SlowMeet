#!/usr/bin/env node

// Sustained-meeting soak with server profiling. Joins N headless Chromium
// participants on synthetic camera+audio media, verifies decoded frames keep
// advancing, and while media flows captures CPU/heap/goroutine profiles from
// the server's admin-gated /debug/pprof endpoints. Run it twice around a
// media-path change to get a comparable before/after CPU baseline.
//
// Env: SOAK_PARTICIPANTS (default 4), SOAK_SECONDS (default 30, min 20),
// SOAK_PROFILE_SECONDS (default 15; two windows must fit in SOAK_SECONDS),
// CHROMIUM_PATH / CHROME_PATH as in the other e2e harnesses.

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright-core");

const root = path.join(__dirname, "..");
const adminPassword = "slowmeet-soak-admin-password";
const participants = Math.max(1, Number(process.env.SOAK_PARTICIPANTS || 4));
const soakSeconds = Math.max(20, Number(process.env.SOAK_SECONDS || 30));
const profileSeconds = Math.max(5, Number(process.env.SOAK_PROFILE_SECONDS || 15));
assert.ok(soakSeconds >= 2 * profileSeconds,
  `SOAK_SECONDS=${soakSeconds} must fit two ${profileSeconds}s profile windows`);

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
      "--no-sandbox", "--disable-dev-shm-usage"],
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

    fs.mkdirSync(artifactsDir, { recursive: true });
    // Allocation-rate windows: the two allocs snapshots bracket the CPU
    // windows (~30s apart), so the allocs delta measures allocation during
    // steady-state media flow. GOGC=100 collects when the heap roughly
    // doubles, so rough GC cadence ≈ live heap / allocation rate.
    const allocs1 = await captureProtoProfile("allocs", "allocs-1");
    const heap1 = await captureProtoProfile("heap", "heap-1");
    const sampleStart = Date.now();
    const first = await captureProfile("cpu-window1", profileSeconds);
    const second = await captureProfile("cpu-window2", profileSeconds);
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
    for (const context of contexts) await context.close().catch(() => {});
    for (const browser of browsers) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
