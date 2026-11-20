#!/usr/bin/env node

// Browser end-to-end check for the TURN relay built into SlowMeet.
//
// It starts one local SlowMeet with TURN_SERVER_ENABLED and no other TURN
// process, then two headless Chromium participants with generated media:
//
//   1. Alice joins on "TURN over UDP" and Bob on "TURN over TCP": each is
//      connected through a relay candidate from the built-in relay, and audio
//      and video flow both ways through it
//   2. They swap methods in place: same WebSocket, same RTCPeerConnection
//   3. Alice switches to Direct and back to TURN over UDP
//   4. The server stops cleanly with the relay running
//
// Credentials are the ones SlowMeet issues to browsers; nothing is configured
// on the relay by hand. scripts/test-relay-rotation-e2e.js covers the rotating
// methods against an external TURN server.
//
// Opt-in (needs Chromium and a Go toolchain): make test-builtin-turn-e2e

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const dgram = require("node:dgram");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright-core");

const root = path.join(__dirname, "..");
const meetingPassword = "builtin-turn-e2e-password";
const turnSecret = "builtin-turn-e2e-secret";
// Chrome keeps the old pair selected until its own connectivity timeout (about
// 5 s) when the replacement ranks lower. Media keeps flowing meanwhile; only
// the reported path lags.
const switchBudgetMs = 9000;

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

// host undefined reserves on every address, for TCP and UDP, which is how the
// relay binds.
async function reservePort(host) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, host, resolve);
    });
    const { port } = server.address();
    await new Promise((resolve) => server.close(resolve));
    if (host !== undefined) return port;
    // A wildcard UDP bind fails if any single address holds the port.
    const udpFree = await new Promise((resolve) => {
      const socket = dgram.createSocket("udp4");
      socket.once("error", () => {
        try {
          socket.close();
        } catch (_) {
          // A socket that never bound may already be closed.
        }
        resolve(false);
      });
      socket.bind(port, () => socket.close(() => resolve(true)));
    });
    if (udpFree) return port;
  }
  throw new Error("no port is free for both TCP and UDP on every address");
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
    await Promise.race([new Promise((resolve) => handle.once("exit", resolve)), delay(15000)]);
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
    window.__e2e = { peers: [], sockets: [] };
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        window.__e2e.sockets.push(this);
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
  // The selector is rendered again when the ICE configuration arrives, which
  // puts a choice made before that back. iceConfigReady is the page's own
  // promise for it, settled after that rendering.
  /* global iceConfigReady */
  assert.equal(await page.evaluate(() => iceConfigReady), true, `${name} did not receive the ICE configuration`);
  await page.waitForFunction((id) => {
    const option = document.querySelector(`#join-connection-method option[value="${id}"]`);
    return option && !option.disabled;
  }, method, { timeout: 15000 });
  await page.selectOption("#join-connection-method", method);
  /* global connectionMethod */
  assert.deepEqual(
    await page.evaluate(() => [document.querySelector("#join-connection-method").value, connectionMethod]),
    [method, method], `${name} could not select ${method} on the join form`);
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
    let videoFrames = 0;
    stats.forEach((stat) => {
      if (stat.type === "transport" && stat.selectedCandidatePairId) pair = stats.get(stat.selectedCandidatePairId);
      if (stat.type === "inbound-rtp" && stat.kind === "audio") audioPackets += stat.packetsReceived || 0;
      if (stat.type === "inbound-rtp" && stat.kind === "video") videoFrames += stat.framesDecoded || 0;
    });
    const local = pair && stats.get(pair.localCandidateId);
    /* global appliedConnectionMethod, connectionMethod */
    return {
      connection: meetingPeer.connectionState,
      path: local ? `${local.candidateType}/${local.relayProtocol || local.protocol}` : null,
      policy: meetingPeer.getConfiguration().iceTransportPolicy,
      relayURL: local?.url || null,
      relayPort: local?.candidateType === "relay" ? local.port : null,
      sockets: window.__e2e.sockets.length,
      socketOpen: window.__e2e.sockets.at(-1)?.readyState === WebSocket.OPEN,
      meetingPeers: window.__e2e.peers.filter((candidate) => candidate.getSenders().length > 0).length,
      applied: appliedConnectionMethod,
      chosen: connectionMethod,
      audioPackets,
      videoFrames
    };
  });
}

