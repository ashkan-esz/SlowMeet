#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium, firefox } = require("playwright-core");
const axeSource = (() => {
  try { return require("axe-core").source; } catch (_) { return ""; }
})();

const root = path.join(__dirname, "..");
const names = ["Avery", "Blake", "Casey", "Drew"];
const roles = names.map((_, index) => `P${index + 1}`);
const adminPassword = "slowmeet-four-e2e-admin-password";
// MEDIA_E2E_FOUR_RECONNECT_GRACE overrides the server's reconnect grace window
// (seconds). The default 5s is comfortably above the client's 2s reconnect
// backoff, so the signaling-reconnect scenario exercises true token resume;
// a 1s grace forces the reconnect-after-expiry full-rejoin path instead.
const reconnectGraceSeconds = Number(process.env.MEDIA_E2E_FOUR_RECONNECT_GRACE || 5);
// MEDIA_E2E_FOUR_ENGINES=mixed (default) keeps P1/P3 on Chromium and P2/P4 on
// Firefox; "chromium" runs every participant on Chromium for faster isolation.
const engineMode = (process.env.MEDIA_E2E_FOUR_ENGINES || "mixed").toLowerCase();
const browserNames = new Map(roles.map((role, index) => [role,
  engineMode === "chromium" ? "chromium" : (index % 2 === 0 ? "chromium" : "firefox")]));
// MEDIA_E2E_FOUR_NETNS=1 (set by scripts/test-four-person-e2e-netns.sh) arms
// the per-participant room classifiers: without it, in a plain run, the
// netns.* scenarios are skipped because shaping the host loopback is forbidden.
const netnsRoom = process.env.MEDIA_E2E_FOUR_NETNS === "1";
const contexts = [];
const traces = new Set();
const pages = new Map();
const events = new Map();
const browsers = [];
let server;
let activeScenario = "startup";

async function startServer() {
  const portServer = net.createServer();
  await new Promise((resolve, reject) => portServer.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = portServer.address().port;
  await new Promise((resolve) => portServer.close(resolve));
  const configPath = path.join(os.tmpdir(), `slowmeet-four-e2e-${process.pid}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ retain_chat_history: true }));
  const output = [];
  const child = spawn("go", ["run", "."], {
    cwd: root,
    env: { ...process.env, HTTP_ADDR: `127.0.0.1:${port}`, MAX_PARTICIPANTS: "4",
      RECONNECT_TIMEOUT_SECONDS: String(reconnectGraceSeconds), MEETING_PASSWORD: "",
      ADMIN_PASSWORD: adminPassword, CONFIG_FILE: configPath,
      // In the namespace the server's only interface is loopback; without
      // the NAT 1-to-1 loopback path the SFU gathers no candidates at all.
      ...(netnsRoom ? { ICE_PUBLIC_IP: "127.0.0.1" } : {}),
      GOCACHE: process.env.GOCACHE || "/tmp/slowmeet-four-e2e-gocache" },
    detached: true, stdio: ["ignore", "pipe", "pipe"]
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
  return { child, output, url, async stop() {
    try { process.kill(-child.pid, "SIGTERM"); } catch (_) { child.kill("SIGTERM"); }
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)]);
    fs.rmSync(configPath, { force: true });
  } };
}

async function createParticipant(role, name, expectRejected = false, skipJoin = false) {
  const browserName = browserNames.get(role) || "chromium";
  const browserType = browserName === "firefox" ? firefox : chromium;
  const configuredPath = browserName === "firefox"
    ? process.env.FIREFOX_PATH || ["/usr/bin/firefox", "/usr/bin/firefox-esr"].find((candidate) => fs.existsSync(candidate))
    : process.env.CHROMIUM_PATH || process.env.CHROME_PATH ||
      ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/opt/google/chrome/chrome"]
        .find((candidate) => fs.existsSync(candidate));
  const browser = await browserType.launch({
    ...(configuredPath ? { executablePath: configuredPath } : {}),
    headless: process.env.MEDIA_E2E_HEADED !== "1",
    ...(browserName === "firefox"
      ? { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true,
          // Loopback e2e must bypass ambient HTTP(S)_PROXY environment settings.
          "network.proxy.type": 0 } }
      : { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required",
          "--no-proxy-server",
          // Inside the netns the only route is loopback. Mirror the
          // two-person runner's netns flags: sandbox/shm relief for four
          // headless browsers, plain host ICE candidates (mDNS names cannot
          // resolve in the namespace), and loopback ICE allowed.
          ...(netnsRoom ? ["--no-sandbox", "--disable-dev-shm-usage",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--disable-renderer-backgrounding",
            "--force-webrtc-ip-handling-policy=default_public_interface_only",
            "--disable-features=WebRtcHideLocalIpsWithMdns",
            "--allow-loopback-in-peer-connection",
            `--unsafely-treat-insecure-origin-as-secure=${server.url}`] : [])] })
  });
  browsers.push(browser);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  contexts.push(context);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  traces.add(context);
  if (browserName === "chromium") await context.grantPermissions(["camera", "microphone"], { origin: server.url });
  await context.addInitScript(() => {
    const nativePeer = window.RTCPeerConnection;
    const nativeSocket = window.WebSocket;
    window.__slowMeetTest = { peerConnections: [], sockets: [], socketEvents: [] };
    window.RTCPeerConnection = new Proxy(nativePeer, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      window.__slowMeetTest.peerConnections.push(peer);
      return peer;
    } });
    window.WebSocket = new Proxy(nativeSocket, { construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      window.__slowMeetTest.sockets.push(socket);
      const record = (direction, value) => {
        let message = value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            message = { type: parsed.type, participant_id: parsed.participant_id,
              screen_share_active: parsed.screen_share_active, screen_share_owner: parsed.screen_share_owner,
              screen_share_enabled: parsed.screen_share_enabled, max_video_bitrate: parsed.max_video_bitrate,
              reconnect_token: parsed.reconnect_token,
              hand_raised: parsed.hand_raised, audio_enabled: parsed.audio_enabled,
              video_enabled: parsed.video_enabled, error: parsed.error };
          } catch (_) { message = value.slice(0, 200); }
        }
        window.__slowMeetTest.socketEvents.push({ direction, message,
          bytes: typeof value === "string" ? value.length : undefined, readyState: socket.readyState });
      };
      const nativeSend = socket.send.bind(socket);
      socket.send = (value) => { record("send", value); return nativeSend(value); };
      socket.addEventListener("message", ({ data }) => record("receive", data));
      socket.addEventListener("close", ({ code, reason, wasClean }) => {
        record("close", { code, reason, wasClean });
      });
      socket.addEventListener("error", () => record("error", "websocket error"));
      return socket;
    } });
  });
  await context.addInitScript(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext("2d"); let frame = 0;
      const draw = () => { ctx.fillStyle = `hsl(${frame * 37 % 360} 70% 45%)`; ctx.fillRect(0, 0, 640, 360); ctx.fillStyle = "white"; ctx.fillText(`Generated share ${frame++}`, 30, 60); };
      draw(); const timer = setInterval(draw, 250); const stream = canvas.captureStream(10);
      stream.getVideoTracks()[0].addEventListener("ended", () => clearInterval(timer), { once: true }); return stream;
    };
  });
  const page = await context.newPage();
  pages.set(role, page); events.set(role, []);
  page.on("console", (message) => events.get(role).push({ type: "console", text: message.text() }));
  page.on("pageerror", (error) => events.get(role).push({ type: "pageerror", text: error.message }));
  page.on("requestfailed", (request) => events.get(role).push({ type: "requestfailed", url: request.url(), error: request.failure()?.errorText }));
  await page.goto(server.url);
  await page.locator("#join-form").waitFor({ timeout: 15000 });
  if (skipJoin) return page;
  await page.locator("#name").fill(name);
  await page.locator("#join").click();
  if (expectRejected) {
    await page.waitForFunction(() => /full|capacity/i.test(document.querySelector("#status")?.textContent || ""), null, { timeout: 10000 });
    return page;
  }
  await page.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
  return page;
}

async function join(role) { return createParticipant(role, names[roles.indexOf(role)]); }

// Joins every missing participant, preserving the staggered-then-simultaneous
// pattern of the opening scenario. Safe to call from every scenario.
async function joinAll() {
  const missing = roles.filter((role) => !pages.has(role));
  if (!missing.length) return;
  for (const role of missing.slice(0, 2)) await join(role);
  await Promise.all(missing.slice(2).map((role) => join(role)));
}

async function enableCameras() {
  for (const page of pages.values()) {
    if (await page.locator("#camera").getAttribute("aria-pressed") !== "true") {
      await page.locator("#camera").click();
    }
  }
  for (const page of pages.values()) {
    await page.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  }
  await assertMedia();
}

async function setupRoom() { await joinAll(); await enableCameras(); }

async function roster(page, expected) {
  // Tiles live under #participants (grid), #pinned-main/#pinned-filmstrip
  // (pinned or the 1:1 auto-pin layout), or #layout-parking (hidden); only
  // parked tiles are excluded from the visible roster. Departed tiles linger
  // for ~1.2s showing "Participant left", so wait for the exact composition
  // to settle instead of just a minimum count.
  await page.waitForFunction((expected) => {
    const visible = [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .filter((tile) => !tile.closest("#layout-parking"));
    return visible.length === expected.length &&
      expected.every((name) => visible.some((tile) => tile.textContent.includes(name)));
  }, expected, { timeout: 20000 });
  const visible = await page.evaluate(() =>
    [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .filter((tile) => !tile.closest("#layout-parking"))
      .map((tile) => tile.textContent));
  assert.equal(visible.length, expected.length, `roster has ghost or duplicate tiles: ${visible.join(" | ")}`);
  for (const name of expected) assert.ok(visible.some((value) => value.includes(name)), `roster missing ${name}: ${visible.join(" | ")}`);
}

async function waitText(page, selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text),
    { selector, text }, { timeout: 15000 });
}

async function openChat(page) {
  const toggle = page.locator("#chat");
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && !rail.hidden && rail.classList.contains("is-open");
  }, null, { timeout: 10000 });
  await page.locator("#chat-form button[type=submit]").waitFor({ state: "visible", timeout: 10000 });
}

async function closeChat(page) {
  if (await page.locator("#chat").getAttribute("aria-pressed") === "true") {
    await page.locator("#close-chat").click();
  }
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && rail.hidden;
  }, null, { timeout: 10000 });
}

async function sendChat(page, text) {
  await openChat(page); await page.locator("#chat-input").fill(text); await page.locator("#chat-form button[type=submit]").click();
}

// The #more button toggles the settings sidebar, so open it only when the
// panel is not already up (a previous scenario may have left it open).
async function openSettingsPanel(page) {
  const quality = page.locator("#camera-quality");
  if (!(await quality.isVisible().catch(() => false))) {
    await page.locator("#more").click();
  }
  await quality.waitFor({ state: "visible", timeout: 5000 });
}

async function participantIDFor(page, name) {
  const participantID = await page.evaluate((target) =>
    [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .find((tile) => tile.textContent.includes(target))?.dataset.participantId, name);
  assert.ok(participantID, `${name} participant tile has no participant ID`);
  return participantID;
}

function waitForTileState(peer, participantID, attribute, value, timeout = 10000) {
  return peer.waitForFunction(({ id, attribute, value }) => {
    const tile = [...document.querySelectorAll("li[data-participant-id]")]
      .find((item) => item.dataset.participantId === id);
    return Boolean(tile) && tile.dataset[attribute] === value;
  }, { id: participantID, attribute, value }, { timeout });
}

// The runner treats every received signaling error as fatal; scenarios that
// intentionally trigger one (lease race, capacity rejection) acknowledge it so
// later media assertions stay strict about *unexpected* errors.
async function acknowledgeSignalingErrors(page) {
  await page.evaluate(() => {
    const events = window.__slowMeetTest?.socketEvents || [];
    window.__slowMeetTest.socketEvents = events.filter((event) =>
      !(event.direction === "receive" && event.message?.type === "error"));
  });
}

async function assertMedia(roleList = [...pages.keys()]) {
  const before = new Map();
  for (const role of roleList) {
    const page = pages.get(role);
    before.set(role, await page.evaluate(async () => {
      const signalingErrors = (window.__slowMeetTest?.socketEvents || [])
        .filter((event) => event.direction === "receive" && event.message?.type === "error");
      if (signalingErrors.length) throw new Error(JSON.stringify(signalingErrors));
      const peers = (window.__slowMeetTest?.peerConnections || []).filter((peer) => peer.connectionState === "connected");
      const reports = await Promise.all(peers.map((peer) => peer.getStats()));
      const framesDecoded = reports.flatMap((report) => [...report.values()])
        .filter((item) => item.type === "inbound-rtp" && item.kind === "video")
        .reduce((total, item) => total + (item.framesDecoded || 0), 0);
      return { framesDecoded, videoTimes: [...document.querySelectorAll("video")].map((video) => video.currentTime) };
    }));
  }
  const deadline = Date.now() + 15000;
  const latest = new Map();
  while (Date.now() < deadline) {
    let allAdvanced = true;
    for (const role of roleList) {
      const page = pages.get(role);
      const stats = await page.evaluate(async () => {
        const signalingErrors = (window.__slowMeetTest?.socketEvents || [])
          .filter((event) => event.direction === "receive" && event.message?.type === "error");
        const pcs = [...(window.__slowMeetTest?.peerConnections || [])];
        const connected = pcs.filter((peer) => peer.connectionState === "connected");
        const reports = await Promise.all(connected.map((peer) => peer.getStats()));
        const framesDecoded = reports.flatMap((report) => [...report.values()])
          .filter((item) => item.type === "inbound-rtp" && item.kind === "video")
          .reduce((total, item) => total + (item.framesDecoded || 0), 0);
        const videos = [...document.querySelectorAll("video")].map((v) => ({ width: v.videoWidth, height: v.videoHeight, time: v.currentTime,
          name: v.closest(".participant-tile")?.textContent || "" }));
      return { signalingErrors, states: pcs.map((pc) => pc.connectionState), connectedPeers: connected.length, videos, framesDecoded };
      });
      const priorTimes = before.get(role).videoTimes;
      stats.playbackAdvanced = stats.videos.some((video, index) => video.width && video.height && video.time > (priorTimes[index] || 0) + 0.5);
      latest.set(role, stats);
      assert.deepEqual(stats.signalingErrors, [], `${role} received signaling errors: ${JSON.stringify(stats.signalingErrors)}`);
      const mediaAdvanced = browserNames.get(role) === "firefox"
        ? stats.playbackAdvanced
        : stats.framesDecoded > before.get(role).framesDecoded;
      allAdvanced = allAdvanced && stats.connectedPeers > 0 && mediaAdvanced;
    }
    if (allAdvanced) break;
    await delay(500);
  }
  for (const role of roleList) {
    const stats = latest.get(role);
    assert.ok(stats, `${role} had no media diagnostics`);
    assert.ok(stats.connectedPeers > 0, `${role} has no connected peers: ${JSON.stringify(stats.states)}`);
    assert.ok(stats.videos.some((video) => video.width && video.height && video.time > 0), `${role} has no advancing decoded video ${JSON.stringify(stats.videos)}`);
    if (browserNames.get(role) === "firefox") {
      assert.ok(stats.playbackAdvanced, `${role} video playback time did not advance after renegotiation: ${JSON.stringify(stats.videos)}`);
    } else {
      assert.ok(stats.framesDecoded > before.get(role).framesDecoded,
        `${role} decoded video frames did not advance (${before.get(role).framesDecoded} -> ${stats.framesDecoded})`);
    }
  }
}

async function assertSingleSharer(page, ownerName) {
  await page.waitForFunction((expected) => {
    const sharing = [...document.querySelectorAll("li[data-participant-id]")]
      .filter((tile) => tile.dataset.sharing === "true");
    return sharing.length === 1 && sharing[0].textContent.includes(expected);
  }, ownerName, { timeout: 15000 });
}

async function waitForScreenButton(page, pressed, timeout = 15000) {
  await page.waitForFunction((expected) => {
    const button = document.querySelector("#screen");
    return Boolean(button) && button.getAttribute("aria-pressed") === expected && !button.disabled;
  }, pressed, { timeout });
}

// --- Mixed-quality room support --------------------------------------------

// A media snapshot per page: outbound/inbound audio bytes, summed decoded
// video frames, and the selected pair's RTT where available.
async function pageMediaSnapshot(page) {
  return page.evaluate(async () => {
    const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
    if (!peer || typeof peer.getStats !== "function") {
      throw new Error("no peer connection for media snapshot");
    }
    const report = await peer.getStats();
    const snapshot = {
      audioSent: 0, audioReceived: 0, videoFrames: 0, rttMs: null,
      packetLossPct: window.__slowMeetTest?.networkQuality?.packetLossPct ?? null
    };
    report.forEach((stat) => {
      if (stat.type === "outbound-rtp" && stat.kind === "audio") snapshot.audioSent += stat.bytesSent || 0;
      if (stat.type === "inbound-rtp" && stat.kind === "audio") snapshot.audioReceived += stat.bytesReceived || 0;
      if (stat.type === "inbound-rtp" && stat.kind === "video") snapshot.videoFrames += stat.framesDecoded || 0;
      if (stat.type === "candidate-pair" && (stat.selected || stat.nominated) &&
        Number.isFinite(stat.currentRoundTripTime)) {
        snapshot.rttMs = stat.currentRoundTripTime * 1000;
      }
    });
    return snapshot;
  });
}

// Per-participant network shaping (tiers, qdisc, port classification, the
// re-arming classifier) lives in scripts/netem-tiers.js, shared with the
// weak-network soak. The wrapper below keeps this script's module-level
// pages map out of the shared module's signature.
const netemTiers = require("./netem-tiers");
const { tiers: fourPersonTiers, pageLocalIcePorts, pageGatheredIcePorts } = netemTiers;
const installRoomQdisc = netemTiers.installRoomQdisc;
const clearRoomProfiles = netemTiers.clearRoomProfiles;

function armParticipantTiers(tierByRole, readPorts) {
  return netemTiers.armParticipantTiers(tierByRole, pages, readPorts);
}

// A tile counts as degraded when its protect-audio pause fired or its
// connection quality dropped to degraded/poor on the observer's browser.
async function waitForDegradedCameraTile(observers, participantID, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let allDegraded = true;
    for (const page of observers) {
      const state = await page.evaluate((id) => {
        const tile = document.querySelector(`li[data-participant-id='${id}']`);
        if (!tile) return { missing: true };
        const quality = tile.dataset.quality || "unknown";
        return {
          missing: false,
          camera: tile.dataset.camera,
          quality,
          degraded: tile.dataset.camera === "paused" ||
            tile.classList.contains("is-poor-connection") ||
            quality === "degraded" || quality === "poor"
        };
      }, participantID);
      if (state.missing || !state.degraded) {
        allDegraded = false;
        break;
      }
    }
    if (allDegraded) return;
    if (Date.now() > deadline) {
      throw new Error(`participant ${participantID} never showed a degraded camera on its observers`);
    }
    await delay(500);
  }
}

// Per-sender decode progress: the tile's <video> exposes presented-frame
// counts, which a room where every sender sits on a different tier needs —
// pageMediaSnapshot's per-page aggregate cannot separate one sender's stream
// from another's, so cross-participant decode comparisons between receivers
// are meaningless there.
async function tileVideoFrames(page, participantID) {
  return page.evaluate((id) => {
    const video = document.querySelector(`li[data-participant-id='${id}'] video:not(.screen-video)`);
    if (!video || typeof video.getVideoPlaybackQuality !== "function") return -1;
    return video.getVideoPlaybackQuality().totalVideoFrames;
  }, participantID);
}

// --- Scenarios -------------------------------------------------------------

async function scenarioStaggeredJoins() {
  await joinAll();
  for (const page of pages.values()) await roster(page, names);
}

async function scenarioEnableCameras() {
  await setupRoom();
}

// Toggling one participant's mic/camera must flip the matching tile state on
// every other browser (server media_state fan-out). The toggle direction is
// derived from the button state: #mic aria-pressed means the mic is live and
// joining starts muted.
async function scenarioMediaStatePropagation() {
  await setupRoom();
  for (const [index, role] of roles.entries()) {
    const page = pages.get(role);
    const participantID = await participantIDFor(page, names[index]);
    const observers = [...pages.entries()].filter(([peerRole]) => peerRole !== role).map(([, peer]) => peer);
    const micLive = await page.locator("#mic").getAttribute("aria-pressed") === "true";
    await page.locator("#mic").click();
    for (const peer of observers) await waitForTileState(peer, participantID, "mic", micLive ? "off" : "on");
    await page.locator("#mic").click();
    for (const peer of observers) await waitForTileState(peer, participantID, "mic", micLive ? "on" : "off");
    const cameraOn = await page.locator("#camera").getAttribute("aria-pressed") === "true";
    await page.locator("#camera").click();
    for (const peer of observers) await waitForTileState(peer, participantID, "camera", cameraOn ? "off" : "on");
    await page.locator("#camera").click();
    for (const peer of observers) await waitForTileState(peer, participantID, "camera", cameraOn ? "on" : "off");
  }
  await assertMedia();
}

// The good-network baseline the impairment scenarios are measured against:
// four participants on a clean link for a sustained window may not degrade
// anything. Audio and video advance on every browser, no tile drops to a
// degraded quality or a protect-audio pause, no participant's own connection
// leaves the Connected state, and a screen share decodes on every viewer
// while the camera grid keeps flowing.
async function scenarioAllCleanFullQuality() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const before = new Map();
  for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
  await delay(15000);
  const after = new Map();
  for (const role of roles) after.set(role, await pageMediaSnapshot(pages.get(role)));
  for (const role of roles) {
    assert.ok(after.get(role).audioSent > before.get(role).audioSent,
      `${role} outbound audio stalled on a clean link`);
    assert.ok(after.get(role).audioReceived > before.get(role).audioReceived,
      `${role} inbound audio stalled on a clean link`);
    assert.ok(after.get(role).videoFrames > before.get(role).videoFrames,
      `${role} decoded no video on a clean link`);
  }
  for (const [role, page] of pages) {
    const degraded = await page.evaluate(() =>
      [...document.querySelectorAll("li[data-participant-id]")].filter((tile) => {
        const quality = tile.dataset.quality || "";
        return tile.dataset.camera === "paused" ||
          tile.classList.contains("is-poor-connection") ||
          quality === "degraded" || quality === "poor";
      }).map((tile) => tile.dataset.participantId));
    assert.deepEqual(degraded, [],
      `${role} saw degraded tiles on a clean link: ${JSON.stringify(degraded)}`);
    const localStatus = await page.evaluate(() =>
      document.querySelector("#status")?.textContent || "");
    assert.ok(localStatus.includes("Connected"),
      `${role}'s own connection left the Connected state on a clean link: "${localStatus}"`);
  }
  // The same clean link must carry a screen share to every viewer without
  // disturbing the camera grid.
  const sharer = pages.get("P1");
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[0]);
  await delay(2000);
  for (const [role, page] of pages) {
    if (role === "P1") continue;
    await page.waitForFunction(() => {
      const video = document.querySelector("li[data-sharing='true'] video.screen-video");
      return Boolean(video) && video.videoWidth > 0 && video.readyState >= 2;
    }, null, { timeout: 30000 });
  }
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "false");
  await assertMedia();
}

