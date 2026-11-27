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
// MEDIA_E2E_FOUR_STRICT=1 turns the stricter checks inside existing scenarios
// (per-pair audio gaps, full-mesh media after a recovery) into assertions;
// without it they only log. SLOWMEET_KNOWN_FAILING=1 runs the scenarios and
// assertions that pin a documented defect ("Known issues pinned by tests" in
// docs/network-testing.md) instead of skipping or logging them.
const strictMode = process.env.MEDIA_E2E_FOUR_STRICT === "1";
const knownFailingEnabled = process.env.SLOWMEET_KNOWN_FAILING === "1";
const contexts = [];
const traces = new Set();
const pages = new Map();
const events = new Map();
const browsers = [];
let server;
let activeScenario = "startup";

async function freePort(protocol = "tcp") {
  if (protocol === "udp") {
    const dgram = require("node:dgram");
    const socket = dgram.createSocket("udp4");
    await new Promise((resolve, reject) => socket.bind(0, "127.0.0.1", resolve).once("error", reject));
    const { port } = socket.address();
    await new Promise((resolve) => socket.close(resolve));
    return port;
  }
  const portServer = net.createServer();
  await new Promise((resolve, reject) => portServer.listen(0, "127.0.0.1", resolve).once("error", reject));
  const { port } = portServer.address();
  await new Promise((resolve) => portServer.close(resolve));
  return port;
}

// The TURN relay's port range for the "turn" server profile, kept clear of
// the browsers' and the SFU's ephemeral UDP ports so tier filters never
// catch a relay socket by accident.
const turnRelayRange = { min: 20480, max: 20543 };
const turnSecret = "slowmeet-four-e2e-turn-secret";

// A port that is free for both TCP and UDP and outside the relay range.
async function freeTurnPort() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await freePort("tcp");
    if (port >= turnRelayRange.min && port <= turnRelayRange.max) continue;
    try {
      const dgram = require("node:dgram");
      const socket = dgram.createSocket("udp4");
      await new Promise((resolve, reject) => socket.bind(port, "127.0.0.1", resolve).once("error", reject));
      await new Promise((resolve) => socket.close(resolve));
      return port;
    } catch (_) {}
  }
  throw new Error("no port free for both TCP and UDP");
}

