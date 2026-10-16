#!/usr/bin/env node

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright-core");

const root = path.join(__dirname, "..");
const stabilityMs = Number(process.env.MEDIA_E2E_STABILITY_MS || 30000);
const headed = process.env.MEDIA_E2E_HEADED === "1";
const realDevices = process.env.MEDIA_E2E_REAL_MEDIA === "1";
const testScreenShare = process.env.MEDIA_E2E_SCREEN_SHARE === "1";
const firstCameraOnly = process.env.MEDIA_E2E_FIRST_CAMERA_ONLY === "1";
const microphoneOnly = process.env.MEDIA_E2E_MIC_ONLY === "1";
const idleOnly = process.env.MEDIA_E2E_IDLE_ONLY === "1";
const iceRestartOnly = process.env.MEDIA_E2E_ICE_RESTART_ONLY === "1";
const diagnosticWaitMs = Number(process.env.MEDIA_E2E_DIAGNOSTIC_WAIT_MS || 7000);
const pollIntervalMs = 1000;
const noProgressLimitMs = 5000;

if (!Number.isFinite(stabilityMs) || stabilityMs < 1000) {
  throw new Error("MEDIA_E2E_STABILITY_MS must be at least 1000 milliseconds");
}
if (testScreenShare && !headed) {
  throw new Error("MEDIA_E2E_SCREEN_SHARE=1 requires MEDIA_E2E_HEADED=1 so the native picker can be used");
}

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

function summarizePeerState(state) {
  return {
    connectionState: state.connectionState,
    iceConnectionState: state.iceConnectionState,
    signalingState: state.signalingState,
    peerConnectionCount: state.peerConnectionCount,
    framesDecoded: state.framesDecoded,
    videoBytesSent: state.videoBytesSent,
    videoBytesReceived: state.videoBytesReceived,
    audioBytesSent: state.audioBytesSent,
    audioBytesReceived: state.audioBytesReceived,
    candidatePair: state.candidatePair,
    videoRtpStats: state.videoRtpStats,
    candidatePairs: state.candidatePairs.slice(0, 8),
    acceptedRemoteCandidates: state.acceptedRemoteCandidates.slice(-8),
    iceCandidateErrors: state.iceCandidateErrors.slice(-4),
    transports: state.transports,
    remoteVideos: state.remoteVideos,
    transceivers: state.transceivers,
    localUfrag: state.localUfrag,
    remoteUfrag: state.remoteUfrag,
    connectionEvents: state.connectionEvents.slice(-8),
    signalingMessages: state.signalingMessages.filter((message) => message.type !== "network_state").slice(-12).map((message) => ({
      direction: message.direction,
      type: message.type,
      candidateType: message.candidateType,
      usernameFragment: message.usernameFragment,
      sdpMid: message.sdpMid,
      candidatePort: message.candidatePort,
      mids: message.mids,
      ufrags: message.ufrags,
      timestamp: message.timestamp
    }))
  };
}