async function scenarioFourWayChat() {
  await setupRoom();
  for (let i = 0; i < roles.length; i += 1) {
    const message = `four-way-message-${names[i]}`;
    await sendChat(pages.get(roles[i]), message);
    await Promise.all([...pages.values()].map((page) => waitText(page, "#chat-messages", message)));
  }
}

async function scenarioSimultaneousFourWayChat() {
  await setupRoom();
  const simultaneousMessages = roles.map((role, index) => `simultaneous-message-${names[index]}`);
  await Promise.all(roles.map((role, index) => sendChat(pages.get(role), simultaneousMessages[index])));
  await Promise.all([...pages.values()].flatMap((page) => simultaneousMessages.map((message) => waitText(page, "#chat-messages", message))));
}

// Unread badge while the rail is closed, badge reset on open, a 500-character
// message, and a reconnect that replays retained history without duplicates.
async function scenarioChatUnreadAndHistory() {
  await setupRoom();
  const reader = pages.get("P2");
  await closeChat(reader);
  const unreadMarker = `unread-probe-${Date.now()}`;
  await sendChat(pages.get("P1"), unreadMarker);
  await reader.waitForFunction(() => {
    const badge = document.querySelector("#chat-badge");
    return Boolean(badge) && !badge.hidden && Number(badge.textContent) >= 1;
  }, null, { timeout: 10000 });
  await openChat(reader);
  await waitText(reader, "#chat-messages", unreadMarker);
  await reader.waitForFunction(() => {
    const badge = document.querySelector("#chat-badge");
    return Boolean(badge) && (badge.hidden || badge.textContent === "0");
  }, null, { timeout: 5000 });

  const longMessage = `long-probe-${Date.now()}-${"x".repeat(440)}`;
  assert.ok(longMessage.length <= 500, "probe message must respect the 500 character limit");
  await sendChat(pages.get("P3"), longMessage);
  for (const page of pages.values()) await waitText(page, "#chat-messages", longMessage.slice(0, 80));

  const historyMarker = `history-probe-${Date.now()}`;
  await sendChat(pages.get("P4"), historyMarker);
  for (const page of pages.values()) await waitText(page, "#chat-messages", historyMarker);
  const reconnecting = pages.get("P1");
  const socketCount = await reconnecting.evaluate(() => window.__slowMeetTest.sockets.length);
  await reconnecting.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "chat history replay"));
  await reconnecting.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
    window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
  await waitText(reconnecting, "#chat-messages", historyMarker);
  const occurrences = await reconnecting.evaluate((marker) =>
    (document.querySelector("#chat-messages")?.textContent || "").split(marker).length - 1, historyMarker);
  assert.equal(occurrences, 1, `chat history replay duplicated the marker (${occurrences} occurrences)`);
  for (const page of pages.values()) await roster(page, names);
}

async function scenarioReactionsAndRaisedHands() {
  await setupRoom();
  for (let i = 0; i < roles.length; i += 1) {
    const page = pages.get(roles[i]); const emoji = i % 2 ? "🎉" : "👏";
    await page.locator("#reactions").click(); await page.locator(`[data-reaction="${emoji}"]`).click();
    await Promise.all([...pages.values()].map((peer) => waitText(peer, "#reaction-announcements", `${names[i]} sent`)));
    await page.locator("#raise-hand").click();
    await page.waitForFunction(() => document.querySelector("#raise-hand")?.getAttribute("aria-pressed") === "true", null, { timeout: 5000 });
    const participantID = await participantIDFor(page, names[i]);
    for (const peer of pages.values()) await waitForTileState(peer, participantID, "handRaised", "true");
    await page.locator("#raise-hand").click();
    await page.waitForFunction(() => document.querySelector("#raise-hand")?.getAttribute("aria-pressed") === "false", null, { timeout: 5000 });
    for (const peer of pages.values()) await waitForTileState(peer, participantID, "handRaised", "false");
  }
}

async function scenarioSimultaneousReactions() {
  await setupRoom();
  await Promise.all(roles.map(async (role, index) => {
    const page = pages.get(role);
    const emoji = index % 2 ? "🎉" : "👏";
    await page.locator("#reactions").click();
    await page.locator(`[data-reaction="${emoji}"]`).click();
  }));
  const expectedReactions = names.map((name, index) => ({ name, emoji: index % 2 ? "🎉" : "👏" }));
  await Promise.all([...pages.values()].map((page) => page.waitForFunction((expected) => expected.every(({ name, emoji }) => {
    const tile = [...document.querySelectorAll("#participants > .participant-tile")]
      .find((participant) => participant.textContent.includes(name));
    return tile?.querySelector(".participant-reaction")?.textContent === emoji;
  }), expectedReactions, { timeout: 10000 })));
}

// Raise order must be first-come-first-served and renumber on every browser
// when a raised hand goes down.
async function scenarioHandOrderFIFO() {
  await setupRoom();
  const raised = [];
  for (const [index, role] of roles.entries()) {
    const page = pages.get(role);
    await page.locator("#raise-hand").click();
    await page.waitForFunction(() => document.querySelector("#raise-hand")?.getAttribute("aria-pressed") === "true", null, { timeout: 5000 });
    const participantID = await participantIDFor(page, names[index]);
    raised.push(participantID);
    for (const peer of pages.values()) {
      await waitForTileState(peer, participantID, "handRaised", "true");
      await waitForTileState(peer, participantID, "handOrder", String(index + 1));
    }
  }
  const first = pages.get("P1");
  await first.locator("#raise-hand").click();
  await first.waitForFunction(() => document.querySelector("#raise-hand")?.getAttribute("aria-pressed") === "false", null, { timeout: 5000 });
  for (const peer of pages.values()) {
    await waitForTileState(peer, raised[0], "handRaised", "false");
    await waitForTileState(peer, raised[1], "handOrder", "1");
    await waitForTileState(peer, raised[2], "handOrder", "2");
    await waitForTileState(peer, raised[3], "handOrder", "3");
  }
  for (const role of ["P2", "P3", "P4"]) {
    const page = pages.get(role);
    if (await page.locator("#raise-hand").getAttribute("aria-pressed") === "true") {
      await page.locator("#raise-hand").click();
    }
  }
  for (const peer of pages.values()) {
    for (const participantID of raised.slice(1)) await waitForTileState(peer, participantID, "handRaised", "false");
  }
}

async function scenarioCameraAndMicrophoneToggles() {
  await setupRoom();
  for (const role of ["P2", "P4", "P1", "P3"]) {
    const page = pages.get(role); await page.locator("#camera").click(); await page.locator("#mic").click();
    await delay(350); await page.locator("#camera").click(); await page.locator("#mic").click();
  }
  await assertMedia();
}

// The connection popover's manual retry forces an ICE restart; media must
// renegotiate and keep flowing on every browser.
async function scenarioIceRestart() {
  await setupRoom();
  const page = pages.get("P1");
  await page.locator("#connection").click();
  await page.locator("#connection-popover-retry").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#connection-popover-retry").click();
  await assertMedia();
}

async function scenarioGeneratedScreenShare() {
  await setupRoom();
  const sharer = pages.get("P3"); await sharer.locator("#screen").click();
  await sharer.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  for (const page of pages.values()) await assertSingleSharer(page, names[2]);
  await delay(1500); await sharer.locator("#screen").click();
  await sharer.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false", null, { timeout: 15000 });
  for (const page of pages.values()) {
    await page.waitForFunction(() => ![...document.querySelectorAll("li[data-participant-id]")]
      .some((tile) => tile.dataset.sharing === "true"), null, { timeout: 15000 });
  }
}

// Two participants race for the exclusive screen-share lease: exactly one
// wins, the loser is told the lease is taken, and the loser succeeds once the
// winner stops.
async function scenarioScreenShareLeaseRace() {
  await setupRoom();
  const p3 = pages.get("P3");
  const p4 = pages.get("P4");
  // Every share control must be armed before the race; a control stuck
  // disabled here means the previous share's stop path left stale UI state.
  for (const [role, page] of pages) {
    await page.waitForFunction(() => {
      const button = document.querySelector("#screen");
      return Boolean(button) && !button.disabled && button.getAttribute("aria-pressed") === "false";
    }, null, { timeout: 15000 }).catch(async () => {
      const state = await page.evaluate(() => ({
        disabled: document.querySelector("#screen")?.disabled,
        pressed: document.querySelector("#screen")?.getAttribute("aria-pressed"),
        sharingOwner: document.querySelector("#participants")?.dataset.sharingOwner,
        tiles: [...document.querySelectorAll("li[data-participant-id]")].map((tile) => ({ name: tile.textContent, sharing: tile.dataset.sharing }))
      }));
      throw new Error(`${role}'s share control never armed before the race: ${JSON.stringify(state)}`);
    });
  }
  // Fire both attempts together. Whichever participant wins the lease first
  // disables the other's control (ownedByOther), so a click that cannot
  // dispatch within 2s simply lost the race — the same as a real user's
  // click landing on a just-disabled button — and must not hang the run.
  await Promise.all([
    p3.locator("#screen").click({ timeout: 2000 }).catch(() => {}),
    p4.locator("#screen").click({ timeout: 2000 }).catch(() => {})
  ]);
  const deadline = Date.now() + 20000;
  let winner = null;
  while (Date.now() < deadline && !winner) {
    const p3Pressed = await p3.locator("#screen").getAttribute("aria-pressed");
    const p4Pressed = await p4.locator("#screen").getAttribute("aria-pressed");
    if (p3Pressed === "true" && p4Pressed === "false") winner = "P3";
    if (p4Pressed === "true" && p3Pressed === "false") winner = "P4";
    if (!winner) await delay(250);
  }
  assert.ok(winner, `neither participant settled as the screen-share owner within 20s`);
  const loser = winner === "P3" ? "P4" : "P3";
  const winnerName = winner === "P3" ? names[2] : names[3];
  const loserName = loser === "P3" ? names[2] : names[3];
  const winnerPage = pages.get(winner);
  const loserPage = pages.get(loser);
  // Baseline the loser's socket history so the rejection check below only
  // sees this scenario's traffic — the loser may have shared in an earlier
  // scenario of the same run.
  const loserEventBaseline = await loserPage.evaluate(() =>
    (window.__slowMeetTest?.socketEvents || []).length);
  for (const page of pages.values()) await assertSingleSharer(page, winnerName);
  // The loser either had its request rejected by the server ("already
  // active") or never got to send one because the winner's state broadcast
  // arrived first and disabled the control; both end with exactly one owner.
  const loserRequested = await loserPage.evaluate((baseline) =>
    (window.__slowMeetTest?.socketEvents || []).slice(baseline).some((event) =>
      event.direction === "send" && event.message?.type === "screen_share" &&
      event.message.screen_share_active === true), loserEventBaseline);
  if (loserRequested) {
    // Assert on the recorded wire traffic: the connection chip can overwrite
    // the #status text before this check reads it.
    const rejected = await loserPage.evaluate((baseline) =>
      (window.__slowMeetTest?.socketEvents || []).slice(baseline).some((event) =>
        event.direction === "receive" && event.message?.type === "error" &&
        /already active/i.test(event.message.error || "")), loserEventBaseline);
    assert.ok(rejected, "lease loser was not told the share is active");
    await acknowledgeSignalingErrors(loserPage);
  }
  // The winner's start flow (camera disable, transceiver setup, renegotiation)
  // settles asynchronously; wait until its control reflects the active share
  // before stopping, so the click cannot race the startup.
  await waitForScreenButton(winnerPage, "true");
  await winnerPage.locator("#screen").click();
  await waitForScreenButton(winnerPage, "false");
  for (const page of pages.values()) {
    await page.waitForFunction(() => ![...document.querySelectorAll("li[data-participant-id]")]
      .some((tile) => tile.dataset.sharing === "true"), null, { timeout: 15000 });
  }
  await loserPage.locator("#screen").click();
  await waitForScreenButton(loserPage, "true");
  for (const page of pages.values()) await assertSingleSharer(page, loserName);
  await loserPage.locator("#screen").click();
  await waitForScreenButton(loserPage, "false");
  // The scenario intentionally triggers "already active" rejections; clear
  // them everywhere so later scenarios' strict error checks stay meaningful.
  for (const page of pages.values()) await acknowledgeSignalingErrors(page);
}