// startServer({ profile }) starts a server; "default" is the plain room and
// "turn" adds the built-in TURN relay (UDP and TCP on one port). The result's
// restart({ downMs }) stops the process and starts it again on the same
// port and config file, the way a deploy or crash restarts it.
async function startServer({ profile = "default", port } = {}) {
  const httpPort = port || await freePort();
  const configPath = path.join(os.tmpdir(), `slowmeet-four-e2e-${process.pid}-${httpPort}.json`);
  fs.writeFileSync(configPath, JSON.stringify({ retain_chat_history: true }));
  const turnPort = profile === "turn" ? await freeTurnPort() : undefined;
  const turnEnv = profile === "turn" ? {
    TURN_SERVER_ENABLED: "true", TURN_SERVER_PORT: String(turnPort), TURN_SERVER_TLS_PORT: "0",
    TURN_SERVER_TLS_CERT_FILE: "", TURN_SERVER_TLS_KEY_FILE: "", TURN_SERVER_REALM: "",
    TURN_SERVER_RELAY_PORT_MIN: String(turnRelayRange.min), TURN_SERVER_RELAY_PORT_MAX: String(turnRelayRange.max),
    TURN_SERVER_RELAY_IP: "", TURN_URL: "",
    TURN_URLS: `turn:127.0.0.1:${turnPort}?transport=udp,turn:127.0.0.1:${turnPort}?transport=tcp`,
    TURN_SHARED_SECRET: turnSecret, TURN_CREDENTIAL_TTL_SECONDS: "", ICE_TRANSPORT_POLICY: "all",
    ICE_PUBLIC_IP: "127.0.0.1"
  } : {};
  const url = `http://127.0.0.1:${httpPort}`;
  const handle = { url, port: httpPort, profile, turnPort, relayRange: profile === "turn" ? turnRelayRange : undefined, output: [] };
  const spawnServer = async () => {
    const child = spawn("go", ["run", "."], {
      cwd: root,
      env: { ...process.env, HTTP_ADDR: `127.0.0.1:${httpPort}`, MAX_PARTICIPANTS: "4",
        RECONNECT_TIMEOUT_SECONDS: String(reconnectGraceSeconds), MEETING_PASSWORD: "",
        ADMIN_PASSWORD: adminPassword, CONFIG_FILE: configPath,
        // In the namespace the server's only interface is loopback; without
        // the NAT 1-to-1 loopback path the SFU gathers no candidates at all.
        ...(netnsRoom ? { ICE_PUBLIC_IP: "127.0.0.1" } : {}),
        ...turnEnv,
        // The "simulcast" profile turns on camera simulcast (low/medium/high
        // layers per publisher, a layer chosen per receiver).
        ...(profile === "simulcast" ? { SIMULCAST_ENABLED: "true" } : {}),
        GOCACHE: process.env.GOCACHE || "/tmp/slowmeet-four-e2e-gocache" },
      detached: true, stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (data) => handle.output.push(data.toString()));
    child.stderr.on("data", (data) => handle.output.push(data.toString()));
    let ready = false;
    for (let i = 0; i < 120; i += 1) {
      try { if ((await fetch(`${url}/health`)).ok) { ready = true; break; } } catch (_) {}
      if (child.exitCode !== null) break;
      await delay(250);
    }
    assert.ok(ready, `local server did not become ready\n${handle.output.join("").slice(-8000)}`);
    handle.child = child;
  };
  const stopChild = async () => {
    const child = handle.child;
    if (!child) return;
    try { process.kill(-child.pid, "SIGTERM"); } catch (_) { child.kill("SIGTERM"); }
    await Promise.race([new Promise((resolve) => child.once("exit", resolve)), delay(5000)]);
    handle.child = undefined;
  };
  await spawnServer();
  handle.stop = async () => {
    await stopChild();
    fs.rmSync(configPath, { force: true });
  };
  handle.restart = async ({ downMs = 0 } = {}) => {
    await stopChild();
    const stoppedAt = Date.now();
    if (downMs > 0) await delay(downMs);
    await spawnServer();
    return { stoppedAt, readyAt: Date.now() };
  };
  return handle;
}

// options.baseURL loads the app from another origin than the server's, such
// as a participant's own signaling relay (scripts/signaling-relay.js).
async function createParticipant(role, name, expectRejected = false, skipJoin = false, { baseURL } = {}) {
  const origin = baseURL || server.url;
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
          "network.proxy.type": 0,
          // Inside the netns 127.0.0.1 is the SFU's only candidate, and the
          // SFU cannot resolve mDNS host names. Firefox's own address there
          // comes from the runner's dummy interface
          // (scripts/test-four-person-e2e-netns.sh).
          ...(netnsRoom ? { "media.peerconnection.ice.loopback": true,
            "media.peerconnection.ice.obfuscate_host_addresses": false } : {}) } }
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
            `--unsafely-treat-insecure-origin-as-secure=${origin}`] : [])] })
  });
  browsers.push(browser);
  const context = await browser.newContext({ viewport: netnsRoom
    ? { width: 1024, height: 700 }
    : { width: 1440, height: 900 } });
  contexts.push(context);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  traces.add(context);
  if (browserName === "chromium") await context.grantPermissions(["camera", "microphone"], { origin });
  if (netnsRoom) {
    // The 2-core CI runner cannot feed four 360p encoders plus 1440x900
    // compositing in real time: receivers stop draining their sockets, the
    // SFU correctly drops audio for the starved receiver, and the
    // audio-guarantee scenarios fail on runner size instead of product
    // behavior. The netns profile captures at 240p and renders a smaller
    // viewport; every scenario guarantee (frames advance, tiers degrade in
    // order, audio flows) is resolution-independent.
    await context.addInitScript(() => localStorage.setItem("meeting.cameraQuality", "240p"));
  }
  await context.addInitScript(() => {
    const nativePeer = window.RTCPeerConnection;
    const nativeSocket = window.WebSocket;
    // socketCreates and peerStates are timestamped histories for the
    // resilience scenarios; they are separate from socketEvents so readers
    // that slice or filter socketEvents keep their meaning.
    window.__slowMeetTest = { peerConnections: [], probePeers: [], sockets: [], socketEvents: [], socketCreates: [], peerStates: [] };
    window.RTCPeerConnection = new Proxy(nativePeer, { construct(target, args, newTarget) {
      const peer = Reflect.construct(target, args, newTarget);
      // The background plain-relay probe (startPlainRelayProbe in app.js)
      // builds its own short-lived sender/echo pair while "Automatic" sits on
      // a relay. Those are not the meeting's peer, so they are kept out of
      // peerConnections, where every reader takes at(-1) as the live one.
      const probe = /startPlainRelayProbe/.test(new Error().stack || "");
      const list = probe ? window.__slowMeetTest.probePeers : window.__slowMeetTest.peerConnections;
      const index = list.length;
      peer.__createdAt = Date.now();
      list.push(peer);
      peer.addEventListener("connectionstatechange", () => {
        const at = Date.now();
        if (peer.connectionState === "connected" && !peer.__connectedAt) peer.__connectedAt = at;
        window.__slowMeetTest.peerStates.push(probe ? { at, peer: index, probe: true, state: peer.connectionState }
          : { at, peer: index, state: peer.connectionState });
      });
      return peer;
    } });
    window.WebSocket = new Proxy(nativeSocket, { construct(target, args, newTarget) {
      const socket = Reflect.construct(target, args, newTarget);
      window.__slowMeetTest.sockets.push(socket);
      window.__slowMeetTest.socketCreates.push({ at: Date.now(), url: String(args[0]) });
      socket.addEventListener("open", () => { socket.__openedAt = Date.now(); });
      socket.addEventListener("close", () => { socket.__closedAt = Date.now(); });
      const record = (direction, value) => {
        let message = value;
        if (typeof value === "string") {
          try {
            const parsed = JSON.parse(value);
            message = { type: parsed.type, participant_id: parsed.participant_id,
              screen_share_active: parsed.screen_share_active, screen_share_owner: parsed.screen_share_owner,
              screen_share_enabled: parsed.screen_share_enabled, max_video_bitrate: parsed.max_video_bitrate,
              reconnect_token: parsed.reconnect_token, participant: parsed.participant?.id,
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
  await page.goto(origin);
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

// Every armer also records proof that its tiers reached traffic: class
// counters when it is armed and again when the scenario stops it (scenarios
// stop the armer before clearing the qdisc). The runner checks the proofs
// after a scenario passes (assertScenarioShaping), so a classifier that never
// matched a port fails the scenario instead of passing it unimpaired.
const shapingProofs = [];
function armParticipantTiers(tierByRole, readPorts) {
  const armer = netemTiers.armParticipantTiers(tierByRole, pages, readPorts);
  const proof = {
    tiers: [...new Set(Object.values(tierByRole).filter((tier) => tier !== "clean"))],
    before: netemTiers.tierClassCounters(), after: undefined, armer
  };
  shapingProofs.push(proof);
  let stopped = false;
  Object.defineProperty(armer, "stopped", {
    get: () => stopped,
    set: (value) => {
      if (value && !stopped && !proof.after) proof.after = netemTiers.tierClassCounters();
      stopped = value;
    }
  });
  return armer;
}

function assertScenarioShaping() {
  const proofs = shapingProofs.splice(0);
  proofs.forEach((proof, index) => {
    if (!proof.after) {
      proof.armer.stopped = true;
      return;
    }
    const label = `armer-${index + 1}`;
    if (!Object.keys(proof.after).length) {
      console.log(`[netem] ${label}: class counters unreadable, shaping proof skipped`);
      return;
    }
    const deltas = {};
    for (const name of proof.tiers) {
      const tier = fourPersonTiers[name];
      if (!tier) continue;
      const delta = netemTiers.classCounterDelta(proof.before, proof.after, tier.classID);
      deltas[name] = delta;
      assert.ok(delta.sentPackets + delta.dropped >= 20,
        `${label}: the ${name} tier (${tier.classID}) carried ${delta.sentPackets} packets and dropped ${delta.dropped} while armed: the classifier never matched the participant's traffic`);
      const lossy = /^[1-9]/.test(String(tier.loss)) || String(tier.loss).startsWith("gemodel");
      if (lossy && delta.sentPackets + delta.dropped >= 200) {
        assert.ok(delta.dropped >= 1, `${label}: the lossy ${name} tier dropped nothing over ${delta.sentPackets} packets`);
      }
    }
    recordEvidence(`shaping-${label}`, { tiers: deltas, classified: Object.fromEntries([...proof.armer.applied].map(([role, ports]) => [role, [...ports]])), errors: proof.armer.errors });
    console.log(`[netem] ${label}: ${Object.entries(deltas).map(([name, delta]) => `${name} sent=${delta.sentPackets} dropped=${delta.dropped}`).join(", ")}`);
  });
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
  const p1ID = await participantIDFor(pages.get("P2"), names[0]);
  const socketCount = await reconnecting.evaluate(() => window.__slowMeetTest.sockets.length);
  await reconnecting.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "four-person reconnect check"));
  await reconnecting.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
    window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
  for (const page of pages.values()) await roster(page, names);
  // Inside the grace window the reconnect is a token resume: the other three
  // keep seeing the same participant, not a newcomer with the same name.
  if (reconnectGraceSeconds >= 3) {
    for (const role of ["P2", "P3", "P4"]) {
      assert.equal(await participantIDFor(pages.get(role), names[0]), p1ID,
        `${role} sees ${names[0]} under a new identity after a signaling reconnect inside the grace window`);
    }
  }
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
  }, null, { timeout: 20000 }).catch(async () => {
    // Dump what the fresh page bound where, so an intermittent miss names
    // its cause: which receiver carries the screen, and which element shows it.
    const state = await fresh.evaluate(async () => {
      const describe = (video) => {
        const track = video?.srcObject?.getVideoTracks?.()[0];
        return video ? `${track ? track.id.slice(0, 24) : "none"} ${video.videoWidth}x${video.videoHeight} t=${video.currentTime.toFixed(1)}` : "no element";
      };
      const tiles = [...document.querySelectorAll("li[data-participant-id]")].map((tile) =>
        `${tile.dataset.participantId.slice(0, 6)} sharing=${tile.dataset.sharing} camera=[${describe(tile.querySelector("video:not(.screen-video)"))}] screen=[${describe(tile.querySelector("video.screen-video"))}]`);
      const receivers = [];
      for (const transceiver of peer.getTransceivers()) {
        const track = transceiver.receiver.track;
        if (track?.kind !== "video") continue;
        let inbound = "";
        (await transceiver.receiver.getStats())?.forEach((report) => {
          if (report.type === "inbound-rtp") inbound = `${report.frameWidth}x${report.frameHeight} ${report.bytesReceived}B`;
        });
        receivers.push(`mid=${transceiver.mid} ${transceiver.currentDirection} track=${track.id.slice(0, 24)} signaled=${signaledRemoteTrackID(transceiver.receiver)} owner=${remoteTrackOwners.get(track.id)?.slice(0, 6)} role=${remoteTrackRoles.get(track.id)} ${track.muted ? "muted " : ""}${inbound}`);
      }
      return { screenShareOwner: screenShareOwner?.slice(0, 6), remoteScreens: [...remoteScreenTracks.keys()].map((id) => id.slice(0, 6)), tiles, receivers };
    });
    assert.fail(`the late joiner never decoded the active screen share: ${JSON.stringify(state)}`);
  });
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
// browser while the other three keep flowing. The switch is applied in place
// (switchConnectionMethodInPlace): the live peer takes the new ICE
// configuration and restarts ICE over the same signaling socket, so the
// participant neither rejoins nor gets a new peer. Only a restart that has not
// connected within methodSwitchFallbackMs falls back to a reconnect.
async function scenarioConnectionMethodSwitch() {
  await setupRoom();
  const p2 = pages.get("P2");
  const before = await p2.evaluate(() => ({
    sockets: window.__slowMeetTest.sockets.length,
    peers: (window.__slowMeetTest.peerConnections || []).length,
    ufrag: /a=ice-ufrag:(\S+)/.exec(peer?.localDescription?.sdp || "")?.[1] || ""
  }));
  assert.ok(before.ufrag, "P2 has no local ICE ufrag before the switch");
  await openSettingsPanel(p2);
  await p2.locator("#settings-connection-method").selectOption("direct", { force: true });
  await p2.waitForFunction((previousUfrag) => {
    const current = /a=ice-ufrag:(\S+)/.exec(peer?.localDescription?.sdp || "")?.[1] || "";
    return appliedConnectionMethod === "direct" && current && current !== previousUfrag &&
      peer.connectionState === "connected";
  }, before.ufrag, { timeout: 20000 }).catch(async () =>
    assert.fail(`P2 did not restart ICE onto the direct method in place (${JSON.stringify(await p2.evaluate(() => ({
      applied: appliedConnectionMethod, state: peer?.connectionState })))})`));
  const after = await p2.evaluate(() => ({
    sockets: window.__slowMeetTest.sockets.length,
    peers: (window.__slowMeetTest.peerConnections || []).length
  }));
  assert.equal(after.sockets, before.sockets, "the method switch reconnected signaling instead of switching in place");
  assert.equal(after.peers, before.peers, "the method switch rebuilt the peer instead of restarting ICE on it");
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
    const p2ID = await participantIDFor(pages.get("P1"), names[1]);
    const socketCount = await reconnecting.evaluate(() => window.__slowMeetTest.sockets.length);
    await reconnecting.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "reconnect under impairment"));
    await reconnecting.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
      window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
    for (const page of pages.values()) await roster(page, names);
    // The grace window (5 s here) is longer than the client's first 2 s
    // retry, so this is a token resume: the same participant comes back.
    for (const role of ["P1", "P3", "P4"]) {
      assert.equal(await participantIDFor(pages.get(role), names[1]), p2ID,
        `${role} sees ${names[1]} under a new identity after a resume inside the grace window`);
    }
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
  await assertFullMeshMedia({ label: "after impaired reconnect" });
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
    const oldP3ID = await participantIDFor(pages.get("P1"), names[2]);
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
    // The seat expired, so the rejoin is a fresh participant, not a resume.
    assert.notEqual(await participantIDFor(pages.get("P1"), names[2]), oldP3ID,
      `${names[2]} rejoined after the grace window under the expired identity`);
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
  await assertFullMeshMedia({ label: "after impaired rejoin" });
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
    // The armer classifies each participant's ports as it finds them; check
    // that both tiers really shape their participant's link before judging
    // it, instead of trusting the settle delay (a still-unclassified P3 once
    // read 7 ms of jitter on its "jitter" link).
    await waitForShapedLink("P2", 300);
    await waitForShapedLink("P3", 60);
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
    const jitterCountersBefore = netemTiers.tierClassCounters();
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
    // Whether P3's traffic actually crossed the jitter tier during the poll,
    // so a failure tells a shaping miss from a client that ignored jitter.
    const jitterClass = netemTiers.classCounterDelta(jitterCountersBefore, netemTiers.tierClassCounters(),
      fourPersonTiers.jitter.classID);
    assert.ok(p3Observed.poorSeen || p3Observed.minLevel < 2,
      `the jitter link never registered as degraded in the poll window (poorSeen=${p3Observed.poorSeen} minLevel=${p3Observed.minLevel} jitterMs=${p3Observed.jitterMs}; jitter tier carried ${jitterClass.sentPackets} packets)`);
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

// --- Fast-link and room-mix support ------------------------------------------

// The top of the Automatic ladder is profiles[3] ("high") in web/js/app.js:
// Automatic never selects very-good or ultra. Its 650 kbps is what the camera
// sender's maxBitrate must read at that level under the e2e server's default
// 3 Mbps MAX_VIDEO_BITRATE (the netns capture preset caps resolution and
// frame rate, never the bitrate).
const topAutomaticLevel = 3;
const topAutomaticBitrate = 650000;

// Evidence a scenario gathers that is worth keeping whether it passes or
// fails: it is attached to failure.json by saveFailure and, when
// MEDIA_E2E_ARTIFACT_DIR is set, written beside the failure artifacts as
// <scenario>/<name>.json on passing runs too.
const scenarioEvidence = new Map();

function recordEvidence(name, evidence) {
  scenarioEvidence.set(activeScenario, { ...(scenarioEvidence.get(activeScenario) || {}), [name]: evidence });
  const parent = process.env.MEDIA_E2E_ARTIFACT_DIR;
  if (!parent) return;
  const directory = path.join(path.resolve(parent), activeScenario);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, `${name}.json`), JSON.stringify(evidence, null, 2));
}

// --- Resilience helpers -----------------------------------------------------

// The active scenario's registry entry (set by the runner).
let activeScenarioEntry;

// A check that pins a documented defect (Bn in docs/network-testing.md). It
// asserts only under SLOWMEET_KNOWN_FAILING=1; otherwise it logs that the
// defect is still present and keeps the evidence, so the scenario stays
// green while the defect stays visible.
function knownIssue(id, ok, message, evidence) {
  if (ok) {
    if (!knownFailingEnabled) console.log(`[known-issue] ${id} did not reproduce this run: ${message}`);
    return true;
  }
  if (evidence !== undefined) recordEvidence(`known-issue-${id}`, evidence);
  if (knownFailingEnabled) assert.fail(`KNOWN ISSUE ${id}: ${message}`);
  console.log(`KNOWN ISSUE ${id} still present | ${activeScenario} | ${message}`);
  return false;
}

// A stricter check inside an existing CI scenario: asserts only under
// MEDIA_E2E_FOUR_STRICT=1 (or always, in an opt-in resilience scenario),
// otherwise logs. knownIssue routes a strict failure through knownIssue.
function expectStrict(ok, message, { knownIssue: issue, evidence } = {}) {
  if (ok) return true;
  if (issue) return knownIssue(issue, false, message, evidence);
  if (evidence !== undefined) recordEvidence(`strict-${Date.now()}`, evidence);
  if (strictMode || activeScenarioEntry?.group) assert.fail(message);
  console.log(`STRICT-ONLY | ${activeScenario} | ${message}`);
  return false;
}

// Inbound bytes on the observer's receiver for one remote participant's
// audio, matched through the tile's <audio> element, or -1 when the tile, its
// track or its receiver is missing.
async function tileAudioBytes(page, participantID) {
  return page.evaluate(async (id) => {
    const audio = document.querySelector(`li[data-participant-id='${id}'] audio`);
    const track = audio?.srcObject?.getAudioTracks?.()[0];
    if (!track) return -1;
    const peers = [...(window.__slowMeetTest?.peerConnections || [])].filter((pc) => pc.connectionState !== "closed");
    for (const peer of peers.reverse()) {
      const receiver = peer.getReceivers().find((item) => item.track?.id === track.id);
      if (!receiver) continue;
      let bytes = -1;
      (await receiver.getStats()).forEach((stat) => {
        if (stat.type === "inbound-rtp") bytes = stat.bytesReceived || 0;
      });
      return bytes;
    }
    return -1;
  }, participantID);
}

// The observer's inbound-rtp stats for one remote participant's camera or
// audio (owner = the SFU egress track "<id>|camera" / "<id>|audio").
async function tileInboundRtp(page, participantID, kind = "video") {
  return page.evaluate(async ({ id, kind }) => {
    const role = kind === "video" ? "camera" : "audio";
    const peers = [...(window.__slowMeetTest?.peerConnections || [])].filter((pc) => pc.connectionState !== "closed");
    for (const peer of peers.reverse()) {
      const receiver = peer.getReceivers().find((item) => item.track?.kind === kind &&
        (item.track.id === `${id}|${role}` || item.track.id.startsWith(`${id}|${role}`)));
      if (!receiver) continue;
      let result = null;
      (await receiver.getStats()).forEach((stat) => {
        if (stat.type === "inbound-rtp") {
          result = { packetsReceived: stat.packetsReceived || 0, packetsLost: stat.packetsLost || 0,
            nackCount: stat.nackCount || 0, framesDecoded: stat.framesDecoded || 0, bytesReceived: stat.bytesReceived || 0 };
        }
      });
      return result;
    }
    return null;
  }, { id: participantID, kind });
}

// Every observer receives audio (and, with video, camera frames) from every
// other participant: the per-pair check behind "after a reconnect, each of
// the other three hears and sees the returning participant". In an opt-in
// resilience scenario it always asserts; in the CI scenarios it asserts only
// under MEDIA_E2E_FOUR_STRICT=1.
async function assertFullMeshMedia({ label = "full mesh", roleList = [...pages.keys()], video = true, skipVideoFrom = [], skipAudioFrom = [], timeoutMs = 45000 } = {}) {
  // Twelve pairs sampled for up to timeoutMs is a real cost; the CI
  // scenarios pay it only when the strict checks are asked for.
  if (!strictMode && !activeScenarioEntry?.group) return true;
  const pending = [];
  for (const observer of roleList) {
    const page = pages.get(observer);
    for (const sender of roleList) {
      if (sender === observer) continue;
      const id = await participantIDFor(page, names[roles.indexOf(sender)]);
      if (!skipAudioFrom.includes(sender)) pending.push({ observer, sender, page, id, kind: "audio" });
      if (video && !skipVideoFrom.includes(sender)) pending.push({ observer, sender, page, id, kind: "video" });
    }
  }
  const sample = (pair) => pair.kind === "audio" ? tileAudioBytes(pair.page, pair.id) : tileVideoFrames(pair.page, pair.id);
  const deadline = Date.now() + timeoutMs;
  let remaining = pending;
  const last = new Map();
  for (const pair of remaining) last.set(pair, await sample(pair));
  while (remaining.length && Date.now() < deadline) {
    await delay(1000);
    const next = [];
    for (const pair of remaining) {
      const value = await sample(pair);
      const before = last.get(pair);
      if (!(before >= 0 && value > before)) next.push(pair);
      last.set(pair, value);
    }
    remaining = next;
  }
  const missing = remaining.map((pair) => `${pair.observer} gets no ${pair.kind} from ${pair.sender} (last=${last.get(pair)})`);
  recordEvidence(`full-mesh-${label}`, { pairs: pending.length, missing });
  return expectStrict(missing.length === 0, `${label}: ${missing.join("; ")}`);
}

// Per-remote audio continuity on every page (scripts/audio-continuity.js).
// Installed only for strict or opt-in runs: four 100 ms getStats loops are a
// real cost on the 2-core CI runner.
const audioContinuity = require("./audio-continuity");
async function startScenarioContinuity(roleList = [...pages.keys()]) {
  if (!strictMode && !activeScenarioEntry?.group) return false;
  for (const role of roleList) await audioContinuity.installAudioContinuity(pages.get(role));
  return true;
}

// Longest per-remote audio gap each observer saw over [from, to], checked
// against budgetMs (a number, or role -> number). Returns the summary.
async function evaluateAudioGaps(label, from, to, budgetMs, roleList = [...pages.keys()]) {
  const summaries = {};
  const problems = [];
  for (const observer of roleList) {
    const page = pages.get(observer);
    const history = await audioContinuity.readAudioContinuity(page);
    if (!history) continue;
    const owners = [];
    for (const sender of roleList) {
      if (sender !== observer) owners.push(await participantIDFor(page, names[roles.indexOf(sender)]).catch(() => sender));
    }
    const summary = audioContinuity.summarize(history, { from, to, owners });
    summaries[observer] = summary;
    const budget = typeof budgetMs === "object" ? budgetMs[observer] : budgetMs;
    if (budget !== undefined && summary.worstGapMs > budget) {
      problems.push(`${observer} longest audio gap ${summary.worstGapMs} ms > ${budget} ms (${JSON.stringify(summary.perOwnerGapMs)})`);
    }
  }
  recordEvidence(`audio-gaps-${label}`, { from, to, budgetMs, summaries });
  if (Object.keys(summaries).length) expectStrict(problems.length === 0, `${label}: ${problems.join("; ")}`);
  return summaries;
}

// An automatic pause left behind by an earlier scenario persists across
// reconnects by design; the manual camera off/on is the documented user
// resume path (see scenarioDelayAndJitterLinks), so the suspension checks
// below are strictly about their own windows.
async function clearStaleVideoSuspensions() {
  for (const page of pages.values()) {
    const suspended = await page.evaluate(() =>
      window.__slowMeetTest?.adaptationState?.videoSuspended === true);
    if (!suspended) continue;
    await page.locator("#camera").click();
    await page.locator("#camera").click();
    await page.waitForFunction(() =>
      window.__slowMeetTest?.adaptationState?.videoSuspended === false,
    null, { timeout: 15000 });
  }
}

// The ladder only runs on the "Automatic" selection, and fresh browsers carry
// the server's fixed DEFAULT_VIDEO_QUALITY. Selecting a fixed profile and then
// Automatic is the user path that also makes the start deterministic: the
// profile change handler puts the ladder at level 2 ("normal") with both
// streaks at zero and the climb backoff reset, whatever earlier scenarios
// left behind on the shared page. The published adaptationState is refreshed
// only by the one-second stats tick, so each selection is awaited there: a
// page an earlier scenario left on Automatic at level 3 would otherwise still
// show that stale snapshot and read as an already-climbed restarted ladder.
async function restartAutomaticLadder(page) {
  await openSettingsPanel(page);
  for (const selection of ["normal", "auto"]) {
    await page.selectOption("#profile", selection);
    await page.waitForFunction((expected) =>
      window.__slowMeetTest?.adaptationState?.selectedProfile === expected,
    selection, { timeout: 10000 });
  }
}

async function restartAutomaticLadders() {
  await Promise.all([...pages.values()].map((page) => restartAutomaticLadder(page)));
}

async function waitForTopAutomaticLevel(role, timeoutMs, label) {
  const page = pages.get(role);
  try {
    await page.waitForFunction((level) => {
      const adaptation = window.__slowMeetTest?.adaptationState || {};
      return adaptation.selectedProfile === "auto" && adaptation.profileLevel === level &&
        adaptation.videoSuspended === false;
    }, topAutomaticLevel, { timeout: timeoutMs });
  } catch (_) {
    const state = await page.evaluate(() => ({
      adaptation: window.__slowMeetTest?.adaptationState || null,
      quality: window.__slowMeetTest?.networkQuality || null
    })).catch(() => null);
    throw new Error(`${role} did not reach the top Auto level within ${timeoutMs / 1000}s ${label}: ${JSON.stringify(state)}`);
  }
}

// Proof that a delay-carrying tier really classifies this participant's
// media: the unshaped namespace loopback measures an RTT of ~0 ms, so an RTT
// at or above the tier's one-way delay can only come from the class. Without
// it a fast-link assertion would pass vacuously on an unshaped link.
async function waitForShapedLink(role, minimumRttMs, timeoutMs = 30000) {
  const page = pages.get(role);
  try {
    await page.waitForFunction((minimum) => {
      const rttMs = window.__slowMeetTest?.networkQuality?.rttMs;
      return Number.isFinite(rttMs) && rttMs >= minimum;
    }, minimumRttMs, { timeout: timeoutMs });
  } catch (_) {
    const quality = await page.evaluate(() => window.__slowMeetTest?.networkQuality || null).catch(() => null);
    throw new Error(`${role}'s tier never shaped its link (RTT stayed under ${minimumRttMs} ms): ${JSON.stringify(quality)}`);
  }
}

// Samples every listed participant's own ladder and connection verdict about
// once a second until stopped. `mark` timestamps scenario events on the same
// clock so a timeline can be read against what the room was doing.
function startAdaptationSampler(roleList, intervalMs = 1000) {
  const startedAt = Date.now();
  const elapsed = () => Math.round((Date.now() - startedAt) / 100) / 10;
  const sampler = { stopped: false, timeline: new Map(roleList.map((role) => [role, []])), marks: [] };
  const loop = (async () => {
    while (!sampler.stopped) {
      for (const role of roleList) {
        const page = pages.get(role);
        if (!page) continue;
        const sample = await page.evaluate(() => {
          const adaptation = window.__slowMeetTest?.adaptationState;
          const quality = window.__slowMeetTest?.networkQuality;
          if (!adaptation || !quality) return null;
          // Same predicate as degradedTileIDs / waitForDegradedCameraTile.
          const degradedTiles = [...document.querySelectorAll("li[data-participant-id]")].filter((tile) => {
            const tileQuality = tile.dataset.quality || "";
            return tile.dataset.camera === "paused" || tile.classList.contains("is-poor-connection") ||
              tileQuality === "degraded" || tileQuality === "poor";
          }).map((tile) => tile.dataset.participantId);
          return {
            degradedTiles,
            selected: adaptation.selectedProfile, profile: adaptation.effectiveProfile,
            level: adaptation.profileLevel, suspended: adaptation.videoSuspended === true,
            suspendedAutomatically: adaptation.videoSuspendedAutomatically === true,
            poor: quality.poor === true, critical: quality.critical === true, good: quality.good === true,
            rttMs: quality.rttMs ?? null, lossPct: quality.packetLossPct ?? null,
            uplinkLossPct: quality.uplinkLossPct ?? null, jitterMs: quality.jitterMs ?? null,
            estimatedOutgoingKbps: quality.estimatedOutgoingKbps ?? null,
            outgoingVideoKbps: quality.outgoingVideoKbps ?? null,
            ownLinkStreams: quality.ownLinkStreams ?? null,
            senderReports: quality.senderReports ?? null,
            // The SFU's measurement of this participant's own download
            // (downlink_quality), and which one the adaptation used.
            serverLossPct: quality.serverDownlink?.lossPct ?? null,
            serverJitterMs: quality.serverDownlink?.jitterMs ?? null,
            serverAgeMs: quality.serverDownlink ? Date.now() - quality.serverDownlink.at : null,
            ownLinkSource: quality.ownLinkSource ?? null
          };
        }).catch(() => null);
        if (sample) sampler.timeline.get(role).push({ t: elapsed(), ...sample });
      }
      await delay(intervalMs);
    }
  })();
  sampler.mark = (label) => sampler.marks.push({ t: elapsed(), label });
  sampler.stop = async () => { sampler.stopped = true; await loop; return sampler; };
  return sampler;
}

function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
}

// The SFU's own measurement of each role's download over the settled part of
// a sampled timeline: fresh values only (they are re-sent every second).
function serverDownlinkLoss(sampled, roleList) {
  return Object.fromEntries(roleList.map((role) => {
    const fresh = sampled.timeline.get(role).filter((sample) => sample.t >= 5 &&
      Number.isFinite(sample.serverLossPct) && sample.serverAgeMs !== null && sample.serverAgeMs < 3000);
    return [role, {
      samples: fresh.length,
      medianPct: median(fresh.map((sample) => sample.serverLossPct)),
      medianJitterMs: median(fresh.map((sample) => sample.serverJitterMs))
    }];
  }));
}

// Takes a page's microphone off the wire without muting it: a muted track
// still sends 50 packets of silence a second.
async function detachMicrophone(page) {
  await page.evaluate(async () => {
    const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
    const sender = peer.getSenders().find((item) => item.track?.kind === "audio");
    window.__detachedMicrophone = { sender, track: sender.track };
    await sender.replaceTrack(null);
  });
}

async function reattachMicrophone(page) {
  await page.evaluate(async () => {
    const detached = window.__detachedMicrophone;
    if (!detached) return;
    window.__detachedMicrophone = null;
    if (!detached.sender.track) await detached.sender.replaceTrack(detached.track);
  });
}

// What one participant's browser counted on its inbound streams, per kind:
// the share of packets that did not arrive first time, and the packets that
// did.
function inboundLossByKind(samples) {
  return Object.fromEntries(["audio", "video"].map((kind) => {
    let received = 0;
    let expected = 0;
    for (const sample of samples) {
      for (const stream of sample.ownLinkStreams || []) {
        if (stream.kind !== kind || !(stream.receivedDelta > 0) || !(stream.lossPct >= 0 && stream.lossPct < 100)) continue;
        received += stream.receivedDelta;
        expected += stream.receivedDelta / (1 - stream.lossPct / 100);
      }
    }
    return [kind, {
      received: Math.round(received),
      lossPct: expected > 0 ? Math.round(1000 * (1 - received / expected)) / 10 : null
    }];
  }));
}

function summarizeAdaptationTimeline(samples) {
  const finite = (values) => values.filter((value) => Number.isFinite(value));
  const levels = finite(samples.map((sample) => sample.level));
  const losses = finite(samples.map((sample) => sample.lossPct));
  const rtts = finite(samples.map((sample) => sample.rttMs));
  return {
    samples: samples.length,
    minLevel: levels.length ? Math.min(...levels) : null,
    maxLevel: levels.length ? Math.max(...levels) : null,
    finalLevel: levels.length ? levels.at(-1) : null,
    suspendedSamples: samples.filter((sample) => sample.suspended).length,
    poorSamples: samples.filter((sample) => sample.poor).length,
    criticalSamples: samples.filter((sample) => sample.critical).length,
    maxLossPct: losses.length ? Math.round(Math.max(...losses) * 10) / 10 : null,
    maxRttMs: rtts.length ? Math.round(Math.max(...rtts)) : null
  };
}

// One token per sample: seconds, ladder level (P = video suspended), the
// own-link verdict (! critical, ~ poor, + good, . neither), own-link loss %.
function formatAdaptationTimeline(samples) {
  return samples.map((sample) => {
    const verdict = sample.critical ? "!" : sample.poor ? "~" : sample.good ? "+" : ".";
    const loss = Number.isFinite(sample.lossPct) ? sample.lossPct.toFixed(1) : "?";
    return `${Math.round(sample.t)}s:L${sample.level}${sample.suspended ? "P" : ""}${verdict}${loss}`;
  }).join(" ");
}

// The camera sender's first encoding on the page's current peer connection.
// No screen share is live in the scenarios that read it, so the only video
// sender is the camera.
async function cameraSenderEncoding(page) {
  return page.evaluate(() => {
    const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
    const sender = peer?.getSenders().find((item) => item.track?.kind === "video");
    const encoding = sender?.getParameters().encodings?.[0];
    if (!encoding) return null;
    return { maxBitrate: encoding.maxBitrate ?? null, maxFramerate: encoding.maxFramerate ?? null };
  });
}

async function degradedTileIDs(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll("li[data-participant-id]")].filter((tile) => {
      const quality = tile.dataset.quality || "";
      return tile.dataset.camera === "paused" ||
        tile.classList.contains("is-poor-connection") ||
        quality === "degraded" || quality === "poor";
    }).map((tile) => tile.dataset.participantId));
}