async function setPressed(page, selector) {
  const button = page.locator(selector);
  if (await button.getAttribute("aria-pressed") !== "true") await button.click();
  await page.waitForFunction((buttonSelector) =>
    document.querySelector(buttonSelector)?.getAttribute("aria-pressed") === "true", selector, { timeout: 15000 });
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

// Both participants must keep receiving the other's audio and video.
async function assertMediaFlows(pages, label) {
  const before = await Promise.all(pages.map((page) => state(page)));
  await delay(2000);
  const after = await Promise.all(pages.map((page) => state(page)));
  after.forEach((current, index) => {
    const audio = current.audioPackets - before[index].audioPackets;
    const video = current.videoFrames - before[index].videoFrames;
    assert.ok(audio > 40, `${label}: participant ${index + 1} received only ${audio} audio packets in 2 s`);
    assert.ok(video > 5, `${label}: participant ${index + 1} decoded only ${video} video frames in 2 s`);
  });
}

async function main() {
  // Without a system Chrome, Playwright's own Chromium is used, as in CI
  // (npx playwright-core install chromium).
  const chromePath = findChrome();
  const goCache = process.env.GOCACHE || path.join(os.tmpdir(), "slowmeet-media-e2e-gocache");
  const cleanup = [];
  try {
    const turnPort = await reservePort();
    const httpPort = await reservePort("127.0.0.1");
    const configFile = path.join(os.tmpdir(), `slowmeet-builtin-turn-e2e-${process.pid}.json`);
    cleanup.push(async () => fs.rmSync(configFile, { force: true }));
    const server = startProcess("go", ["run", "."], {
      GOCACHE: goCache,
      HTTP_ADDR: `127.0.0.1:${httpPort}`,
      CONFIG_FILE: configFile,
      ICE_PUBLIC_IP: "127.0.0.1",
      ICE_TRANSPORT_POLICY: "all",
      ICE_UDP_PORT_MIN: "",
      ICE_UDP_PORT_MAX: "",
      MEETING_PASSWORD: meetingPassword,
      MAX_PARTICIPANTS: "2",
      // The built-in relay is the only TURN server in this test.
      TURN_SERVER_ENABLED: "true",
      TURN_SERVER_PORT: String(turnPort),
      TURN_SERVER_TLS_PORT: "0",
      TURN_SERVER_TLS_CERT_FILE: "",
      TURN_SERVER_TLS_KEY_FILE: "",
      TURN_SERVER_REALM: "",
      TURN_SERVER_RELAY_PORT_MIN: "",
      TURN_SERVER_RELAY_PORT_MAX: "",
      TURN_SERVER_RELAY_IP: "",
      TURN_URL: "",
      TURN_URLS: `turn:127.0.0.1:${turnPort}?transport=udp,turn:127.0.0.1:${turnPort}?transport=tcp`,
      TURN_SHARED_SECRET: turnSecret,
      TURN_CREDENTIAL_TTL_SECONDS: "",
      // Flow is measured as inbound audio packets; with DTX a silent source
      // sends one packet every 400 ms by design.
      OPUS_DTX_ENABLED: "false",
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
    assert.ok(server.output.join("").includes("turn_server_started"), "the built-in relay must report that it started");
    assert.ok(!server.output.join("").includes(turnSecret), "the shared secret must not be logged");
    // The relay must know the SFU's media ports, or it would forward to any
    // port and this test would not exercise its port check. The empty
    // ICE_UDP_PORT_* above select the default range.
    assert.match(server.output.join(""), /sfu_ports\W+50000-50100/,
      "the relay must restrict peers to the SFU's media port range");

    const iceConfig = await (await fetch(`${baseURL}/ice-config`)).json();
    const methods = Object.fromEntries(iceConfig.connection_methods.map((method) => [method.id, method]));
    assert.equal(methods["turn-udp"].enabled, true, "TURN over UDP must be offered for the built-in relay");
    assert.equal(methods["turn-tcp"].enabled, true, "TURN over TCP must be offered for the built-in relay");
    assert.equal(methods["turn-tls"].enabled, false, "TURN over TLS must not be offered without a turns: URL");
    assert.ok(JSON.stringify(iceConfig).includes(`turn:127.0.0.1:${turnPort}`), "browsers must be told the relay's address");
    assert.ok(!JSON.stringify(iceConfig).includes("credential"), "the public ICE configuration must carry no credentials");

    const launchOptions = {
      headless: process.env.MEDIA_E2E_HEADED !== "1",
      args: ["--no-proxy-server", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
    };
    if (chromePath) launchOptions.executablePath = chromePath;
    const browser = await chromium.launch(launchOptions);
    cleanup.push(() => browser.close());
    const alice = await join(browser, baseURL, "Alice", "turn-udp");
    const bob = await join(browser, baseURL, "Bob", "turn-tcp");
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
    }

    // 1. Both are on the built-in relay, each over its own transport.
    const relayURL = (transport) => `turn:127.0.0.1:${turnPort}?transport=${transport}`;
    const onRelay = (transport, method) => (s) => s.connection === "connected" &&
      s.path === `relay/${transport}` && s.applied === method;
    let [current, elapsed] = await until(alice, onRelay("udp", "turn-udp"), "Alice on TURN over UDP");
    assertSameSession(current, "Alice on TURN over UDP");
    assert.equal(current.policy, "relay", "a TURN method must force relay candidates");
    assert.equal(current.relayURL, relayURL("udp"), "Alice's relay candidate must come from the built-in relay");
    assert.ok(current.relayPort >= 49152 && current.relayPort <= 49999,
      `Alice's relay port ${current.relayPort} must be inside the relay port range`);
    [current] = await until(bob, onRelay("tcp", "turn-tcp"), "Bob on TURN over TCP");
    assertSameSession(current, "Bob on TURN over TCP");
    assert.equal(current.policy, "relay", "a TURN method must force relay candidates");
    assert.equal(current.relayURL, relayURL("tcp"), "Bob's relay candidate must come from the built-in relay");
    await assertMediaFlows([alice, bob], "TURN over UDP and TCP");
    console.log("[join] Alice relay/udp, Bob relay/tcp through the built-in relay; audio and video flow both ways");

    // 2. Swap methods in place.
    await selectMethod(alice, "turn-tcp");
    [current, elapsed] = await until(alice, onRelay("tcp", "turn-tcp"), "Alice TURN over UDP -> TCP");
    assertSameSession(current, "Alice after switching to TURN over TCP");
    console.log(`[switch] Alice relay/udp -> relay/tcp in ${elapsed} ms, same socket and peer`);
    await selectMethod(bob, "turn-udp");
    [current, elapsed] = await until(bob, onRelay("udp", "turn-udp"), "Bob TURN over TCP -> UDP");
    assertSameSession(current, "Bob after switching to TURN over UDP");
    console.log(`[switch] Bob relay/tcp -> relay/udp in ${elapsed} ms, same socket and peer`);
    await assertMediaFlows([alice, bob], "after swapping methods");

    // 3. Off the relay and back onto it.
    await selectMethod(alice, "direct");
    [current, elapsed] = await until(alice, (s) => s.connection === "connected" && s.applied === "direct" &&
      s.path !== null && !s.path.startsWith("relay/"), "Alice -> Direct");
    assertSameSession(current, "Alice on Direct");
    console.log(`[switch] Alice relay/tcp -> ${current.path} in ${elapsed} ms`);
    await selectMethod(alice, "turn-udp");
    [current, elapsed] = await until(alice, onRelay("udp", "turn-udp"), "Alice Direct -> TURN over UDP");
    assertSameSession(current, "Alice back on TURN over UDP");
    console.log(`[switch] Alice direct -> relay/udp in ${elapsed} ms`);
    await assertMediaFlows([alice, bob], "after returning to the relay");

    // 4. A clean stop with relayed calls just ended.
    await browser.close();
    await server.stop();
    const logs = server.output.join("");
    assert.ok(logs.includes("turn_server_stopped"), `the relay must stop with the server:\n${logs.slice(-2000)}`);
    assert.ok(logs.includes("server_stopped"), `the server must stop cleanly:\n${logs.slice(-2000)}`);
    console.log("built-in TURN relay e2e passed");
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
