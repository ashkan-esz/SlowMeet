#!/usr/bin/env node

// Browser end-to-end check for the rotating TURN connection methods, in-place
// connection-method switching, and the "Automatic" relay handoff.
//
// It starts a loopback TURN-over-TCP server (scripts/e2e-turn-server), a local
// SlowMeet that issues credentials for it, and two headless Chromium
// participants with generated media, then walks one participant through:
//
//   1. TURN over TCP (rotating): rotations happen on schedule, and neither
//      audio nor video pauses across them (the SFU keeps the old ICE pair
//      alive until the restarted one is selected)
//   2. -> TURN over TCP: same peer configuration, rotation just stops
//   3. -> Direct: in-place switch off the relay
//   4. -> TURN over TCP (rotating): in-place switch back onto the relay
//   5. -> Automatic, then an early direct-path death: in-place relay handoff
//
// Every step must keep the same WebSocket and RTCPeerConnection, and the other
// participant's inbound audio must keep advancing throughout.
//
// Opt-in (needs Chromium and a Go toolchain): make test-relay-rotation-e2e

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright-core");

const root = path.join(__dirname, "..");
const rotateSeconds = 10; // the server-side minimum
const meetingPassword = "relay-rotation-e2e-password";
const turnSecret = "relay-rotation-e2e-secret";
const switchBudgetMs = 5000;
// Chrome keeps an old direct pair selected until its own connectivity timeout
// (about 5 s) when the replacement relay pair ranks lower. Media must keep
// flowing meanwhile; only the reported path lags.
const directToRelayBudgetMs = 9000;

function findChrome() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.CHROME_PATH,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate));
}

async function reserveLocalPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function startProcess(command, args, env) {
  const output = [];
  const handle = spawn(command, args, {
    cwd: root, env: { ...process.env, ...env }, detached: true, stdio: ["ignore", "pipe", "pipe"]
  });
  handle.stdout.on("data", (chunk) => output.push(chunk.toString()));
  handle.stderr.on("data", (chunk) => output.push(chunk.toString()));
  const stop = async () => {
    if (handle.exitCode !== null) return;
    try {
      process.kill(-handle.pid, "SIGTERM");
    } catch (_) {
      handle.kill("SIGTERM");
    }
    await Promise.race([new Promise((resolve) => handle.once("exit", resolve)), delay(5000)]);
    if (handle.exitCode === null) {
      try {
        process.kill(-handle.pid, "SIGKILL");
      } catch (_) {
        handle.kill("SIGKILL");
      }
    }
  };
  return { handle, output, stop };
}

async function waitFor(check, description, processInfo, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processInfo.handle.exitCode !== null) {
      throw new Error(`${description}: process exited (code ${processInfo.handle.exitCode})\n${processInfo.output.join("")}`);
    }
    const value = await check();
    if (value) return value;
    await delay(200);
  }
  throw new Error(`${description}: timed out\n${processInfo.output.join("")}`);
}

async function join(browser, baseURL, name, method) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__e2e = { restarts: [], peers: [], sockets: [] };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__e2e.sockets.push(this);
      }
      send(data) {
        try {
          const message = JSON.parse(data);
          if (message.type === "ice_restart") {
            window.__e2e.restarts.push({ at: Date.now(), reason: message.reason || "recovery" });
          }
        } catch (_) {
          // Non-JSON frames are not signaling messages.
        }
        return super.send(data);
      }
    };
    const NativePeerConnection = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends NativePeerConnection {
      constructor(...args) {
        super(...args);
        window.__e2e.peers.push(this);
      }
    };
  });
  page.on("pageerror", (error) => console.error(`[${name}] page error: ${error.message}`));
  await page.goto(baseURL);
  await page.fill("#name", name);
  await page.fill("#password", meetingPassword);
  await page.waitForFunction((id) => {
    const option = document.querySelector(`#join-connection-method option[value="${id}"]`);
    return option && !option.disabled;
  }, method, { timeout: 15000 });
  // The selector is re-rendered when the ICE configuration arrives.
  await delay(1000);
  // The connection type is a visible field on the join form.
  await page.selectOption("#join-connection-method", method);
  assert.equal(await page.evaluate(() => document.querySelector("#join-connection-method").value), method,
    `${name} could not select ${method} on the join form`);
  await page.evaluate(() => document.querySelector("#join-form").requestSubmit());
  await page.waitForFunction(() => window.__e2e.peers[0]?.connectionState === "connected", null, { timeout: 30000 });
  return page;
}