// pageMediaSnapshot pools every inbound audio stream, so one live sender
// hides two silent ones. This polls per stream until at least
// `minimumStreams` distinct inbound audio streams grow between two
// consecutive samples on the page's current peer — the per-publisher form of
// waitForAudioFlow, and replacement-proof for the same reason.
async function waitForAdvancingAudioStreams(page, minimumStreams, label, timeoutMs = 45000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let advancing = 0;
  for (;;) {
    const current = await page.evaluate(async () => {
      const peer = [...(window.__slowMeetTest?.peerConnections || [])].at(-1);
      if (!peer || typeof peer.getStats !== "function") return {};
      const report = await peer.getStats();
      const streams = {};
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && stat.kind === "audio") streams[stat.id] = stat.bytesReceived || 0;
      });
      return streams;
    });
    if (previous) {
      advancing = Object.keys(current).filter((id) => id in previous && current[id] > previous[id]).length;
      if (advancing >= minimumStreams) return advancing;
    }
    previous = current;
    if (Date.now() > deadline) {
      throw new Error(`${label}: only ${advancing} of ${minimumStreams} inbound audio streams advanced`);
    }
    await delay(1000);
  }
}

// A camera crossing an impaired link is acceptable in exactly two observable
// shapes on its observer (the contract all-distinct-qualities documents):
// frames still trickling through, or the visible degradation reaction — a
// protect-audio pause or a degraded/poor quality badge.
async function assertCameraTrickleOrDegraded(observerRole, senderIndex, tag) {
  const observer = pages.get(observerRole);
  const participantID = await participantIDFor(observer, names[senderIndex]);
  const framesStart = await tileVideoFrames(observer, participantID);
  if (framesStart >= 0) {
    await delay(5000);
    const delta = await tileVideoFrames(observer, participantID) - framesStart;
    if (delta > 0) {
      console.log(`[${tag}] ${roles[senderIndex]}'s camera decoded ${delta} frames on ${observerRole} in 5s`);
      return;
    }
  }
  await waitForDegradedCameraTile([observer], participantID);
  console.log(`[${tag}] ${observerRole}'s view of ${roles[senderIndex]}'s camera shows the degradation reaction`);
}

// How many peer connections and signaling sockets a page has created so far,
// and the state of the current peer: a rebuild or a signaling reconnect shows
// up as a count that moved.
async function connectionIdentity(page) {
  return page.evaluate(() => ({
    peers: (window.__slowMeetTest?.peerConnections || []).length,
    sockets: (window.__slowMeetTest?.sockets || []).length,
    state: (window.__slowMeetTest?.peerConnections || []).at(-1)?.connectionState || "missing"
  }));
}

// The good-network counterpart of the impaired rooms, on a link that is
// actually shaped: all four participants on the fast tier (20 mbit, RTT
// ≈ 20 ms, no loss). Every participant's Automatic ladder must reach the top
// level and HOLD it — no step-down, no protect-audio pause, no degraded tile
// — with the camera sender carrying the top profile's bitrate. One
// participant's link then turns moderate for a window and returns: the whole
// room must be back at the top level afterwards.
// What the machine and the shaped tiers looked like at one moment: load,
// memory, the busiest processes, and the tc class/qdisc counters (sent,
// dropped, backlog per tier). all-fast-link-top-quality failed only late in
// full runs, with every stream on the "clean" fast tier losing 15-46 %; these
// tell a saturated tier queue apart from a starved machine.
function hostAndTierSnapshot(label) {
  let processes = "";
  try {
    processes = execFileSync("ps", ["-eo", "pid,pcpu,pmem,rss,comm", "--sort=-pcpu"], { encoding: "utf8" })
      .split("\n").slice(0, 16).join("\n");
  } catch (error) {
    processes = `ps failed: ${error.message}`;
  }
  return {
    label,
    at: new Date().toISOString(),
    loadavg: os.loadavg(),
    cpus: os.cpus().length,
    freeMemMB: Math.round(os.freemem() / 1048576),
    totalMemMB: Math.round(os.totalmem() / 1048576),
    processes,
    tierStats: netemTiers.snapshotTierStats()
  };
}

// Each browser's packet counters per connection (transport totals against
// RTP audio/video and retransmissions; the difference is RTCP and STUN) and
// the SFU's /metrics, at one moment. Two of these bracket a window.
async function roomPacketCounters() {
  const browsers = {};
  for (const role of roles) {
    browsers[role] = await pages.get(role).evaluate(async () => {
      const peers = [...(window.__slowMeetTest?.peerConnections || [])]
        .filter((peer) => peer.connectionState !== "closed");
      const out = [];
      for (const peer of peers) {
        const entry = { state: peer.connectionState, transport: null, outbound: [], inbound: [] };
        try {
          (await peer.getStats()).forEach((stat) => {
            if (stat.type === "transport") {
              entry.transport = { packetsSent: stat.packetsSent, packetsReceived: stat.packetsReceived,
                bytesSent: stat.bytesSent, bytesReceived: stat.bytesReceived };
            } else if (stat.type === "outbound-rtp") {
              entry.outbound.push({ kind: stat.kind, packetsSent: stat.packetsSent, bytesSent: stat.bytesSent,
                retransmittedPacketsSent: stat.retransmittedPacketsSent, nackCount: stat.nackCount,
                pliCount: stat.pliCount, firCount: stat.firCount, frameHeight: stat.frameHeight,
                framesPerSecond: stat.framesPerSecond, targetBitrate: stat.targetBitrate, rid: stat.rid });
            } else if (stat.type === "inbound-rtp") {
              entry.inbound.push({ kind: stat.kind, packetsReceived: stat.packetsReceived,
                packetsLost: stat.packetsLost, nackCount: stat.nackCount, pliCount: stat.pliCount,
                retransmittedPacketsReceived: stat.retransmittedPacketsReceived });
            }
          });
        } catch (_) {}
        out.push(entry);
      }
      return out;
    }).catch((pageError) => `getStats failed: ${pageError.message}`);
  }
  let serverMetrics = null;
  try {
    serverMetrics = await (await fetch(`${server.url}/metrics`)).text();
  } catch (metricsError) {
    serverMetrics = `metrics failed: ${metricsError.message}`;
  }
  return { at: Date.now(), browsers, serverMetrics };
}

// Non-RTP packets each browser sent per second between two counter
// snapshots, and the SFU's transport-wide feedback relayed per second.
function packetCounterRates(before, after) {
  const seconds = Math.max(0.001, (after.at - before.at) / 1000);
  const nonRTPSent = (entry) => {
    if (!Array.isArray(entry)) return null;
    return entry.reduce((total, peer) => total + (peer.transport?.packetsSent || 0) -
      peer.outbound.reduce((sum, stream) => sum + (stream.packetsSent || 0), 0), 0);
  };
  const metric = (text, name) => Number((String(text).match(new RegExp(`^${name.replace(/[{}"=]/g, "\\$&")} (\\d+)`, "m")) || [])[1] ?? NaN);
  const rates = {};
  for (const role of Object.keys(after.browsers)) {
    const a = nonRTPSent(before.browsers[role]);
    const b = nonRTPSent(after.browsers[role]);
    rates[role] = a === null || b === null ? null : Math.round((b - a) / seconds);
  }
  const twcc = 'slowmeet_rtcp_relayed_total{type="transport_cc"}';
  rates.sfuTransportCCPerSecond = Math.round((metric(after.serverMetrics, twcc) - metric(before.serverMetrics, twcc)) / seconds);
  return rates;
}

async function scenarioAllFastLinkTopQuality() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await clearStaleVideoSuspensions();
  const config = await (await fetch(`${server.url}/config`)).json();
  // 650000 under the default caps; an admin cap left lowered by an earlier
  // scenario in a full run (admin-caps-and-chat-reset) lowers it with it.
  const expectedTopBitrate = Math.min(topAutomaticBitrate, config.max_video_bitrate);
  // Each participant on a fast link of its own (one 20 mbit class each).
  const fastTierByRole = { P1: "fast", P2: "fast-2", P3: "fast-3", P4: "fast-4" };
  const allFast = Object.fromEntries(roles.map((role) => [role, fastTierByRole[role]]));
  let armer;
  // Moving a participant between tiers replaces the whole qdisc: classifier
  // filters accumulate per port, so a second filter for an already-classified
  // port would leave which tier wins to filter ordering.
  const arm = (tierByRole) => {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
    installRoomQdisc({ include: ["fast-2", "fast-3", "fast-4"] });
    armer = armParticipantTiers(tierByRole);
  };
  const snapshots = [];
  let packetCountersAtArm = null;
  try {
    arm(allFast);
    // 10 ms each way ⇒ ~20 ms RTT; 15 ms leaves margin below that while
    // staying clear of what a loaded unshaped loopback can show.
    for (const role of roles) await waitForShapedLink(role, 15);
    snapshots.push(hostAndTierSnapshot("fast tier armed"));
    packetCountersAtArm = await roomPacketCounters();
    console.log(`[fast] load ${snapshots[0].loadavg.map((value) => value.toFixed(1)).join("/")} on ${snapshots[0].cpus} CPUs, ${snapshots[0].freeMemMB} of ${snapshots[0].totalMemMB} MB free`);
    await restartAutomaticLadders();
    // From level 2 the climb needs 5 transport-healthy one-second samples.
    await Promise.all(roles.map((role) => waitForTopAutomaticLevel(role, 30000, "on the fast tier")));
    // A tile badge needs five good samples to clear (stabilizeParticipantQuality),
    // so one a previous scenario left degraded (delay-and-jitter-links runs
    // just before this one in CI) can outlast the ladder's climb. The hold
    // below checks the fast link, so it starts once those have cleared.
    for (const role of roles) {
      try {
        await pages.get(role).waitForFunction(() =>
          ![...document.querySelectorAll("li[data-participant-id]")].some((tile) => {
            const quality = tile.dataset.quality || "";
            return tile.dataset.camera === "paused" || tile.classList.contains("is-poor-connection") ||
              quality === "degraded" || quality === "poor";
          }), null, { timeout: 20000 });
      } catch (_) {
        assert.fail(`${role}'s degraded tiles never cleared on the fast tier: ${JSON.stringify(await degradedTileIDs(pages.get(role)))}`);
      }
    }

    const before = new Map();
    for (const role of roles) before.set(role, await pageMediaSnapshot(pages.get(role)));
    const holdSampler = startAdaptationSampler(roles);
    await delay(15000);
    const hold = await holdSampler.stop();
    for (const role of roles) {
      const page = pages.get(role);
      const samples = hold.timeline.get(role);
      const summary = summarizeAdaptationTimeline(samples);
      assert.ok(samples.length >= 10, `${role} produced only ${samples.length} ladder samples in the 15s hold window`);
      assert.ok(samples.every((sample) => sample.selected === "auto"), `${role} left the Automatic profile during the hold window`);
      assert.equal(summary.minLevel, topAutomaticLevel,
        `${role} stepped down from the top Auto level on the fast tier: ${formatAdaptationTimeline(samples)}`);
      assert.equal(summary.suspendedSamples, 0,
        `${role} suspended video on the fast tier: ${formatAdaptationTimeline(samples)}`);
      // Every sample, not one end-of-window snapshot: a badge that flickers
      // to degraded mid-window is exactly what the fast link must not show.
      const degradedSample = samples.find((sample) => sample.degradedTiles.length > 0);
      assert.equal(degradedSample, undefined,
        `${role} saw degraded tiles on the fast tier at ${degradedSample?.t}s: ${JSON.stringify(degradedSample?.degradedTiles)}`);
      const after = await pageMediaSnapshot(page);
      assert.ok(after.audioSent > before.get(role).audioSent, `${role} outbound audio stalled on the fast tier`);
      assert.ok(after.audioReceived > before.get(role).audioReceived, `${role} inbound audio stalled on the fast tier`);
      assert.ok(after.videoFrames > before.get(role).videoFrames, `${role} decoded no video on the fast tier`);
      assert.deepEqual(await degradedTileIDs(page), [], `${role} saw degraded tiles on the fast tier`);
      const encoding = await cameraSenderEncoding(page);
      assert.ok(encoding, `${role} has no camera sender encoding`);
      assert.equal(encoding.maxBitrate, expectedTopBitrate,
        `${role}'s camera sender does not carry the top Auto profile's bitrate (maxFramerate=${encoding.maxFramerate})`);
      console.log(`[fast] ${role} held Auto level ${summary.minLevel} for ${samples.length} samples: rtt<=${summary.maxRttMs}ms loss<=${summary.maxLossPct}% poor=${summary.poorSamples} maxBitrate=${encoding.maxBitrate} maxFramerate=${encoding.maxFramerate}`);
    }

    // One link turns bad and comes back.
    arm({ ...allFast, P2: "moderate" });
    const impairedSampler = startAdaptationSampler(roles);
    await delay(20000);
    const impaired = await impairedSampler.stop();
    const impairedSummaries = Object.fromEntries(roles.map((role) =>
      [role, summarizeAdaptationTimeline(impaired.timeline.get(role))]));
    // Without this the return-to-top check below would pass on a window that
    // never bit: the moderate tier's RTT alone (~400 ms) is past the poor bar.
    assert.ok(impairedSummaries.P2.minLevel < topAutomaticLevel,
      `the moderate window never stepped P2's ladder down: ${formatAdaptationTimeline(impaired.timeline.get("P2"))}`);
    // One bad uplink must not drag the fast participants: each still has two
    // clean inbound streams, so its own-link estimate (the per-stream
    // minimum) stays clean and its ladder holds the top level. This is the
    // contrast case for one-fast-three-bad-uplinks, where no clean stream is
    // left and B1 steps the good participant down.
    for (const role of roles.filter((item) => item !== "P2")) {
      const samples = impaired.timeline.get(role);
      assert.ok(samples.length >= 10, `${role} produced only ${samples.length} ladder samples in P2's moderate window`);
      assert.equal(impairedSummaries[role].minLevel, topAutomaticLevel,
        `${role} on the fast tier stepped down while only P2's link was moderate: ${formatAdaptationTimeline(samples)}`);
      assert.equal(impairedSummaries[role].suspendedSamples, 0,
        `${role} on the fast tier paused its video while only P2's link was moderate: ${formatAdaptationTimeline(samples)}`);
    }
    console.log(`[fast] P2 on moderate for 20s — min Auto levels: ${roles.map((role) =>
      `${role}=${impairedSummaries[role].minLevel}${impairedSummaries[role].suspendedSamples ? "(paused)" : ""}`).join(" ")}`);
    arm(allFast);
    await Promise.all(roles.map((role) =>
      waitForTopAutomaticLevel(role, 90000, "after P2's moderate window lifted")));
    for (const role of roles) {
      const encoding = await cameraSenderEncoding(pages.get(role));
      assert.equal(encoding?.maxBitrate, expectedTopBitrate,
        `${role}'s camera sender did not return to the top Auto profile's bitrate after the lift`);
    }
    console.log("[fast] all four ladders returned to the top Auto level after the moderate window lifted");
    // Each browser's RTCP (mostly transport-cc feedback) and STUN. ~25-50 a
    // second is normal; when the SFU forwarded its publishers' transport-cc
    // numbers instead of stamping its own, a receiver saw unrelated counters
    // interleaved and sent thousands a second, saturating this tier late in
    // full runs (B15 in docs/network-testing.md).
    const feedbackRates = packetCounterRates(packetCountersAtArm, await roomPacketCounters());
    console.log(`[fast] non-RTP packets per second per browser over the scenario ${JSON.stringify(feedbackRates)}`);
    for (const role of roles) {
      assert.ok(feedbackRates[role] !== null && feedbackRates[role] < 200,
        `${role} sent ${feedbackRates[role]} non-RTP packets a second on the fast tier: a transport-cc feedback flood (B15)`);
    }
  } catch (error) {
    snapshots.push(hostAndTierSnapshot("failure"));
    // What fills the tier: each browser's packet counters per connection
    // (transport totals against RTP audio/video and retransmissions; the
    // difference is RTCP and STUN), and the SFU's own counters.
    const counters = await roomPacketCounters();
    const rates = packetCountersAtArm ? packetCounterRates(packetCountersAtArm, counters) : null;
    console.log(`[fast] at failure: non-RTP packets per second per browser since the tier was armed ${JSON.stringify(rates)}`);
    recordEvidence("fast-tier-diagnostics", { snapshots, packetCountersAtArm, counters, rates });
    const failure = snapshots.at(-1);
    console.log(`[fast] at failure: load ${failure.loadavg.map((value) => value.toFixed(1)).join("/")}, ${failure.freeMemMB} MB free; tiers:\n${failure.tierStats}\n${failure.processes}`);
    throw error;
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  await assertMedia();
}

