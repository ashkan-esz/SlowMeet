#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
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
          "--no-proxy-server"] })
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
  for (const [role, page] of pages) {
    const participantID = await participantIDFor(page, names[roles.indexOf(role)]);
    await page.evaluate(({ participantID }) => {
      const socket = window.__slowMeetTest.sockets.at(-1);
      for (let i = 0; i < 90; i += 1) {
        socket.send(JSON.stringify({ version: 1, type: "chat_message", participant_id: participantID, text: `flood-${i}` }));
      }
    }, { participantID });
  }
  await pages.get("P4").waitForFunction(() =>
    document.querySelectorAll("#chat-messages .chat-message").length >= 250, null, { timeout: 30000 });
  for (const [role, page] of pages) {
    const count = await page.evaluate(() => document.querySelectorAll("#chat-messages .chat-message").length);
    assert.ok(count <= 300, `${role} kept ${count} chat nodes; the 300-node cap should hold`);
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
        if (entry.type === "inbound-rtp" && entry.kind === "video") {
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
  for (const peer of observers) await waitForTileState(peer, participantID, "camera", "paused", 30000);
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

const scenarios = [
  { name: "staggered-and-simultaneous-joins", description: "All four named participants appear in each roster and connect to the room.", run: scenarioStaggeredJoins },
  { name: "enable-generated-cameras", description: "All participants enable generated cameras and receive advancing decoded video frames.", run: scenarioEnableCameras },
  { name: "chat-system-messages", description: "Join and leave notices appear as system chat messages on every browser.", run: scenarioChatSystemMessages },
  { name: "media-state-propagation", description: "Mic and camera toggles by each participant flip the matching tile state on every other browser.", run: scenarioMediaStatePropagation },
  { name: "four-way-chat", description: "Each participant's chat message appears on all four browsers.", run: scenarioFourWayChat },
  { name: "simultaneous-four-way-chat", description: "Concurrent chat messages from all participants appear on all four browsers.", run: scenarioSimultaneousFourWayChat },
  { name: "chat-unread-and-history", description: "Closed-rail unread badge increments and clears, a 500-character message renders everywhere, and reconnect replays retained chat history without duplicates.", run: scenarioChatUnreadAndHistory },
  { name: "reactions-and-raised-hands", description: "Each participant's reaction and raised-hand state synchronizes to the other browsers.", run: scenarioReactionsAndRaisedHands },
  { name: "simultaneous-reactions", description: "Concurrent reactions from all participants appear on all four browsers.", run: scenarioSimultaneousReactions },
  { name: "reaction-rate-limit", description: "Ten rapid reactions from one client deliver exactly the six the 3-second limit allows, and the tile still renders the reaction.", run: scenarioReactionRateLimit },
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
  { name: "fifth-participant-capacity", description: "The room rejects a fifth browser with a clear full-room message and every present participant sees the room-full notice.", run: scenarioFifthParticipantCapacity }
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
  const findings = path.join(root, "docs/four-person-e2e-findings.md");
  const header = "# Four Person Room E2E Findings\n\nFailures from `make test-media-e2e-four` are appended; prior entries and artifacts are preserved.\n";
  const prior = fs.existsSync(findings) ? fs.readFileSync(findings, "utf8") : header;
  const section = `\n## ${new Date().toISOString()} — ${activeScenario}\n\n- Reproduction: \`${report.reproduction}\`\n- Expected: ${report.expected}\n- Actual: ${report.actual}\n- Failure type: ${report.failureType}\n- Participant roles: ${report.participants.map((item) => `${item.role}=${item.name}`).join(", ")}\n- Artifacts: \`${directory}\`\n`;
  fs.writeFileSync(findings, `${prior.trimEnd()}\n${section}`);
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
    for (const scenario of selected) {
      activeScenario = scenario.name;
      const startedAt = Date.now();
      await scenario.run();
      console.log(`[pass] ${scenario.name} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
    }
    console.log(`PASS | ${selected.length} scenario(s) across four independent mixed-engine Playwright participants`);
  }
  catch (error) {
    console.error(error.stack || error.message);
    await saveFailure(error);
    process.exitCode = 1;
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
