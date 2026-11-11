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
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "slowmeet-soak-"));
const serverBinary = path.join(workDir, "slowmeet-soak");

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
  const configPath = path.join(workDir, "config.json");
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
    url, port, profileDir: workDir,
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
  const file = path.join(workDir, `${windowName}.prof`);
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
  const file = path.join(workDir, `${name}.txt`);
  const response = await fetch(`${server.url}/debug/pprof/${name}?debug=1`,
    { headers: { "X-Admin-Password": adminPassword } });
  assert.equal(response.status, 200, `${name} profile status ${response.status}`);
  fs.writeFileSync(file, await response.text());
  return file;
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

    const first = await captureProfile("cpu-window1", profileSeconds);
    const second = await captureProfile("cpu-window2", profileSeconds);
    const heapFile = await captureTextProfile("heap");
    const goroutineFile = await captureTextProfile("goroutine");
    const goroutines = (fs.readFileSync(goroutineFile, "utf8").match(/^goroutine profile: total (\d+)$/m) || [])[1];

    console.log("\n=== soak summary ===");
    console.log(`participants: ${participants}, profile windows: 2 x ${profileSeconds}s`);
    console.log(`cpu window 1 total samples: ${first.totalSamples} ${first.unit}`);
    console.log(`cpu window 2 total samples: ${second.totalSamples} ${second.unit}`);
    console.log(`goroutines: ${goroutines}`);
    console.log(`profiles in ${workDir}: cpu-window1.prof, cpu-window2.prof, heap.txt, goroutine.txt`);
    assert.ok(first.totalSamples > 0 && second.totalSamples > 0,
      "CPU profiles contain no samples — media was not flowing during capture");
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    for (const browser of browsers) await browser.close().catch(() => {});
    if (server) await server.stop();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