// The hard room mix: ONE good link and three bad UPLINKS. P1 sits on the
// fast tier; P2 (moderate), P3 (severe), and P4 (moderate, on its own class)
// are impaired in both directions, so — unlike all-distinct-qualities, where
// the capped participant is downlink-only and still publishes cleanly — P1
// has no clean inbound stream at all. Hard guarantees: audio keeps flowing
// for everyone and from every bad publisher to P1, P1's camera reaches each
// bad participant as a trickle or a visible degradation reaction, every bad
// camera reads as degraded on P1, the severe participant leaving does not
// disturb P1's connection, its audio, or its remaining streams, and the room
// recovers when the tiers lift.
async function scenarioOneFastThreeBadUplinks() {
  const tag = "one-fast-three-bad";
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await clearStaleVideoSuspensions();
  const tierByRole = { P1: "fast", P2: "moderate", P3: "severe", P4: "moderate-2" };
  const badRoles = ["P2", "P3", "P4"];
  const p1 = pages.get("P1");
  let armer;
  let sampler;
  let b1Evidence = null;
  installRoomQdisc();
  try {
    // P1 starts from the top of the ladder on its fast link, so the sampled
    // timeline below reads from a known state.
    armer = armParticipantTiers({ P1: "fast" });
    await waitForShapedLink("P1", 15);
    await restartAutomaticLadders();
    await waitForTopAutomaticLevel("P1", 45000, "on the fast tier before the three uplinks turned bad");

    armer.stopped = true;
    clearRoomProfiles();
    installRoomQdisc();
    armer = armParticipantTiers(tierByRole);
    const impairedAt = Date.now();
    sampler = startAdaptationSampler(roles);
    await delay(15000);

    // Audio flows everywhere — polled for flow, as in every impaired room.
    for (const role of roles) {
      await waitForAudioFlow(pages.get(role), `${role} receiving audio with three bad uplinks in the room`);
    }
    // ...and P1 hears each of the three bad publishers, not just one of them.
    await waitForAdvancingAudioStreams(p1, badRoles.length,
      "P1 receiving audio from each of the three bad publishers", 60000);
    // P1's camera reaches every bad participant at their tier's rate or as
    // the degradation reaction.
    for (const role of badRoles) await assertCameraTrickleOrDegraded(role, 0, tag);
    // Every bad camera reads as degraded on the good participant.
    for (const role of badRoles) {
      const participantID = await participantIDFor(p1, names[roles.indexOf(role)]);
      await waitForDegradedCameraTile([p1], participantID);
      console.log(`[${tag}] ${role}'s camera degraded on P1`);
    }
    // Keep the three-bad-uplinks window open long enough for the sampled
    // timeline to show P1's whole reaction before the room changes shape.
    const remaining = 40000 - (Date.now() - impairedAt);
    if (remaining > 0) await delay(remaining);

    // Only the severe participant leaves (leaveSharedRoom would drain the
    // whole room). P1 must keep its peer connection and its signaling socket,
    // keep sending audio, and keep receiving both remaining publishers.
    const identityBefore = await connectionIdentity(p1);
    const audioSentBefore = (await pageMediaSnapshot(p1)).audioSent;
    const p3 = pages.get("P3");
    await p3.locator("#leave").click();
    await p3.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
    pages.delete("P3");
    sampler.mark("P3 left");
    await delay(2000);
    const remainingNames = [names[0], names[1], names[3]];
    for (const page of pages.values()) await roster(page, remainingNames);
    await waitForAdvancingAudioStreams(p1, 2, "P1 receiving audio from both remaining publishers after P3 left");
    for (const role of ["P2", "P4"]) await assertCameraTrickleOrDegraded("P1", roles.indexOf(role), tag);
    const identityAfter = await connectionIdentity(p1);
    assert.deepEqual(identityAfter, { ...identityBefore, state: "connected" },
      "P3 leaving rebuilt P1's peer connection or reconnected its signaling socket");
    assert.ok((await pageMediaSnapshot(p1)).audioSent > audioSentBefore,
      "P1's outbound audio stalled when P3 left");
    console.log(`[${tag}] P3 left alone: P1 kept its peer connection, its audio, and both remaining streams`);
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
    if (sampler) {
      const sampled = await sampler.stop();
      // B1: the client estimates its own link as the minimum per-stream
      // inbound loss (selectOwnLinkMeasurements). With three lossy remote
      // uplinks there is no clean inbound stream, so P1 — on the fast tier,
      // with a clean uplink — read 20-70 % own-link loss, stepped 3 -> 0 in
      // about 5 s and paused its camera for the rest of the window. Most of
      // that loss is created at the SFU (late retransmissions over a slow
      // uplink are never forwarded), and the SFU now relays its measurement
      // of it per sender (source_quality) for P1 to discount. P1's
      // profileLevel / videoSuspended / networkQuality timeline is sampled
      // here; after the samples, the pause is asserted and the level logged.
      const p1Samples = sampled.timeline.get("P1");
      const p3LeftAtSec = sampled.marks.find((mark) => mark.label === "P3 left")?.t ?? null;
      const beforeP3Left = p3LeftAtSec == null ? p1Samples : p1Samples.filter((sample) => sample.t < p3LeftAtSec);
      const p1Levels = beforeP3Left.map((sample) => sample.level).filter((level) => Number.isFinite(level));
      const evidence = {
        issue: "B1", asserted: true, tiers: tierByRole, p3LeftAtSec,
        p1ThreeBadUplinks: {
          ...summarizeAdaptationTimeline(beforeP3Left),
          stepDowns: p1Levels.filter((level, index) => index > 0 && level < p1Levels[index - 1]).length,
          samplesAtTop: p1Levels.filter((level) => level === topAutomaticLevel).length,
          levelSamples: p1Levels.length
        },
        p1WholeWindow: summarizeAdaptationTimeline(p1Samples),
        marks: sampled.marks,
        timeline: Object.fromEntries(sampled.timeline)
      };
      b1Evidence = evidence;
      recordEvidence("b1-own-link-evidence", evidence);
      console.log(`[${tag}] B1 evidence (pause, step count, final level and time at the top asserted) — P1 on the fast tier with three bad uplinks: ${JSON.stringify(evidence.p1ThreeBadUplinks)}; P3 left at ${p3LeftAtSec}s; whole window: ${JSON.stringify(evidence.p1WholeWindow)}`);
      console.log(`[${tag}] P1 own-link timeline (seconds:Level[P=paused][!critical ~poor +good .neither]loss%): ${formatAdaptationTimeline(p1Samples)}`);
    }
  }
  // The evidence must exist: a sampler that silently read nothing would leave
  // B1 unobserved. The three-bad-uplinks window is held open for 40 s.
  assert.ok(b1Evidence && b1Evidence.p1ThreeBadUplinks.samples >= 20,
    `the B1 evidence sampler recorded only ${b1Evidence?.p1ThreeBadUplinks.samples ?? 0} P1 samples before P3 left`);
  // B1: the SFU relays what each bad sender's streams lose before it forwards
  // them (source_quality), and P1 discounts that from its own-link estimate,
  // so P1 — on the fast tier — must keep sending its camera. It used to pause
  // it for most of the window.
  assert.equal(b1Evidence.p1ThreeBadUplinks.suspendedSamples, 0,
    `P1 on the fast tier paused its camera in ${b1Evidence.p1ThreeBadUplinks.suspendedSamples} samples with three bad uplinks (B1)`);
  // Not pausing is not enough: P1 could sit at a low level for the whole
  // window and still never pause. The SFU measures what each bad sender's
  // streams lose and queue before it forwards them, including its window in
  // progress, and the hub pushes that every 250 ms (worsenings at once), so
  // P1's samples are discounted from the first impaired second: five runs
  // never stepped down and held the top for every sample (39/39, 39/39,
  // 40/40, 40/40, 40/40). Before the window in progress and the push, one
  // early step and 28-39 of 39; with the senders' own reports, 9-40 of 40.
  // The bar sits about ten points under the worst run.
  const p1Window = b1Evidence.p1ThreeBadUplinks;
  assert.equal(p1Window.stepDowns, 0,
    `P1 on the fast tier stepped its ladder down ${p1Window.stepDowns} times with three bad uplinks (B1)`);
  assert.equal(p1Window.finalLevel, topAutomaticLevel,
    `P1 on the fast tier ended the three-bad-uplinks window at level ${p1Window.finalLevel}, not ${topAutomaticLevel} (B1)`);
  const p1TopShare = p1Window.levelSamples ? p1Window.samplesAtTop / p1Window.levelSamples : 0;
  console.log(`[${tag}] P1 at level ${topAutomaticLevel} in ${p1Window.samplesAtTop} of ${p1Window.levelSamples} samples with three bad uplinks`);
  assert.ok(p1TopShare >= 0.9,
    `P1 on the fast tier was at level ${topAutomaticLevel} in only ${p1Window.samplesAtTop} of ${p1Window.levelSamples} samples with three bad uplinks (B13 needs 90 %)`);

  // Recovery. The cameras that were live through the window return first —
  // P1's own camera included, since B1 may have paused it — then a fresh
  // browser takes the seat P3 freed.
  const present = ["P1", "P2", "P4"];
  for (const observer of present) {
    for (const sender of present) {
      if (observer === sender) continue;
      const participantID = await participantIDFor(pages.get(observer), names[roles.indexOf(sender)]);
      await waitForTileState(pages.get(observer), participantID, "camera", "on", 90000);
    }
  }
  await join("P3");
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  for (const page of pages.values()) await roster(page, names);
  const p3ID = await participantIDFor(p1, names[2]);
  await waitForTileState(p1, p3ID, "camera", "on", 90000);
  // On the healed room P1's ladder must be back at the top whatever B1 did
  // to it during the window.
  await waitForTopAutomaticLevel("P1", 90000, "after the three bad uplinks lifted");
  for (const role of roles) {
    await waitForAudioFlow(pages.get(role), `${role} receiving audio after the three bad uplinks lifted`);
  }
  console.log(`[${tag}] the room recovered after the tiers were lifted and P3 rejoined`);
  await assertMedia();
}

// Nobody has a good link: all four participants on the moderate link quality
// at once, each on a class of its own (200 kbit, 200 ms, 8% loss in both
// directions — so every stream crosses two impaired hops and no participant
// has a clean reference stream). Audio must keep flowing for everyone, the
// impairment must degrade the room without turning into a peer-rebuild
// storm, and every camera and ladder must recover when the tiers lift.
// One participant's own download loses 12 % (no rate cap, ~10 ms, clean
// uplink) while the other three send over uploads that lose 10 %. Receivers
// discount each inbound stream by what the SFU measured its sender losing;
// this proves that discount does not also cancel the receiver's own loss: P1
// must still read its link as poor and step its ladder down. The senders are
// bad but working: with uplinks near an outage (the moderate tier's shared
// queue makes their audio lose 60-85 %) their few surviving packets cannot
// reveal a receiver's own 12 %, and the own-link estimate skips them
// (selectOwnLinkMeasurements, maxSenderLossPct).
async function scenarioBadDownlinkAmongBadSenders() {
  const tag = "bad-downlink-bad-senders";
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await clearStaleVideoSuspensions();
  const tierByRole = { P1: "lossy-downlink", P2: "lossy-uplink", P3: "lossy-uplink", P4: "lossy-uplink" };
  const p1 = pages.get("P1");
  let armer;
  let sampler;
  let evidence = null;
  installRoomQdisc({ include: ["lossy-downlink", "lossy-uplink"] });
  try {
    // P1 starts at the top of its ladder, so a step down is observable.
    await restartAutomaticLadders();
    await waitForTopAutomaticLevel("P1", 45000, "on a clean link before its download turned lossy");
    armer = armParticipantTiers(tierByRole);
    const impairedAt = Date.now();
    sampler = startAdaptationSampler(roles);
    for (const role of roles) {
      await waitForAudioFlow(pages.get(role), `${role} receiving audio with every link impaired`);
    }
    await waitForAdvancingAudioStreams(p1, 3, "P1 receiving audio from each of the three lossy publishers", 60000);
    const remaining = 40000 - (Date.now() - impairedAt);
    if (remaining > 0) await delay(remaining);
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
    if (sampler) {
      const sampled = await sampler.stop();
      const p1Samples = sampled.timeline.get("P1");
      // The first seconds belong to the tiers arming.
      const settled = p1Samples.filter((sample) => sample.t >= 5);
      const serverLoss = serverDownlinkLoss(sampled, roles);
      evidence = {
        tiers: tierByRole,
        summary: summarizeAdaptationTimeline(settled),
        samples: settled.length,
        lossyOwnSamples: settled.filter((sample) => Number.isFinite(sample.lossPct) && sample.lossPct > 5).length,
        serverSourcedSamples: settled.filter((sample) => sample.ownLinkSource === "server").length,
        serverLoss,
        timeline: Object.fromEntries(sampled.timeline)
      };
      recordEvidence("own-downlink-evidence", evidence);
      console.log(`[${tag}] P1 own link with a lossy download among three bad senders: ${JSON.stringify(evidence.summary)}; own loss above 5 % in ${evidence.lossyOwnSamples} of ${evidence.samples} samples, ${evidence.serverSourcedSamples} from the SFU's measurement; SFU-measured download loss ${JSON.stringify(serverLoss)}`);
      console.log(`[${tag}] P1 own-link timeline (seconds:Level[P=paused][!critical ~poor +good .neither]loss%): ${formatAdaptationTimeline(p1Samples)}`);
    }
  }
  assert.ok(evidence && evidence.samples >= 20,
    `the sampler recorded only ${evidence?.samples ?? 0} P1 samples in the impaired window`);
  // The discount must leave P1's own 12 % loss visible. Pooling the reported
  // streams and narrowing the SFU's report to its last window: 27, 29 and 26
  // of 35 samples; before, with the minimum over streams and the worst of
  // three windows, 0-1 of 35. The bar sits about ten points under the worst.
  const lossyShare = evidence.lossyOwnSamples / evidence.samples;
  assert.ok(lossyShare >= 0.6,
    `P1's own lossy download showed as own loss in only ${evidence.lossyOwnSamples} of ${evidence.samples} samples: the sender discount hid it`);
  assert.ok(evidence.summary.minLevel < topAutomaticLevel,
    `P1 never stepped its ladder down on a download losing 12 % (own loss above 5 % in ${evidence.lossyOwnSamples} of ${evidence.samples} samples)`);
  // The SFU measures each download from that participant's transport-cc
  // feedback, with nothing of the senders' uplinks in it: P1's reads the
  // tier's 12 % (before NACK repair), the clean downloads read about 0 even
  // though every packet they receive crossed a lossy uplink, and P1's
  // adaptation uses that measurement rather than its estimate.
  assert.ok(evidence.serverLoss.P1.samples >= 10 &&
    evidence.serverLoss.P1.medianPct >= 8 && evidence.serverLoss.P1.medianPct <= 16,
    `the SFU measured P1's 12 % download as ${JSON.stringify(evidence.serverLoss.P1)}`);
  for (const role of ["P2", "P3", "P4"]) {
    assert.ok(evidence.serverLoss[role].samples >= 10 && evidence.serverLoss[role].medianPct < 3,
      `the SFU measured ${role}'s clean download as ${JSON.stringify(evidence.serverLoss[role])}`);
  }
  assert.ok(evidence.serverSourcedSamples >= evidence.samples * 0.8,
    `P1's own link came from the SFU's measurement in only ${evidence.serverSourcedSamples} of ${evidence.samples} samples`);

  // Recovery: every ladder back at the top and audio everywhere.
  await Promise.all(roles.map((role) =>
    waitForTopAutomaticLevel(role, 90000, "after the impaired links lifted")));
  for (const role of roles) {
    await waitForAudioFlow(pages.get(role), `${role} receiving audio after the impaired links lifted`);
  }
  await assertMedia();
}