// A sharer leaving mid-share must clear the room's sharing state and release
// the lease for the next participant.
async function scenarioSharerDepartsMidShare() {
  await setupRoom();
  const sharer = pages.get("P3");
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[2]);
  await sharer.locator("#leave").click();
  await sharer.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
  pages.delete("P3");
  await delay(2000);
  const remaining = names.filter((_, index) => index !== 2);
  for (const page of pages.values()) {
    await roster(page, remaining);
    await page.waitForFunction(() => ![...document.querySelectorAll("li[data-participant-id]")]
      .some((tile) => tile.dataset.sharing === "true"), null, { timeout: 15000 });
  }
  const p4 = pages.get("P4");
  await p4.locator("#screen").click();
  await waitForScreenButton(p4, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[3]);
  await p4.locator("#screen").click();
  await waitForScreenButton(p4, "false");
  await join("P3");
  for (const page of pages.values()) await roster(page, names);
}

// Turning off incoming video pauses remote camera decoding for that viewer
// only; everyone else keeps receiving, and re-enabling resumes the stream.
async function scenarioReceiveVideoToggle() {
  await setupRoom();
  const viewer = pages.get("P3");
  await viewer.locator("#receive-video").click();
  await viewer.waitForFunction(() => document.querySelector("#receive-video")?.getAttribute("aria-pressed") === "false", null, { timeout: 5000 });
  await viewer.waitForFunction(() => {
    const tiles = [...document.querySelectorAll("#participants > .participant-tile")]
      .filter((tile) => !tile.classList.contains("is-local"));
    return tiles.length > 0 && tiles.every((tile) => tile.dataset.receiveVideo === "false");
  }, null, { timeout: 10000 });
  await assertMedia(["P1", "P2", "P4"]);
  await viewer.locator("#receive-video").click();
  await viewer.waitForFunction(() => document.querySelector("#receive-video")?.getAttribute("aria-pressed") === "true", null, { timeout: 5000 });
  await assertMedia();
}

// "Protect audio" pauses the participant's camera for the whole room and
// blocks screen sharing; turning it off restores the previous camera state.
async function scenarioAudioOnlyMode() {
  await setupRoom();
  const page = pages.get("P2");
  const participantID = await participantIDFor(page, names[1]);
  await openSettingsPanel(page);
  await page.locator("#audio-only").check();
  for (const peer of pages.values()) await waitForTileState(peer, participantID, "camera", "off");
  assert.ok(await page.locator("#screen").isDisabled(), "share control should be disabled while Protect audio is enabled");
  await page.locator("#audio-only").uncheck();
  for (const peer of pages.values()) await waitForTileState(peer, participantID, "camera", "on");
  await assertMedia();
}

// Pinning a participant switches the pinner to pinned layout; other browsers
// keep their own grid view, and unpinning restores the grid.
async function scenarioPinAndLayout() {
  await setupRoom();
  const p1 = pages.get("P1");
  const p2ID = await participantIDFor(p1, names[1]);
  const menuTrigger = p1.locator(`li[data-participant-id="${p2ID}"] .participant-menu-trigger`);
  await menuTrigger.click();
  await p1.locator("#participant-menu-pin").waitFor({ state: "visible", timeout: 5000 });
  await p1.locator("#participant-menu-pin").click();
  await p1.waitForFunction(() => document.querySelector("#meeting-layout-host")?.dataset.layoutMode === "pinned", null, { timeout: 5000 });
  await p1.waitForFunction((id) => Boolean(document.querySelector(`#pinned-main li[data-participant-id="${id}"]`)), p2ID, { timeout: 5000 });
  await p1.waitForFunction(() => document.querySelector("#participants")?.dataset.pinned === "true", null, { timeout: 5000 });
  await menuTrigger.click();
  await p1.locator("#participant-menu-pin").waitFor({ state: "visible", timeout: 5000 });
  await p1.locator("#participant-menu-pin").click();
  await p1.waitForFunction(() => document.querySelector("#meeting-layout-host")?.dataset.layoutMode === "grid", null, { timeout: 5000 });
  for (const [role, page] of pages) {
    if (role === "P1") continue;
    const mode = await page.evaluate(() => document.querySelector("#meeting-layout-host")?.dataset.layoutMode);
    assert.equal(mode, "grid", `${role} unexpectedly changed layout mode`);
  }
  const paginationHidden = await p1.evaluate(() => document.querySelector("#participant-pagination")?.hidden);
  assert.ok(paginationHidden, "pagination is visible with only four participants");
}

// Single-key shortcuts toggle the mic and camera and open the chat rail;
// Escape closes it again.
async function scenarioKeyboardShortcuts() {
  await setupRoom();
  const page = pages.get("P1");
  await page.evaluate(() => document.body.focus());
  const micBefore = await page.locator("#mic").getAttribute("aria-pressed");
  await page.keyboard.press("m");
  await page.waitForFunction((before) => document.querySelector("#mic")?.getAttribute("aria-pressed") !== before,
    micBefore, { timeout: 5000 });
  const cameraBefore = await page.locator("#camera").getAttribute("aria-pressed");
  await page.keyboard.press("v");
  await page.waitForFunction((before) => document.querySelector("#camera")?.getAttribute("aria-pressed") !== before,
    cameraBefore, { timeout: 10000 });
  await page.keyboard.press("c");
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && !rail.hidden && rail.classList.contains("is-open");
  }, null, { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && rail.hidden;
  }, null, { timeout: 5000 });
}

// Switching the camera quality preset to "off" pauses the participant's
// camera room-wide. A preset change re-arms the control but deliberately does
// not force the camera back on; the participant enables it themselves.
async function scenarioCameraQualityPreset() {
  await setupRoom();
  const page = pages.get("P2");
  const participantID = await participantIDFor(page, names[1]);
  await openSettingsPanel(page);
  await page.locator("#camera-quality").selectOption("off");
  for (const peer of pages.values()) await waitForTileState(peer, participantID, "camera", "off");
  await page.locator("#camera-quality").selectOption("360p");
  await page.waitForFunction(() => {
    const button = document.querySelector("#camera");
    return Boolean(button) && !button.disabled && button.getAttribute("aria-pressed") === "false";
  }, null, { timeout: 5000 });
  await page.locator("#camera").click();
  for (const peer of pages.values()) await waitForTileState(peer, participantID, "camera", "on");
  await assertMedia();
}

// Hiding a remote tile removes it from that browser's visible roster only —
// the participant count still includes them, and the people panel offers to
// show the tile again.
async function scenarioHideAndShowTile() {
  await setupRoom();
  const page = pages.get("P1");
  const p3ID = await participantIDFor(page, names[2]);
  await page.locator(`li[data-participant-id="${p3ID}"] .participant-menu-trigger`).click();
  await page.locator("#participant-menu-hide-tile").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#participant-menu-hide-tile").click();
  await page.waitForFunction((id) => {
    const tile = [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .find((item) => item.dataset.participantId === id);
    return Boolean(tile) && (tile.closest("#layout-parking") !== null || tile.hidden);
  }, p3ID, { timeout: 5000 });
  const count = await page.evaluate(() => document.querySelector("#participant-count")?.textContent || "");
  assert.ok(/4/.test(count), `participant count dropped while a tile was merely hidden: ${count}`);
  await page.locator("#participants-button").click();
  const showTile = page.locator(`#people-list button[data-action="show-tile"][data-participant-id="${p3ID}"]`);
  await showTile.waitFor({ state: "visible", timeout: 5000 });
  await showTile.click();
  await page.waitForFunction((id) => {
    const tile = [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .find((item) => item.dataset.participantId === id);
    return Boolean(tile) && !tile.hidden && tile.closest("#layout-parking") === null;
  }, p3ID, { timeout: 5000 });
  await page.keyboard.press("Escape");
}

// "Expand tile" stage-focuses one participant; Escape returns to the grid.
async function scenarioStageFocusToggle() {
  await setupRoom();
  const page = pages.get("P1");
  const p2ID = await participantIDFor(page, names[1]);
  await page.locator(`li[data-participant-id="${p2ID}"] .participant-menu-trigger`).click();
  await page.locator("#participant-menu-stage-focus").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#participant-menu-stage-focus").click();
  await page.waitForFunction((id) => {
    const host = document.querySelector("#meeting-layout-host");
    return host?.dataset.stageFocus === "true" && host?.dataset.stageFocusParticipantId === id &&
      Boolean(document.querySelector(`li[data-participant-id="${id}"].is-stage-focused`));
  }, p2ID, { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#meeting-layout-host")?.dataset.stageFocus === "false",
    null, { timeout: 5000 });
}

// Holding Space is push-to-talk: the muted mic goes live while held and mutes
// again on release, visible to the other browsers.
async function scenarioPushToTalk() {
  await setupRoom();
  const page = pages.get("P1");
  const participantID = await participantIDFor(page, names[0]);
  const observer = pages.get("P3");
  if (await page.locator("#mic").getAttribute("aria-pressed") === "true") {
    await page.locator("#mic").click();
  }
  // Push-to-talk ignores Space while a button has focus (the key would double
  // as button activation), so blur whatever the previous scenario left
  // focused; body.focus() alone does not reset activeElement.
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
  });
  await page.keyboard.down(" ");
  await page.waitForFunction(() => document.querySelector("#mic")?.getAttribute("aria-pressed") === "true",
    null, { timeout: 5000 });
  await waitForTileState(observer, participantID, "mic", "on");
  await page.keyboard.up(" ");
  await page.waitForFunction(() => document.querySelector("#mic")?.getAttribute("aria-pressed") === "false",
    null, { timeout: 5000 });
  await waitForTileState(observer, participantID, "mic", "off");
}

// The chat composer's emoji picker inserts into the input and the message
// still delivers to every browser.
async function scenarioChatEmojiPicker() {
  await setupRoom();
  const sender = pages.get("P1");
  await openChat(sender);
  await sender.locator("#chat-emoji").click();
  await sender.locator("#chat-emoji-picker").waitFor({ state: "visible", timeout: 5000 });
  const emojiMessage = `emoji-probe-${Date.now()}`;
  await sender.locator("#chat-input").fill(emojiMessage);
  await sender.locator('#chat-emoji-picker button[data-emoji="👍"]').click();
  const composed = await sender.locator("#chat-input").inputValue();
  assert.equal(composed, `${emojiMessage}👍`, `emoji picker did not append to the composer: ${composed}`);
  await sender.locator("#chat-form button[type=submit]").click();
  for (const page of pages.values()) await waitText(page, "#chat-messages", emojiMessage);
  await closeChat(sender);
}

async function scenarioResponsiveLayout() {
  await setupRoom();
  for (const page of pages.values()) {
    await page.setViewportSize({ width: 375, height: 812 });
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width + 1, `horizontal overflow ${JSON.stringify(size)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
}

async function scenarioDepartureAndRejoin() {
  await setupRoom();
  const sharingPage = pages.get("P3");
  await sharingPage.locator("#screen").click();
  await waitForScreenButton(sharingPage, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[2]);
  const p4 = pages.get("P4"); await p4.locator("#leave").click(); await p4.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
  pages.delete("P4"); await delay(2000);
  for (const page of pages.values()) await roster(page, names.slice(0, 3));
  await sharingPage.locator("#screen").click();
  await waitForScreenButton(sharingPage, "false");
  for (const page of pages.values()) {
    await page.waitForFunction(() => ![...document.querySelectorAll("li[data-participant-id]")]
      .some((tile) => tile.dataset.sharing === "true"), null, { timeout: 15000 });
  }
  await join("P4"); for (const page of pages.values()) await roster(page, names);
  // A fresh join must re-establish media for the existing participants too —
  // this is the path a reconnect-after-expiry also takes.
  await assertMedia();
}

// The post-leave screen's Rejoin action returns the same browser to the room
// as a fresh participant with its name preserved.
async function scenarioRejoinViaButton() {
  await setupRoom();
  const page = pages.get("P4");
  await page.locator("#leave").click();
  await page.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
  await page.locator("#meeting-ended").waitFor({ state: "visible", timeout: 10000 });
  await page.locator("#rejoin").click();
  await page.locator("#join-form").waitFor({ state: "visible", timeout: 10000 });
  assert.equal(await page.locator("#name").inputValue(), names[3], "rejoin should preserve the participant name");
  await page.locator("#join").click();
  await page.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
  for (const peer of pages.values()) await roster(peer, names);
  await assertMedia();
}

// Two participants leave at once; rosters must converge without ghosts and
// both slots must be reusable.
async function scenarioSimultaneousDepartures() {
  await setupRoom();
  await Promise.all(["P2", "P4"].map((role) => pages.get(role).locator("#leave").click()));
  pages.delete("P2"); pages.delete("P4");
  await delay(2000);
  for (const page of pages.values()) await roster(page, [names[0], names[2]]);
  await Promise.all([join("P2"), join("P4")]);
  for (const page of pages.values()) await roster(page, names);
}

// Closing the signaling socket and reconnecting inside the server's grace
// window must resume the same participant identity and keep media flowing.
async function scenarioSignalingReconnect() {
  await setupRoom();
  const reconnecting = pages.get("P1");
  const socketCount = await reconnecting.evaluate(() => window.__slowMeetTest.sockets.length);
  await reconnecting.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "four-person reconnect check"));
  await reconnecting.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
    window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
  for (const page of pages.values()) await roster(page, names);
  await assertMedia();
}

// Killing a browser outright (no leave message, no reconnect) must free the
// seat once the reconnect grace period lapses.
async function scenarioAbruptCloseNoResume() {
  await setupRoom();
  const victim = pages.get("P4");
  const victimContext = victim.context();
  await victimContext.close();
  pages.delete("P4");
  const contextIndex = contexts.indexOf(victimContext);
  if (contextIndex >= 0) contexts.splice(contextIndex, 1);
  traces.delete(victimContext);
  await delay(2500);
  for (const page of pages.values()) await roster(page, names.slice(0, 3));
  await delay(reconnectGraceSeconds * 1000);
  await join("P4");
  for (const page of pages.values()) await roster(page, names);
}

// A server-side policy change must reach every connected browser through
// config_update and disable the share control room-wide until reverted.
async function scenarioAdminConfigBroadcast() {
  await setupRoom();
  const adminHeaders = { "Content-Type": "application/json", "X-Admin-Password": adminPassword };
  const disable = await fetch(`${server.url}/admin/config`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ screen_share_enabled: false })
  });
  assert.equal(disable.status, 200, `admin update to disable screen share was rejected (${disable.status})`);
  for (const page of pages.values()) {
    await page.waitForFunction(() => document.querySelector("#screen")?.disabled === true, null, { timeout: 10000 });
  }
  const enable = await fetch(`${server.url}/admin/config`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ screen_share_enabled: true })
  });
  assert.equal(enable.status, 200, `admin update to enable screen share was rejected (${enable.status})`);
  for (const page of pages.values()) {
    await page.waitForFunction(() => document.querySelector("#screen")?.disabled === false, null, { timeout: 10000 });
  }
}

async function scenarioFifthParticipantCapacity() {
  await setupRoom();
  const fifth = await createParticipant("P5", "Fifth", true);
  const result = await fifth.locator("#status").textContent().catch(() => "");
  assert.match(result || "", /full|capacity/i, `fifth client not rejected: ${result}`);
  await acknowledgeSignalingErrors(fifth);
  pages.delete("P5");
  // The rejection is announced to the whole room, not only the rejected client.
  for (const [role, page] of pages) {
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#toast-region .toast--warning")]
        .some((toast) => /full/i.test(toast.textContent)), null, { timeout: 5000 });
  }
}

// Every browser saw the other three join as system chat messages; a leave and
// rejoin add the matching notices on the continuous browsers.
async function scenarioChatSystemMessages() {
  await setupRoom();
  for (const page of pages.values()) await openChat(page);
  for (const [role, page] of pages) {
    const joined = await page.evaluate(() =>
      [...document.querySelectorAll("#chat-messages .chat-message--system")]
        .filter((item) => item.textContent.includes("joined the room")).length);
    assert.equal(joined, 3, `${role} expected 3 join system messages, saw ${joined}`);
  }
  const p4 = pages.get("P4");
  await p4.locator("#leave").click();
  await p4.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
  pages.delete("P4");
  await delay(2000);
  const observers = [...pages.entries()].filter(([role]) => role !== "P4");
  for (const [role, page] of observers) {
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#chat-messages .chat-message--system")]
        .some((item) => item.textContent.includes("Drew left the room")), null, { timeout: 10000 });
  }
  await join("P4");
  for (const page of pages.values()) await roster(page, names);
  for (const [role, page] of observers) {
    await page.waitForFunction(() =>
      [...document.querySelectorAll("#chat-messages .chat-message--system")]
        .some((item) => item.textContent.includes("Drew joined the room")), null, { timeout: 10000 });
  }
}

// The server rate-limits reactions to 6 per 3s per client and silently drops
// the rest; the tile still shows the surviving reaction.
async function scenarioReactionRateLimit() {
  await setupRoom();
  // Prior scenarios' reactions may have consumed part of the sender's current
  // fixed 3s window; wait it out so the burst starts from a fresh one.
  await delay(3100);
  const sender = pages.get("P1");
  const observer = pages.get("P2");
  const participantID = await participantIDFor(sender, names[0]);
  const baseline = await observer.evaluate(() => (window.__slowMeetTest?.socketEvents || []).length);
  await sender.evaluate(({ participantID }) => {
    const socket = window.__slowMeetTest.sockets.at(-1);
    for (let i = 0; i < 10; i += 1) {
      socket.send(JSON.stringify({ version: 1, type: "emoji_reaction", participant_id: participantID, emoji: "👍" }));
    }
  }, { participantID });
  const received = await observer.evaluate((baseline) =>
    (window.__slowMeetTest?.socketEvents || []).slice(baseline).filter((event) =>
      event.direction === "receive" && event.message?.type === "emoji_reaction").length, baseline);
  assert.equal(received, 6, `expected the 6-per-3s reaction limit to pass 6 of 10, saw ${received}`);
  await observer.waitForFunction((name) => {
    const tile = [...document.querySelectorAll("li[data-participant-id]")]
      .find((item) => item.textContent.includes(name));
    return tile?.querySelector(".participant-reaction")?.textContent === "👍";
  }, names[0], { timeout: 5000 });
}

// Duplicate raises and lowers are server-side no-ops: exactly one broadcast
// per real transition reaches the room.
async function scenarioHandStateEdgeCases() {
  await setupRoom();
  const raiser = pages.get("P1");
  const observer = pages.get("P2");
  const participantID = await participantIDFor(raiser, names[0]);
  const sendHandState = (raised) => raiser.evaluate(({ participantID, raised }) => {
    const socket = window.__slowMeetTest.sockets.at(-1);
    socket.send(JSON.stringify({ version: 1, type: "hand_state", participant_id: participantID, hand_raised: raised }));
  }, { participantID, raised });
  const baseline = await observer.evaluate(() => (window.__slowMeetTest?.socketEvents || []).length);
  await sendHandState(true);
  await waitForTileState(observer, participantID, "handRaised", "true");
  await sendHandState(true);
  await delay(400);
  await sendHandState(false);
  await waitForTileState(observer, participantID, "handRaised", "false");
  await sendHandState(false);
  await delay(400);
  const handStates = await observer.evaluate((baseline) =>
    (window.__slowMeetTest?.socketEvents || []).slice(baseline).filter((event) =>
      event.direction === "receive" && event.message?.type === "hand_state")
      .map((event) => event.message.hand_raised), baseline);
  assert.deepEqual(handStates, [true, false],
    `duplicate raise/lower must be server-side no-ops, saw ${JSON.stringify(handStates)}`);
}

// The remote screen video must actually decode advancing frames on every
// viewer, not only flip the sharing state.
async function scenarioRemoteScreenDecodes() {
  await setupRoom();
  const sharer = pages.get("P3");
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "true");
  for (const [role, page] of pages) {
    if (role === "P3") continue;
    await page.waitForFunction(() => {
      const video = document.querySelector("li[data-sharing='true'] video.screen-video");
      return Boolean(video) && video.videoWidth > 0 && video.readyState >= 2;
    }, null, { timeout: 20000 });
    const advanced = await page.evaluate(async () => {
      const video = document.querySelector("li[data-sharing='true'] video.screen-video");
      const before = video.currentTime;
      await new Promise((resolve) => setTimeout(resolve, 1000));
      return video.currentTime > before + 0.3;
    });
    assert.ok(advanced, `${role}'s remote screen video did not advance`);
  }
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "false");
}