async function reserveLocalPort(host) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(url, processHandle, output) {
  const deadline = Date.now() + 45000;
  let lastError;
  while (Date.now() < deadline) {
    if (processHandle.exitCode !== null) {
      throw new Error(`SlowMeet exited before becoming ready (code ${processHandle.exitCode})\n${output.join("")}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(250);
  }
  throw new Error(`SlowMeet did not become ready: ${lastError?.message || "timeout"}\n${output.join("")}`);
}

async function startLocalServer() {
  const host = process.env.MEDIA_E2E_HOST || "127.0.0.1";
  const port = await reserveLocalPort(host);
  const address = `${host}:${port}`;
  const output = [];
  const processHandle = spawn("go", ["run", "."], {
    cwd: root,
    env: {
      ...process.env,
      HTTP_ADDR: address,
      ICE_PUBLIC_IP: process.env.MEDIA_E2E_ICE_PUBLIC_IP ?? host,
      GOCACHE: process.env.GOCACHE || "/tmp/slowmeet-media-e2e-gocache"
    },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"]
  });
  processHandle.stdout.on("data", (chunk) => output.push(chunk.toString()));
  processHandle.stderr.on("data", (chunk) => output.push(chunk.toString()));
  await waitForServer(`http://${address}/`, processHandle, output);
  return {
    url: `http://${address}`,
    async stop() {
      if (processHandle.exitCode !== null) return;
      try {
        process.kill(-processHandle.pid, "SIGTERM");
      } catch (_) {
        processHandle.kill("SIGTERM");
      }
      await Promise.race([
        new Promise((resolve) => processHandle.once("exit", resolve)),
        delay(5000)
      ]);
      if (processHandle.exitCode === null) {
        try {
          process.kill(-processHandle.pid, "SIGKILL");
        } catch (_) {
          processHandle.kill("SIGKILL");
        }
      }
    },
    output
  };
}

async function waitForPeerConnection(page, expected = "connected", timeout = 30000) {
  await page.waitForFunction((state) => {
    const peer = window.__slowMeetTest?.peerConnections.at(-1);
    return peer && peer.connectionState === state &&
      (state !== "connected" || ["connected", "completed"].includes(peer.iceConnectionState));
  }, expected, { timeout });
}

async function waitForPeerStability(peers, stableMs = 3000, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let stableSince;
  let lastStates = [];
  while (Date.now() < deadline) {
    lastStates = await Promise.all(peers.map(diagnostics));
    const connected = lastStates.every((state) => state.connectionState === "connected" &&
      ["connected", "completed"].includes(state.iceConnectionState));
    if (!connected) {
      stableSince = undefined;
    } else {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableMs) return;
    }
    await delay(pollIntervalMs);
  }
  assert.fail(`peers did not stay connected for ${stableMs}ms: ${JSON.stringify(lastStates.map(summarizePeerState))}`);
}

async function diagnostics(page) {
  return page.evaluate(async () => {
    const peer = window.__slowMeetTest?.peerConnections.at(-1);
    if (!peer) return { peer: "missing" };
    const report = await peer.getStats();
    const stats = [...report.values()];
    const sum = (type, kind, field) => stats
      .filter((item) => item.type === type && (item.kind || item.mediaType) === kind)
      .reduce((total, item) => total + (Number(item[field]) || 0), 0);
    const remoteVideos = [...document.querySelectorAll("#participants video[data-media-role]")]
      .map((video) => ({
        role: video.dataset.mediaRole,
        width: video.videoWidth,
        height: video.videoHeight,
        currentTime: video.currentTime,
        paused: video.paused,
        participant: video.closest("li")?.textContent?.trim() || ""
      }));
    const selectedTransport = stats.find((item) => item.type === "transport");
    const selectedPair = stats.find((item) => item.type === "candidate-pair" &&
      item.id === selectedTransport?.selectedCandidatePairId) || stats.find((item) => item.type === "candidate-pair" &&
      (item.selected || (item.nominated && item.state === "succeeded")));
    const localCandidate = selectedPair && stats.find((item) => item.id === selectedPair.localCandidateId);
    const remoteCandidate = selectedPair && stats.find((item) => item.id === selectedPair.remoteCandidateId);
    const transports = stats.filter((item) => item.type === "transport").map((item) => ({
      id: item.id,
      iceState: item.iceState,
      dtlsState: item.dtlsState,
      selectedCandidatePairId: item.selectedCandidatePairId
    }));
    const candidatePairCount = stats.filter((item) => item.type === "candidate-pair").length;
    const videoRtpStats = stats.filter((item) =>
      (item.type === "inbound-rtp" || item.type === "outbound-rtp") &&
      (item.kind || item.mediaType) === "video").map((item) => ({
      type: item.type,
      ssrc: item.ssrc,
      packetsReceived: item.packetsReceived,
      packetsSent: item.packetsSent,
      packetsLost: item.packetsLost,
      bytesReceived: item.bytesReceived,
      bytesSent: item.bytesSent,
      framesReceived: item.framesReceived,
      framesDecoded: item.framesDecoded,
      framesDropped: item.framesDropped,
      framesEncoded: item.framesEncoded,
      keyFramesDecoded: item.keyFramesDecoded,
      keyFramesEncoded: item.keyFramesEncoded,
      nackCount: item.nackCount,
      pliCount: item.pliCount,
      firCount: item.firCount,
      jitter: item.jitter,
      jitterBufferDelay: item.jitterBufferDelay,
      jitterBufferEmittedCount: item.jitterBufferEmittedCount
    }));
    return {
      connectionState: peer.connectionState,
      iceConnectionState: peer.iceConnectionState,
      signalingState: peer.signalingState,
      peerConnectionCount: window.__slowMeetTest?.peerConnections.length || 0,
      localUfrag: peer.localDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "",
      remoteUfrag: peer.remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "",
      iceCandidateErrors: window.__slowMeetTest?.iceCandidateErrors || [],
      acceptedRemoteCandidates: window.__slowMeetTest?.acceptedRemoteCandidates || [],
      framesDecoded: sum("inbound-rtp", "video", "framesDecoded"),
      videoBytesReceived: sum("inbound-rtp", "video", "bytesReceived"),
      audioBytesReceived: sum("inbound-rtp", "audio", "bytesReceived"),
      audioBytesSent: sum("outbound-rtp", "audio", "bytesSent"),
      videoBytesSent: sum("outbound-rtp", "video", "bytesSent"),
      videoRtpStats,
      remoteVideos,
      candidatePair: selectedPair ? {
        state: selectedPair.state,
        nominated: selectedPair.nominated,
        requestsSent: selectedPair.requestsSent,
        responsesReceived: selectedPair.responsesReceived,
        bytesSent: selectedPair.bytesSent,
        bytesReceived: selectedPair.bytesReceived,
        local: localCandidate?.candidateType,
        remote: remoteCandidate?.candidateType,
        localAddress: localCandidate?.address,
        remoteAddress: remoteCandidate?.address,
        localPort: localCandidate?.port,
        remotePort: remoteCandidate?.port
      } : undefined,
      candidatePairs: stats.filter((item) => item.type === "candidate-pair" &&
        (item.state === "succeeded" || item.state === "in-progress" || item.selected || item.nominated))
        .slice(-20).map((item) => {
          const local = stats.find((candidate) => candidate.id === item.localCandidateId);
          const remote = stats.find((candidate) => candidate.id === item.remoteCandidateId);
          return {
            state: item.state,
            nominated: item.nominated,
            selected: item.selected,
            requestsSent: item.requestsSent,
            responsesReceived: item.responsesReceived,
            localAddress: local?.address,
            localPort: local?.port,
            remoteAddress: remote?.address,
            remotePort: remote?.port
          };
        }),
      transports,
      candidatePairCount,
      transceivers: peer.getTransceivers().map((transceiver) => ({
        kind: transceiver.receiver?.track?.kind,
        direction: transceiver.direction,
        currentDirection: transceiver.currentDirection,
        senderTrack: transceiver.sender?.track?.kind || null
      })),
      replaceTrackEvents: window.__slowMeetTest?.replaceTrackEvents || [],
      connectionEvents: window.__slowMeetTest?.connectionEvents.slice(-20) || [],
      signalingMessages: window.__slowMeetTest?.signalingMessages.slice(-20) || [],
      cameraButton: document.querySelector("#camera")?.getAttribute("aria-pressed"),
      micButton: document.querySelector("#mic")?.getAttribute("aria-pressed"),
      incomingVideoButton: document.querySelector("#receive-video")?.getAttribute("aria-pressed")
    };
  });
}

async function joinMeeting(context, name, baseURL) {
  const page = await context.newPage();
  page.on("pageerror", (error) => console.error(`[${name}] browser error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(`[${name}] console error: ${message.text()}`);
  });
  await page.addInitScript(() => {
    const NativePeerConnection = window.RTCPeerConnection;
    const NativeWebSocket = window.WebSocket;
    const originalReplaceTrack = RTCRtpSender.prototype.replaceTrack;
    const senderIDs = new WeakMap();
    let nextSenderID = 1;
    window.__slowMeetTest = {
      peerConnections: [],
      sockets: [],
      replaceTrackEvents: [],
      connectionEvents: [],
      iceCandidateErrors: [],
      acceptedRemoteCandidates: [],
      signalingMessages: []
    };
    const originalAddIceCandidate = NativePeerConnection.prototype.addIceCandidate;
    NativePeerConnection.prototype.addIceCandidate = async function addIceCandidate(candidate) {
      const candidateString = candidate?.candidate || "";
      const candidateInfo = {
        candidateType: candidateString.match(/\btyp\s+(\S+)/)?.[1],
        candidateAddress: candidateString.match(/\s([0-9a-f:.]+)\s\d+\s+typ\s/i)?.[1],
        candidatePort: candidateString.match(/\s(\d+)\s+typ\s/)?.[1],
        usernameFragment: candidate?.usernameFragment || candidateString.match(/\bufrag\s+(\S+)/)?.[1],
        sdpMid: candidate?.sdpMid,
        sdpMLineIndex: candidate?.sdpMLineIndex,
        remoteUfrag: this.remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || ""
      };
      try {
        const result = await originalAddIceCandidate.call(this, candidate);
        window.__slowMeetTest.acceptedRemoteCandidates.push(candidateInfo);
        return result;
      } catch (error) {
        window.__slowMeetTest.iceCandidateErrors.push({
          message: error.message,
          ...candidateInfo
        });
        throw error;
      }
    };
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(target, args, newTarget) {
        const connection = Reflect.construct(target, args, newTarget);
        window.__slowMeetTest.peerConnections.push(connection);
        for (const eventName of ["connectionstatechange", "iceconnectionstatechange", "signalingstatechange", "icecandidateerror"]) {
          connection.addEventListener(eventName, (event) => {
            window.__slowMeetTest.connectionEvents.push({
              event: eventName,
              connectionState: connection.connectionState,
              iceConnectionState: connection.iceConnectionState,
              signalingState: connection.signalingState,
              errorCode: event.errorCode,
              errorText: event.errorText,
              timestamp: Date.now()
            });
          });
        }
        return connection;
      }
    });
    window.WebSocket = new Proxy(NativeWebSocket, {
      construct(target, args, newTarget) {
        const socket = Reflect.construct(target, args, newTarget);
        window.__slowMeetTest.sockets.push(socket);
        socket.addEventListener("message", (event) => {
          try {
            const message = JSON.parse(event.data);
            const sdp = message.sdp || "";
            const passwords = [...sdp.matchAll(/^a=ice-pwd:(.+)$/gm)].map((match) => match[1]);
            window.__slowMeetTest.signalingMessages.push({
              direction: "in",
              type: message.type,
              candidateType: message.candidate?.match(/\btyp\s+(\S+)/)?.[1],
              usernameFragment: message.candidate?.match(/\bufrag\s+(\S+)/)?.[1],
              sdpMid: message.sdp_mid,
              candidatePort: message.candidate?.match(/\s(\d+)\s+typ\s/)?.[1],
              ufrags: [...sdp.matchAll(/^a=ice-ufrag:(.+)$/gm)].map((match) => match[1]),
              uniquePasswordCount: new Set(passwords).size,
              bundle: sdp.match(/^a=group:BUNDLE .+$/m)?.[0],
              mids: [...sdp.matchAll(/^a=mid:(.+)$/gm)].map((match) => match[1]),
              timestamp: Date.now()
            });
          } catch (_) {}
        });
        const originalSend = socket.send.bind(socket);
        socket.send = (data) => {
          try {
            const message = JSON.parse(data);
            const sdp = message.sdp || "";
            const passwords = [...sdp.matchAll(/^a=ice-pwd:(.+)$/gm)].map((match) => match[1]);
            window.__slowMeetTest.signalingMessages.push({
              direction: "out",
              type: message.type,
              candidateType: message.candidate?.match(/\btyp\s+(\S+)/)?.[1],
              usernameFragment: message.candidate?.match(/\bufrag\s+(\S+)/)?.[1],
              sdpMid: message.sdp_mid,
              candidatePort: message.candidate?.match(/\s(\d+)\s+typ\s/)?.[1],
              ufrags: [...sdp.matchAll(/^a=ice-ufrag:(.+)$/gm)].map((match) => match[1]),
              uniquePasswordCount: new Set(passwords).size,
              bundle: sdp.match(/^a=group:BUNDLE .+$/m)?.[0],
              mids: [...sdp.matchAll(/^a=mid:(.+)$/gm)].map((match) => match[1]),
              timestamp: Date.now()
            });
          } catch (_) {}
          return originalSend(data);
        };
        return socket;
      }
    });
    RTCRtpSender.prototype.replaceTrack = function replaceTrack(track) {
      let senderID = senderIDs.get(this);
      if (!senderID) {
        senderID = nextSenderID++;
        senderIDs.set(this, senderID);
      }
      window.__slowMeetTest.replaceTrackEvents.push({
        senderID,
        kind: this.track?.kind || track?.kind || "unknown",
        nextTrackId: track?.id || null
      });
      return originalReplaceTrack.call(this, track);
    };
  });
  await page.goto(`${baseURL}/`);
  await page.locator("#name").fill(name);
  await page.locator("#join").click();
  await page.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
  return page;
}

async function waitForRemoteCamera(page, senderName) {
  await page.waitForFunction((name) => {
    return [...document.querySelectorAll("#participants video[data-media-role='camera']")]
      .some((video) => video.closest("li")?.textContent?.includes(name) &&
        video.videoWidth > 0 && video.videoHeight > 0);
  }, senderName, { timeout: 30000 });
}

async function monitorCamera(label, senderName, receivingPage, peers, expectedPeerConnectionCounts, durationMs = stabilityMs) {
  await waitForRemoteCamera(receivingPage, senderName);
  const start = Date.now();
  let previousFrames = -1;
  let lastFrameProgressAt = start;
  let firstVideoTime;
  let lastVideoTime;
  let framesAtStart;
  let framesAtEnd;
  const diagnosticHistory = [];
  let lastDiagnosticAt = 0;
  while (Date.now() - start < durationMs) {
    const states = await Promise.all(peers.map(diagnostics));
    const sampledAt = Date.now();
    if (sampledAt - lastDiagnosticAt >= 1000) {
      lastDiagnosticAt = sampledAt;
      diagnosticHistory.push(states.map((state) => ({
        connectionState: state.connectionState,
        iceConnectionState: state.iceConnectionState,
        framesDecoded: state.framesDecoded,
        videoBytesSent: state.videoBytesSent,
        videoBytesReceived: state.videoBytesReceived,
        videoRtpStats: state.videoRtpStats.map(({ type, ssrc, packetsReceived, packetsSent, packetsLost,
          bytesReceived, bytesSent, framesDecoded: decoded, framesEncoded, keyFramesDecoded, keyFramesEncoded,
          nackCount, pliCount }) => ({
          type, ssrc, packetsReceived, packetsSent, packetsLost, bytesReceived, bytesSent,
          framesDecoded: decoded, framesEncoded, keyFramesDecoded, keyFramesEncoded, nackCount, pliCount
        })),
        remoteVideos: state.remoteVideos.map(({ role, width, height, currentTime, paused, participant }) => ({
          role, width, height, currentTime, paused, participant
        }))
      })));
      if (diagnosticHistory.length > 8) diagnosticHistory.shift();
    }
    const disconnected = states.find((state) => state.connectionState !== "connected" ||
      !["connected", "completed"].includes(state.iceConnectionState));
    if (disconnected) {
      assert.fail(`${label}: a peer left ICE connected during camera delivery: ${JSON.stringify(summarizePeerState(disconnected))}`);
    }
    const replacedPeer = states.find((state, index) =>
      state.peerConnectionCount !== expectedPeerConnectionCounts[index]);
    if (replacedPeer) {
      assert.fail(`${label}: a peer connection was replaced during camera delivery: ${JSON.stringify(states.map(summarizePeerState))}`);
    }
    const receiver = states[peers.indexOf(receivingPage)];
    const video = receiver.remoteVideos.find((entry) => entry.role === "camera" &&
      entry.participant.includes(senderName));
    assert.ok(video && video.width > 0 && video.height > 0,
      `${label}: remote camera has no decoded dimensions: ${JSON.stringify(summarizePeerState(receiver))}`);
    if (framesAtStart === undefined) framesAtStart = receiver.framesDecoded;
    framesAtEnd = receiver.framesDecoded;
    firstVideoTime ??= video.currentTime;
    lastVideoTime = video.currentTime;
    if (receiver.framesDecoded > previousFrames) {
      previousFrames = receiver.framesDecoded;
      lastFrameProgressAt = Date.now();
    } else if (Date.now() - lastFrameProgressAt > noProgressLimitMs) {
      assert.fail(`${label}: decoded-frame count stopped advancing: ${JSON.stringify({
        framesAtStart,
        framesAtEnd,
        diagnosticHistory
      })}`);
    }
    await delay(Math.min(pollIntervalMs, Math.max(1, durationMs - (Date.now() - start))));
  }
  assert.ok(framesAtEnd > framesAtStart,
    `${label}: no additional frames decoded in ${durationMs}ms (start=${framesAtStart}, end=${framesAtEnd})`);
  assert.ok(lastVideoTime > firstVideoTime,
    `${label}: remote video time did not advance (start=${firstVideoTime}, end=${lastVideoTime})`);
  console.log(`[pass] ${label}: ${framesAtStart} -> ${framesAtEnd} decoded frames over ${durationMs}ms`);
}

async function assertRemoteVideoMoves(page, role, label) {
  await page.waitForFunction((mediaRole) => [...document.querySelectorAll(`#participants video[data-media-role='${mediaRole}']`)]
    .some((video) => video.videoWidth > 0 && video.videoHeight > 0 && !video.paused), role, { timeout: 30000 });
  const startTime = await page.evaluate((mediaRole) => Math.max(0, ...[...document.querySelectorAll(`#participants video[data-media-role='${mediaRole}']`)]
    .map((video) => video.currentTime)), role);
  await page.waitForFunction(({ mediaRole, previousTime }) => [...document.querySelectorAll(`#participants video[data-media-role='${mediaRole}']`)]
    .some((video) => video.videoWidth > 0 && video.videoHeight > 0 && video.currentTime > previousTime + 0.5),
  { mediaRole: role, previousTime: startTime }, { timeout: 15000 });
  console.log(`[pass] ${label}: remote ${role} video time advanced`);
}

async function waitForAudioProgress(sender, receiver) {
  const before = await diagnostics(receiver);
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const [senderState, receiverState] = await Promise.all([diagnostics(sender), diagnostics(receiver)]);
    if (senderState.audioBytesSent > 0 && receiverState.audioBytesReceived > before.audioBytesReceived) return;
    await delay(250);
  }
  assert.fail(`unmuted audio did not reach the other peer: ${JSON.stringify({ sender: await diagnostics(sender), receiver: await diagnostics(receiver) })}`);
}

async function testMicrophoneControls(pageA, pageB, browser, baseURL) {
  await pageA.locator("#mic").click();
  await pageA.waitForFunction(() => document.querySelector("#mic")?.getAttribute("aria-pressed") === "true");
  await waitForAudioProgress(pageA, pageB);
  await pageA.locator("#mic").click();
  await pageA.waitForFunction(() => document.querySelector("#mic")?.getAttribute("aria-pressed") === "false");
  await pageB.locator("#mic").click();
  await pageB.waitForFunction(() => document.querySelector("#mic")?.getAttribute("aria-pressed") === "true");
  await waitForAudioProgress(pageB, pageA);
  console.log("[pass] microphone permission, mute/unmute, and remote audio packets in both directions");
}

async function requestIceRestart(page) {
  const oldUfrag = await page.evaluate(() => {
    const peer = window.__slowMeetTest.peerConnections.at(-1);
    return peer.remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "";
  });
  await page.evaluate(() => {
    const socket = window.__slowMeetTest?.sockets.at(-1);
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error("signaling socket is not open");
    }
    socket.send(JSON.stringify({ version: 1, type: "ice_restart" }));
  });
  await page.waitForFunction((previousUfrag) => {
    const peer = window.__slowMeetTest.peerConnections.at(-1);
    const nextUfrag = peer?.remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "";
    return nextUfrag && nextUfrag !== previousUfrag && peer.signalingState === "stable";
  }, oldUfrag, { timeout: 30000 });
  await waitForPeerConnection(page);
}

async function testUnavailableMicrophone(browser, baseURL) {
  const context = await browser.newContext();
  await context.grantPermissions(["camera", "microphone"], { origin: baseURL });
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints?.audio) {
        return Promise.reject(new DOMException("Requested microphone is unavailable", "NotFoundError"));
      }
      return original(constraints);
    };
  });
  const page = await joinMeeting(context, "No microphone", baseURL);
  await waitForPeerConnection(page);
  await page.waitForFunction(() => document.querySelector("#mic")?.disabled === true);
  assert.equal(await page.locator("#mic").getAttribute("aria-label"), "Microphone unavailable");
  console.log("[pass] unavailable microphone: meeting joined and microphone control is disabled");
  await context.close();
}