// One participant's download loses 12 % at a 10 ms delay and carries only
// video: the other three, on clean links, send no audio. Every lost packet is
// then resent within one round trip, and the SFU must still measure the loss.
// A resend that repeated the lost packet's transport-wide number made the
// browser report that number as arrived, and the loss disappeared. A download
// with audio in it cannot show that: a receiver this lossy takes the low
// camera layers, so most of its packets are audio, which is never resent.
async function lossyDownlinkCleanSenders(receiver, tag) {
  const senders = roles.filter((role) => role !== receiver);
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await clearStaleVideoSuspensions();
  let armer;
  let sampler;
  let evidence = null;
  installRoomQdisc({ include: ["lossy-downlink"] });
  try {
    await restartAutomaticLadders();
    await Promise.all(roles.map((role) =>
      waitForTopAutomaticLevel(role, 60000, `on a clean link before ${receiver}'s download turned lossy`)));
    for (const role of senders) await detachMicrophone(pages.get(role));
    armer = armParticipantTiers({ [receiver]: "lossy-downlink" });
    sampler = startAdaptationSampler(roles);
    await delay(40000);
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
    for (const role of senders) await reattachMicrophone(pages.get(role));
    if (sampler) {
      const sampled = await sampler.stop();
      const receiverSamples = sampled.timeline.get(receiver);
      // The first seconds belong to the tier arming.
      const settled = receiverSamples.filter((sample) => sample.t >= 5);
      evidence = {
        engines: Object.fromEntries(browserNames),
        receiver,
        summary: summarizeAdaptationTimeline(settled),
        samples: settled.length,
        serverSourcedSamples: settled.filter((sample) => sample.ownLinkSource === "server").length,
        inbound: inboundLossByKind(settled),
        serverLoss: serverDownlinkLoss(sampled, roles),
        timeline: Object.fromEntries(sampled.timeline)
      };
      recordEvidence(`${tag}-evidence`, evidence);
      console.log(`[${tag}] ${receiver}'s lossy download (${browserNames.get(receiver)}): ${JSON.stringify(evidence.summary)}; its browser's inbound streams ${JSON.stringify(evidence.inbound)}; SFU-measured download loss ${JSON.stringify(evidence.serverLoss)}; ${evidence.serverSourcedSamples} of ${evidence.samples} samples from the SFU's measurement`);
      console.log(`[${tag}] ${receiver} own-link timeline (seconds:Level[P=paused][!critical ~poor +good .neither]loss%): ${formatAdaptationTimeline(receiverSamples)}`);
    }
  }
  const measured = evidence?.serverLoss[receiver];
  assert.ok(measured && measured.samples >= 10,
    `the SFU measured ${receiver}'s download in only ${measured?.samples ?? 0} samples`);
  // With audio in the download the resends are too few to prove anything.
  assert.ok(evidence.inbound.video.received > 10 * evidence.inbound.audio.received,
    `${receiver}'s download was not only video, so this run cannot show what resends hide: ${JSON.stringify(evidence.inbound)}`);
  // Ten runs: 10.9-15.6 % (the worse of two windows of about 50 packets reads
  // a little over the 12 %) and no jitter. With resends repeating the lost
  // packets' numbers: 4.8, 4.8 and 10.3 %, and 7, 7 and 14 ms, because a
  // repair that arrives before the first feedback reads as a late packet.
  assert.ok(measured.medianPct >= 8 && measured.medianPct <= 19,
    `the SFU measured ${receiver}'s 12 % download as ${JSON.stringify(measured)}`);
  assert.ok(measured.medianJitterMs <= 3,
    `the SFU measured jitter on a download that has none: ${JSON.stringify(measured)}`);
  for (const role of senders) {
    assert.ok(evidence.serverLoss[role].samples >= 10 && evidence.serverLoss[role].medianPct < 3,
      `the SFU measured ${role}'s clean download as ${JSON.stringify(evidence.serverLoss[role])}`);
  }
  assert.ok(evidence.serverSourcedSamples >= evidence.samples * 0.8,
    `${receiver}'s own link came from the SFU's measurement in only ${evidence.serverSourcedSamples} of ${evidence.samples} samples`);
  await Promise.all(roles.map((role) =>
    waitForTopAutomaticLevel(role, 90000, `after ${receiver}'s download recovered`)));
  await assertMedia();
}

async function scenarioLossyDownlinkCleanSenders() {
  await lossyDownlinkCleanSenders("P1", "lossy-downlink-clean-senders");
}

// The same with a Firefox receiver, whose transport-cc feedback, resends and
// stats are its own. Run with MEDIA_E2E_FOUR_ENGINES=mixed (P2 and P4 are
// Firefox).
async function scenarioLossyDownlinkCleanSendersFirefox() {
  assert.equal(browserNames.get("P2"), "firefox",
    "lossy-downlink-clean-senders-firefox needs MEDIA_E2E_FOUR_ENGINES=mixed, which puts P2 on Firefox");
  await lossyDownlinkCleanSenders("P2", "lossy-downlink-clean-senders-firefox");
}

async function scenarioAllFourImpaired() {
  const tag = "all-impaired";
  // A rebuild or two per participant is the recovery machinery working on a
  // link this bad; a storm is the same peer being torn down over and over.
  const maxRebuildsPerParticipant = 2;
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await clearStaleVideoSuspensions();
  await restartAutomaticLadders();
  const tierByRole = { P1: "moderate", P2: "moderate-2", P3: "moderate-3", P4: "moderate-4" };
  const identityBefore = new Map();
  for (const role of roles) identityBefore.set(role, await connectionIdentity(pages.get(role)));
  installRoomQdisc();
  let armer;
  let sampler;
  try {
    armer = armParticipantTiers(tierByRole);
    const impairedAt = Date.now();
    sampler = startAdaptationSampler(roles);
    await delay(20000);
    // Per publisher: the pooled waitForAudioFlow would pass on one live
    // sender while the other two are silent.
    for (const role of roles) {
      await waitForAdvancingAudioStreams(pages.get(role), roles.length - 1,
        `${role} receiving audio from each of the three other impaired publishers`, 60000);
    }
    const remaining = 40000 - (Date.now() - impairedAt);
    if (remaining > 0) await delay(remaining);
    const sampled = await sampler.stop();
    sampler = null;
    for (const role of roles) {
      const samples = sampled.timeline.get(role);
      const summary = summarizeAdaptationTimeline(samples);
      const identity = await connectionIdentity(pages.get(role));
      const rebuilds = identity.peers - identityBefore.get(role).peers;
      console.log(`[${tag}] ${role} over the impaired window: ${JSON.stringify(summary)} rebuilds=${rebuilds} reconnects=${identity.sockets - identityBefore.get(role).sockets} peer=${identity.state}`);
      // The tier must have bitten on every participant's own link (its RTT
      // alone, ~400 ms, is past the poor bar), or the room was not impaired.
      assert.ok(summary.poorSamples > 0,
        `${role}'s own link never read as poor with all four links impaired: ${formatAdaptationTimeline(samples)}`);
      assert.ok(rebuilds <= maxRebuildsPerParticipant,
        `${role} rebuilt its peer connection ${rebuilds} times in the impaired window (a rebuild storm)`);
    }
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
    if (sampler) await sampler.stop();
  }

  // Recovery: every camera returns on every other browser, no participant
  // stays suspended, and audio flows room-wide.
  for (const observer of roles) {
    for (const sender of roles) {
      if (observer === sender) continue;
      const participantID = await participantIDFor(pages.get(observer), names[roles.indexOf(sender)]);
      await waitForTileState(pages.get(observer), participantID, "camera", "on", 90000);
    }
  }
  // ...and every ladder climbs back to the top Auto level (which also means
  // the camera is no longer suspended): the moderate window never offers a
  // transport-healthy sample, so no climb fails and the back-off stays at its
  // base, leaving 0 -> 3 well inside the bound.
  await Promise.all(roles.map((role) =>
    waitForTopAutomaticLevel(role, 90000, "after the four impaired links lifted")));
  for (const role of roles) {
    await waitForAudioFlow(pages.get(role), `${role} receiving audio after the four impaired links lifted`);
  }
  console.log(`[${tag}] every camera and ladder recovered after the four impaired links were lifted`);
  await assertMedia();
}

// --- Opt-in resilience scenarios ---------------------------------------------
//
// Grouped "resilience" / "resilience-slow": never part of a default or CI
// selection (see scenarioFilter). Each one proves its fault reached the
// participant (class counters, relay byte counts, or the isolation filters)
// and asserts recovery per pair with assertFullMeshMedia.

const { startSignalingRelay } = require("./signaling-relay");

const offlineText = "Offline. Select Leave to try again.";

async function currentPeerState(page) {
  return page.evaluate(async () => {
    const peers = window.__slowMeetTest?.peerConnections || [];
    const peer = peers.at(-1);
    if (!peer) return { count: 0 };
    const ports = [];
    let pair = null;
    try {
      const report = await peer.getStats();
      const byID = new Map([...report.values()].map((stat) => [stat.id, stat]));
      report.forEach((stat) => {
        if (stat.type === "local-candidate" && stat.port) ports.push(Number(stat.port));
        if (stat.type === "transport" && stat.selectedCandidatePairId) {
          const selected = byID.get(stat.selectedCandidatePairId);
          const local = selected && byID.get(selected.localCandidateId);
          if (local) pair = { candidateType: local.candidateType, protocol: local.protocol, relayProtocol: local.relayProtocol || null, port: local.port };
        }
      });
    } catch (_) {}
    return { count: peers.length, probePeers: window.__slowMeetTest.probePeers.length, state: peer.connectionState, ports, pair,
      sockets: window.__slowMeetTest.sockets.length,
      socketOpen: window.__slowMeetTest.sockets.at(-1)?.readyState === WebSocket.OPEN };
  });
}

async function waitForCurrentPeerConnected(page, label, timeoutMs) {
  await page.waitForFunction(() => {
    const peer = (window.__slowMeetTest?.peerConnections || []).at(-1);
    return Boolean(peer) && peer.connectionState === "connected";
  }, null, { timeout: timeoutMs }).catch(async () => {
    assert.fail(`${label}: the current peer connection never reached connected within ${timeoutMs} ms (${JSON.stringify(await currentPeerState(page))})`);
  });
}

async function isOffline(page) {
  return page.evaluate((text) => document.body.innerText.includes(text), offlineText);
}

// Audio bytes from one sender's tile grow on the observer within timeoutMs.
async function waitForSenderAudio(observerRole, senderRole, label, timeoutMs = 20000) {
  const observer = pages.get(observerRole);
  const id = await participantIDFor(observer, names[roles.indexOf(senderRole)]);
  const deadline = Date.now() + timeoutMs;
  let previous = await tileAudioBytes(observer, id);
  while (Date.now() < deadline) {
    await delay(1000);
    const current = await tileAudioBytes(observer, id);
    if (previous >= 0 && current > previous) return;
    previous = current;
  }
  assert.fail(`${label}: ${observerRole} received no audio from ${senderRole} within ${timeoutMs} ms`);
}

async function assertRoomKeepsTalking(roleList, label) {
  for (const observer of roleList) {
    for (const sender of roleList) {
      if (sender !== observer) await waitForSenderAudio(observer, sender, label);
    }
  }
}

async function identities(observerRole) {
  const page = pages.get(observerRole);
  const result = {};
  for (const name of names) result[name] = await participantIDFor(page, name).catch(() => null);
  return result;
}

// Takes one participant's browser out of the room entirely.
async function retireParticipant(role) {
  const page = pages.get(role);
  if (!page) return;
  if (await page.locator("#meeting").isVisible().catch(() => false)) {
    await page.locator("#leave").click({ timeout: 5000 }).catch(() => {});
    await page.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 }).catch(() => {});
  }
  const context = page.context();
  const browser = context.browser();
  traces.delete(context);
  await context.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  const contextIndex = contexts.indexOf(context);
  if (contextIndex >= 0) contexts.splice(contextIndex, 1);
  const browserIndex = browsers.indexOf(browser);
  if (browserIndex >= 0) browsers.splice(browserIndex, 1);
  pages.delete(role);
  events.delete(role);
}

async function enableCamera(page) {
  if (await page.locator("#camera").getAttribute("aria-pressed") !== "true") await page.locator("#camera").click();
  await page.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
}

// Runs fn with one participant re-joined through its own signaling relay,
// then puts the participant back on a direct connection.
async function withRelayedParticipant(role, fn) {
  const relay = await startSignalingRelay({ target: server.url });
  await retireParticipant(role);
  for (const page of pages.values()) await roster(page, names.filter((_, index) => roles[index] !== role));
  await delay(reconnectGraceSeconds * 1000 + 1000);
  await createParticipant(role, names[roles.indexOf(role)], false, false, { baseURL: relay.url });
  await enableCamera(pages.get(role));
  await unmuteAllForAudioGuarantee();
  for (const page of pages.values()) await roster(page, names);
  try {
    return await fn(relay);
  } catch (error) {
    // The failure report is written after this participant is put back on a
    // direct connection, so keep the relayed page's own state here.
    const page = pages.get(role);
    if (page) {
      recordEvidence(`relayed-${role}-at-failure`, {
        peer: await currentPeerState(page).catch((cause) => ({ error: cause.message })),
        offline: await isOffline(page).catch(() => null),
        tiles: await page.evaluate(() => [...document.querySelectorAll("li[data-participant-id]")].map((tile) => ({
          id: tile.dataset.participantId, name: tile.textContent.slice(0, 20), camera: tile.dataset.camera,
          connection: tile.dataset.connection, audioTrack: Boolean(tile.querySelector("audio")?.srcObject?.getAudioTracks?.().length)
        }))).catch(() => []),
        socketEvents: await page.evaluate(() => (window.__slowMeetTest?.socketEvents || []).slice(-80)).catch(() => []),
        socketCreates: await page.evaluate(() => window.__slowMeetTest?.socketCreates || []).catch(() => []),
        peerStates: await page.evaluate(() => window.__slowMeetTest?.peerStates || []).catch(() => []),
        console: (events.get(role) || []).slice(-60)
      });
    }
    throw error;
  } finally {
    recordEvidence(`relay-${role}`, relay.stats());
    await retireParticipant(role);
    await relay.close();
    await delay(reconnectGraceSeconds * 1000 + 1000);
    await join(role);
    await enableCamera(pages.get(role));
  }
}

async function screenDecodesOn(page, label, timeoutMs = 30000) {
  await page.waitForFunction(() => [...document.querySelectorAll("li[data-sharing='true'] video.screen-video")]
    .some((video) => video.videoWidth > 0 && video.currentTime > 0), null, { timeout: timeoutMs })
    .catch(() => assert.fail(`${label}: the shared screen never decoded`));
}

async function noSharerOn(page, label, timeoutMs = 15000) {
  await page.waitForFunction(() => ![...document.querySelectorAll("li[data-participant-id]")]
    .some((tile) => tile.dataset.sharing === "true"), null, { timeout: timeoutMs })
    .catch(() => assert.fail(`${label}: a tile still shows a live share`));
}

// The share owner's signaling drops and resumes inside the grace window: the
// share must end cleanly for every viewer (no frozen tile left "sharing"),
// the lease must be free for someone else, and the owner can share again.
async function runSharerReconnectMidShare(impaired) {
  await setupRoom();
  const sharerRole = "P3";
  const sharer = pages.get(sharerRole);
  const viewers = roles.filter((role) => role !== sharerRole);
  const before = await identities("P1");
  let armer;
  if (impaired) {
    installRoomQdisc();
    armer = armParticipantTiers({ [sharerRole]: "moderate" });
    await delay(8000);
  }
  try {
    await sharer.locator("#screen").click();
    await waitForScreenButton(sharer, "true");
    for (const page of pages.values()) await assertSingleSharer(page, names[2]);
    // On a 200 kbit uplink the share need not decode (impaired-sharer-screen-
    // share asserts decoding only after the lift); the lease is what counts.
    if (!impaired) {
      for (const role of viewers) await screenDecodesOn(pages.get(role), `${role} before the reconnect`);
    }
    const socketCount = await sharer.evaluate(() => window.__slowMeetTest.sockets.length);
    await sharer.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "sharer reconnect mid-share"));
    await sharer.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
      window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
    for (const page of pages.values()) await roster(page, names);
    assert.equal((await identities("P1"))[names[2]], before[names[2]], "the sharer resumed under a new identity");
    for (const role of viewers) await noSharerOn(pages.get(role), `${role} after the sharer's reconnect`);
    await waitForScreenButton(sharer, "false");
  } finally {
    if (armer) armer.stopped = true;
    if (impaired) clearRoomProfiles();
  }
  // The lease is free: someone else can share, and then the owner again.
  const other = pages.get("P2");
  await other.locator("#screen").click();
  await waitForScreenButton(other, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[1]);
  await other.locator("#screen").click();
  await waitForScreenButton(other, "false");
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "true");
  for (const page of pages.values()) await assertSingleSharer(page, names[2]);
  for (const role of viewers) await screenDecodesOn(pages.get(role), `${role} after the owner shares again`);
  await sharer.locator("#screen").click();
  await waitForScreenButton(sharer, "false");
  // Starting a share turns the sharer's camera off and stopping it does not
  // turn it back on (startScreenShare restores it only when the share fails
  // to start), so both sharers switch their cameras back on by hand.
  await enableCamera(other);
  await enableCamera(sharer);
  // The owner resumed mid-share; a camera it turns on afterwards must reach
  // the viewers (B9: it used to land on the receivers' old screen
  // transceivers and never show), so its camera is checked on its own here.
  const sharerID = await participantIDFor(pages.get("P1"), names[2]);
  const framesAt = async () => tileVideoFrames(pages.get("P1"), sharerID);
  const startFrames = await framesAt();
  let sharerCameraFlows = false;
  for (let attempt = 0; attempt < 20 && !sharerCameraFlows; attempt++) {
    await delay(1000);
    sharerCameraFlows = (await framesAt()) > Math.max(0, startFrames) + 5;
  }
  try {
    if (!sharerCameraFlows) {
      recordEvidence("sharer-camera-after-resume", { sharerID, startFrames, endFrames: await framesAt(),
        inbound: await tileInboundRtp(pages.get("P1"), sharerID, "video") });
    }
    assert.ok(sharerCameraFlows, "a camera turned on after a mid-share resume never reached the viewers (B9)");
    // Each viewer's tile for the owner must have the owner's audio bound to it
    // and playing (B11).
    await assertResumedParticipantHeard(sharerRole, "after the sharer reconnect");
    await assertMedia();
  } finally {
    // A share left on would block the next scenario's setup.
    await stopAnyShare();
  }
}

// After a resume every other page must hear the resumed participant: its
// tile has the participant's audio track bound (B11: the resume used to
// leave it unbound, or its audio arrived out of sequence and was dropped),
// and every pair's media flows.
async function assertResumedParticipantHeard(role, label) {
  const others = [...pages.keys()].filter((candidate) => candidate !== role);
  const bound = {};
  for (const observer of others) {
    const page = pages.get(observer);
    bound[observer] = await tileAudioBytes(page, await participantIDFor(page, names[roles.indexOf(role)]));
  }
  if (!Object.values(bound).every((bytes) => bytes >= 0)) recordEvidence(`unbound-audio-${role}`, { role, bound });
  assert.ok(Object.values(bound).every((bytes) => bytes >= 0),
    `after ${role}'s resume some tiles for ${role} have no audio track, so ${role} is not heard (B11): ${JSON.stringify(bound)}`);
  await assertFullMeshMedia({ label });
}

// A share left running (camera disabled while sharing) would block the next
// scenario's setup, so every exit path stops any share still on.
async function stopAnyShare() {
  for (const page of pages.values()) {
    if (await page.locator("#screen").getAttribute("aria-pressed").catch(() => null) === "true") {
      await page.locator("#screen").click().catch(() => {});
      await waitForScreenButton(page, "false").catch(() => {});
    }
  }
}

async function scenarioSharerReconnectMidShare() {
  try { await runSharerReconnectMidShare(false); } finally { await stopAnyShare(); }
}
async function scenarioSharerReconnectMidShareImpaired() {
  try { await runSharerReconnectMidShare(true); } finally { await stopAnyShare(); }
}