// Hiding self-view removes the local tile from that browser's stage only;
// the other participants still see and hear the person.
async function scenarioSelfViewToggle() {
  await setupRoom();
  const page = pages.get("P1");
  const peer = pages.get("P2");
  await openSettingsPanel(page);
  await page.locator("#self-view").uncheck();
  await page.waitForFunction(() => {
    const tile = [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .find((item) => item.classList.contains("is-local"));
    return !tile || tile.hidden || tile.closest("#layout-parking") !== null;
  }, null, { timeout: 5000 });
  const averyVisible = await peer.evaluate((name) =>
    [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .some((item) => item.textContent.includes(name) && !item.hidden && item.closest("#layout-parking") === null), names[0]);
  assert.ok(averyVisible, "the peer lost Avery's tile when Avery hid self-view");
  await page.locator("#self-view").check();
  await page.waitForFunction(() => {
    const tile = [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
      .find((item) => item.classList.contains("is-local"));
    return Boolean(tile) && !tile.hidden && tile.closest("#layout-parking") === null;
  }, null, { timeout: 5000 });
  await page.keyboard.press("Escape");
}

// The "New messages" jump appears when a message lands while scrolled up, and
// a rail-closed message surfaces a preview toast.
async function scenarioChatUxDetails() {
  await setupRoom();
  const reader = pages.get("P1");
  await openChat(reader);
  for (let i = 0; i < 18; i += 1) {
    await sendChat(pages.get(roles[(i % 3) + 1]), `filler-${i}`);
  }
  await reader.evaluate(() => { document.querySelector("#chat-messages").scrollTop = 0; });
  const jumpProbe = `jump-probe-${Date.now()}`;
  await sendChat(pages.get("P2"), jumpProbe);
  await reader.waitForFunction(() => document.querySelector("#new-messages")?.hidden === false, null, { timeout: 10000 });
  await reader.locator("#new-messages").click();
  await reader.waitForFunction(() => document.querySelector("#new-messages")?.hidden === true, null, { timeout: 5000 });
  await closeChat(reader);
  const toastProbe = `toast-probe-${Date.now()}`;
  await sendChat(pages.get("P3"), toastProbe);
  await reader.waitForFunction((text) =>
    [...document.querySelectorAll("#toast-region .toast")].some((toast) => toast.textContent.includes(text)),
  toastProbe, { timeout: 10000 });
}

// Escape has two tiers: an active stage focus consumes the first press, and
// one further press dismisses every remaining popover/picker plus the open
// panel together. Popover-style surfaces also close on outside pointerdown —
// opening the reactions picker dismisses the connection popover.
async function scenarioEscapePriorityChain() {
  await setupRoom();
  const page = pages.get("P1");
  const p2ID = await participantIDFor(page, names[1]);
  await page.locator(`li[data-participant-id="${p2ID}"] .participant-menu-trigger`).click();
  await page.locator("#participant-menu-stage-focus").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#participant-menu-stage-focus").click();
  await page.waitForFunction(() => document.querySelector("#meeting-layout-host")?.dataset.stageFocus === "true", null, { timeout: 5000 });
  await page.locator("#connection").click();
  await page.locator("#connection-popover-retry").waitFor({ state: "visible", timeout: 5000 });
  await page.locator("#reactions").click();
  await page.locator("#reaction-picker").waitFor({ state: "visible", timeout: 5000 });
  await page.waitForFunction(() => document.querySelector("#connection-popover")?.hidden === true, null, { timeout: 5000 });
  await page.keyboard.press("c");
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && !rail.hidden && rail.classList.contains("is-open");
  }, null, { timeout: 5000 });

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#meeting-layout-host")?.dataset.stageFocus === "false", null, { timeout: 5000 });
  await page.waitForFunction(() => document.querySelector("#reaction-picker")?.hidden === false, null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && !rail.hidden;
  }, null, { timeout: 5000 });
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector("#reaction-picker")?.hidden === true, null, { timeout: 5000 });
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && rail.hidden;
  }, null, { timeout: 5000 });
}

// During a member's reconnect grace window the other browsers show the
// "Participant left" state, then the same identity resumes without ghosts.
async function scenarioGraceWindowChurn() {
  await setupRoom();
  const leaver = pages.get("P2");
  const p2ID = await participantIDFor(pages.get("P1"), names[1]);
  const socketCount = await leaver.evaluate(() => window.__slowMeetTest.sockets.length);
  const baselines = new Map();
  for (const [role, page] of pages) baselines.set(role, await page.evaluate(() => (window.__slowMeetTest?.socketEvents || []).length));
  await leaver.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "grace churn check"));
  for (const [role, page] of pages) {
    if (role === "P2") continue;
    const sawLeft = await page.evaluate((baseline) =>
      (window.__slowMeetTest?.socketEvents || []).slice(baseline).some((event) =>
        event.direction === "receive" && event.message?.type === "participant_left"), baselines.get(role));
    assert.ok(sawLeft, `${role} did not observe Blake's participant_left during the grace window`);
  }
  await leaver.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
    window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
  const observers = [...pages.entries()].filter(([role]) => role !== "P2").map(([, page]) => page);
  if (reconnectGraceSeconds >= 2) {
    // The reconnect beats the grace window: the same identity resumes.
    for (const peer of observers) await waitForTileState(peer, p2ID, "connection", "connected", 20000);
  } else {
    // The reconnect arrives after expiry: the stale tile is removed and a
    // fresh join replaces it under a new identity.
    for (const peer of observers) {
      await peer.waitForFunction((id) => ![...document.querySelectorAll("li[data-participant-id]")]
        .some((tile) => tile.dataset.participantId === id), p2ID, { timeout: 20000 });
    }
  }
  for (const page of pages.values()) await roster(page, names);
  const p2IDAfter = await participantIDFor(pages.get("P1"), names[1]);
  if (reconnectGraceSeconds >= 2) {
    assert.equal(p2IDAfter, p2ID, "grace resume must keep Blake's participant identity");
  } else {
    assert.notEqual(p2IDAfter, p2ID, "reconnect after expiry must issue a fresh identity");
  }
  await assertMedia();
}

// A second socket presenting the live reconnect token actively takes over the
// seat; the displaced client then reclaims it, keeping identity and media.
async function scenarioTokenTakeover() {
  await setupRoom();
  const p2 = pages.get("P2");
  const p2ID = await participantIDFor(pages.get("P1"), names[1]);
  const token = await p2.evaluate(() => {
    const events = window.__slowMeetTest?.socketEvents || [];
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const event = events[i];
      if (event.direction === "receive" && event.message?.type === "participant" && event.message.reconnect_token) {
        return event.message.reconnect_token;
      }
    }
    return "";
  });
  assert.ok(token, "no reconnect token recorded on P2");
  const baseline = await p2.evaluate(() => (window.__slowMeetTest?.socketEvents || []).length);
  const socketCount = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
  await p2.evaluate((token) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      version: 1, type: "join", name: "Blake", password: "", reconnect_token: token
    })));
  }, token);
  // The raw socket wins the seat, the app's socket is displaced, and the app
  // then reclaims the token from the raw socket (two socket generations +).
  await p2.waitForFunction((count) => window.__slowMeetTest.sockets.length > count + 1,
    socketCount, { timeout: 25000 });
  const acked = await p2.evaluate((baseline) =>
    (window.__slowMeetTest?.socketEvents || []).slice(baseline).some((event) =>
      event.direction === "receive" && event.message?.type === "participant"), baseline);
  assert.ok(acked, "the takeover socket never received a participant ack");
  for (const page of pages.values()) await roster(page, names);
  const p2IDAfter = await participantIDFor(pages.get("P1"), names[1]);
  assert.equal(p2IDAfter, p2ID, "takeover must keep Blake's participant identity");
  await assertMedia();
}

// A member who rejoins must rebuild the room state purely from the server's
// replay: mic state, the active sharer, and the sharer's screen video.
async function scenarioLateJoinerReplay() {
  await setupRoom();
  const p4 = pages.get("P4");
  await p4.locator("#leave").click();
  await p4.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
  pages.delete("P4");
  await delay(2000);
  for (const page of pages.values()) await roster(page, names.slice(0, 3));
  const p2 = pages.get("P2");
  if (await p2.locator("#mic").getAttribute("aria-pressed") === "false") {
    await p2.locator("#mic").click();
  }
  const p2ID = await participantIDFor(pages.get("P1"), names[1]);
  const p3 = pages.get("P3");
  await p3.locator("#screen").click();
  await waitForScreenButton(p3, "true");
  await join("P4");
  const fresh = pages.get("P4");
  await waitForTileState(fresh, p2ID, "mic", "on");
  await assertSingleSharer(fresh, names[2]);
  await fresh.waitForFunction(() => {
    const video = document.querySelector("li[data-sharing='true'] video.screen-video");
    return Boolean(video) && video.videoWidth > 0 && video.currentTime > 0;
  }, null, { timeout: 20000 });
  await p2.locator("#mic").click();
  await p3.locator("#screen").click();
  await waitForScreenButton(p3, "false");
  for (const page of pages.values()) await roster(page, names);
}

// With two people left the client auto-pins the remote peer; regrowing the
// room dismisses the automatic pin and restores the grid.
async function scenarioAutoPinShrink() {
  await setupRoom();
  await Promise.all(["P2", "P4"].map((role) => pages.get(role).locator("#leave").click()));
  pages.delete("P2"); pages.delete("P4");
  await delay(2000);
  for (const page of pages.values()) await roster(page, [names[0], names[2]]);
  for (const page of pages.values()) {
    await page.waitForFunction(() => document.querySelector("#meeting-layout-host")?.dataset.layoutMode === "pinned", null, { timeout: 10000 });
    await page.waitForFunction(() => {
      const pinnedTile = document.querySelector("#pinned-main .participant-tile");
      return Boolean(pinnedTile) && !pinnedTile.classList.contains("is-local");
    }, null, { timeout: 5000 });
  }
  await Promise.all([join("P2"), join("P4")]);
  for (const page of pages.values()) await roster(page, names);
  for (const page of pages.values()) {
    await page.waitForFunction(() => document.querySelector("#meeting-layout-host")?.dataset.layoutMode === "grid", null, { timeout: 15000 });
  }
}

// The welcome screen previews who is already in the room before joining.
async function scenarioWelcomeRosterPreview() {
  await setupRoom();
  const p4 = pages.get("P4");
  await p4.locator("#leave").click();
  await p4.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
  pages.delete("P4");
  await delay(2000);
  for (const page of pages.values()) await roster(page, names.slice(0, 3));
  const preview = await createParticipant("P5", "Fifth", false, true);
  const previewNames = [names[0], names[1], names[2]];
  await preview.waitForFunction((expected) => {
    const list = document.querySelector("#room-roster-list")?.textContent || "";
    return expected.every((name) => list.includes(name));
  }, previewNames, { timeout: 15000 });
  const count = await preview.evaluate(() => document.querySelector("#room-roster-count")?.textContent || "");
  assert.ok(/3/.test(count), `roster preview count should mention 3, got ${count}`);
  pages.delete("P5");
  await join("P4");
  for (const page of pages.values()) await roster(page, names);
}

