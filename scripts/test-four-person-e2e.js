#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium, firefox } = require("playwright-core");

const root = path.join(__dirname, "..");
const names = ["Avery", "Blake", "Casey", "Drew"];
const roles = names.map((_, index) => `P${index + 1}`);
const browserNames = new Map([["P1", "chromium"], ["P2", "firefox"], ["P3", "chromium"], ["P4", "firefox"]]);
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
  const output = [];
  const child = spawn("go", ["run", "."], {
    cwd: root,
    env: { ...process.env, HTTP_ADDR: `127.0.0.1:${port}`, MAX_PARTICIPANTS: "4", RECONNECT_TIMEOUT_SECONDS: "1",
      MEETING_PASSWORD: "", CONFIG_FILE: path.join(os.tmpdir(), `slowmeet-four-e2e-${process.pid}.json`),
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
  } };
}

async function createParticipant(role, name, expectRejected = false) {
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
      ? { firefoxUserPrefs: { "media.navigator.streams.fake": true, "media.navigator.permission.disabled": true } }
      : { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] })
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
              hand_raised: parsed.hand_raised, video_enabled: parsed.video_enabled, error: parsed.error };
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
  await page.locator("#join-form").waitFor();
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
async function roster(page, expected) {
  await page.waitForFunction((count) => document.querySelectorAll("#participants > .participant-tile").length >= count,
    expected.length, { timeout: 20000 });
  const visible = await page.locator("#participants > .participant-tile").allTextContents();
  assert.equal(visible.length, expected.length, `roster has ghost or duplicate tiles: ${visible.join(" | ")}`);
  for (const name of expected) assert.ok(visible.some((value) => value.includes(name)), `roster missing ${name}: ${visible.join(" | ")}`);
}
async function waitText(page, selector, text) {
  await page.waitForFunction(({ selector, text }) => document.querySelector(selector)?.textContent?.includes(text), { selector, text });
}
async function openChat(page) {
  const toggle = page.locator("#chat");
  if (await toggle.getAttribute("aria-pressed") !== "true") await toggle.click();
  await page.waitForFunction(() => {
    const rail = document.querySelector("#chat-rail");
    return rail && !rail.hidden && rail.classList.contains("is-open");
  });
  await page.locator("#chat-form button[type=submit]").waitFor({ state: "visible" });
}
async function sendChat(page, text) {
  await openChat(page); await page.locator("#chat-input").fill(text); await page.locator("#chat-form button[type=submit]").click();
}
async function assertMedia() {
  const before = new Map();
  for (const [role, page] of pages) before.set(role, await page.evaluate(async () => {
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
  const deadline = Date.now() + 15000;
  const latest = new Map();
  while (Date.now() < deadline) {
    let allAdvanced = true;
    for (const [role, page] of pages) {
      const stats = await page.evaluate(async () => {
        const signalingErrors = (window.__slowMeetTest?.socketEvents || [])
          .filter((event) => event.direction === "receive" && event.message?.type === "error");
        const pcs = [...(window.__slowMeetTest?.peerConnections || [])];
        const connected = pcs.filter((pc) => pc.connectionState === "connected");
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
  for (const [role] of pages) {
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

async function run() {
  server = await startServer();
  activeScenario = "staggered-and-simultaneous-joins";
  await join("P1"); await join("P2"); await Promise.all([join("P3"), join("P4")]);
  for (const page of pages.values()) await roster(page, names);
  activeScenario = "enable-generated-cameras";
  for (const page of pages.values()) {
    await page.locator("#camera").click();
    await page.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  }
  await assertMedia();

  activeScenario = "four-way-chat";
  for (let i = 0; i < roles.length; i += 1) {
    const message = `four-way-message-${names[i]}`;
    await sendChat(pages.get(roles[i]), message);
    await Promise.all([...pages.values()].map((page) => waitText(page, "#chat-messages", message)));
  }
  activeScenario = "simultaneous-four-way-chat";
  const simultaneousMessages = roles.map((role, index) => `simultaneous-message-${names[index]}`);
  await Promise.all(roles.map((role, index) => sendChat(pages.get(role), simultaneousMessages[index])));
  await Promise.all([...pages.values()].flatMap((page) => simultaneousMessages.map((message) => waitText(page, "#chat-messages", message))));

  activeScenario = "reactions-and-raised-hands";
  for (let i = 0; i < roles.length; i += 1) {
    const page = pages.get(roles[i]); const emoji = i % 2 ? "🎉" : "👏";
    await page.locator("#reactions").click(); await page.locator(`[data-reaction="${emoji}"]`).click();
    await Promise.all([...pages.values()].map((peer) => waitText(peer, "#reaction-announcements", `${names[i]} sent`)));
    await page.locator("#raise-hand").click();
    await page.waitForFunction(() => document.querySelector("#raise-hand")?.getAttribute("aria-pressed") === "true", null, { timeout: 5000 });
    const participantID = await page.locator("#participants > .participant-tile").evaluateAll((tiles, name) =>
      tiles.find((tile) => tile.textContent.includes(name))?.dataset.participantId, names[i]);
    assert.ok(participantID, `${names[i]} participant tile has no participant ID`);
    await Promise.all([...pages.values()].map((peer) => peer.waitForFunction((id) =>
      [...document.querySelectorAll("#participants > .participant-tile")]
        .some((tile) => tile.dataset.participantId === id && tile.dataset.handRaised === "true"),
    participantID, { timeout: 5000 })));
    await page.locator("#raise-hand").click();
    await page.waitForFunction(() => document.querySelector("#raise-hand")?.getAttribute("aria-pressed") === "false", null, { timeout: 5000 });
    await Promise.all([...pages.values()].map((peer) => peer.waitForFunction((id) =>
      [...document.querySelectorAll("#participants > .participant-tile")]
        .some((tile) => tile.dataset.participantId === id && tile.dataset.handRaised === "false"),
    participantID, { timeout: 5000 })));
  }
  activeScenario = "simultaneous-reactions";
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

  activeScenario = "camera-and-microphone-toggles";
  for (const role of ["P2", "P4", "P1", "P3"]) {
    const page = pages.get(role); await page.locator("#camera").click(); await page.locator("#mic").click();
    await delay(350); await page.locator("#camera").click(); await page.locator("#mic").click();
  }
  await assertMedia();
  activeScenario = "generated-screen-share";
  const sharer = pages.get("P3"); await sharer.locator("#screen").click();
  await sharer.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  await pages.get("P1").waitForFunction((name) => [...document.querySelectorAll("#participants li[data-participant-id]")]
    .some((tile) => tile.textContent.includes(name) && tile.dataset.sharing === "true"), names[2], { timeout: 15000 })
    .catch(async () => {
      const state = await pages.get("P1").evaluate((name) => ({ owner: document.querySelector("#participants")?.dataset.sharingOwner,
        tiles: [...document.querySelectorAll("#participants li[data-participant-id]")].map((tile) => ({ name: tile.textContent, sharing: tile.dataset.sharing }))
      }), names[2]);
      throw new Error(`Avery did not observe Casey's remote screen-share state: ${JSON.stringify(state)}`);
    });
  await delay(1500); await sharer.locator("#screen").click();
  await sharer.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false", null, { timeout: 15000 });
  await pages.get("P1").waitForFunction((name) => [...document.querySelectorAll("#participants li[data-participant-id]")]
    .some((tile) => tile.textContent.includes(name) && tile.dataset.sharing === "false"), names[2], { timeout: 15000 });
  activeScenario = "responsive-layout";
  for (const page of pages.values()) {
    await page.setViewportSize({ width: 375, height: 812 });
    const size = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }));
    assert.ok(size.scroll <= size.width + 1, `horizontal overflow ${JSON.stringify(size)}`);
    await page.setViewportSize({ width: 1440, height: 900 });
  }
  activeScenario = "departure-and-rejoin";
  const sharingPage = pages.get("P3");
  await sharingPage.locator("#screen").click();
  await sharingPage.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
  await pages.get("P1").waitForFunction((name) => [...document.querySelectorAll("#participants li[data-participant-id]")]
    .some((tile) => tile.textContent.includes(name) && tile.dataset.sharing === "true"), names[2], { timeout: 15000 });
  const p4 = pages.get("P4"); await p4.locator("#leave").click(); await p4.locator("#meeting").waitFor({ state: "hidden" });
  pages.delete("P4"); await delay(1400);
  for (const page of pages.values()) await roster(page, names.slice(0, 3));
  await sharingPage.locator("#screen").click();
  await sharingPage.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false", null, { timeout: 15000 });
  await pages.get("P1").waitForFunction((name) => [...document.querySelectorAll("#participants li[data-participant-id]")]
    .some((tile) => tile.textContent.includes(name) && tile.dataset.sharing === "false"), names[2], { timeout: 15000 });
  await join("P4"); for (const page of pages.values()) await roster(page, names);
  activeScenario = "signaling-reconnect";
  const reconnecting = pages.get("P1");
  const socketCount = await reconnecting.evaluate(() => window.__slowMeetTest.sockets.length);
  await reconnecting.evaluate(() => window.__slowMeetTest.sockets.at(-1).close(4001, "four-person reconnect check"));
  await reconnecting.waitForFunction((count) => window.__slowMeetTest.sockets.length > count &&
    window.__slowMeetTest.sockets.at(-1).readyState === WebSocket.OPEN, socketCount, { timeout: 20000 });
  await assertMedia();
  activeScenario = "fifth-participant-capacity";
  const fifth = await createParticipant("P5", "Fifth", true);
  const result = await fifth.locator("#status").textContent().catch(() => "");
  assert.match(result || "", /full|capacity/i, `fifth client not rejected: ${result}`);
  console.log("PASS | four independent mixed-engine Playwright participants (2 Chromium, 2 Firefox)");
}

async function saveFailure(error) {
  const parent = process.env.MEDIA_E2E_ARTIFACT_DIR;
  const directory = parent ? path.join(path.resolve(parent), activeScenario) : fs.mkdtempSync(path.join(os.tmpdir(), "slowmeet-four-person-e2e-failure-"));
  fs.mkdirSync(directory, { recursive: true });
  const expectedByScenario = {
    "staggered-and-simultaneous-joins": "All four named participants appear in each roster and connect to the room.",
    "enable-generated-cameras": "All participants enable generated cameras and receive advancing decoded video frames.",
    "four-way-chat": "Each participant's chat message appears on all four browsers.",
    "simultaneous-four-way-chat": "Concurrent chat messages from all participants appear on all four browsers.",
    "reactions-and-raised-hands": "Each participant's reaction and raised-hand state synchronizes to the other browsers.",
    "simultaneous-reactions": "Concurrent reactions from all participants appear on all four browsers.",
    "camera-and-microphone-toggles": "Rotating camera and microphone toggles complete while peer media remains connected.",
    "generated-screen-share": "Avery observes Casey's screen-share state start and stop.",
    "responsive-layout": "Each participant view fits a 375-pixel viewport without horizontal overflow.",
    "departure-and-rejoin": "Drew leaves without a ghost tile, then rejoins the four-person roster.",
    "signaling-reconnect": "Avery reconnects signaling and resumes advancing video.",
    "fifth-participant-capacity": "The room rejects a fifth browser with a clear full-room message."
  };
  const report = { scenario: activeScenario, reproduction: "make test-media-e2e-four", expected: expectedByScenario[activeScenario] || "Four participants join, synchronize room state, exchange media, and reject a fifth join.",
    actual: error.message, failureType: /launch|executable doesn't exist|permission|eperm|eacces|address already in use|did not become ready/i.test(error.message) ? "environment-or-browser" : "application-or-assertion",
    participants: names.map((name, index) => ({ role: roles[index], name })), artifactDirectory: directory, serverLogs: server?.output.slice(-300), pages: [] };
  for (const [role, page] of pages) {
    const diagnostics = await page.evaluate(() => ({ url: location.href, status: document.querySelector("#status")?.textContent,
      meetingStatus: document.querySelector("#meeting-status")?.textContent,
      roster: [...document.querySelectorAll("#participants > li")].map((item) => item.textContent),
      sharing: { owner: document.querySelector("#participants")?.dataset.sharingOwner,
        tiles: [...document.querySelectorAll("#participants li[data-participant-id]")].map((item) => ({ name: item.textContent, sharing: item.dataset.sharing })) },
      localScreenPressed: document.querySelector("#screen")?.getAttribute("aria-pressed"),
      visibleStatus: document.body.innerText.slice(-1200),
      media: [...(window.__slowMeetTest?.peerConnections || [])].map((pc) => ({
        connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState,
        signalingState: pc.signalingState, iceGatheringState: pc.iceGatheringState
      })),
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
  try { await run(); }
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