// Counts participant_joined events each page received per participant since
// a mark (socketEvents index), keyed by page role.
async function joinedCounts(marks) {
  const counts = {};
  for (const [role, page] of pages) {
    counts[role] = await page.evaluate((mark) => {
      const result = {};
      for (const event of (window.__slowMeetTest?.socketEvents || []).slice(mark)) {
        if (event.direction === "receive" && event.message?.type === "participant_joined" && event.message.participant) {
          result[event.message.participant] = (result[event.message.participant] || 0) + 1;
        }
      }
      return result;
    }, marks[role] || 0);
  }
  return counts;
}

async function socketEventMarks() {
  const marks = {};
  for (const [role, page] of pages) marks[role] = await page.evaluate(() => window.__slowMeetTest.socketEvents.length);
  return marks;
}

// Two, then all four participants lose signaling in the same instant (an
// office Wi-Fi blip, a proxy reload) and resume together.
async function scenarioSimultaneousReconnect() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const before = await identities("P1");
  for (const dropped of [["P2", "P3"], [...roles]]) {
    const marks = await socketEventMarks();
    const counts = {};
    for (const role of dropped) counts[role] = await pages.get(role).evaluate(() => window.__slowMeetTest.sockets.length);
    await Promise.all(dropped.map((role) => pages.get(role).evaluate(() =>
      window.__slowMeetTest.sockets.at(-1).close(4001, "simultaneous reconnect"))));
    for (const role of dropped) {
      await pages.get(role).waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
        window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, counts[role], { timeout: 30000 });
    }
    for (const page of pages.values()) await roster(page, names);
    for (const role of roles) {
      const seen = await identities(role);
      for (const name of names) {
        if (name === names[roles.indexOf(role)]) continue;
        assert.equal(seen[name], before[name], `${role} sees ${name} under a new identity after ${dropped.length} simultaneous resumes`);
      }
    }
    for (const role of dropped) await waitForCurrentPeerConnected(pages.get(role), `${role} after the simultaneous resume`, 45000);
    await delay(2000);
    const joined = await joinedCounts(marks);
    const duplicates = Object.entries(joined).flatMap(([role, byID]) =>
      Object.entries(byID).filter(([, count]) => count > 1).map(([id, count]) => `${role} got participant_joined for ${id} x${count}`));
    knownIssue("B5", duplicates.length === 0,
      `concurrent resumes announced a participant more than once (${duplicates.join("; ")})`, joined);
    await assertFullMeshMedia({ label: `after ${dropped.length} simultaneous resumes` });
  }
}

// The server process restarts under a live room (a deploy, a crash). Every
// browser redials with a token the new process has never seen and must come
// back as a fresh participant; the room ends up whole, with media.
async function scenarioServerRestartRejoin() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const before = await identities("P1");
  const restart = await server.restart({ downMs: 3000 });
  console.log(`[restart] server was down for ${restart.readyAt - restart.stoppedAt} ms`);
  for (const page of pages.values()) {
    await page.waitForFunction((count) => {
      const sockets = window.__slowMeetTest.sockets;
      return sockets.at(-1)?.readyState === WebSocket.OPEN && (sockets.at(-1).__openedAt || 0) > count;
    }, restart.stoppedAt, { timeout: 90000 });
  }
  for (const page of pages.values()) await roster(page, names);
  for (const [role, page] of pages) {
    assert.equal(await isOffline(page), false, `${role} went Offline across a server restart`);
  }
  const after = await identities("P1");
  for (const name of names.slice(1)) {
    assert.notEqual(after[name], before[name], `${name} kept an identity the restarted server could not know`);
  }
  for (const role of roles) await waitForCurrentPeerConnected(pages.get(role), `${role} after the restart`, 60000);
  await assertFullMeshMedia({ label: "after the server restart" });
}

// A participant's current UDP path dies and stays dead (Wi-Fi to a hotspot,
// a NAT rebinding): only the ports it uses now are blackholed, once. The
// client must find a working path on its own, without a reload, keeping its
// identity, while the other three keep talking.
async function scenarioPathChangeAutoIceRestart() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const moverRole = "P3";
  const mover = pages.get(moverRole);
  const before = await identities("P1");
  const deadPorts = await netemTiers.pageLocalIcePorts(mover);
  assert.ok(deadPorts.length > 0, "the moving participant has no live ICE port to kill");
  installRoomQdisc();
  const countersBefore = netemTiers.tierClassCounters();
  const killedAt = Date.now();
  for (const port of deadPorts) netemTiers.applyParticipantTier(port, "blackout");
  console.log(`[path-change] blackholed ${moverRole}'s ports ${deadPorts.join(", ")} for good`);
  try {
    await delay(4000);
    const blackout = netemTiers.classCounterDelta(countersBefore, netemTiers.tierClassCounters(), fourPersonTiers.blackout.classID);
    assert.ok(blackout.dropped >= 20, `the old path's blackout dropped only ${blackout.dropped} packets: the fault never reached it`);
    await assertRoomKeepsTalking(["P1", "P2", "P4"], "while P3's path is dead");
    await mover.waitForFunction(async (dead) => {
      const peer = (window.__slowMeetTest?.peerConnections || []).at(-1);
      if (!peer || peer.connectionState !== "connected") return false;
      const report = await peer.getStats();
      const byID = new Map([...report.values()].map((stat) => [stat.id, stat]));
      for (const stat of report.values()) {
        if (stat.type !== "transport" || !stat.selectedCandidatePairId) continue;
        const local = byID.get(byID.get(stat.selectedCandidatePairId)?.localCandidateId);
        if (local && !dead.includes(Number(local.port))) return true;
      }
      return false;
    }, deadPorts, { timeout: 120000 }).catch(async () =>
      assert.fail(`P3 never moved to a working path while its old one stayed dead (${JSON.stringify(await currentPeerState(mover))})`));
    const recoveredMs = Date.now() - killedAt;
    const state = await currentPeerState(mover);
    recordEvidence("path-change", { deadPorts, recoveredMs, state });
    console.log(`[path-change] P3 recovered on port ${state.pair?.port} after ${recoveredMs} ms (sockets=${state.sockets})`);
    assert.equal(await isOffline(mover), false, "P3 went Offline instead of finding a new path");
  } finally {
    clearRoomProfiles();
  }
  for (const page of pages.values()) await roster(page, names);
  assert.equal((await identities("P1"))[names[2]], before[names[2]], "P3 came back under a new identity");
  await assertFullMeshMedia({ label: "after the path change" });
}

// Shared shape of the "hold a tier, check, lift, check recovery" scenarios.
async function holdTiers({ tierByRole, include = [], holdMs, during }) {
  installRoomQdisc({ include });
  let armer;
  try {
    armer = armParticipantTiers(tierByRole);
    await delay(holdMs);
    await during();
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
}

async function waitForCamerasOn(observerRole, senderRoles, timeoutMs = 90000) {
  const observer = pages.get(observerRole);
  for (const role of senderRoles) {
    const id = await participantIDFor(observer, names[roles.indexOf(role)]);
    await waitForTileState(observer, id, "camera", "on", timeoutMs);
  }
}

// One participant's upload alone is thin and lossy (300 kbit, 8%): the room
// still hears it, its camera degrades for the others instead of freezing
// the room, and its own clean download keeps every other camera sharp.
async function scenarioSlowUplinkRoom() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const p2IDOnP1 = await participantIDFor(pages.get("P1"), names[1]);
  await holdTiers({ tierByRole: { P2: "thin-uplink" }, include: ["thin-uplink"], holdMs: 20000, during: async () => {
    for (const role of ["P1", "P3", "P4"]) await waitForSenderAudio(role, "P2", "P2's audio over a thin uplink");
    await waitForDegradedCameraTile([pages.get("P1"), pages.get("P4")], p2IDOnP1);
    const p2 = pages.get("P2");
    const p1IDOnP2 = await participantIDFor(p2, names[0]);
    const start = await tileVideoFrames(p2, p1IDOnP2);
    await delay(5000);
    const end = await tileVideoFrames(p2, p1IDOnP2);
    assert.ok(end - start >= 25, `P2's clean download decoded only ${end - start} of P1's frames in 5 s: the uplink impairment leaked into its downlink`);
    for (const role of ["P1", "P4"]) {
      const other = role === "P1" ? "P4" : "P1";
      const id = await participantIDFor(pages.get(role), names[roles.indexOf(other)]);
      await waitForTileState(pages.get(role), id, "camera", "on", 10000);
    }
  } });
  await waitForCamerasOn("P1", ["P2"]);
  await assertFullMeshMedia({ label: "after the thin uplink lifts" });
}

// One participant's link loses packets in bursts and reorders and
// duplicates them (congested Wi-Fi). Audio to and from it must keep flowing
// with no long hole, and the room recovers when the link clears.
async function scenarioBurstyLinkRoom() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await startScenarioContinuity();
  let from;
  await holdTiers({ tierByRole: { P4: "bursty" }, include: ["bursty"], holdMs: 2000, during: async () => {
    from = Date.now();
    await delay(20000);
    for (const role of ["P1", "P2", "P3"]) {
      await waitForSenderAudio(role, "P4", "P4's audio over a bursty link");
      await waitForSenderAudio("P4", role, "audio to P4 over a bursty link");
    }
    await evaluateAudioGaps("bursty window", from, Date.now(), 3000);
  } });
  await assertFullMeshMedia({ label: "after the bursty link clears" });
}

// Nobody has a good link, and every link is bad differently: moderate, a
// thin uplink, severe, and a capped downlink, held past the 20-40 s horizon
// where a starved queue kills ICE consent. Everybody keeps hearing
// somebody, nobody is pushed Offline or into a reconnect storm, the severe
// camera degrades, and the room recovers.
async function scenarioAllImpairedRoom() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const socketsBefore = {};
  for (const [role, page] of pages) socketsBefore[role] = await page.evaluate(() => window.__slowMeetTest.sockets.length);
  await holdTiers({ tierByRole: { P1: "moderate", P2: "thin-uplink", P3: "severe", P4: "capped" }, include: ["thin-uplink"],
    holdMs: 40000, during: async () => {
      for (const [role, page] of pages) {
        await waitForAudioFlow(page, `${role} receiving audio with every link impaired`, 30000);
        assert.equal(await isOffline(page), false, `${role} went Offline with every link impaired`);
        const sockets = await page.evaluate(() => window.__slowMeetTest.sockets.length);
        assert.ok(sockets - socketsBefore[role] <= 1, `${role} reconnected its signaling ${sockets - socketsBefore[role]} times under impairment`);
      }
      const p3ID = await participantIDFor(pages.get("P1"), names[2]);
      await waitForDegradedCameraTile([pages.get("P1")], p3ID);
    } });
  await waitForCamerasOn("P1", ["P2", "P3", "P4"]);
  await assertFullMeshMedia({ label: "after every link clears" });
}

// The impaired resume of reconnect-under-impairment, shaped by construction:
// all of P2's UDP — including the ports its resumed peer opens — sits in the
// moderate tier, so the resume's ICE, DTLS and first keyframe all cross the
// bad link. The resume must finish inside the superseded-peer close delay
// (10 s) so the room is not dragged through a renegotiation.
async function scenarioReconnectUnderImpairmentIsolated() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const p2 = pages.get("P2");
  const before = await identities("P1");
  installRoomQdisc();
  const isolation = netemTiers.armRoleUdpIsolation("P2", "moderate", pages);
  try {
    await isolation.ready;
    await delay(8000);
    const countersBefore = netemTiers.tierClassCounters();
    const socketCount = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
    const peerCount = await p2.evaluate(() => window.__slowMeetTest.peerConnections.length);
    const closedAt = Date.now();
    await p2.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "isolated impaired resume"));
    await p2.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
      window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
    await p2.waitForFunction((count) => {
      const peers = window.__slowMeetTest.peerConnections;
      return peers.length > count && peers.at(-1).connectionState === "connected";
    }, peerCount, { timeout: 60000 }).catch(async () =>
      assert.fail(`P2's resumed peer never connected over the moderate link (${JSON.stringify(await currentPeerState(p2))})`));
    const resumeMs = Date.now() - closedAt;
    const moderate = netemTiers.classCounterDelta(countersBefore, netemTiers.tierClassCounters(), fourPersonTiers.moderate.classID);
    recordEvidence("isolated-resume", { resumeMs, moderate, isolationErrors: isolation.errors });
    console.log(`[isolated-resume] P2 resumed in ${resumeMs} ms over the moderate link (moderate sent=${moderate.sentPackets} dropped=${moderate.dropped})`);
    assert.ok(moderate.sentPackets >= 50, `the moderate tier carried only ${moderate.sentPackets} packets during the resume: the handshake was not shaped`);
    expectStrict(resumeMs < 10000, `P2's impaired resume took ${resumeMs} ms, past the 10 s superseded-peer close delay`);
    for (const page of pages.values()) await roster(page, names);
    for (const role of ["P1", "P3", "P4"]) {
      assert.equal((await identities(role))[names[1]], before[names[1]], `${role} sees P2 under a new identity after the resume`);
    }
    await assertRoomKeepsTalking(["P1", "P3", "P4"], "while P2 resumes over a moderate link");
  } finally {
    await isolation.lift();
    clearRoomProfiles();
  }
  await waitForCamerasOn("P1", ["P2"]);
  await assertResumedParticipantHeard("P2", "after the isolated resume");
}

// One participant's link flaps: 2 s up / 2 s down for a minute, then 3 s up
// / 8 s down. The other three must keep talking throughout, and the flapping
// participant must end up connected with its identity, not Offline.
async function scenarioRapidFlapLink() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const before = await identities("P1");
  installRoomQdisc({ include: ["flap"] });
  let armer;
  try {
    armer = armParticipantTiers({ P2: "flap" });
    await delay(4000);
    const fast = netemTiers.flapTier("flap", { onMs: 2000, offMs: 2000, untilMs: 60000 });
    const flapStartedAt = Date.now();
    while (Date.now() - flapStartedAt < 50000) {
      await assertRoomKeepsTalking(["P1", "P3", "P4"], "while P2's link flaps every 2 s");
      await delay(5000);
    }
    await fast.done;
    const slow = netemTiers.flapTier("flap", { schedule: [{ link: {}, ms: 3000 }, { link: { loss: "100%" }, ms: 8000 }], cycles: 3 });
    await assertRoomKeepsTalking(["P1", "P3", "P4"], "while P2's link is mostly down");
    await slow.done;
    recordEvidence("flap", { fast: fast.transitions.length, slow: slow.transitions.length, errors: [...fast.errors, ...slow.errors] });
    assert.ok(fast.transitions.length >= 25, `the fast flap made only ${fast.transitions.length} transitions`);
  } finally {
    if (armer) armer.stopped = true;
    clearRoomProfiles();
  }
  const p2 = pages.get("P2");
  await waitForCurrentPeerConnected(p2, "P2 after the flapping stops", 120000);
  assert.equal(await isOffline(p2), false, "P2 went Offline after its link flapped");
  for (const page of pages.values()) await roster(page, names);
  assert.equal((await identities("P1"))[names[1]], before[names[1]], "P2 came back under a new identity after the flapping");
  await assertResumedParticipantHeard("P2", "after the link stops flapping");
}

// A whole-link outage for one participant: its signaling (through its relay)
// and its media UDP die together, with no FIN and no RST, then return.
async function linkOutage(outageMs) {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await withRelayedParticipant("P2", async (relay) => {
    const p2 = pages.get("P2");
    const before = await identities("P1");
    const p2SocketsBefore = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
    installRoomQdisc();
    const isolation = netemTiers.armRoleUdpIsolation("P2", "blackout", pages);
    let lifted = false;
    try {
      await isolation.ready;
      relay.blackhole();
      const startedAt = Date.now();
      const countersBefore = netemTiers.tierClassCounters();
      while (Date.now() - startedAt < outageMs) {
        await assertRoomKeepsTalking(["P1", "P3", "P4"], "while P2's link is down");
        await delay(Math.min(10000, Math.max(0, outageMs - (Date.now() - startedAt))));
      }
      const blackout = netemTiers.classCounterDelta(countersBefore, netemTiers.tierClassCounters(), fourPersonTiers.blackout.classID);
      const relayStats = relay.stats();
      recordEvidence("outage", { outageMs, blackout, relay: relayStats, isolationErrors: isolation.errors });
      assert.ok(blackout.dropped >= 20, `P2's media blackout dropped only ${blackout.dropped} packets`);
      if (outageMs >= 70000) {
        // Past the hub's 60 s pong deadline the server gives up on P2 and,
        // past the grace window, frees the seat.
        for (const role of ["P1", "P3", "P4"]) await roster(pages.get(role), [names[0], names[2], names[3]]);
      }
      relay.resume();
      await isolation.lift();
      lifted = true;
    } finally {
      if (!lifted) {
        relay.resume();
        await isolation.lift();
      }
      clearRoomProfiles();
    }
    await waitForCurrentPeerConnected(p2, "P2 after its link returns", 120000);
    for (const page of pages.values()) await roster(page, names);
    assert.equal(await isOffline(p2), false, "P2 went Offline after its link returned");
    const after = await identities("P1");
    if (outageMs < 30000) {
      assert.equal(after[names[1]], before[names[1]], "P2 came back under a new identity after a short outage");
    } else {
      assert.notEqual(after[names[1]], before[names[1]], "P2 kept its identity after the server had freed its seat");
    }
    recordEvidence("outage-sockets", { before: p2SocketsBefore, after: await p2.evaluate(() => window.__slowMeetTest.sockets.length) });
    await assertFullMeshMedia({ label: `after a ${outageMs / 1000} s link outage` });
  });
}

async function scenarioLinkOutageShort() { await linkOutage(15000); }
async function scenarioLinkOutageLong() { await linkOutage(75000); }