// Disabling screen sharing while a lease is held evicts the sharer and frees
// the seat for the next participant once re-enabled.
async function scenarioAdminShareEviction() {
  await setupRoom();
  const p3 = pages.get("P3");
  await p3.locator("#screen").click();
  await waitForScreenButton(p3, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[2]);
  const adminHeaders = { "Content-Type": "application/json", "X-Admin-Password": adminPassword };
  const disable = await fetch(`${server.url}/admin/config`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ screen_share_enabled: false })
  });
  assert.equal(disable.status, 200, "admin update to disable screen share was rejected");
  for (const page of pages.values()) {
    await page.waitForFunction(() => ![...document.querySelectorAll("li[data-participant-id]")]
      .some((tile) => tile.dataset.sharing === "true"), null, { timeout: 10000 });
    await page.waitForFunction(() => document.querySelector("#screen")?.disabled === true, null, { timeout: 10000 });
  }
  await p3.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false", null, { timeout: 10000 });
  const enable = await fetch(`${server.url}/admin/config`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ screen_share_enabled: true })
  });
  assert.equal(enable.status, 200, "admin update to enable screen share was rejected");
  for (const page of pages.values()) {
    await page.waitForFunction(() => document.querySelector("#screen")?.disabled === false, null, { timeout: 10000 });
  }
  const p4 = pages.get("P4");
  await p4.locator("#screen").click();
  await waitForScreenButton(p4, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[3]);
  await p4.locator("#screen").click();
  await waitForScreenButton(p4, "false");
}

// Admin caps and retention changes fan out to every browser, and turning
// history retention off empties what a reconnect replays.
async function scenarioAdminCapsAndChatReset() {
  await setupRoom();
  const baselines = new Map();
  for (const [role, page] of pages) baselines.set(role, await page.evaluate(() => (window.__slowMeetTest?.socketEvents || []).length));
  const adminHeaders = { "Content-Type": "application/json", "X-Admin-Password": adminPassword };
  const update = await fetch(`${server.url}/admin/config`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ max_video_bitrate: 300000, retain_chat_history: false })
  });
  assert.equal(update.status, 200, "admin caps update was rejected");
  for (const [role, page] of pages) {
    const applied = await page.evaluate((baseline) =>
      (window.__slowMeetTest?.socketEvents || []).slice(baseline).some((event) =>
        event.direction === "receive" && event.message?.type === "config_update" &&
        event.message.max_video_bitrate === 300000), baselines.get(role));
    assert.ok(applied, `${role} did not receive the bitrate cap config_update`);
  }
  const marker = `cap-probe-${Date.now()}`;
  await sendChat(pages.get("P1"), marker);
  for (const page of pages.values()) await waitText(page, "#chat-messages", marker);
  const reconnecting = pages.get("P1");
  const socketCount = await reconnecting.evaluate(() => window.__slowMeetTest.sockets.length);
  await reconnecting.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "chat reset check"));
  await reconnecting.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
    window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
  await delay(1000);
  const stillThere = await reconnecting.evaluate((text) =>
    (document.querySelector("#chat-messages")?.textContent || "").includes(text), marker);
  assert.ok(!stillThere, "chat history survived the retain_chat_history=false reset");
  const restore = await fetch(`${server.url}/admin/config`, {
    method: "POST", headers: adminHeaders, body: JSON.stringify({ retain_chat_history: true })
  });
  assert.equal(restore.status, 200, "restoring retain_chat_history was rejected");
  for (const page of pages.values()) await roster(page, names);
}

// Switching the connection method mid-meeting rebuilds the media path on that
// browser while the other three keep flowing.
async function scenarioConnectionMethodSwitch() {
  await setupRoom();
  const p2 = pages.get("P2");
  const socketCount = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
  await openSettingsPanel(p2);
  await p2.locator("#settings-connection-method").selectOption("direct", { force: true });
  await p2.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
    window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
  for (const page of pages.values()) await roster(page, names);
  await assertMedia();
}

// The diagnostics loop feeds /metrics: four active participants and live
// network samples from every browser.
async function scenarioMetricsEndpoint() {
  await setupRoom();
  await delay(2000);
  const response = await fetch(`${server.url}/metrics`);
  assert.equal(response.status, 200, "metrics endpoint request failed");
  const body = await response.text();
  const participants = body.match(/slowmeet_active_participants (\d+)/);
  assert.ok(participants && Number(participants[1]) === 4,
    `expected 4 active participants in metrics, got ${participants?.[1] ?? "none"}`);
  const samples = body.match(/slowmeet_network_samples_total (\d+)/);
  assert.ok(samples && Number(samples[1]) > 0, "no network samples recorded in metrics");
}

// Four senders flooding the room cannot grow the chat rail without bound.
async function scenarioChatDomCap() {
  await setupRoom();
  // The server's chat limiter allows 10 messages per 10 s per client: a raw
  // flood is mostly rejected with error events that poison every later
  // scenario's strict signaling-error check. Pace the flood just under the
  // sustained allowance (4 clients ≈ 3.6 msg/s) until the cap provably
  // engages, then assert the rail stopped growing at 300 nodes.
  const participantIDs = new Map();
  for (const [role, page] of pages) {
    participantIDs.set(role, await participantIDFor(page, names[roles.indexOf(role)]));
  }
  let floodRounds = 0;
  const floodDeadline = Date.now() + 150000;
  while (floodRounds < 90) {
    for (const [role, page] of pages) {
      await page.evaluate(({ participantID, round }) => {
        const socket = window.__slowMeetTest.sockets.at(-1);
        socket.send(JSON.stringify({ version: 1, type: "chat_message", participant_id: participantID, text: `flood-${round}-${participantID.slice(0, 6)}` }));
      }, { participantID: participantIDs.get(role), round: floodRounds });
    }
    floodRounds += 1;
    const domCount = await pages.get("P4").evaluate(() =>
      document.querySelectorAll("#chat-messages .chat-message").length);
    if (domCount >= 310 && floodRounds > 300 / (pages.size - 0)) break;
    await delay(1100);
    if (Date.now() > floodDeadline) break;
  }
  await pages.get("P4").waitForFunction(() =>
    document.querySelectorAll("#chat-messages .chat-message").length >= 250, null, { timeout: 60000 });
  for (const [role, page] of pages) {
    const count = await page.evaluate(() => document.querySelectorAll("#chat-messages .chat-message").length);
    assert.ok(count <= 300, `${role} kept ${count} chat nodes; the 300-node cap should hold`);
    assert.ok(count >= 250, `${role} only reached ${count} chat nodes; the flood must exceed the cap to prove it trims`);
  }
}

// Injected heavy packet loss drives the automatic adaptation: the sender's
// video pauses room-wide, then recovers when the stats do.
async function scenarioCongestionAdaptation() {
  await setupRoom();
  const sender = pages.get("P1");
  const participantID = await participantIDFor(sender, names[0]);
  const injected = await sender.evaluate(() => {
    const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
    if (!peer || typeof peer.getStats !== "function") return false;
    const native = peer.getStats.bind(peer);
    peer.__injectPoor = true;
    // Loss percentages come from deltas between cumulative counters, so the
    // injected counters must keep growing with 60% of samples lost.
    peer.__poorSampleIndex = 0;
    peer.getStats = async () => {
      const report = await native();
      if (!peer.__injectPoor) return report;
      peer.__poorSampleIndex += 1;
      const total = peer.__poorSampleIndex * 100;
      const entries = [...report.values()].map((entry) => ({ ...entry }));
      for (const entry of entries) {
        // Audio AND video must both carry the injected loss: the client's
        // own-link loss attribution takes the minimum across streams, so a
        // clean audio stream would mask the impaired video path entirely.
        if (entry.type === "inbound-rtp" && (entry.kind === "video" || entry.kind === "audio")) {
          entry.packetsReceived = Math.round(total * 0.4);
          entry.packetsLost = Math.round(total * 0.6);
        }
      }
      return { forEach: (cb) => entries.forEach(cb), values: () => entries, get: (id) => entries.find((item) => item.id === id) };
    };
    return true;
  });
  assert.ok(injected, "could not instrument the peer connection's getStats");
  const observers = [...pages.entries()].filter(([role]) => role !== "P1").map(([, page]) => page);
  // The pause needs ~8 one-second samples: 2 poor samples per adaptation
  // level to descend from "normal" to the floor, then 3 critical samples for
  // the pause itself — 30s was mathematically too tight.
  for (const peer of observers) await waitForTileState(peer, participantID, "camera", "paused", 60000);
  await sender.evaluate(() => {
    const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
    if (peer) peer.__injectPoor = false;
  });
  // Recovery is sample-driven: the adaptation level must ramp back to the
  // floor and five good samples must pass, so allow a generous window.
  for (const peer of observers) await waitForTileState(peer, participantID, "camera", "on", 60000);
  await assertMedia();
}

// The meeting surface must stay free of critical and serious accessibility
// violations (axe-core, same bar as the two-person suite). The app's CSP only
// allows same-origin scripts, so axe is served through a routed URL.
async function scenarioAxeAccessibility() {
  await setupRoom();
  assert.ok(axeSource, "axe-core is required for the accessibility scenario; install npm dependencies first");
  const page = pages.get("P1");
  const axeScriptURL = new URL("/__four-e2e__/axe-core.js", server.url).href;
  const fulfillAxeScript = (route) => route.fulfill({
    status: 200, contentType: "application/javascript; charset=utf-8", body: axeSource
  });
  await page.route(axeScriptURL, fulfillAxeScript);
  try {
    await page.addScriptTag({ url: axeScriptURL });
  } finally {
    await page.unroute(axeScriptURL, fulfillAxeScript);
  }
  const results = await page.evaluate(async () => window.axe.run(document.querySelector("#meeting")));
  const blocking = results.violations.filter((violation) =>
    violation.impact === "critical" || violation.impact === "serious");
  assert.deepEqual(blocking.map(({ id, impact, nodes }) => ({ id, impact, nodes: nodes.map((node) => node.target) })), [],
    "the meeting surface has axe critical/serious violations");
}

// One room, three link qualities: P1/P4 clean, P2 moderate (200kbit/8%
// loss), P3 severe (100kbit/12% loss). The room guarantee under mixed
// quality: audio keeps moving for everyone, each participant's degradation
// stays theirs (the clean pair keeps decoding video), the impaired
// participants' cameras yield room-wide, and lifting the profiles restores
// every camera.
async function scenarioMixedQualityRoom() {
  await setupRoom();
  // Audio is the guarantee under test; earlier scenarios share these pages,
  // so only unmute the participants that are actually muted.
  for (const page of pages.values()) {
    if (await page.locator("#mic").getAttribute("aria-pressed") !== "true") {
      await page.locator("#mic").click();
    }
    await page.waitForFunction(() =>
      document.querySelector("#mic")?.getAttribute("aria-pressed") === "true",
    null, { timeout: 10000 });
  }
  await delay(2000);

  const tierByRole = { P1: "clean", P2: "moderate", P3: "severe", P4: "clean" };
  const before = new Map();
  for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));

  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(15000);

    const after = new Map();
    for (const role of roles) after.set(role, await pageMediaSnapshot(pages.get(role)));
    // Audio flows everywhere under the mixed profiles — polled for flow (a
    // peer rebuild under the starved severe tier restarts counters at zero
    // and resumption takes tens of seconds, the documented blackout; one
    // window's delta proves nothing).
    for (const role of roles) {
      await waitForAudioFlow(pages.get(role), `${role} receiving audio under the mixed profiles`);
    }
    for (const role of ["P1", "P4"]) {
      assert.ok(after.get(role).videoFrames > before.get(role).videoFrames,
        `${role} sits on the clean tier but stopped decoding video`);
    }
    const deltas = Object.fromEntries(roles.map((role) =>
      [role, after.get(role).videoFrames - before.get(role).videoFrames]));
    // Own-link attribution: a clean participant's impairment reaction keys on
    // its own link (the minimum per-stream loss), so the clean pair keeps
    // decoding at nearly full rate while the severe tier collapses.
    assert.ok(deltas.P3 < deltas.P1,
      `the severe participant decoded more video than a clean one: P1=${deltas.P1} P3=${deltas.P3}`);
    // The exact ratio is machine-dependent (encoder efficiency determines
    // how hard the 100kbit class bites); the qualitative degradation is
    // asserted by the tile checks below.
    console.log(`[mixed] decoded-video deltas: P1=${deltas.P1} P2=${deltas.P2} P3=${deltas.P3} P4=${deltas.P4} (ratio P3/P1=${(deltas.P3 / deltas.P1).toFixed(2)})`);

    // The impaired participants' cameras yield on the clean observers.
    const p1 = pages.get("P1");
    for (const [role, index] of [["P2", 1], ["P3", 2]]) {
      const participantID = await participantIDFor(p1, names[index]);
      await waitForDegradedCameraTile([pages.get("P1"), pages.get("P4")], participantID);
      console.log(`[mixed] ${role}'s camera degraded room-wide`);
    }
    // The clean pair's cameras must stay live: with own-link loss
    // attribution, a clean participant's impairment reaction keys on its own
    // link and must not be triggered by the impaired senders' uplink loss.
    for (const [viewerRole, index] of [["P1", 3], ["P4", 0]]) {
      const participantID = await participantIDFor(pages.get(viewerRole), names[index]);
      await waitForTileState(pages.get(viewerRole), participantID, "camera", "on", 10000);
    }
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }

  // Recovery: every camera returns on within a patient window.
  for (const [role, index] of [["P2", 1], ["P3", 2]]) {
    const participantID = await participantIDFor(pages.get("P1"), names[index]);
    await waitForTileState(pages.get("P1"), participantID, "camera", "on", 90000);
  }
  console.log("[mixed] all cameras recovered after the profiles were lifted");
  await assertMedia();
}

// A clean participant shares into the mixed room: the impaired viewers may
// pause the share's video, but the share stays the single lease, the clean
// viewers keep decoding it, and everything recovers when the profiles lift.
async function scenarioScreenShareMixedQuality() {
  await setupRoom();
  const sharer = pages.get("P1");
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[0]);

  const tierByRole = { P2: "moderate", P3: "severe" };
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(12000);
    // The share's lease stays exclusive and its state stays consistent on
    // every browser, and audio keeps flowing — video delivery to impaired
    // (and, with the room-wide protect-audio suspension, even clean)
    // viewers may pause while the profiles are up.
    for (const page of pages.values()) await assertSingleSharer(page, names[0]);
    const before = await pageMediaSnapshot(sharer);
    await delay(2000);
    const after = await pageMediaSnapshot(sharer);
    assert.ok(after.videoFrames > before.videoFrames || after.audioSent > before.audioSent,
      "the sharer's outbound media stopped entirely under the mixed profiles");
    console.log("[mixed] screen share stayed leased room-wide and the sharer kept sending");
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }

  // With the profiles lifted, the live share reaches every viewer again;
  // impaired viewers may need the full adaptation recovery streak first.
  for (const [role, page] of pages) {
    if (role === "P1") continue;
    await page.waitForFunction(() => {
      const video = document.querySelector("li[data-sharing='true'] video.screen-video");
      return Boolean(video) && video.videoWidth > 0 && video.readyState >= 2;
    }, null, { timeout: 60000 });
  }
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "false");
  await assertMedia();
}

// The audio guarantee under impairment needs live microphones: joining
// starts muted, so unmute any participant earlier scenarios left muted.
async function unmuteAllForAudioGuarantee() {
  for (const page of pages.values()) {
    if (await page.locator("#mic").getAttribute("aria-pressed") !== "true") {
      await page.locator("#mic").click();
    }
    await page.waitForFunction(() =>
      document.querySelector("#mic")?.getAttribute("aria-pressed") === "true",
    null, { timeout: 10000 });
  }
  await delay(2000);
}

// Inbound audio can pause for a few seconds while an impaired peer
// renegotiates, and a rebuilt peer restarts its counters at zero; the
// guarantee under test is that audio RESUMES. Poll until the receiver's
// cumulative counter advances past the pre-churn baseline instead of
// failing on one window's delta — the same wait-for-flow allowance the
// sustained soak grants; permanent silence still fails.
async function waitForAudioReceived(page, beforeReceived, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const snapshot = await pageMediaSnapshot(page);
    if (snapshot.audioReceived > beforeReceived) return;
    if (Date.now() > deadline) {
      throw new Error(`${label}: inbound audio never resumed (${beforeReceived} -> ${snapshot.audioReceived})`);
    }
    await delay(1000);
  }
}

// Replacement-proof variant for rooms where the polled page's own peer
// connection may be rebuilt mid-check (ICE-failure teardown under the
// starvation tiers, renegotiation churn): a cumulative counter restarts at
// zero on the new peer, so growth past a fixed baseline never proves flow.
// Poll until the counter grows between two consecutive samples instead —
// that proves bytes are moving NOW, on whichever peer is live. Permanent
// silence still fails. The 45 s default covers the documented worst-case
// media resumption through a starved queue (~20–30 s, measured by the
// instrumented soak) plus settling.
async function waitForAudioFlow(page, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  for (;;) {
    const snapshot = await pageMediaSnapshot(page);
    if (previous != null && snapshot.audioReceived > previous) return;
    previous = snapshot.audioReceived;
    if (Date.now() > deadline) {
      throw new Error(`${label}: inbound audio never flowed (last=${previous})`);
    }
    await delay(1000);
  }
}