async function testHeadedScreenShare(pageA, pageB, peers) {
  console.log("[screen] Select a screen or window in Chromium's native picker when it opens.");
  await pageA.locator("#screen").click();
  await pageA.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true", null, { timeout: 60000 });
  await assertRemoteVideoMoves(pageB, "screen", "first screen share");
  await pageA.locator("#screen").click();
  await pageA.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false");
  await pageA.locator("#screen").click();
  await pageA.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true", null, { timeout: 60000 });
  await assertRemoteVideoMoves(pageB, "screen", "screen share after toolbar stop");
  console.log("[pass] headed screen share: share, toolbar stop, and share again");

  await pageA.evaluate(() => {
    const track = typeof screenStream === "undefined" ? undefined : screenStream?.getVideoTracks()[0];
    if (!track) throw new Error("active screen source track is missing");
    window.__slowMeetTest.browserStoppedScreenShare = false;
    track.addEventListener("ended", () => {
      window.__slowMeetTest.browserStoppedScreenShare = true;
    }, { once: true });
  });
  console.log("[screen] Stop sharing from Chromium's browser sharing indicator now.");
  await pageA.waitForFunction(() => window.__slowMeetTest?.browserStoppedScreenShare === true, null, { timeout: 120000 });
  await pageA.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false", null, { timeout: 15000 });
  await pageA.locator("#screen").click();
  await pageA.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true", null, { timeout: 60000 });
  await assertRemoteVideoMoves(pageB, "screen", "screen share after browser-level stop");
  console.log("[pass] headed screen share: restarted after the native browser stop event");
  await pageA.locator("#screen").click();
  await Promise.all(peers.map(waitForPeerConnection));
}