// P2's signaling stalls (its media keeps flowing) while P4 leaves and
// rejoins: every offer and roster change for P2 is held, then delivered at
// once. P2 keeps hearing the room through the stall and converges on the
// new room afterwards.
async function scenarioSignalingStallDuringChurn() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await withRelayedParticipant("P2", async (relay) => {
    relay.blackhole();
    try {
      await retireParticipant("P4");
      await assertRoomKeepsTalking(["P1", "P2", "P3"], "while P2's signaling stalls");
      await delay(reconnectGraceSeconds * 1000 + 1000);
      await join("P4");
      await enableCamera(pages.get("P4"));
      await unmuteAllForAudioGuarantee();
      await waitForSenderAudio("P2", "P1", "P2 hearing P1 through the stall");
      assert.ok(relay.stats().heldDownBytes > 0, "nothing was held for P2 during the stall: the relay never blackholed it");
    } finally {
      relay.resume();
    }
    for (const role of ["P1", "P3", "P4"]) await roster(pages.get(role), names);
    // P2 gets the held left/joined/offer burst at once. Its departed tile
    // for the old Drew has been seen to stay up as a "Participant left"
    // ghost next to the rejoined Drew instead of disappearing after 1.2 s.
    const p2 = pages.get("P2");
    let ghosts = [];
    for (let attempt = 0; attempt < 15; attempt++) {
      ghosts = await p2.evaluate(() => [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
        .filter((tile) => !tile.closest("#layout-parking") && tile.dataset.connection === "left")
        .map((tile) => ({ id: tile.dataset.participantId, text: tile.textContent.slice(0, 40) })));
      if (!ghosts.length) break;
      await delay(1000);
    }
    knownIssue("B10", ghosts.length === 0,
      "a departed participant's tile stays as a ghost after a stalled signaling session delivers left/joined in one burst", ghosts);
    await p2.waitForFunction((expected) => expected.every((name) =>
      [...document.querySelectorAll("#meeting-layout-host .participant-tile")]
        .some((tile) => tile.dataset.connection !== "left" && tile.textContent.includes(name))), names, { timeout: 20000 });
    await waitForCurrentPeerConnected(pages.get("P2"), "P2 after the stall", 60000);
    await assertFullMeshMedia({ label: "after the signaling stall" });
  });
}

// One participant's media is dead for minutes while its signaling lives:
// the client spends its retry budget (ICE restarts, then reconnects backing
// off 2/4/8/16/30 s) and goes Offline, and stays Offline once the path
// returns until the user leaves and rejoins. The others keep talking.
async function scenarioLongBlackoutRetryBudget() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const p2 = pages.get("P2");
  const socketsBefore = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
  installRoomQdisc();
  const isolation = netemTiers.armRoleUdpIsolation("P2", "blackout", pages);
  let offlineAt;
  try {
    await isolation.ready;
    const startedAt = Date.now();
    while (Date.now() - startedAt < 300000) {
      await assertRoomKeepsTalking(["P1", "P3", "P4"], "while P2's media is dead");
      if (await isOffline(p2)) {
        offlineAt = Date.now() - startedAt;
        break;
      }
      await delay(10000);
    }
    const sockets = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
    recordEvidence("retry-budget", { offlineAfterMs: offlineAt, socketsOpened: sockets - socketsBefore,
      creates: await p2.evaluate(() => window.__slowMeetTest.socketCreates.map((entry) => entry.at)) });
    assert.ok(offlineAt, "P2 never went Offline in 300 s of dead media");
    console.log(`[retry-budget] P2 went Offline after ${offlineAt} ms and ${sockets - socketsBefore} signaling sessions`);
    assert.ok(sockets - socketsBefore >= 5, `P2 opened only ${sockets - socketsBefore} signaling sessions before going Offline`);
  } finally {
    await isolation.lift();
    clearRoomProfiles();
  }
  // Offline is final until the user acts: the path is back, nothing retries.
  const socketsAtLift = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
  await delay(15000);
  assert.equal(await isOffline(p2), true, "P2 left the Offline state on its own");
  assert.equal(await p2.evaluate(() => window.__slowMeetTest.sockets.length), socketsAtLift, "P2 kept retrying after going Offline");
  await p2.locator("#leave").click();
  await p2.locator("#meeting").waitFor({ state: "hidden", timeout: 10000 });
  await p2.locator("#meeting-ended").waitFor({ state: "visible", timeout: 10000 });
  await p2.locator("#rejoin").click();
  await p2.locator("#join-form").waitFor({ state: "visible", timeout: 10000 });
  await p2.locator("#join").click();
  await p2.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
  await enableCamera(p2);
  await unmuteAllForAudioGuarantee();
  for (const page of pages.values()) await roster(page, names);
  await assertFullMeshMedia({ label: "after Leave and Rejoin" });
}

// With the built-in TURN relay available, one participant's UDP is blocked
// mid-call (policed UDP). On Automatic its client must hand off to TURN/TCP
// while UDP stays dead, and nobody else may be dragged off their path.
async function scenarioUdpBlockedRelayFailover() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const p4 = pages.get("P4");
  await waitForCurrentPeerConnected(p4, "P4 before UDP is blocked", 30000);
  const others = {};
  for (const role of ["P1", "P2", "P3"]) others[role] = await currentPeerState(pages.get(role));
  installRoomQdisc();
  const isolation = netemTiers.armRoleUdpIsolation("P4", "blackout", pages, {
    allowPortMasks: [{ port: server.relayRange.min, mask: "0xffc0" }]
  });
  try {
    await isolation.ready;
    await p4.waitForFunction(async () => {
      const peer = (window.__slowMeetTest?.peerConnections || []).at(-1);
      if (!peer || peer.connectionState !== "connected") return false;
      const report = await peer.getStats();
      const byID = new Map([...report.values()].map((stat) => [stat.id, stat]));
      for (const stat of report.values()) {
        if (stat.type !== "transport" || !stat.selectedCandidatePairId) continue;
        const local = byID.get(byID.get(stat.selectedCandidatePairId)?.localCandidateId);
        if (local?.candidateType === "relay" && local.relayProtocol === "tcp") return true;
      }
      return false;
    }, null, { timeout: 120000 }).catch(async () =>
      assert.fail(`P4 never moved to TURN/TCP while its UDP was blocked (${JSON.stringify(await currentPeerState(p4))})`));
    recordEvidence("relay-failover", { p4: await currentPeerState(p4) });
    for (const role of ["P1", "P2", "P3"]) {
      await waitForSenderAudio(role, "P4", "P4's audio over TURN/TCP");
      await waitForSenderAudio("P4", role, "audio to P4 over TURN/TCP");
      const now = await currentPeerState(pages.get(role));
      assert.equal(now.sockets, others[role].sockets, `${role} reconnected its signaling because of P4's failover`);
      assert.equal(now.pair?.candidateType, "host", `${role} left its direct path because of P4's failover`);
    }
  } finally {
    await isolation.lift();
    clearRoomProfiles();
  }
  await assertFullMeshMedia({ label: "after the relay failover" });
}

// A participant pinned to TURN/TCP sees 2% loss and 50 ms on the relay leg
// (TCP turns the loss into head-of-line stalls). Audio must keep flowing
// both ways and the room must recover when the leg clears.
async function scenarioRelayPathUnderLoss() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const p4 = pages.get("P4");
  await openSettingsPanel(p4);
  // Switching to a relay method may rebuild the media path in place or over
  // a new signaling session; either way the newest peer must end up
  // connected through a TURN/TCP relay.
  await p4.locator("#settings-connection-method").selectOption("turn-tcp", { force: true });
  await p4.waitForFunction(async () => {
    const peer = (window.__slowMeetTest?.peerConnections || []).at(-1);
    if (!peer || peer.connectionState !== "connected") return false;
    const report = await peer.getStats();
    const byID = new Map([...report.values()].map((stat) => [stat.id, stat]));
    for (const stat of report.values()) {
      if (stat.type !== "transport" || !stat.selectedCandidatePairId) continue;
      const local = byID.get(byID.get(stat.selectedCandidatePairId)?.localCandidateId);
      if (local?.candidateType === "relay" && local.relayProtocol === "tcp") return true;
    }
    return false;
  }, null, { timeout: 60000 }).catch(async () =>
    assert.fail(`P4 never connected through TURN/TCP after choosing it (${JSON.stringify(await currentPeerState(p4))})`));
  installRoomQdisc({ include: ["relay-lossy"] });
  const countersBefore = netemTiers.tierClassCounters();
  netemTiers.applyTcpPortTier(server.turnPort, "relay-lossy");
  try {
    await delay(20000);
    for (const role of ["P1", "P2", "P3"]) {
      await waitForSenderAudio(role, "P4", "P4's audio over a lossy TURN/TCP leg");
      await waitForSenderAudio("P4", role, "audio to P4 over a lossy TURN/TCP leg");
    }
    const lossy = netemTiers.classCounterDelta(countersBefore, netemTiers.tierClassCounters(), fourPersonTiers["relay-lossy"].classID);
    recordEvidence("relay-lossy", lossy);
    assert.ok(lossy.sentPackets >= 100, `the relay leg's tier carried only ${lossy.sentPackets} packets`);
    assert.equal(await isOffline(p4), false, "P4 went Offline on a lossy relay leg");
  } finally {
    clearRoomProfiles();
  }
  await openSettingsPanel(p4);
  await p4.locator("#settings-connection-method").selectOption("auto", { force: true });
  await waitForCurrentPeerConnected(p4, "P4 back on Automatic", 60000);
  console.log(`  P4 back on Automatic: ${JSON.stringify(await currentPeerState(p4))}`);
  await assertFullMeshMedia({ label: "after the relay leg clears" });
}

// Simulcast (the "simulcast" server profile). Each publisher sends as many
// camera layers as its capture supports (planCameraSimulcast): a 360p capture
// is two layers, 320x180 and 640x360. Before B12 was fixed, the layers kept
// fixed 4/2/1 scales and Chrome dropped all but the first, so every receiver
// got one 90x60 layer. Here every publisher must send both layers at those
// sizes; a receiver whose downlink fits only the low layers must step down,
// keep decoding every camera at the low size while a fast receiver keeps the
// full size, and climb back once its cap lifts. An impaired participant's own
// camera may take the protect-audio pause (the contract every tier scenario
// keeps), so the full-mesh checks skip suspended publishers.
async function cameraLayerHeights(page) {
  return page.evaluate(async () => {
    const heights = {};
    if (!cameraSender) return heights;
    (await cameraSender.getStats()).forEach((report) => {
      if (report.type === "outbound-rtp" && report.rid && report.frameHeight) heights[report.rid] = report.frameHeight;
    });
    return heights;
  });
}

async function tileVideoHeight(page, participantID) {
  return page.evaluate((id) =>
    document.querySelector(`li[data-participant-id='${id}'] video:not(.screen-video)`)?.videoHeight ?? -1, participantID);
}

// describeCameraLayers reports, for one remote participant on a page, the
// preferred layer, each layer track (state, whether it is bound to the
// tile, inbound size and bytes) and every video receiver with the track ID
// it carries, so a wrong binding or a missing layer shows in the failure.
async function describeCameraLayers(page, participantID) {
  return page.evaluate(async (participantID) => {
    const tracks = remoteCameraLayerTracks.get(participantID);
    const bound = participantElements.get(participantID)?.cameraVideo?.srcObject?.getVideoTracks?.()[0];
    const out = { preferred: cameraLayer };
    for (const [layer, track] of tracks || []) {
      const receiver = peer.getReceivers().find((item) => item.track === track);
      let inbound = "";
      (await receiver?.getStats())?.forEach((report) => {
        if (report.type === "inbound-rtp") inbound = `${report.frameHeight}p ${report.bytesReceived}B`;
      });
      out[layer] = `${track.readyState}${track.muted ? " muted" : ""}${track === bound ? " bound" : ""} ${inbound}`;
    }
    out.receivers = [];
    for (const transceiver of peer.getTransceivers()) {
      const track = transceiver.receiver.track;
      if (track?.kind !== "video" || transceiver.direction === "sendonly") continue;
      let inbound = "";
      (await transceiver.receiver.getStats())?.forEach((report) => {
        if (report.type === "inbound-rtp") inbound = `${report.frameHeight}p ${report.bytesReceived}B`;
      });
      out.receivers.push(`${transceiver.mid} ${transceiver.currentDirection} ${track.id} ${track.readyState}${track.muted ? " muted" : ""} owner=${remoteTrackOwners.get(track.id)?.slice(0, 6)} ${inbound}`);
    }
    return out;
  }, participantID);
}

async function waitForTileVideoHeight(observer, sender, accept, description, timeoutMs = 30000) {
  const page = pages.get(observer);
  const id = await participantIDFor(page, names[roles.indexOf(sender)]);
  const deadline = Date.now() + timeoutMs;
  let height = -1;
  while (Date.now() < deadline) {
    height = await tileVideoHeight(page, id);
    if (accept(height)) return height;
    await delay(1000);
  }
  const layers = await describeCameraLayers(page, id);
  assert.fail(`${observer} decodes ${sender}'s camera at ${height} px, not ${description}: ${JSON.stringify(layers)}`);
}

async function suspendedPublishers() {
  const suspended = [];
  for (const [role, page] of pages) {
    if (await page.evaluate(() => window.__slowMeetTest?.adaptationState?.videoSuspended === true)) suspended.push(role);
  }
  return suspended;
}

async function scenarioSimulcastMixedRoom() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await clearStaleVideoSuspensions();
  const layerRank = { low: 0, medium: 1, high: 2 };
  const layerOf = (role) => pages.get(role).evaluate(() => cameraLayer);
  const restore = new Map();
  for (const [role, page] of pages) {
    assert.equal(await page.evaluate(() => simulcastEnabled), true, `${role} did not get simulcast from the server`);
    restore.set(role, await page.evaluate(() => ({
      quality: document.querySelector("#camera-quality").value,
      profile: document.querySelector("#profile").value
    })));
    await openSettingsPanel(page);
    await page.selectOption("#camera-quality", "360p");
    await openSettingsPanel(page);
    await page.selectOption("#profile", "normal");
  }
  try {
    for (const [role, page] of pages) {
      const deadline = Date.now() + 30000;
      let heights = {};
      while (Date.now() < deadline) {
        heights = await cameraLayerHeights(page);
        if (heights.low === 180 && heights.medium === 360 && !heights.high) break;
        await delay(1000);
      }
      const senderDetail = await page.evaluate(async () => {
        const detail = { encodings: cameraSender?.getParameters?.().encodings?.map((e) => `${e.rid}:${e.active}:${e.scaleResolutionDownBy}:${e.maxBitrate}`), capture: localCameraTrack?.getSettings?.() };
        const reports = await cameraSender?.getStats?.();
        reports?.forEach((report) => {
          if (report.type === "outbound-rtp") detail[report.rid] = `${report.frameWidth}x${report.frameHeight} ${report.qualityLimitationReason} ${report.bytesSent}`;
          if (report.type === "candidate-pair" && report.nominated) detail.availableOutgoingBitrate = report.availableOutgoingBitrate;
        });
        detail.localSim = (peer.localDescription?.sdp || "").split("\r\n").filter((l) => /^a=simulcast/.test(l));
        detail.remoteSim = (peer.remoteDescription?.sdp || "").split("\r\n").filter((l) => /^a=simulcast/.test(l));
        detail.localType = peer.localDescription?.type;
        return detail;
      });
      assert.deepEqual(heights, { low: 180, medium: 360 },
        `${role}'s 360p camera does not send a 180 px and a 360 px layer (B12): ${JSON.stringify(senderDetail)}`);
    }
    installRoomQdisc({ include: ["narrow-downlink"] });
    let armer;
    try {
      armer = armParticipantTiers({ P1: "fast", P3: "narrow-downlink" });
      try {
        await pages.get("P3").waitForFunction(() => cameraLayer === "low", null, { timeout: 60000 });
      } catch (_) {
        assert.fail(`P3 on the narrow downlink never stepped down to the low camera layer (still ${await layerOf("P3")})`);
      }
      const fastLayer = await layerOf("P1");
      assert.ok(layerRank[fastLayer] > layerRank.low,
        `P1 on the fast tier is on the ${fastLayer} camera layer, no higher than P3's low layer`);
      // The SFU forwards P3 the low layer of P1's camera while the fast P1
      // and the clean P4 keep each other's full-size layer.
      await waitForTileVideoHeight("P3", "P1", (height) => height === 180, "the 180 px low layer");
      await waitForTileVideoHeight("P4", "P1", (height) => height === 360, "the 360 px top layer");
      await waitForTileVideoHeight("P1", "P4", (height) => height === 360, "the 360 px top layer");
      try {
        await assertFullMeshMedia({ label: "with P3 on the low camera layer", skipVideoFrom: await suspendedPublishers() });
      } catch (error) {
        const detail = { suspended: await suspendedPublishers() };
        for (const [observer, sender] of [["P1", "P3"], ["P4", "P3"], ["P1", "P2"]]) {
          const page = pages.get(observer);
          detail[`${observer}<-${sender}`] = await describeCameraLayers(page, await participantIDFor(page, names[roles.indexOf(sender)]));
        }
        error.message += ` ${JSON.stringify(detail)}`;
        throw error;
      }
    } finally {
      if (armer) armer.stopped = true;
      clearRoomProfiles();
    }
    try {
      await pages.get("P3").waitForFunction(() => cameraLayer !== "low", null, { timeout: 60000 });
    } catch (_) {
      assert.fail(`P3 stayed on the low camera layer after its downlink cap lifted (${await layerOf("P3")})`);
    }
    await waitForTileVideoHeight("P3", "P1", (height) => height === 360, "the 360 px top layer after the cap lifted");
    await clearStaleVideoSuspensions();
    await assertFullMeshMedia({ label: "after P3's camera layer climbed back" });
  } finally {
    for (const [role, page] of pages) {
      const { quality, profile } = restore.get(role);
      await openSettingsPanel(page).catch(() => {});
      await page.selectOption("#camera-quality", quality).catch(() => {});
      await openSettingsPanel(page).catch(() => {});
      await page.selectOption("#profile", profile).catch(() => {});
    }
  }
}

// Each resume of a participant now swaps its media onto the room's existing
// senders (held publications, an audio rebase, a client rebind). Five TCP
// resets of one participant's signaling in a row must each resume the same
// identity with everyone hearing and seeing it, so that chained swaps do not
// accumulate damage.
async function scenarioRepeatedSignalingResumes() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  await withRelayedParticipant("P2", async (relay) => {
    const p2 = pages.get("P2");
    const before = await identities("P1");
    for (let round = 1; round <= 5; round++) {
      const socketsBefore = await p2.evaluate(() => window.__slowMeetTest.sockets.length);
      const acceptedBefore = relay.stats().accepted;
      relay.reset();
      await p2.waitForFunction((count) => {
        const sockets = window.__slowMeetTest.sockets;
        return sockets.length > count && sockets.at(-1).readyState === WebSocket.OPEN;
      }, socketsBefore, { timeout: 30000 });
      assert.ok(relay.stats().accepted > acceptedBefore, `round ${round}: P2 did not reconnect through the relay`);
      await waitForCurrentPeerConnected(p2, `P2 after resume ${round}`, 60000);
      for (const page of pages.values()) await roster(page, names);
      const after = await identities("P1");
      assert.equal(after[names[1]], before[names[1]], `round ${round}: P2's resume became a rejoin under a new identity`);
      await assertResumedParticipantHeard("P2", `after resume ${round}`);
      await delay(3000);
    }
  });
}