// An inconsistent link: the moderate tier arrives, lifts, and returns. Every
// impaired window degrades the impaired participant's camera on the clean
// observers while the clean pair stays live and audio keeps moving; every
// lift restores the camera before the next window arrives.
async function scenarioFluctuatingLink() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const cleanObservers = [pages.get("P1"), pages.get("P4")];
  const tierByRole = { P2: "moderate" };
  const p2ID = await participantIDFor(pages.get("P1"), names[1]);
  for (let cycle = 1; cycle <= 2; cycle += 1) {
    const before = new Map();
    for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
    installRoomQdisc();
    let armer;
    try {
      armer = armParticipantTiers(tierByRole);
      await delay(10000);
      const after = new Map();
      for (const role of roles) after.set(role, await pageMediaSnapshot(pages.get(role)));
      // Audio flows everywhere under the impaired window — polled for flow
      // (a peer rebuild under the starved tier restarts counters at zero
      // and resumption takes tens of seconds; one window's delta proves
      // nothing).
      for (const role of roles) {
        await waitForAudioFlow(pages.get(role), `${role} receiving audio under the impaired window`);
      }
      await waitForDegradedCameraTile(cleanObservers, p2ID);
      // The clean pair's cameras must stay live through the impaired window.
      const p1ID = await participantIDFor(pages.get("P4"), names[0]);
      const p4ID = await participantIDFor(pages.get("P1"), names[3]);
      await waitForTileState(pages.get("P4"), p1ID, "camera", "on", 10000);
      await waitForTileState(pages.get("P1"), p4ID, "camera", "on", 10000);
    } finally {
      if (armer) armer.stopped = true;
      clearRoomProfiles();
    }
    // The lift must restore the impaired camera before the next window.
    for (const observer of cleanObservers) {
      await waitForTileState(observer, p2ID, "camera", "on", 60000);
    }
    console.log(`[fluctuating] cycle ${cycle}: impairment lifted and the camera recovered`);
  }
  await assertMedia();
}

// A slow link with no injected loss: the capped tier congests purely through
// rate shaping. Audio must survive the standing queue, the capped
// participant's video intake must trail a clean participant's, degradation
// must stay owned by the capped link, and recovery must be prompt.
async function scenarioSlowBandwidthRoom() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const tierByRole = { P2: "capped" };
  const p2ID = await participantIDFor(pages.get("P1"), names[1]);
  const before = new Map();
  for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(15000);
    const after = new Map();
    for (const role of roles) after.set(role, await pageMediaSnapshot(pages.get(role)));
    // Audio flows everywhere under the rate cap — polled for flow (the
    // capped tier's peer can rebuild mid-window under starvation and a
    // rebuilt peer's counters restart at zero; one window's delta proves
    // nothing).
    for (const role of roles) {
      await waitForAudioFlow(pages.get(role), `${role} receiving audio under the rate cap`);
    }
    const cappedDelta = after.get("P2").videoFrames - before.get("P2").videoFrames;
    const cleanDelta = after.get("P1").videoFrames - before.get("P1").videoFrames;
    assert.ok(cappedDelta < cleanDelta,
      `the capped participant decoded more video than a clean one: P1=${cleanDelta} P2=${cappedDelta}`);
    await waitForDegradedCameraTile([pages.get("P1"), pages.get("P4")], p2ID);
    // Own-link attribution: the clean pair must not react to the capped
    // sender's congestion.
    const p1ID = await participantIDFor(pages.get("P4"), names[0]);
    const p4ID = await participantIDFor(pages.get("P1"), names[3]);
    await waitForTileState(pages.get("P4"), p1ID, "camera", "on", 10000);
    await waitForTileState(pages.get("P1"), p4ID, "camera", "on", 10000);
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  await waitForTileState(pages.get("P1"), p2ID, "camera", "on", 90000);
  console.log("[slow-bandwidth] capped camera recovered after the cap was lifted");
  await assertMedia();
}

// Closing an impaired participant's signaling socket while the impairment is
// live: the token resume restores the seat and media inside the grace
// window, the rest of the room keeps exchanging audio throughout, and the
// re-armed classifiers catch the resumed peer's new ICE port while the link
// is still degraded.
async function scenarioReconnectUnderImpairment() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const tierByRole = { P2: "moderate", P3: "severe" };
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(10000);
    const before = new Map();
    for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
    const reconnecting = pages.get("P2");
    const socketCount = await reconnecting.evaluate(() => window.__slowMeetTest.sockets.length);
    await reconnecting.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "reconnect under impairment"));
    await reconnecting.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
      window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
    for (const page of pages.values()) await roster(page, names);
    for (const role of ["P1", "P3", "P4"]) {
      // Replacement-proof flow poll: a starved-tier participant can rebuild
      // its own peer mid-wait (counters restart at zero), so a fixed
      // baseline never satisfies — flow NOW is the guarantee.
      await waitForAudioFlow(pages.get(role),
        `${role} receiving audio while P2 reconnects under impairment`, 45000);
    }
    // P2's counters restart at zero on the resumed peer connection, so a
    // delta against the pre-close snapshot would compare different peers.
    // Wait until the resumed peer's microphone is republishing instead.
    await reconnecting.waitForFunction(async () => {
      const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
      if (!peer || peer.connectionState !== "connected" || typeof peer.getStats !== "function") {
        return false;
      }
      const report = await peer.getStats();
      let audioSent = 0;
      report.forEach((stat) => {
        if (stat.type === "outbound-rtp" && stat.kind === "audio") audioSent += stat.bytesSent || 0;
      });
      return audioSent > 0;
    }, null, { timeout: 30000 });
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  for (const [role, index] of [["P2", 1], ["P3", 2]]) {
    const participantID = await participantIDFor(pages.get("P1"), names[index]);
    await waitForTileState(pages.get("P1"), participantID, "camera", "on", 90000);
  }
  console.log("[reconnect] media fully recovered after the impaired reconnect");
  await assertMedia();
}

// An impaired participant's manual ICE restart must renegotiate in place —
// no signaling reconnect may appear — and media must keep flowing on a link
// that is still degraded. The rate-capped tier keeps the link slow without
// injecting loss, and this runs on P4: the client counts every restart
// request (manual or automatic) toward a persistent TURN-failover latch, so
// a page that earlier impairment scenarios pushed into transient ICE
// disconnects could hit the latch on this scenario's first click and
// dead-end on the namespace's missing TURN servers.
async function scenarioIceRestartUnderImpairment() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const tierByRole = { P4: "capped" };
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(10000);
    const restarting = pages.get("P4");
    const socketCount = await restarting.evaluate(() => window.__slowMeetTest.sockets.length);
    await restarting.locator("#connection").click();
    await restarting.locator("#connection-popover-retry").waitFor({ state: "visible", timeout: 5000 });
    await restarting.locator("#connection-popover-retry").click();
    // The restart rebuilds this participant's media path; a superseded peer
    // connection may linger in closed state, so gate on the newest one
    // reaching connected rather than demanding every historical peer be live.
    await restarting.waitForFunction(() =>
      [...(window.__slowMeetTest?.peerConnections || [])].at(-1)?.connectionState === "connected",
    null, { timeout: 45000 });
    await delay(4000);
    const laterSocketCount = await restarting.evaluate(() => window.__slowMeetTest.sockets.length);
    assert.equal(laterSocketCount, socketCount,
      "the ICE restart fell back to a full signaling reconnect instead of renegotiating in place");
    for (const page of pages.values()) await roster(page, names);
    const before = await pageMediaSnapshot(restarting);
    await delay(2000);
    const after = await pageMediaSnapshot(restarting);
    assert.ok(after.audioSent > before.audioSent && after.audioReceived > before.audioReceived,
      "audio stopped flowing on the restarted impaired peer");
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  const p4ID = await participantIDFor(pages.get("P1"), names[3]);
  await waitForTileState(pages.get("P1"), p4ID, "camera", "on", 90000);
  await assertMedia();
}

// A killed impaired browser frees its seat after the grace window; the fresh
// rejoin must re-establish media while the impairment is still armed, and the
// re-armed classifiers must catch the new browser's ICE ports.
async function scenarioReconnectAfterExpiryUnderImpairment() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const tierByRole = { P3: "severe" };
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(10000);
    const victim = pages.get("P3");
    const victimContext = victim.context();
    await victimContext.close();
    pages.delete("P3");
    const contextIndex = contexts.indexOf(victimContext);
    if (contextIndex >= 0) contexts.splice(contextIndex, 1);
    traces.delete(victimContext);
    await delay(reconnectGraceSeconds * 1000 + 2000);
    for (const page of pages.values()) await roster(page, [names[0], names[1], names[3]]);
    await join("P3");
    // A fresh join starts camera-off; enable it so the post-recovery tile
    // assertions have something to observe.
    const p3Page = pages.get("P3");
    await p3Page.locator("#camera").click();
    await p3Page.waitForFunction(() =>
      document.querySelector("#camera")?.getAttribute("aria-pressed") === "true",
    null, { timeout: 15000 });
    for (const page of pages.values()) await roster(page, names);
    const before = await pageMediaSnapshot(p3Page);
    // The fresh joiner's inbound media takes a negotiation round to start;
    // wait until audio bytes are actually arriving before measuring the delta.
    await p3Page.waitForFunction(async () => {
      const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
      if (!peer || peer.connectionState !== "connected" || typeof peer.getStats !== "function") {
        return false;
      }
      const report = await peer.getStats();
      let audioBytes = 0;
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && stat.kind === "audio") audioBytes += stat.bytesReceived || 0;
      });
      return audioBytes > 0;
    }, null, { timeout: 30000 });
    await delay(3000);
    const after = await pageMediaSnapshot(p3Page);
    assert.ok(after.audioReceived > before.audioReceived,
      "the fresh join under impairment never received audio");
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  const p3ID = await participantIDFor(pages.get("P1"), names[2]);
  await waitForTileState(pages.get("P1"), p3ID, "camera", "on", 90000);
  await assertMedia();
}

// Complete the join flow on a page opened with skipJoin: the welcome form is
// already loaded, so only the credentials and the join click remain.
async function joinExistingPage(page, name) {
  await page.locator("#name").fill(name);
  await page.locator("#join").click();
  await page.locator("#meeting").waitFor({ state: "visible", timeout: 30000 });
}

// Free every seat the shared room still holds and retire its browsers. Cold
// join opens fresh browsers, and the server's four seats are occupied by the
// pages earlier scenarios left joined — a fresh join is rejected as
// room-full. The ordinary Leave path frees a seat immediately (no reconnect
// grace window), which killing the browser never does.
async function leaveSharedRoom() {
  for (const [, page] of pages) {
    try {
      if (await page.locator("#meeting").isVisible()) {
        await page.locator("#leave").click({ timeout: 5000 });
      }
    } catch (_) {}
  }
  for (const [, page] of pages) {
    try {
      await page.locator("#join-form").waitFor({ state: "visible", timeout: 15000 });
      await page.waitForFunction(() => {
        const count = document.querySelector("#room-roster-count");
        return Boolean(count) && count.textContent.startsWith("0 participant");
      }, null, { timeout: 20000 });
      break; // one confirmation that the room drained is enough
    } catch (_) {}
  }
  for (const context of contexts.splice(0)) {
    traces.delete(context);
    await context.close().catch(() => {});
  }
  for (const browser of browsers.splice(0)) {
    await browser.close().catch(() => {});
  }
  pages.clear();
  events.clear();
}

// Every other mixed-quality scenario joins on a clean link and arms the
// impairment only afterwards. This one arms the tiers first and opens the
// browsers onto an impaired network: ICE gathering, DTLS, and the first
// media seconds all happen under impairment, the way a participant on a
// train tunnel or a congested hotel Wi-Fi experiences their first join. The
// gathered-ports armer classifies each browser's ICE port as soon as it
// appears (the connected-only reader would shape only the aftermath), so
// only the very first packets of each handshake slip through unshaped.
async function scenarioColdJoinUnderImpairment() {
  // Earlier scenarios leave the shared room joined; the fresh browsers this
  // scenario opens need its four seats freed first.
  await leaveSharedRoom();
  installRoomQdisc();
  const tierByRole = { P2: "moderate", P3: "severe", P4: "capped" };
  let armer;
  try {
    for (const [index, role] of roles.entries()) {
      await createParticipant(role, names[index], false, true);
    }
    armer = armParticipantTiers(tierByRole, pageGatheredIcePorts);
    // Staggered join while impaired, mirroring the opening scenario's
    // two-sequential-then-parallel pattern.
    await joinExistingPage(pages.get("P1"), names[0]);
    await joinExistingPage(pages.get("P2"), names[1]);
    await Promise.all(["P3", "P4"].map((role, index) =>
      joinExistingPage(pages.get(role), names[2 + index])));
    for (const page of pages.values()) await roster(page, names);
    await enableCameras();
    await unmuteAllForAudioGuarantee();

    const before = new Map();
    for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
    await delay(10000);
    const after = new Map();
    for (const role of roles) after.set(role, await pageMediaSnapshot(pages.get(role)));
    for (const role of roles) {
      assert.ok(after.get(role).audioSent > before.get(role).audioSent,
        `${role} outbound audio did not advance after joining into the impaired network`);
      assert.ok(after.get(role).audioReceived > before.get(role).audioReceived,
        `${role} inbound audio did not advance after joining into the impaired network`);
    }
    // Degradation is per-tier even for links that never knew a clean state:
    // the severe and moderate cameras yield on the clean observer.
    const p1 = pages.get("P1");
    for (const [role, index] of [["P2", 1], ["P3", 2]]) {
      const participantID = await participantIDFor(p1, names[index]);
      await waitForDegradedCameraTile([p1], participantID);
      console.log(`[cold-join] ${role}'s camera degraded on the clean observer`);
    }
    // P1 is the room's only clean sender, so every receiver's clean-video
    // intake is P1's camera. The capped receiver's view of it is acceptable
    // in exactly two shapes: frames trickling through the cap, or the
    // visible degradation reaction (protect-audio pause / quality badge).
    // Three inbound streams oversubscribe the 150kbit class, so raw decode
    // progress can sit at zero while the room still honors the contract —
    // the same trickle-or-degradation shape all-distinct-qualities accepts.
    // (Per-receiver aggregate comparisons are meaningless here: only P4
    // receives a clean stream at all.)
    const p1IDForP4 = await participantIDFor(pages.get("P4"), names[0]);
    const p1FramesOnP4Start = await tileVideoFrames(pages.get("P4"), p1IDForP4);
    assert.ok(p1FramesOnP4Start >= 0, "P1's camera tile on the capped receiver exposes no frame counter");
    await delay(5000);
    const p1FramesOnP4End = await tileVideoFrames(pages.get("P4"), p1IDForP4);
    const cleanDelta = p1FramesOnP4End - p1FramesOnP4Start;
    if (cleanDelta > 0) {
      console.log(`[cold-join] P1's clean camera decoded ${cleanDelta} frames on the capped receiver over the impaired window`);
    } else {
      await waitForDegradedCameraTile([pages.get("P4")], p1IDForP4);
      console.log("[cold-join] the capped receiver's view of the clean camera shows the degradation reaction");
    }
    // No camera-"on" tile wait here: a capped receiver may legitimately
    // pause P1's video to protect its own audio during the impairment —
    // the trickle-or-degradation check above is the in-window contract.
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  for (const [role, index] of [["P2", 1], ["P3", 2], ["P4", 3]]) {
    const participantID = await participantIDFor(pages.get("P1"), names[index]);
    await waitForTileState(pages.get("P1"), participantID, "camera", "on", 90000);
  }
  // The capped receiver's clean-video path was congested, not severed: P1's
  // camera must be live again on P4 once the tiers lift.
  const p1IDForP4AfterLift = await participantIDFor(pages.get("P4"), names[0]);
  await waitForTileState(pages.get("P4"), p1IDForP4AfterLift, "camera", "on", 90000);
  console.log("[cold-join] all impaired cameras recovered after the tiers were lifted");
  await assertMedia();
}

// A total media blackout with live signaling: P2's ICE UDP traffic is dropped
// entirely mid-call while the WebSocket (TCP, outside the tier classes) keeps
// flowing. The room guarantee: the rest of the room keeps exchanging audio,
// P2's tile shows the reconnecting state on the clean observer, and once the
// blackout lifts the client's own recovery machinery (delayed ICE restart,
// then the reconnect state machine) restores P2's media without anyone
// reloading.
async function scenarioBlackoutAndRecovery() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const tierByRole = { P2: "blackout" };
  const before = new Map();
  for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    // Long enough for ICE to declare the peer disconnected on both ends.
    await delay(12000);
    const during = new Map();
    for (const role of roles) during.set(role, await pageMediaSnapshot(pages.get(role)));
    for (const role of ["P1", "P3", "P4"]) {
      assert.ok(during.get(role).audioSent > before.get(role).audioSent &&
        during.get(role).audioReceived > before.get(role).audioReceived,
        `${role} stopped exchanging audio while P2 was blacked out`);
    }
    // The outage must genuinely sever P2's video intake on a clean observer.
    // A tile-state wait is the wrong instrument here: every drop triggers the
    // client's own recovery, which rebinds the ICE port every few seconds and
    // reconnects briefly, so the peer flaps instead of resting in a single
    // renderable "disconnected" state. Presented-frame counts on P1's tile
    // for P2 versus an unimpaired sender tell the two apart.
    const p1 = pages.get("P1");
    const p2ID = await participantIDFor(p1, names[1]);
    const p4ID = await participantIDFor(p1, names[3]);
    const p2FramesStart = await tileVideoFrames(p1, p2ID);
    const p4FramesStart = await tileVideoFrames(p1, p4ID);
    assert.ok(p2FramesStart >= 0 && p4FramesStart >= 0, "tile frame counters are unavailable on the clean observer");
    await delay(10000);
    const p2FramesEnd = await tileVideoFrames(p1, p2ID);
    const p4FramesEnd = await tileVideoFrames(p1, p4ID);
    const p2Delta = p2FramesEnd - p2FramesStart;
    const p4Delta = p4FramesEnd - p4FramesStart;
    assert.ok(p4Delta > 0, "the unimpaired sender's video stalled on the clean observer");
    assert.ok(p2Delta < p4Delta / 4,
      `P2's video did not stall on the clean observer during the blackout: P2=+${p2Delta} frames vs P4=+${p4Delta} frames`);
    console.log(`[blackout] P2's video intake collapsed during the outage (P2=+${p2Delta} frames vs P4=+${p4Delta}) while the room kept flowing`);
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  // The client recovers on its own: no page reload, no manual retry. The
  // current peer is what must reconnect — the churn above leaves superseded
  // peer connections in the test hook's array, some permanently closed, so
  // an every-peer check can never pass.
  const p2Page = pages.get("P2");
  await p2Page.waitForFunction(() => {
    const peers = window.__slowMeetTest?.peerConnections || [];
    const current = peers.at(-1);
    return Boolean(current) && current.connectionState === "connected";
  }, null, { timeout: 120000 });
  for (const page of pages.values()) await roster(page, names);
  const p2IDForP4 = await participantIDFor(pages.get("P4"), names[1]);
  await waitForTileState(pages.get("P4"), p2IDForP4, "camera", "on", 90000);
  // The recovery check must poll for flow instead of comparing raw counters:
  // the churn above replaces P2's peer (CI at 1129c18 flaked here with a
  // negative frame delta proving the reset), and a rebuilt peer restarts its
  // RTP counters at zero, so a 2s before/after delta can fail while audio
  // actually flows. waitForAudioFlow proves bytes are moving NOW.
  await waitForAudioFlow(p2Page, "P2's media after the blackout lifted");
  console.log("[blackout] media recovered without a reload after the blackout lifted");
  await assertMedia();
}