async function main() {
  const server = process.env.MEDIA_E2E_BASE_URL
    ? undefined
    : await startLocalServer();
  const baseURL = (process.env.MEDIA_E2E_BASE_URL || server.url).replace(/\/$/, "");
  const chromePath = findChrome();
  const launchOptions = {
    headless: !headed,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--force-webrtc-ip-handling-policy=default_public_interface_only",
      `--unsafely-treat-insecure-origin-as-secure=${baseURL}`,
      "--autoplay-policy=no-user-gesture-required",
      "--disable-features=WebRtcHideLocalIpsWithMdns"
    ]
  };
  const browserHost = new URL(baseURL).hostname.replace(/^\[|\]$/g, "");
  if (browserHost === "localhost" || browserHost === "127.0.0.1" || browserHost === "::1") {
    launchOptions.args.push("--allow-loopback-in-peer-connection");
  }
  if (chromePath) launchOptions.executablePath = chromePath;
  if (!realDevices) {
    launchOptions.args.push("--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream");
  }

  let browser;
  const contexts = [];
  try {
    browser = await chromium.launch(launchOptions);
    const origin = new URL(baseURL).origin;
    const contextA = await browser.newContext();
    const contextB = await browser.newContext();
    contexts.push(contextA, contextB);
    await Promise.all([contextA, contextB].map((context) =>
      context.grantPermissions(["camera", "microphone"], { origin })));
    const pageA = await joinMeeting(contextA, "Media A", baseURL);
    const pageB = await joinMeeting(contextB, "Media B", baseURL);
    const peers = [pageA, pageB];
    await Promise.all(peers.map((page) => waitForPeerConnection(page, "connected", 15000)));
    console.log("[pass] two isolated Chromium contexts joined and connected");
    await waitForPeerStability(peers, 3000, 20000);
    console.log("[pass] both peers remained connected through the startup ICE recovery window");
    const expectedPeerConnectionCounts = await Promise.all(peers.map((page) =>
      page.evaluate(() => window.__slowMeetTest.peerConnections.length)));
    assert.deepEqual(expectedPeerConnectionCounts, [1, 1], "expected one peer connection per participant before media starts");

    if (idleOnly) {
      await waitForPeerStability(peers, stabilityMs, stabilityMs + 30000);
      console.log(`[pass] both idle peer connections remained connected for ${stabilityMs}ms`);
      return;
    }

    if (microphoneOnly) {
      await testMicrophoneControls(pageA, pageB, browser, baseURL);
      await testUnavailableMicrophone(browser, baseURL);
      console.log("Stopped after microphone diagnostics as requested.");
      return;
    }

    if (iceRestartOnly) {
      await pageA.locator("#camera").click();
      await pageA.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
      await pageB.locator("#camera").click();
      await pageB.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
      await Promise.all([
        monitorCamera("before ICE restart A -> B", "Media A", pageB, peers, expectedPeerConnectionCounts),
        monitorCamera("before ICE restart B -> A", "Media B", pageA, peers, expectedPeerConnectionCounts)
      ]);
      await requestIceRestart(pageA);
      await Promise.all([
        monitorCamera("ICE restart from A -> B", "Media A", pageB, peers, expectedPeerConnectionCounts),
        monitorCamera("ICE restart from A -> A receives B", "Media B", pageA, peers, expectedPeerConnectionCounts)
      ]);
      await requestIceRestart(pageB);
      await Promise.all([
        monitorCamera("ICE restart from B -> A", "Media B", pageA, peers, expectedPeerConnectionCounts),
        monitorCamera("ICE restart from B -> B receives A", "Media A", pageB, peers, expectedPeerConnectionCounts)
      ]);
      console.log("Stopped after bidirectional ICE-restart diagnostics as requested.");
      return;
    }

    await pageA.locator("#camera").click();
    await pageA.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
    await monitorCamera("A first camera enable -> B", "Media A", pageB, peers, expectedPeerConnectionCounts);
    if (firstCameraOnly) {
      console.log("Stopped after first-camera diagnostic as requested.");
      return;
    }

    await pageA.locator("#camera").click();
    await pageA.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "false");
    await pageA.waitForFunction(() => window.__slowMeetTest.replaceTrackEvents.some((event) =>
      event.kind === "video" && event.nextTrackId === null));
    const stoppedSenderID = await pageA.evaluate(() => window.__slowMeetTest.replaceTrackEvents
      .filter((event) => event.kind === "video" && event.nextTrackId === null).at(-1)?.senderID);
    await pageA.locator("#camera").click();
    await pageA.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
    await pageA.waitForFunction((senderID) => window.__slowMeetTest.replaceTrackEvents.some((event) =>
      event.senderID === senderID && event.kind === "video" && event.nextTrackId !== null), stoppedSenderID);
    const resumedSenderID = await pageA.evaluate(() => window.__slowMeetTest.replaceTrackEvents
      .filter((event) => event.kind === "video" && event.nextTrackId !== null).at(-1)?.senderID);
    assert.equal(resumedSenderID, stoppedSenderID, "camera resume should reuse the established video sender");
    await monitorCamera("A camera off/on -> B", "Media A", pageB, peers, expectedPeerConnectionCounts);

    await pageB.locator("#receive-video").click();
    await pageB.waitForFunction(() => document.querySelector("#receive-video")?.getAttribute("aria-pressed") === "false");
    await pageB.locator("#receive-video").click();
    await pageB.waitForFunction(() => document.querySelector("#receive-video")?.getAttribute("aria-pressed") === "true");
    await monitorCamera("B incoming video off/on, A keeps sending", "Media A", pageB, peers, expectedPeerConnectionCounts);

    await pageB.locator("#camera").click();
    await pageB.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
    await Promise.all([
      monitorCamera("A receives B while both cameras are on", "Media B", pageA, peers, expectedPeerConnectionCounts),
      monitorCamera("B receives A while both cameras are on", "Media A", pageB, peers, expectedPeerConnectionCounts)
    ]);

    await pageA.locator("#receive-video").click();
    await pageA.waitForFunction(() => document.querySelector("#receive-video")?.getAttribute("aria-pressed") === "false");
    await pageA.locator("#receive-video").click();
    await pageA.waitForFunction(() => document.querySelector("#receive-video")?.getAttribute("aria-pressed") === "true");
    await monitorCamera("A incoming video off/on, B keeps sending", "Media B", pageA, peers, expectedPeerConnectionCounts);

    await pageB.locator("#camera").click();
    await pageB.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "false");
    await pageB.waitForFunction(() => window.__slowMeetTest.replaceTrackEvents.some((event) =>
      event.kind === "video" && event.nextTrackId === null));
    const stoppedSenderBID = await pageB.evaluate(() => window.__slowMeetTest.replaceTrackEvents
      .filter((event) => event.kind === "video" && event.nextTrackId === null).at(-1)?.senderID);
    await pageB.locator("#camera").click();
    await pageB.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
    await pageB.waitForFunction((senderID) => window.__slowMeetTest.replaceTrackEvents.some((event) =>
      event.senderID === senderID && event.kind === "video" && event.nextTrackId !== null), stoppedSenderBID);
    const resumedSenderBID = await pageB.evaluate(() => window.__slowMeetTest.replaceTrackEvents
      .filter((event) => event.kind === "video" && event.nextTrackId !== null).at(-1)?.senderID);
    assert.equal(resumedSenderBID, stoppedSenderBID, "camera resume should reuse the established video sender");
    await monitorCamera("B camera off/on -> A", "Media B", pageA, peers, expectedPeerConnectionCounts);

    await testMicrophoneControls(pageA, pageB, browser, baseURL);

    const beforeA = await pageA.evaluate(() => window.__slowMeetTest.peerConnections.at(-1).remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "");
    await requestIceRestart(pageA);
    const afterA = await pageA.evaluate(() => window.__slowMeetTest.peerConnections.at(-1).remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "");
    assert.notEqual(afterA, beforeA, "A's ICE restart should negotiate new ICE credentials");
    await Promise.all([
      monitorCamera("ICE restart from A -> B", "Media A", pageB, peers, expectedPeerConnectionCounts),
      monitorCamera("ICE restart from A -> A receives B", "Media B", pageA, peers, expectedPeerConnectionCounts)
    ]);

    await requestIceRestart(pageB);
    await Promise.all([
      monitorCamera("ICE restart from B -> A", "Media B", pageA, peers, expectedPeerConnectionCounts),
      monitorCamera("ICE restart from B -> B receives A", "Media A", pageB, peers, expectedPeerConnectionCounts)
    ]);

    if (testScreenShare) await testHeadedScreenShare(pageA, pageB, peers);
    await testUnavailableMicrophone(browser, baseURL);
    console.log("All media E2E checks passed.");
  } catch (error) {
    console.error(error.message || error);
    if (contexts.length > 0) await delay(diagnosticWaitMs);
    for (const context of contexts) {
      for (const page of context.pages()) {
        try {
          const state = await diagnostics(page);
          console.error(`[diagnostics] ${page.url()}: ${JSON.stringify({
            ...summarizePeerState(state),
            replaceTrackEvents: state.replaceTrackEvents
          })}`);
        } catch (_) {}
      }
    }
    if (server?.output.length) {
      const stateLogs = server.output.filter((line) =>
        /webrtc_(connected|failed|state_changed)|network_degraded|media_publication_(duplicate_track|read_stopped)/.test(line));
      console.error(`[server ICE logs]\n${stateLogs.slice(-30).join("")}`);
    }
    process.exitCode = 1;
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close().catch(() => {});
    await server?.stop();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