// A participant leaves for good and a new one takes the seat (a new
// identity). The SFU reuses the departed participant's freed transceivers for
// the newcomer, and a browser keeps a receiver's track ID from its first use,
// so every page must still bind the newcomer's audio and camera to the
// newcomer's tile (and, with simulcast, the right layer), and the departed
// tile must be gone.
async function scenarioSeatHandoverChurn() {
  await setupRoom();
  await unmuteAllForAudioGuarantee();
  const observers = ["P1", "P2", "P3"];
  const oldID = await participantIDFor(pages.get("P1"), names[3]);
  await retireParticipant("P4");
  await delay(reconnectGraceSeconds * 1000 + 1000);
  for (const role of observers) await roster(pages.get(role), names.slice(0, 3));
  await join("P4");
  await enableCamera(pages.get("P4"));
  await unmuteAllForAudioGuarantee();
  for (const page of pages.values()) await roster(page, names);
  for (const role of observers) {
    const page = pages.get(role);
    const newID = await participantIDFor(page, names[3]);
    assert.notEqual(newID, oldID, `${role} sees the newcomer under the departed participant's identity`);
    await page.waitForFunction((id) => !document.querySelector(`li[data-participant-id='${id}']`), oldID, { timeout: 10000 })
      .catch(() => assert.fail(`${role} still shows the departed participant's tile`));
    const framesAt = () => tileVideoFrames(page, newID);
    const startFrames = await framesAt();
    let flowing = false;
    for (let attempt = 0; attempt < 20 && !flowing; attempt++) {
      await delay(1000);
      flowing = (await framesAt()) > Math.max(0, startFrames) + 5;
    }
    assert.ok(flowing, `${role} never decoded the newcomer's camera on the newcomer's tile`);
    assert.ok(await tileAudioBytes(page, newID) >= 0, `${role}'s tile for the newcomer has no audio track`);
  }
  await assertFullMeshMedia({ label: "after the seat handover" });
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
  { name: "signaling-reconnect", description: "One participant's signaling socket closes on a healthy link and reconnects: the roster settles on all four, the other three keep seeing the same participant identity, and media flows everywhere.", run: scenarioSignalingReconnect },
  { name: "grace-window-churn", description: "During a member's reconnect grace window the other browsers see the left state, then the room recovers — same identity on resume with the default grace, a fresh identity after expiry with a 1s grace.", run: scenarioGraceWindowChurn },
  { name: "token-takeover", description: "A second socket presenting the live reconnect token takes over the seat and the displaced client reclaims it with identity and media intact.", run: scenarioTokenTakeover },
  { name: "late-joiner-replay", description: "A member who rejoins rebuilds mic state, the active sharer, and the sharer's screen video purely from the server replay.", run: scenarioLateJoinerReplay },
  { name: "auto-pin-shrink", description: "A 1:1 room auto-pins the remote peer on both remaining browsers and regrowing dismisses the automatic pin.", run: scenarioAutoPinShrink },
  { name: "welcome-roster-preview", description: "The prejoin screen previews the three current members before the fourth joins.", run: scenarioWelcomeRosterPreview },
  { name: "admin-config-broadcast", description: "An admin policy change reaches all four browsers via config_update and the share control disables and re-enables room-wide.", run: scenarioAdminConfigBroadcast },
  { name: "admin-share-eviction", description: "Disabling screen sharing mid-share evicts the lease room-wide and the seat is reusable after re-enabling.", run: scenarioAdminShareEviction },
  { name: "admin-caps-and-chat-reset", description: "Admin bitrate caps and history-retention changes fan out to every browser and a reset empties what reconnect replays.", run: scenarioAdminCapsAndChatReset },
  { name: "connection-method-switch", description: "Switching the connection method mid-meeting restarts that participant's ICE in place, on the same signaling socket and peer, while the others keep flowing.", run: scenarioConnectionMethodSwitch },
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
  { name: "delay-and-jitter-links", description: "A pure-latency link (RTT ~350 ms, poor-not-critical) degrades interactivity while throughput survives, and a jitter-only link steps the ladder down without suspending video; the clean pair stays unaffected and everything recovers.", run: scenarioDelayAndJitterLinks, netns: true },
  { name: "all-fast-link-top-quality", description: "All four participants on a shaped-but-fast link (20 mbit, RTT ~20 ms, no loss): every Automatic ladder reaches the top level and holds it with the top profile's sender bitrate, no pause, and no degraded tile; while one link turns moderate the other three hold the top level, and after it lifts the whole room returns to the top level.", run: scenarioAllFastLinkTopQuality, netns: true },
  { name: "one-fast-three-bad-uplinks", description: "One fast link and three participants impaired in both directions (moderate/severe/moderate): audio flows for everyone and from every bad publisher, the good camera reaches each bad participant as a trickle or a degradation reaction, the bad cameras degrade on the good participant, the severe participant leaving does not disturb the good participant's connection, and the room recovers on lift.", run: scenarioOneFastThreeBadUplinks, netns: true },
  { name: "bad-downlink-among-bad-senders", description: "One participant's own download loses 12 % (no rate cap, clean uplink) while the other three send over uploads losing 10 %: the discount for the senders' own loss must not hide the receiver's, so its link still reads poor and its ladder steps down, and the room recovers.", run: scenarioBadDownlinkAmongBadSenders, netns: true },
  { name: "lossy-downlink-clean-senders", description: "One participant's download loses 12 % and carries only video, from three senders on clean links: the SFU measures the loss although every lost packet is resent, and the room recovers.", run: scenarioLossyDownlinkCleanSenders, netns: true },
  { name: "all-four-impaired", description: "All four participants on a moderate link of their own at once: audio keeps flowing everywhere, the impairment does not turn into a peer-rebuild storm, and every camera and Automatic ladder recovers when the links lift.", run: scenarioAllFourImpaired, netns: true },
  // Opt-in mixed-engine netns scenarios: MEDIA_E2E_FOUR_GROUP=firefox, or by
  // exact name, with MEDIA_E2E_FOUR_ENGINES=mixed. Never in CI.
  { name: "lossy-downlink-clean-senders-firefox", group: "firefox", description: "A Firefox participant's download loses 12 % and carries only video, from three senders on clean links: the SFU measures it from Firefox's transport-cc feedback although every lost packet is resent, Firefox's adaptation uses that measurement, and the room recovers.", run: scenarioLossyDownlinkCleanSendersFirefox, netns: true },
  // Opt-in resilience scenarios: MEDIA_E2E_FOUR_GROUP=resilience (or
  // resilience-slow), or each by its exact name. Never in CI.
  { name: "sharer-reconnect-mid-share", group: "resilience", description: "The screen-share owner's signaling drops and resumes inside the grace window: the share ends cleanly for all three viewers, the lease is free for someone else, and the owner can share again.", run: scenarioSharerReconnectMidShare },
  { name: "simultaneous-reconnect", group: "resilience", description: "Two, then all four participants lose signaling in the same instant and resume together with their identities, and every participant hears and sees every other one afterwards.", run: scenarioSimultaneousReconnect },
  { name: "server-restart-rejoin", group: "resilience", description: "The server restarts under a live four-person room: every browser rejoins on its own as a fresh participant, nobody goes Offline, and the room's media comes back pair by pair.", run: scenarioServerRestartRejoin },
  { name: "path-change-auto-ice-restart", group: "resilience", description: "One participant's current UDP path dies for good: the client finds a working path on its own without a reload, keeps its identity, and the other three keep talking.", run: scenarioPathChangeAutoIceRestart, netns: true },
  { name: "slow-uplink-room", group: "resilience", description: "One participant's upload alone is thin and lossy: the room still hears it, its camera degrades for the others, and its clean download keeps everyone else's camera sharp.", run: scenarioSlowUplinkRoom, netns: true },
  { name: "bursty-link-room", group: "resilience", description: "One participant's link drops packets in bursts and reorders and duplicates them: audio both ways keeps flowing with no gap over 3 s, and the room recovers.", run: scenarioBurstyLinkRoom, netns: true },
  { name: "all-impaired-room", group: "resilience", description: "Every link is bad and bad differently (moderate, thin uplink, severe, capped) for 40 s: everyone keeps hearing someone, nobody goes Offline or into a reconnect storm, and the room recovers.", run: scenarioAllImpairedRoom, netns: true },
  { name: "sharer-reconnect-mid-share-impaired", group: "resilience", description: "The screen-share owner on a moderate link drops signaling mid-share: the share ends cleanly everywhere and the lease is free again.", run: scenarioSharerReconnectMidShareImpaired, netns: true },
  { name: "reconnect-under-impairment-isolated", group: "resilience", description: "A signaling resume whose new ICE, DTLS and first media all cross a moderate link: identity kept, resume inside the superseded-peer close delay, room keeps talking.", run: scenarioReconnectUnderImpairmentIsolated, netns: true },
  { name: "rapid-flap-link", group: "resilience", description: "One participant's link flaps 2 s on / 2 s off for a minute, then 3 s on / 8 s off: the others keep talking and the flapping participant ends up connected with its identity.", run: scenarioRapidFlapLink, netns: true },
  { name: "link-outage-short", group: "resilience", description: "One participant's signaling and media die together for 15 s with no FIN or RST: the room keeps talking and the participant comes back on its own with its identity.", run: scenarioLinkOutageShort, netns: true },
  { name: "signaling-stall-during-churn", group: "resilience", description: "One participant's signaling stalls while its media flows and another participant leaves and rejoins: it keeps hearing the room and converges on the new room afterwards.", run: scenarioSignalingStallDuringChurn, netns: true },
  { name: "udp-blocked-relay-failover", group: "resilience", server: "turn", description: "With the built-in TURN relay, one participant's UDP is blocked mid-call: Automatic hands it off to TURN/TCP while the other three stay on their direct paths.", run: scenarioUdpBlockedRelayFailover, netns: true },
  { name: "relay-path-under-loss", group: "resilience", server: "turn", description: "A participant on TURN/TCP sees 2% loss and 50 ms on the relay leg: audio flows both ways and the room recovers.", run: scenarioRelayPathUnderLoss, netns: true },
  { name: "simulcast-mixed-room", group: "resilience", server: "simulcast",
    description: "With simulcast on, every 360p camera sends a 180 px and a 360 px layer (B12); a receiver whose downlink fits only the low layers falls to them below a fast receiver's, keeps decoding every camera, and climbs back once the cap lifts.", run: scenarioSimulcastMixedRoom, netns: true },
  { name: "repeated-signaling-resumes", group: "resilience", description: "One participant's signaling is reset five times in a row: each time it resumes under the same identity and the room keeps hearing and seeing it.", run: scenarioRepeatedSignalingResumes, netns: true },
  { name: "seat-handover-churn", group: "resilience", description: "A participant leaves for good and a new one takes the seat: every page binds the newcomer's audio and camera to the newcomer's tile and drops the departed tile.", run: scenarioSeatHandoverChurn, netns: true },
  { name: "seat-handover-churn-simulcast", group: "resilience", server: "simulcast", description: "The seat handover with simulcast on, where a receiver also reads the newcomer's camera layer from the reused track.", run: scenarioSeatHandoverChurn, netns: true },
  { name: "link-outage-long", group: "resilience-slow", description: "A 75 s outage of one participant's signaling and media: the server frees the seat, the room keeps talking, and the participant rejoins on its own once the link returns.", run: scenarioLinkOutageLong, netns: true },
  { name: "long-blackout-retry-budget", group: "resilience-slow", description: "One participant's media is dead for minutes while signaling lives: it spends its retry budget and goes Offline, stays Offline when the path returns, and Leave then Rejoin restores it.", run: scenarioLongBlackoutRetryBudget, netns: true }
];

// A scenario with a `group` is opt-in: it never runs in a default or
// substring-filtered selection. It runs when MEDIA_E2E_FOUR_GROUP names its
// group, or when MEDIA_E2E_FOUR_SCENARIO names it exactly.
function scenarioFilter() {
  const split = (value) => (value || "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const raw = split(process.env.MEDIA_E2E_FOUR_SCENARIO);
  const groups = split(process.env.MEDIA_E2E_FOUR_GROUP);
  if (!raw.length && !groups.length) return scenarios.filter((scenario) => !scenario.group);
  const selected = scenarios.filter(({ name, group }) =>
    (group && groups.includes(group)) ||
    raw.some((entry) => group ? name === entry : (name === entry || name.includes(entry))));
  assert.ok(selected.length, `no scenario matches MEDIA_E2E_FOUR_SCENARIO=${process.env.MEDIA_E2E_FOUR_SCENARIO || ""} MEDIA_E2E_FOUR_GROUP=${process.env.MEDIA_E2E_FOUR_GROUP || ""}; known scenarios:\n  ${scenarios.map((scenario) => scenario.name).join("\n  ")}`);
  return selected;
}

function reproductionFor(scenario) {
  if (!scenario) return "make test-media-e2e-four";
  const known = scenario.knownFailing ? "SLOWMEET_KNOWN_FAILING=1 " : "";
  if (scenario.netns) return `${known}MEDIA_E2E_FOUR_SCENARIO=${scenario.name} make test-media-e2e-four-netns`;
  return `${known}MEDIA_E2E_FOUR_SCENARIO=${scenario.name} make test-media-e2e-four-scenario`;
}

async function saveFailure(error) {
  const parent = process.env.MEDIA_E2E_ARTIFACT_DIR;
  const directory = parent ? path.join(path.resolve(parent), activeScenario) : fs.mkdtempSync(path.join(os.tmpdir(), "slowmeet-four-person-e2e-failure-"));
  fs.mkdirSync(directory, { recursive: true });
  const expectedByScenario = new Map(scenarios.map(({ name, description }) => [name, description]));
  const report = { scenario: activeScenario, reproduction: reproductionFor(scenarios.find(({ name }) => name === activeScenario)),
    expected: expectedByScenario.get(activeScenario) || "Four participants join, synchronize room state, exchange media, and reject a fifth join.",
    actual: error.message, failureType: /launch|executable doesn't exist|permission|eperm|eacces|address already in use|did not become ready/i.test(error.message) ? "environment-or-browser" : "application-or-assertion",
    participants: names.map((name, index) => ({ role: roles[index], name })), artifactDirectory: directory, serverLogs: server?.output.slice(-1500),
    evidence: scenarioEvidence.get(activeScenario) || null, pages: [] };
  for (const [role, page] of pages) {
    const diagnostics = await page.evaluate(async () => ({ url: location.href, status: document.querySelector("#status")?.textContent,
      meetingStatus: document.querySelector("#meeting-status")?.textContent,
      roster: [...document.querySelectorAll("#participants > li")].map((item) => item.textContent),
      sharing: { owner: document.querySelector("#participants")?.dataset.sharingOwner,
        tiles: [...document.querySelectorAll("li[data-participant-id]")].map((item) => ({ id: item.dataset.participantId, name: item.textContent,
          connection: item.dataset.connection, sharing: item.dataset.sharing, camera: item.dataset.camera,
          mic: item.dataset.mic, parked: Boolean(item.closest("#layout-parking")), removed: !item.isConnected })) },
      localScreenPressed: document.querySelector("#screen")?.getAttribute("aria-pressed"),
      screenDisabled: document.querySelector("#screen")?.disabled,
      visibleStatus: document.body.innerText.slice(-1200),
      media: await Promise.all([...(window.__slowMeetTest?.peerConnections || [])].map(async (pc) => ({
        connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState,
        transceivers: pc.getTransceivers().map((item) => ({ kind: item.receiver?.track?.kind || item.sender?.track?.kind || null,
          direction: item.direction, currentDirection: item.currentDirection, senderTrack: item.sender?.track?.kind || null })),
        inboundRtp: await pc.getStats().then((report) => [...report.values()]
          .filter((item) => item.type === "inbound-rtp").map((item) => ({ kind: item.kind || item.mediaType,
            bytesReceived: item.bytesReceived, packetsReceived: item.packetsReceived, packetsLost: item.packetsLost,
            framesDecoded: item.framesDecoded })))
      }))),

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
    for (const { name, description, group, knownFailing } of scenarios) {
      const tags = [group && `opt-in: ${group}`, knownFailing && `known failing: ${knownFailing.finding}`].filter(Boolean);
      console.log(`${name} — ${description}${tags.length ? ` [${tags.join("; ")}]` : ""}`);
    }
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
      if (scenario.knownFailing && !knownFailingEnabled) {
        console.log(`SKIP | ${scenario.name} | known failing ${scenario.knownFailing.finding}: ${scenario.knownFailing.reason} (SLOWMEET_KNOWN_FAILING=1 to run)`);
        skipped += 1;
        continue;
      }
      // A scenario that needs another server profile (the built-in TURN
      // relay) gets a fresh room on a fresh server; the next scenario that
      // needs the default profile gets it back the same way.
      const profile = scenario.server || "default";
      if (server.profile !== profile) {
        await leaveSharedRoom();
        await server.stop();
        server = await startServer({ profile });
      }
      activeScenario = scenario.name;
      activeScenarioEntry = scenario;
      const startedAt = Date.now();
      shapingProofs.length = 0;
      try {
        await scenario.run();
        assertScenarioShaping();
        ran += 1;
        if (scenario.knownFailing) {
          console.log(`UNEXPECTED PASS | ${scenario.name} | known failing ${scenario.knownFailing.finding} did not reproduce; remove the knownFailing mark if it is fixed`);
        }
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
      // What the server's video path dropped so far (counted since this
      // server started), to tell a transport loss from an SFU one.
      try {
        const dropLines = (await (await fetch(`${server.url}/metrics`)).text()).split("\n")
          .filter((line) => /^slowmeet_video_(frames_dropped|mailbox|frame_|keyframes)/.test(line));
        console.log(`[video drops] after ${scenario.name}: ${dropLines.join("; ")}`);
      } catch (_) {
        // The server may be gone after a failed scenario.
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