// Snapshot of the meeting peer (always the first one the page created; the
// plain-relay probe's throwaway peers have no media senders).
function state(page) {
  return page.evaluate(async () => {
    const meetingPeer = window.__e2e.peers[0];
    const stats = await meetingPeer.getStats();
    let pair = null;
    let audioPackets = 0;
    stats.forEach((stat) => {
      if (stat.type === "transport" && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId);
      if (stat.type === "inbound-rtp" && stat.kind === "audio") audioPackets += stat.packetsReceived || 0;
    });
    const local = pair && stats.get(pair.localCandidateId);
    /* global appliedConnectionMethod, connectionMethod, relayRotationActive, plainRelaySuspended, connectionMetrics */
    return {
      connection: meetingPeer.connectionState,
      path: local ? `${local.candidateType}/${local.relayProtocol || local.protocol}` : null,
      policy: meetingPeer.getConfiguration().iceTransportPolicy,
      sockets: window.__e2e.sockets.length,
      socketOpen: window.__e2e.sockets.at(-1)?.readyState === WebSocket.OPEN,
      meetingPeers: window.__e2e.peers.filter((candidate) => candidate.getSenders().length > 0).length,
      restarts: window.__e2e.restarts.slice(),
      applied: appliedConnectionMethod,
      chosen: connectionMethod,
      rotationActive: relayRotationActive,
      suspended: plainRelaySuspended,
      measuredPath: connectionMetrics.icePath,
      statusText: document.querySelector("#status")?.textContent || "",
      audioPackets
    };
  });
}

async function setPressed(page, selector) {
  const button = page.locator(selector);
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  await page.waitForFunction((buttonSelector) =>
    document.querySelector(buttonSelector)?.getAttribute("aria-pressed") === "true", selector, { timeout: 15000 });
}

// Samples the meeting peer's inbound media every 100 ms and records when
// audio packets and decoded video frames advance.
function startContinuityMonitor(page) {
  return page.evaluate(() => {
    const monitor = { audioAt: [], videoAt: [], audio: -1, video: -1, freezes: 0 };
    window.__e2e.continuity = monitor;
    setInterval(async () => {
      const stats = await window.__e2e.peers[0].getStats();
      let audio = 0;
      let video = 0;
      let freezes = 0;
      stats.forEach((stat) => {
        if (stat.type !== "inbound-rtp") return;
        if (stat.kind === "audio") audio += stat.packetsReceived || 0;
        if (stat.kind === "video") {
          video += stat.framesDecoded || 0;
          freezes += stat.freezeCount || 0;
        }
      });
      const now = Date.now();
      if (monitor.audio >= 0 && audio > monitor.audio) monitor.audioAt.push(now);
      if (monitor.video >= 0 && video > monitor.video) monitor.videoAt.push(now);
      monitor.audio = audio;
      monitor.video = video;
      monitor.freezes = freezes;
    }, 100);
  });
}

// Longest stretch without inbound audio / decoded video inside [from, to].
function continuity(page, from, to) {
  return page.evaluate(({ from, to }) => {
    const longestGap = (times) => {
      let previous = from;
      let longest = 0;
      for (const at of times) {
        if (at < from || at > to) continue;
        longest = Math.max(longest, at - previous);
        previous = at;
      }
      return Math.max(longest, to - previous);
    };
    const monitor = window.__e2e.continuity;
    return {
      audioGapMs: longestGap(monitor.audioAt),
      videoGapMs: longestGap(monitor.videoAt),
      videoSamples: monitor.videoAt.filter((at) => at >= from && at <= to).length,
      freezes: monitor.freezes
    };
  }, { from, to });
}

// Keyframes this page's camera encoder has produced, PLIs it has received,
// and how many relay candidates the server offered for itself.
function senderVideoCounters(page) {
  return page.evaluate(async () => {
    const counters = { keyFrames: 0, plis: 0, serverRelayCandidates: 0 };
    (await window.__e2e.peers[0].getStats()).forEach((stat) => {
      if (stat.type === "outbound-rtp" && stat.kind === "video") {
        counters.keyFrames += stat.keyFramesEncoded || 0;
        counters.plis += stat.pliCount || 0;
      }
      if (stat.type === "remote-candidate" && stat.candidateType === "relay") counters.serverRelayCandidates += 1;
    });
    return counters;
  });
}