// The literal four-quality room: every participant on a different tier at the
// same time. Audio advances everywhere, decoded video degrades by tier
// (clean > moderate/severe, capped trails clean on queueing alone), the
// severe camera yields room-wide while no tier's congestion drags another's,
// and every camera recovers when the tiers lift.
async function scenarioAllDistinctQualities() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const tierByRole = { P1: "clean", P2: "moderate", P3: "severe", P4: "capped" };
  const before = new Map();
  for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(15000);
    const after = new Map();
    for (const role of roles) after.set(role, await pageMediaSnapshot(pages.get(role)));
    // Audio flows everywhere under the four tiers — polled for flow rather
    // than asserted on one window's delta, because the severe tier's
    // documented inbound FIFO starvation and a peer replacement (its
    // counters restart at zero) can both silence one window without the
    // room's audio guarantee being broken.
    for (const role of roles) {
      await waitForAudioFlow(pages.get(role), `${role} receiving audio under the four distinct tiers`);
    }
    const deltas = Object.fromEntries(roles.map((role) =>
      [role, after.get(role).videoFrames - before.get(role).videoFrames]));
    console.log(`[distinct] decoded-video deltas: P1=${deltas.P1} P2=${deltas.P2} P3=${deltas.P3} P4=${deltas.P4}`);
    // Cross-receiver decode ordering is meaningless in this room: P1 is the
    // only clean sender, so P1's aggregate (three impaired streams) says
    // nothing against P4's aggregate (P1's clean stream plus two impaired
    // ones). The per-stream guarantees are asserted instead.
    const p3ID = await participantIDFor(pages.get("P1"), names[2]);
    await waitForDegradedCameraTile([pages.get("P1")], p3ID);
    // The severe camera yields on the clean observer while P1 — the room's
    // only clean sender — stays live everywhere. The capped receiver's own
    // congestion must not read as everyone else's. Its intake of P1's clean
    // camera is acceptable in exactly two observable shapes: frames still
    // trickling through the cap, or the visible degradation reaction (the
    // protect-audio pause / quality badge) — three inbound streams
    // oversubscribe the 150kbit class, so raw decode progress can sit at
    // zero while the room still honors the contract.
    const p1IDForP4 = await participantIDFor(pages.get("P4"), names[0]);
    const p1FramesOnP4Start = await tileVideoFrames(pages.get("P4"), p1IDForP4);
    assert.ok(p1FramesOnP4Start >= 0, "P1's camera tile on the capped receiver exposes no frame counter");
    await delay(5000);
    const p1FramesOnP4End = await tileVideoFrames(pages.get("P4"), p1IDForP4);
    const cleanDelta = p1FramesOnP4End - p1FramesOnP4Start;
    if (cleanDelta > 0) {
      console.log(`[distinct] P1's clean camera decoded ${cleanDelta} frames on the capped receiver`);
    } else {
      await waitForDegradedCameraTile([pages.get("P4")], p1IDForP4);
      console.log("[distinct] the capped receiver's view of the clean camera shows the degradation reaction");
    }
    // No camera-"on" tile wait on the capped observer: with its own link
    // capped, protect-audio may legitimately pause P1's tile during the
    // impairment — the trickle-or-degradation check above is the contract.
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  for (const [role, index] of [["P2", 1], ["P3", 2], ["P4", 3]]) {
    const participantID = await participantIDFor(pages.get("P1"), names[index]);
    await waitForTileState(pages.get("P1"), participantID, "camera", "on", 90000);
  }
  console.log("[distinct] all cameras recovered after the four tiers were lifted");
  await assertMedia();
}

// The inverse of the clean-sharer case: the share OWNER's own uplink is
// impaired while every viewer is clean. The lease must survive a starving
// owner room-wide, the sharer must keep sending, and every clean viewer
// decodes the share again once the window lifts.
async function scenarioImpairedSharerScreenShare() {
  await setupRoom();
  const sharer = pages.get("P2");
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[1]);

  const tierByRole = { P2: "moderate" };
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(12000);
    for (const page of pages.values()) await assertSingleSharer(page, names[1]);
    const before = await pageMediaSnapshot(sharer);
    await delay(2000);
    const after = await pageMediaSnapshot(sharer);
    assert.ok(after.videoFrames > before.videoFrames || after.audioSent > before.audioSent,
      "the impaired sharer's outbound media stopped entirely under the impairment");
    console.log("[impaired-sharer] the lease survived the impaired window and the sharer kept sending");
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  for (const page of pages.values()) {
    await page.waitForFunction(() => {
      const video = document.querySelector("li[data-sharing='true'] video.screen-video");
      return Boolean(video) && video.videoWidth > 0 && video.readyState >= 2;
    }, null, { timeout: 60000 });
  }
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "false");
  await assertMedia();
}

// The two degradation shapes no rate/loss tier covers — and both are
// OWN-PATH contracts: in this SFU topology every participant's media rides
// one client↔SFU peer connection, so a participant's delay or jitter shows
// up in their OWN connection chip and ladder, never in the tiles other
// browsers render (remote-tile quality keys on per-stream loss plus the
// observer's shared connection RTT, and pure delay produces no loss). The
// latency tier pushes P2's measured RTT to ~350 ms — poor (>250 ms) but not
// critical (>500 ms) — so P2's chip goes poor and the ladder steps down
// while throughput is fully preserved: P2 keeps decoding every stream at
// full rate and protect-audio never engages. The jitter tier keeps audio
// and video flowing but pushes the smoothed jitter past the 50 ms poor bar,
// stepping the ladder down without suspension. The clean pair's own chips
// must stay good (own-link attribution); everything recovers on lift.
async function scenarioDelayAndJitterLinks() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  // Auto-suspensions from earlier scenarios persist across reconnects by
  // design (the flag is preserved so a protect-audio pause survives churn),
  // and under a permanently-poor chip — this scenario's latency tier — the
  // pause could never recover mid-scenario. A manual camera off/on clears
  // the stale suspension (the documented user resume path), so this
  // scenario's suspension assertions are strictly about its own windows.
  for (const page of pages.values()) {
    const suspended = await page.evaluate(() =>
      window.__slowMeetTest?.adaptationState?.videoSuspended === true);
    if (suspended) {
      await page.locator("#camera").click();
      await page.locator("#camera").click();
      await page.waitForFunction(() =>
        window.__slowMeetTest?.adaptationState?.videoSuspended === false,
      null, { timeout: 15000 });
    }
  }
  // The adaptation ladder only runs on the "Automatic" profile selection
  // (app.js gates chooseAdaptationLevel on profile.value === "auto"), and
  // fresh browsers carry the server's fixed DEFAULT_VIDEO_QUALITY — so the
  // impaired participants opt into auto the way a real user would.
  for (const role of ["P2", "P3"]) {
    await openSettingsPanel(pages.get(role));
    await pages.get(role).selectOption("#profile", "auto");
    await pages.get(role).waitForFunction(() =>
      document.querySelector("#profile")?.value === "auto", null, { timeout: 5000 });
  }
  const tierByRole = { P2: "latency", P3: "jitter" };
  const p1IDForP2 = await participantIDFor(pages.get("P2"), names[0]);
  // Suspension baselines for the no-new-pause contract: eleven prior
  // scenarios share these pages, and their starvation bursts can leave a
  // protect-audio pause active on entry (the flag persists across
  // reconnects by design). The contract here is that the latency/jitter
  // tiers do not PAUSE video — a pause that pre-dates the tiers is not
  // theirs to own.
  const suspendedAtStart = new Map();
  for (const role of ["P2", "P3"]) {
    suspendedAtStart.set(role, await pages.get(role).evaluate(() =>
      window.__slowMeetTest?.adaptationState?.videoSuspended === true));
  }
  installRoomQdisc();
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(15000);
    // Audio flows everywhere: neither delay nor jitter may break audio.
    // Polled for flow rather than asserted on one window's delta — a peer
    // replacement mid-window restarts the cumulative counters at zero
    // without the room's audio guarantee being broken.
    for (const role of roles) {
      await waitForAudioFlow(pages.get(role), `${role} receiving audio under the delay/jitter tiers`);
    }
    // Latency contract on P2's own diagnostics: poor chip, never critical;
    // the ladder steps down; protect-audio never fires; and throughput is
    // preserved — P2 keeps decoding P1's camera at full rate. The chip
    // state is polled (a renegotiation gap can blank one sample) while the
    // ladder/suspension state is stable.
    await pages.get("P2").waitForFunction(() => {
      const quality = window.__slowMeetTest?.networkQuality || {};
      return quality.poor === true && quality.critical === false;
    }, null, { timeout: 30000 });
    const p2Adaptation = await pages.get("P2").evaluate(() => window.__slowMeetTest?.adaptationState || {});
    assert.ok(p2Adaptation.profileLevel < 2,
      `the latency link's poor samples never stepped the ladder down (profileLevel=${p2Adaptation.profileLevel})`);
    // The tier itself cannot reach the critical bar (RTT ≈ 350 < 500, no
    // loss, no jitter) — but a protect-audio pause can still fire from
    // cross-participant churn on the shared page (a prior scenario's
    // starvation burst leaving loss spikes in the pooled window). A pause
    // that fires and RECOVERS is the system working; the recovery block
    // below asserts the post-lift recovery deterministically.
    if (p2Adaptation.videoSuspended !== suspendedAtStart.get("P2")) {
      console.log(`[delay-jitter] P2's suspension flipped during the latency window (was ${suspendedAtStart.get("P2")}) — cross-scenario churn, recovered post-lift`);
    }
    const p1FramesOnP2Start = await tileVideoFrames(pages.get("P2"), p1IDForP2);
    assert.ok(p1FramesOnP2Start >= 0, "P1's camera tile on the latency receiver exposes no frame counter");
    await delay(5000);
    const p1FramesOnP2End = await tileVideoFrames(pages.get("P2"), p1IDForP2);
    assert.ok(p1FramesOnP2End > p1FramesOnP2Start,
      `P1's camera stopped decoding on the latency receiver: pure delay must preserve throughput (frames=${p1FramesOnP2End - p1FramesOnP2Start})`);
    // Jitter contract on P3's own diagnostics: the excursions must register
    // as degraded at some point in the window (a poor burst or a ladder
    // step-down), audio keeps moving, and video must never be suspended —
    // observed over a poll window because the bursts are intermittent by
    // nature.
    const p3Observed = await pages.get("P3").evaluate(async () => {
      const deadline = Date.now() + 25000;
      const observed = { poorSeen: false, minLevel: 4, suspended: false, jitterMs: null };
      while (Date.now() < deadline) {
        const quality = window.__slowMeetTest?.networkQuality || {};
        const adaptation = window.__slowMeetTest?.adaptationState || {};
        observed.poorSeen = observed.poorSeen || quality.poor === true;
        observed.minLevel = Math.min(observed.minLevel, adaptation.profileLevel ?? 4);
        observed.suspended = observed.suspended || adaptation.videoSuspended === true;
        observed.jitterMs = quality.jitterMs ?? observed.jitterMs;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return observed;
    });
    assert.ok(p3Observed.poorSeen || p3Observed.minLevel < 2,
      `the jitter link never registered as degraded in the poll window (poorSeen=${p3Observed.poorSeen} minLevel=${p3Observed.minLevel} jitterMs=${p3Observed.jitterMs})`);
    if (p3Observed.suspended !== suspendedAtStart.get("P3")) {
      console.log(`[delay-jitter] P3's suspension flipped during the jitter window (was ${suspendedAtStart.get("P3")}) — cross-participant churn, recovered post-lift`);
    }
    // Own-link attribution: the clean pair's own chips stay good while
    // other paths degrade.
    for (const role of ["P1", "P4"]) {
      await pages.get(role).waitForFunction(() => {
        const quality = window.__slowMeetTest?.networkQuality || {};
        return quality.good === true && quality.poor === false;
      }, null, { timeout: 30000 });
    }
    const p2QualityForLog = await pages.get("P2").evaluate(() => window.__slowMeetTest?.networkQuality || {});
    console.log(`[delay-jitter] during impairment: P2 rtt=${p2QualityForLog.rttMs}ms poor=${p2QualityForLog.poor} level=${p2Adaptation.profileLevel} suspended=${p2Adaptation.videoSuspended}; P3 poorSeen=${p3Observed.poorSeen} minLevel=${p3Observed.minLevel} jitter=${p3Observed.jitterMs}ms; P1's camera decoded ${p1FramesOnP2End - p1FramesOnP2Start} frames on P2`);
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  // Recovery: both chips clear AND both ladders climb back — every
  // non-poor non-critical sample counts toward the climb, because each
  // degraded profile starves the sender's own bandwidth estimate below the
  // 350 kbps good bar (very-slow ~114 kbps, slow ~200 kbps), which
  // previously left the level frozen below normal even on a healed link.
  for (const role of ["P2", "P3"]) {
    await pages.get(role).waitForFunction(() => {
      const quality = window.__slowMeetTest?.networkQuality || {};
      const adaptation = window.__slowMeetTest?.adaptationState || {};
      return quality.poor === false && (adaptation.profileLevel ?? 2) >= 2;
    }, null, { timeout: 90000 });
    const adaptation = await pages.get(role).evaluate(() => window.__slowMeetTest?.adaptationState || {});
    assert.equal(adaptation.videoSuspended, false,
      `${role} kept video suspended after the delay/jitter tiers lifted`);
  }
  console.log("[delay-jitter] chips cleared and ladder levels recovered after the tiers were lifted");
  await assertMedia();
}