async function selectMethod(page, method) {
  await page.evaluate((id) => {
    const select = document.querySelector("#settings-connection-method");
    select.value = id;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, method);
}

// Waits until predicate(state) holds; returns [state, elapsedMs].
async function until(page, predicate, description, timeoutMs = switchBudgetMs) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    last = await state(page);
    if (predicate(last)) return [last, Date.now() - started];
    await delay(100);
  }
  throw new Error(`${description}: not reached in ${timeoutMs} ms; last state ${JSON.stringify(last)}`);
}

function assertSameSession(current, label) {
  assert.equal(current.sockets, 1, `${label}: the signaling WebSocket must not be replaced`);
  assert.equal(current.socketOpen, true, `${label}: the signaling WebSocket must stay open`);
  assert.equal(current.meetingPeers, 1, `${label}: the meeting must keep one RTCPeerConnection`);
  assert.equal(current.connection, "connected", `${label}: the peer must be connected`);
}

async function main() {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("no Chromium/Chrome found; set CHROMIUM_PATH");
  const goCache = process.env.GOCACHE || path.join(os.tmpdir(), "slowmeet-media-e2e-gocache");
  const cleanup = [];
  try {
    const turnPort = await reserveLocalPort();
    const turn = startProcess("go", ["run", "./scripts/e2e-turn-server", "-listen", `127.0.0.1:${turnPort}`,
      "-secret", turnSecret], { GOCACHE: goCache });
    cleanup.push(turn.stop);
    await waitFor(() => turn.output.join("").includes("turn-server listening"), "TURN test server", turn);

    const httpPort = await reserveLocalPort();
    const configFile = path.join(os.tmpdir(), `slowmeet-relay-rotation-e2e-${process.pid}.json`);
    cleanup.push(async () => fs.rmSync(configFile, { force: true }));
    const server = startProcess("go", ["run", "."], {
      GOCACHE: goCache,
      HTTP_ADDR: `127.0.0.1:${httpPort}`,
      CONFIG_FILE: configFile,
      ICE_PUBLIC_IP: "127.0.0.1",
      ICE_TRANSPORT_POLICY: "all",
      MEETING_PASSWORD: meetingPassword,
      MAX_PARTICIPANTS: "2",
      TURN_URL: "",
      TURN_URLS: `turn:127.0.0.1:${turnPort}?transport=tcp`,
      TURN_SHARED_SECRET: turnSecret,
      TURN_TCP_ROTATE_SECONDS: String(rotateSeconds),
      HTTP_PROXY: "", HTTPS_PROXY: "", http_proxy: "", https_proxy: ""
    });
    cleanup.push(server.stop);
    const baseURL = `http://127.0.0.1:${httpPort}`;
    await waitFor(async () => {
      try {
        return (await fetch(`${baseURL}/health`)).ok;
      } catch (_) {
        return false;
      }
    }, "SlowMeet", server);

    const iceConfig = await (await fetch(`${baseURL}/ice-config`)).json();
    const methods = Object.fromEntries(iceConfig.connection_methods.map((method) => [method.id, method]));
    assert.equal(iceConfig.turn_tcp_rotate_seconds, rotateSeconds);
    assert.equal(methods["turn-tcp-rotate"].enabled, true, "rotating TCP must be offered when TURN/TCP is configured");
    assert.equal(methods["turn-tls-rotate"].enabled, false, "rotating TLS must not be offered without a turns: URL");

    const browser = await chromium.launch({
      executablePath: chromePath,
      headless: process.env.MEDIA_E2E_HEADED !== "1",
      args: ["--no-proxy-server", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
    });
    cleanup.push(() => browser.close());
    const alice = await join(browser, baseURL, "Alice", "turn-tcp-rotate");
    const bob = await join(browser, baseURL, "Bob", "turn-tcp-rotate");
    for (const page of [alice, bob]) {
      await setPressed(page, "#mic");
      await setPressed(page, "#camera");
    }
    for (const page of [alice, bob]) {
      await page.waitForFunction(async () => {
        let frames = 0;
        (await window.__e2e.peers[0].getStats()).forEach((stat) => {
          if (stat.type === "inbound-rtp" && stat.kind === "video") frames += stat.framesDecoded || 0;
        });
        return frames > 5;
      }, null, { timeout: 30000, polling: 250 });
      await startContinuityMonitor(page);
    }
    await delay(1500);
    const continuityFrom = Date.now();
    const freezesBefore = [(await continuity(alice, continuityFrom, continuityFrom)).freezes,
      (await continuity(bob, continuityFrom, continuityFrom)).freezes];
    const videoCountersBefore = [await senderVideoCounters(alice), await senderVideoCounters(bob)];
    let bobAudio = (await state(bob)).audioPackets;
    const assertBobHearsAlice = async (label) => {
      await delay(1500);
      const next = (await state(bob)).audioPackets;
      assert.ok(next > bobAudio, `${label}: Bob's inbound audio stalled (${bobAudio} -> ${next})`);
      bobAudio = next;
    };

    // 1. Rotating method rotates on schedule without disturbing the session.
    let [current] = await until(alice, (s) => s.restarts.filter((r) => r.reason === "rotate").length >= 2,
      "two rotations on the rotating method", (rotateSeconds * 2 + 6) * 1000);
    assertSameSession(current, "rotating");
    assert.equal(current.applied, "turn-tcp-rotate");
    assert.equal(current.path, "relay/tcp");
    assert.equal(current.rotationActive, true);
    assert.equal(current.suspended, false, "an explicit rotating choice is never suspended by the probe");
    const rotations = current.restarts.filter((r) => r.reason === "rotate");
    const gapSeconds = (rotations[1].at - rotations[0].at) / 1000;
    assert.ok(gapSeconds >= rotateSeconds && gapSeconds <= rotateSeconds + 3,
      `rotation gap ${gapSeconds}s should be the interval plus about a second`);
    assert.ok(current.restarts.every((r) => r.reason === "rotate"), "rotation must not trigger recovery restarts");
    assert.doesNotMatch(current.statusText, /restart|reconnect|offline/i, "rotation must not change the visible status");
    await assertBobHearsAlice("rotating");
    console.log(`[rotation] 2 rotations, gap ${gapSeconds.toFixed(1)}s, path ${current.path}`);

    // Both participants rotated at least twice in this window; media must
    // not have paused for either of them.
    await until(bob, (s) => s.restarts.filter((r) => r.reason === "rotate").length >= 2,
      "two rotations for Bob", (rotateSeconds + 6) * 1000);
    await delay(1500);
    const continuityTo = Date.now();
    for (const [index, [name, page]] of [["Alice", alice], ["Bob", bob]].entries()) {
      const flow = await continuity(page, continuityFrom, continuityTo);
      console.log(`[continuity] ${name}: longest audio gap ${flow.audioGapMs} ms, longest video gap ` +
        `${flow.videoGapMs} ms (${flow.videoSamples} samples), freezes +${flow.freezes - freezesBefore[index]}`);
      assert.ok(flow.audioGapMs <= 400, `${name}: inbound audio paused ${flow.audioGapMs} ms across rotations`);
      assert.ok(flow.videoGapMs <= 600, `${name}: inbound video paused ${flow.videoGapMs} ms across rotations`);
      assert.equal(flow.freezes, freezesBefore[index], `${name}: video froze during rotations`);
      // A rotation loses no media, so it must not make anyone re-encode a
      // keyframe: the server sends no PLI for it and viewers have no reason to.
      const counters = await senderVideoCounters(page);
      const keyFrames = counters.keyFrames - videoCountersBefore[index].keyFrames;
      const plis = counters.plis - videoCountersBefore[index].plis;
      console.log(`[keyframes] ${name}: +${keyFrames} keyframes encoded, +${plis} PLIs received across the rotations`);
      assert.ok(plis === 0 && keyFrames <= 1,
        `${name}: rotations forced ${keyFrames} keyframes / ${plis} PLIs; a pure rotation needs none`);
      assert.equal(counters.serverRelayCandidates, 0,
        `${name}: a directly reachable server must not allocate TURN relays for itself`);
    }

    // 2. Rotating -> plain of the same transport: nothing to renegotiate.
    const restartsBeforePlain = current.restarts.length;
    await selectMethod(alice, "turn-tcp");
    let elapsed;
    [current, elapsed] = await until(alice, (s) => s.applied === "turn-tcp" && s.rotationActive === false,
      "rotating -> plain", 3000);
    assertSameSession(current, "plain");
    assert.equal(current.restarts.length, restartsBeforePlain, "plain <-> rotating must not send an ICE restart");
    await delay((rotateSeconds + 3) * 1000);
    current = await state(alice);
    assertSameSession(current, "plain after one interval");
    assert.equal(current.restarts.length, restartsBeforePlain, "the plain method must never rotate");
    assert.equal(current.path, "relay/tcp");
    await assertBobHearsAlice("plain");
    console.log(`[switch] rotating -> plain in ${elapsed} ms, no restart, no rotation for ${rotateSeconds + 3}s`);

    // 3. Plain relay -> direct: in-place configuration change.
    await selectMethod(alice, "direct");
    [current, elapsed] = await until(alice, (s) => s.applied === "direct" && s.connection === "connected" &&
      s.path !== null && !s.path.startsWith("relay"), "relay -> direct");
    assertSameSession(current, "direct");
    assert.equal(current.policy, "all");
    assert.equal(current.restarts.at(-1).reason, "switch");
    await assertBobHearsAlice("direct");
    console.log(`[switch] relay -> direct in ${elapsed} ms, path ${current.path}`);

    // 4. Direct -> rotating relay. Both directions must keep flowing while
    // the browser lets go of the old direct pair.
    const toRelayFrom = Date.now();
    await selectMethod(alice, "turn-tcp-rotate");
    [current, elapsed] = await until(alice, (s) => s.applied === "turn-tcp-rotate" && s.connection === "connected" &&
      s.path === "relay/tcp", "direct -> rotating relay", directToRelayBudgetMs);
    assertSameSession(current, "rotating again");
    assert.equal(current.policy, "relay");
    await delay(1000);
    const toRelayTo = Date.now();
    const aliceFlow = await continuity(alice, toRelayFrom, toRelayTo);
    const bobFlow = await continuity(bob, toRelayFrom, toRelayTo);
    console.log(`[switch] direct -> rotating relay in ${elapsed} ms; longest gap: Alice receiving ` +
      `${aliceFlow.audioGapMs} ms audio / ${aliceFlow.videoGapMs} ms video, Bob receiving ` +
      `${bobFlow.audioGapMs} ms audio / ${bobFlow.videoGapMs} ms video`);
    assert.ok(aliceFlow.audioGapMs <= 500 && bobFlow.audioGapMs <= 500,
      "audio must keep flowing in both directions during a direct -> relay switch");
    assert.ok(aliceFlow.videoGapMs <= 1000 && bobFlow.videoGapMs <= 1000,
      "video must keep flowing in both directions during a direct -> relay switch");
    await assertBobHearsAlice("rotating again");

    // 5. Automatic, then an early direct-path death: handoff to the relay in place.
    await alice.evaluate(() => localStorage.removeItem("meeting.directUdpFailAt"));
    await selectMethod(alice, "auto");
    [current, elapsed] = await until(alice, (s) => s.applied === "auto" && s.connection === "connected" &&
      s.path !== null && !s.path.startsWith("relay"), "rotating relay -> Automatic (direct)");
    assertSameSession(current, "automatic");
    console.log(`[switch] rotating relay -> Automatic in ${elapsed} ms, path ${current.path}`);
    // The app classifies a disconnect by its own once-a-second path sample.
    await until(alice, (s) => typeof s.measuredPath === "string" && s.measuredPath.startsWith("Direct/"),
      "the app's diagnostics see the direct path");
    /* global noteDirectLedDisconnectEpisode, peer, socket, socketGeneration, peerFirstConnectedAtMs:writable, directDisconnectCounted:writable */
    await alice.evaluate(() => {
      // Simulate what a UDP-policing path does: the direct pair dies moments
      // after the peer first connected.
      peerFirstConnectedAtMs = Date.now() - 1500;
      directDisconnectCounted = false;
      noteDirectLedDisconnectEpisode(peer, socket, socketGeneration);
    });
    [current, elapsed] = await until(alice, (s) => s.applied === "turn-tcp-rotate" && s.connection === "connected" &&
      s.path === "relay/tcp", "Automatic early-death handoff", directToRelayBudgetMs);
    assertSameSession(current, "automatic handoff");
    assert.equal(current.chosen, "auto", "the handoff must not change the user's choice");
    assert.ok(await alice.evaluate(() => Number(localStorage.getItem("meeting.directUdpFailAt")) > 0),
      "the handoff must remember the direct-UDP failure for later joins");
    await assertBobHearsAlice("automatic handoff");
    console.log(`[automatic] early direct death -> rotating relay in ${elapsed} ms, same socket and peer`);

    const bobFinal = await state(bob);
    assertSameSession(bobFinal, "Bob");
    assert.ok(bobFinal.restarts.every((r) => r.reason === "rotate"), "Bob only ever rotated");
    console.log("relay rotation e2e passed");
  } finally {
    for (const stop of cleanup.reverse()) {
      try {
        await stop();
      } catch (error) {
        console.error(`cleanup failed: ${error.message}`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