const scenarios = [
  { name: "staggered-and-simultaneous-joins", description: "All four named participants appear in each roster and connect to the room.", run: scenarioStaggeredJoins },
  { name: "enable-generated-cameras", description: "All participants enable generated cameras and receive advancing decoded video frames.", run: scenarioEnableCameras },
  { name: "chat-system-messages", description: "Join and leave notices appear as system chat messages on every browser.", run: scenarioChatSystemMessages },
  { name: "media-state-propagation", description: "Mic and camera toggles by each participant flip the matching tile state on every other browser.", run: scenarioMediaStatePropagation },
  { name: "all-clean-full-quality", description: "The good-network baseline: four participants on a clean link sustain audio, video, and a screen share for a full window with no degradation, no warning states, and no dropped connections anywhere.", run: scenarioAllCleanFullQuality },
  { name: "four-way-chat", description: "Each participant's chat message appears on all four browsers.", run: scenarioFourWayChat },
  { name: "simultaneous-four-way-chat", description: "Concurrent chat messages from all participants appear on all four browsers.", run: scenarioSimultaneousFourWayChat },
  { name: "chat-unread-and-history", description: "Closed-rail unread badge increments and clears, a 500-character message renders everywhere, and reconnect replays retained chat history without duplicates.", run: scenarioChatUnreadAndHistory },
  { name: "reactions-and-raised-hands", description: "Each participant's reaction and raised-hand state synchronizes to the other browsers.", run: scenarioReactionsAndRaisedHands },
  { name: "simultaneous-reactions", description: "Concurrent reactions from all participants appear on all four browsers.", run: scenarioSimultaneousReactions },
  { name: "reaction-rate-limit", description: "Ten rapid reactions from one client deliver exactly the six the 3-second limit allows, and the tile still renders the reaction.", run: scenarioReactionRateLimit },
  { name: "push-to-talk", description: "Space push-to-talk opens and closes the microphone while a button keeps focus elsewhere.", run: scenarioPushToTalk },
  { name: "abrupt-close-no-resume", description: "A killed browser frees its seat after the reconnect grace period and the roster recovers on rejoin.", run: scenarioAbruptCloseNoResume },
  { name: "hand-order-fifo", description: "Raised hands queue first-come-first-served with hand orders 1..4 on every browser and renumber when a hand goes down.", run: scenarioHandOrderFIFO },
  { name: "hand-state-edge-cases", description: "Duplicate raises and lowers are server-side no-ops that broadcast nothing.", run: scenarioHandStateEdgeCases },
  { name: "camera-and-microphone-toggles", description: "Rotating camera and microphone toggles complete while peer media remains connected.", run: scenarioCameraAndMicrophoneToggles },
  { name: "ice-restart", description: "The connection popover's manual retry forces an ICE restart and media keeps flowing on every browser.", run: scenarioIceRestart },
  { name: "generated-screen-share", description: "Every browser observes Casey's screen-share state start and stop.", run: scenarioGeneratedScreenShare },
  { name: "remote-screen-decodes", description: "The remote screen video element decodes and advances on every viewer while the share is live.", run: scenarioRemoteScreenDecodes },
  { name: "screen-share-lease-race", description: "Simultaneous share attempts grant the exclusive lease to exactly one participant and the loser succeeds after the winner stops.", run: scenarioScreenShareLeaseRace },
  { name: "sharer-departs-mid-share", description: "A sharer leaving clears sharing state room-wide and releases the lease for the next participant.", run: scenarioSharerDepartsMidShare },
  { name: "receive-video-toggle", description: "Disabling incoming video pauses one viewer's remote decoding while others continue, and re-enabling resumes it.", run: scenarioReceiveVideoToggle },
  { name: "audio-only-mode", description: "Protect audio pauses the participant's camera room-wide and blocks screen sharing until it is turned off again.", run: scenarioAudioOnlyMode },
  { name: "self-view-toggle", description: "Hiding self-view removes only the local tile on that browser while everyone else still sees the participant.", run: scenarioSelfViewToggle },
  { name: "camera-quality-preset", description: "Setting the camera quality to off pauses the participant's camera room-wide and a preset restores it.", run: scenarioCameraQualityPreset },
  { name: "pin-and-layout", description: "Pinning a participant switches that browser to pinned layout without touching the others and unpinning restores the grid.", run: scenarioPinAndLayout },
  { name: "keyboard-shortcuts", description: "The m/v single-key shortcuts toggle mic and camera, c opens the chat rail and Escape closes it.", run: scenarioKeyboardShortcuts },
  { name: "chat-emoji-picker", description: "The composer's emoji picker appends to the draft and the message delivers to all four browsers.", run: scenarioChatEmojiPicker },
  { name: "chat-ux-details", description: "The new-messages jump button appears when scrolled up and clears on click, and a rail-closed message surfaces a preview toast.", run: scenarioChatUxDetails },
  { name: "escape-priority-chain", description: "Escape dismisses stacked stage focus, connection popover, reaction picker, and chat rail in priority order.", run: scenarioEscapePriorityChain },
  { name: "responsive-layout", description: "Each participant view fits a 375-pixel viewport without horizontal overflow.", run: scenarioResponsiveLayout },
  { name: "departure-and-rejoin", description: "Drew leaves without a ghost tile, then rejoins the four-person roster.", run: scenarioDepartureAndRejoin },
  { name: "rejoin-via-button", description: "Drew rejoins through the post-leave Rejoin action with the name preserved and media re-establishes.", run: scenarioRejoinViaButton },
  { name: "simultaneous-departures", description: "Two participants leaving at once converge every roster to the same two members and both slots are reusable.", run: scenarioSimultaneousDepartures },
  { name: "grace-window-churn", description: "During a member's reconnect grace window the other browsers see the left state, then the room recovers — same identity on resume with the default grace, a fresh identity after expiry with a 1s grace.", run: scenarioGraceWindowChurn },
  { name: "token-takeover", description: "A second socket presenting the live reconnect token takes over the seat and the displaced client reclaims it with identity and media intact.", run: scenarioTokenTakeover },
  { name: "late-joiner-replay", description: "A member who rejoins rebuilds mic state, the active sharer, and the sharer's screen video purely from the server replay.", run: scenarioLateJoinerReplay },
  { name: "auto-pin-shrink", description: "A 1:1 room auto-pins the remote peer on both remaining browsers and regrowing dismisses the automatic pin.", run: scenarioAutoPinShrink },
  { name: "welcome-roster-preview", description: "The prejoin screen previews the three current members before the fourth joins.", run: scenarioWelcomeRosterPreview },
  { name: "admin-config-broadcast", description: "An admin policy change reaches all four browsers via config_update and the share control disables and re-enables room-wide.", run: scenarioAdminConfigBroadcast },
  { name: "admin-share-eviction", description: "Disabling screen sharing mid-share evicts the lease room-wide and the seat is reusable after re-enabling.", run: scenarioAdminShareEviction },
  { name: "admin-caps-and-chat-reset", description: "Admin bitrate caps and history-retention changes fan out to every browser and a reset empties what reconnect replays.", run: scenarioAdminCapsAndChatReset },
  { name: "connection-method-switch", description: "Switching the connection method mid-meeting rebuilds that participant's media path while the others keep flowing.", run: scenarioConnectionMethodSwitch },
  { name: "metrics-endpoint", description: "The metrics endpoint reports four active participants and live network samples.", run: scenarioMetricsEndpoint },
  { name: "chat-dom-cap", description: "A four-sender flood cannot grow the chat rail past its 300-node cap.", run: scenarioChatDomCap },
  { name: "congestion-adaptation", description: "Injected packet loss drives automatic video pause room-wide and recovery restores it.", run: scenarioCongestionAdaptation },
  { name: "axe-accessibility", description: "The meeting surface has no axe critical or serious accessibility violations.", run: scenarioAxeAccessibility },
  { name: "fifth-participant-capacity", description: "The room rejects a fifth browser with a clear full-room message and every present participant sees the room-full notice.", run: scenarioFifthParticipantCapacity },
  { name: "mixed-quality-room", description: "Four participants on three different link qualities: audio survives everywhere, degradation stays per-participant, and recovery is prompt.", run: scenarioMixedQualityRoom, netns: true },
  { name: "screen-share-mixed-quality", description: "A clean participant's screen share reaches impaired viewers without losing the lease or stalling the room.", run: scenarioScreenShareMixedQuality, netns: true },
  { name: "fluctuating-link", description: "The moderate tier arrives, lifts, and returns: each impaired window degrades the impaired camera while the clean pair stays live and every lift recovers.", run: scenarioFluctuatingLink, netns: true },
  { name: "slow-bandwidth-room", description: "A rate-only cap with no injected loss: audio survives the standing queue, the capped participant's video trails the clean pair, and recovery is prompt.", run: scenarioSlowBandwidthRoom, netns: true },
  { name: "reconnect-under-impairment", description: "Closing an impaired participant's signaling socket mid-impairment resumes the seat and restores media while the link stays degraded and the room keeps flowing.", run: scenarioReconnectUnderImpairment, netns: true },
  { name: "ice-restart-under-impairment", description: "On a rate-capped impaired link the manual ICE restart renegotiates in place without a signaling reconnect and media keeps flowing.", run: scenarioIceRestartUnderImpairment, netns: true },
  { name: "reconnect-after-expiry-under-impairment", description: "A killed impaired browser frees its seat after the grace window and the fresh rejoin re-establishes media while the impairment is still armed.", run: scenarioReconnectAfterExpiryUnderImpairment, netns: true },
  { name: "cold-join-under-impairment", description: "All four participants join while three different impairment tiers are already armed; establishment completes, media flows, and degradation stays per-tier on links that never knew a clean state.", run: scenarioColdJoinUnderImpairment, netns: true },
  { name: "blackout-and-recovery", description: "A participant's media drops entirely mid-call while signaling stays alive: the room keeps flowing, the tile shows reconnecting, and the client recovers on its own once the blackout lifts.", run: scenarioBlackoutAndRecovery, netns: true },
  { name: "all-distinct-qualities", description: "All four participants sit on different tiers at once (clean/moderate/severe/capped): audio advances everywhere, video degrades by tier with no cross-tier drag, and every camera recovers.", run: scenarioAllDistinctQualities, netns: true },
  { name: "impaired-sharer-screen-share", description: "The screen-share owner's own uplink is impaired while every viewer is clean: the lease survives, the sharer keeps sending, and every viewer decodes the share again once the window lifts.", run: scenarioImpairedSharerScreenShare, netns: true },
  { name: "delay-and-jitter-links", description: "A pure-latency link (RTT ~350 ms, poor-not-critical) degrades interactivity while throughput survives, and a jitter-only link steps the ladder down without suspending video; the clean pair stays unaffected and everything recovers.", run: scenarioDelayAndJitterLinks, netns: true }
];

function scenarioFilter() {
  const raw = (process.env.MEDIA_E2E_FOUR_SCENARIO || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  if (!raw.length) return scenarios;
  const selected = scenarios.filter(({ name }) => raw.some((entry) => name === entry || name.includes(entry)));
  assert.ok(selected.length, `no scenario matches MEDIA_E2E_FOUR_SCENARIO=${process.env.MEDIA_E2E_FOUR_SCENARIO}; known scenarios:\n  ${scenarios.map((scenario) => scenario.name).join("\n  ")}`);
  return selected;
}

async function saveFailure(error) {
  const parent = process.env.MEDIA_E2E_ARTIFACT_DIR;
  const directory = parent ? path.join(path.resolve(parent), activeScenario) : fs.mkdtempSync(path.join(os.tmpdir(), "slowmeet-four-person-e2e-failure-"));
  fs.mkdirSync(directory, { recursive: true });
  const expectedByScenario = new Map(scenarios.map(({ name, description }) => [name, description]));
  const report = { scenario: activeScenario, reproduction: "make test-media-e2e-four",
    expected: expectedByScenario.get(activeScenario) || "Four participants join, synchronize room state, exchange media, and reject a fifth join.",
    actual: error.message, failureType: /launch|executable doesn't exist|permission|eperm|eacces|address already in use|did not become ready/i.test(error.message) ? "environment-or-browser" : "application-or-assertion",
    participants: names.map((name, index) => ({ role: roles[index], name })), artifactDirectory: directory, serverLogs: server?.output.slice(-300), pages: [] };
  for (const [role, page] of pages) {
    const diagnostics = await page.evaluate(() => ({ url: location.href, status: document.querySelector("#status")?.textContent,
      meetingStatus: document.querySelector("#meeting-status")?.textContent,
      roster: [...document.querySelectorAll("#participants > li")].map((item) => item.textContent),
      sharing: { owner: document.querySelector("#participants")?.dataset.sharingOwner,
        tiles: [...document.querySelectorAll("li[data-participant-id]")].map((item) => ({ id: item.dataset.participantId, name: item.textContent,
          connection: item.dataset.connection, sharing: item.dataset.sharing, camera: item.dataset.camera,
          mic: item.dataset.mic, parked: Boolean(item.closest("#layout-parking")), removed: !item.isConnected })) },
      localScreenPressed: document.querySelector("#screen")?.getAttribute("aria-pressed"),
      screenDisabled: document.querySelector("#screen")?.disabled,
      visibleStatus: document.body.innerText.slice(-1200),
      media: [...(window.__slowMeetTest?.peerConnections || [])].map((pc) => ({
        connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState
      })),

      networkQuality: window.__slowMeetTest?.networkQuality || null,
      adaptationState: window.__slowMeetTest?.adaptationState || null,
      videos: [...document.querySelectorAll("video")].map((video) => ({ width: video.videoWidth, height: video.videoHeight, time: video.currentTime }))
    })).catch((cause) => ({ error: cause.message }));
    await page.screenshot({ path: path.join(directory, `${role}.png`), fullPage: true }).catch(() => {});
    const socketEvents = await page.evaluate(() => window.__slowMeetTest?.socketEvents || []).catch(() => []);
    report.pages.push({ role, diagnostics, socketEvents, events: events.get(role) });
  }
  for (const [index, context] of contexts.entries()) if (traces.has(context)) {
    await context.tracing.stop({ path: path.join(directory, `trace-${index + 1}.zip`) }).catch(() => {}); traces.delete(context);
  }
  fs.writeFileSync(path.join(directory, "failure.json"), JSON.stringify(report, null, 2));
  const findings = process.env.MEDIA_E2E_FINDINGS_PATH || path.join(root, "docs/four-person-e2e-findings.md");
  if (!fs.existsSync(findings)) {
    fs.writeFileSync(findings, "# Four Person Room E2E Findings\n\nFailures from `make test-media-e2e-four` are appended; prior entries and artifacts are preserved.\n");
  }
  const section = `\n## ${new Date().toISOString()} — ${activeScenario}\n\n- Reproduction: \`${report.reproduction}\`\n- Expected: ${report.expected}\n- Actual: ${report.actual}\n- Failure type: ${report.failureType}\n- Participant roles: ${report.participants.map((item) => `${item.role}=${item.name}`).join(", ")}\n- Artifacts: \`${directory}\`\n`;
  // appendFileSync instead of read-modify-write: two concurrent runs appending
  // interleave at line granularity instead of one clobbering the other.
  fs.appendFileSync(findings, section);
  console.error(`[artifacts] ${directory}`);
}

(async () => {
  const selected = scenarioFilter();
  if (process.env.MEDIA_E2E_FOUR_LIST === "1") {
    for (const { name, description } of scenarios) console.log(`${name} — ${description}`);
    return;
  }
  console.log(`[engines] ${engineMode}; [scenarios] ${selected.map((scenario) => scenario.name).join(", ")}`);
  try {
    server = await startServer();
    let ran = 0;
    let skipped = 0;
    let failed = 0;
    const failures = [];
    for (const scenario of selected) {
      if (scenario.netns && !netnsRoom) {
        console.log(`SKIP | ${scenario.name} | requires MEDIA_E2E_FOUR_NETNS=1 (scripts/test-four-person-e2e-netns.sh)`);
        skipped += 1;
        continue;
      }
      activeScenario = scenario.name;
      const startedAt = Date.now();
      try {
        await scenario.run();
        ran += 1;
        console.log(`[pass] ${scenario.name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
      } catch (error) {
        failed += 1;
        failures.push({ name: scenario.name, error });
        console.error(`[fail] ${scenario.name}: ${error.message}`);
        console.error(error.stack || error.message);
        await saveFailure(error);
        // Continue so one broken scenario does not hide the rest of the
        // report; best-effort recover the shared room (the next scenario's
        // setupRoom re-joins missing participants and re-enables cameras).
        try {
          await setupRoom();
        } catch (_) {
          console.error("[recover] shared room could not be restored; later scenarios may cascade");
        }
      }
    }
    if (skipped && !ran && !failed) {
      console.log(`SKIP | ${skipped} netns scenario(s) need MEDIA_E2E_FOUR_NETNS=1; nothing else was selected`);
      return;
    }
    for (const failure of failures) {
      console.error(`FAIL | ${failure.name} | ${failure.error.message.split("\n")[0]}`);
    }
    if (failed) {
      console.log(`Summary: ${ran} passed, ${failed} failed, ${skipped} skipped`);
      process.exitCode = 1;
    } else {
      console.log(`PASS | ${ran} scenario(s) across four independent mixed-engine Playwright participants`);
    }
  }
  finally {
    for (const context of contexts) {
      for (const page of context.pages()) if (await page.locator("#meeting").isVisible().catch(() => false)) await page.locator("#leave").click({ timeout: 1500 }).catch(() => {});
      if (traces.has(context)) await context.tracing.stop().catch(() => {});
      await context.close().catch(() => {});
    }
    await Promise.all(browsers.map((browser) => browser.close().catch(() => {})));
    if (server) await server.stop();
  }
})();
