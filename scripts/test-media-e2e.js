#!/usr/bin/env node

const assert = require("node:assert/strict");
const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { chromium } = require("playwright-core");
const axeCore = (() => {
  try {
    return require("axe-core");
  } catch (_) {
    return undefined;
  }
})();
const participantFlowScenarios = require("./media-e2e/participant-flows").scenarios;
const mediaLifecycleScenarios = require("./media-e2e/media-lifecycle").scenarios;
const { installCameraQualityRecorder, validateCameraQualityReports } = require("./media-e2e/camera-quality");

const root = path.join(__dirname, "..");
const stabilityMs = Number(process.env.MEDIA_E2E_STABILITY_MS || 30000);
const headed = process.env.MEDIA_E2E_HEADED === "1";
const realDevices = process.env.MEDIA_E2E_REAL_MEDIA === "1";
const testScreenShare = process.env.MEDIA_E2E_SCREEN_SHARE === "1";
const testNativeScreenShare = process.env.MEDIA_E2E_SCREEN_SHARE_NATIVE === "1";
const screenShareOnly = process.env.MEDIA_E2E_SCREEN_SHARE_ONLY === "1";
const testNetworkImpairment = process.env.MEDIA_E2E_NETWORK_IMPAIRMENT === "1";
const testNetworkNamespace = process.env.MEDIA_E2E_NETNS === "1";
const suiteProfile = process.env.MEDIA_E2E_PROFILE || (screenShareOnly ? "screen-share" : "full");
const requestedScenario = process.env.MEDIA_E2E_SCENARIO;
const externalBaseURL = process.env.MEDIA_E2E_BASE_URL;
const testMeetingPassword = process.env.MEDIA_E2E_MEETING_PASSWORD ??
  (externalBaseURL ? "" : "slowmeet-e2e-password");
const deviceFixtures = !realDevices && process.env.MEDIA_E2E_DEVICE_FIXTURES !== "0";
const screenSourceTitle = process.env.MEDIA_E2E_SCREEN_SOURCE_TITLE || "SlowMeet E2E Changing Content";
const diagnosticWaitMs = Number(process.env.MEDIA_E2E_DIAGNOSTIC_WAIT_MS || 7000);
const pollIntervalMs = 1000;
const noProgressLimitMs = 5000;
const cameraStopObservationMs = 1200;
const cameraStopTimeoutMs = 8000;
const cameraQualitySettleMs = 500;
const cameraQualityWindowMs = 5000;
const mediaProgressTimeoutMs = 15000;
const mediaProgressPollMs = 250;
const transientDisconnectGraceMs = 0;

if (!Number.isFinite(stabilityMs) || stabilityMs < 1000) {
  throw new Error("MEDIA_E2E_STABILITY_MS must be at least 1000 milliseconds");
}
if ((testScreenShare || testNativeScreenShare) && !headed) {
  throw new Error("screen-share E2E requires MEDIA_E2E_HEADED=1");
}
if (screenShareOnly && !testScreenShare) {
  throw new Error("MEDIA_E2E_SCREEN_SHARE_ONLY=1 requires MEDIA_E2E_SCREEN_SHARE=1");
}
if (testNetworkImpairment && !testNetworkNamespace) {
  throw new Error("MEDIA_E2E_NETWORK_IMPAIRMENT=1 must run through scripts/test-media-e2e-netns.sh");
}
if (!["full", "network", "screen-share", "real-media"].includes(suiteProfile)) {
  throw new Error("MEDIA_E2E_PROFILE must be full, network, screen-share, or real-media");
}
if (suiteProfile === "network" && (!testNetworkNamespace || !testNetworkImpairment)) {
  throw new Error("the network profile must run through scripts/test-media-e2e-netns.sh");
}
if (suiteProfile === "screen-share" && !testScreenShare && !testNativeScreenShare) {
  throw new Error("the screen-share profile requires MEDIA_E2E_SCREEN_SHARE=1 or MEDIA_E2E_SCREEN_SHARE_NATIVE=1");
}
if (suiteProfile === "real-media" && (!realDevices || !headed)) {
  throw new Error("the real-media profile requires MEDIA_E2E_REAL_MEDIA=1 and MEDIA_E2E_HEADED=1");
}
if (suiteProfile === "full" && realDevices) {
  throw new Error("real capture devices use MEDIA_E2E_PROFILE=real-media; the full profile uses generated media");
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
    socketCount: state.socketCount,
    framesDecoded: state.framesDecoded,
    networkQuality: state.networkQuality,
    connectionUI: state.connectionUI,
    participantTiles: state.participantTiles,
    adaptationState: state.adaptationState,
    videoBytesSent: state.videoBytesSent,
    videoBytesReceived: state.videoBytesReceived,
    audioBytesSent: state.audioBytesSent,
    audioBytesReceived: state.audioBytesReceived,
    audioStats: state.audioStats,
    audioRtpStats: state.audioRtpStats,
    candidatePair: state.candidatePair,
    videoRtpStats: state.videoRtpStats,
    videoSenderStats: state.videoSenderStats,
    candidatePairs: state.candidatePairs.slice(0, 8),
    acceptedRemoteCandidates: state.acceptedRemoteCandidates.slice(-8),
    iceCandidateErrors: state.iceCandidateErrors.slice(-4),
    transports: state.transports,
    remoteVideos: state.remoteVideos,
    remoteAudios: state.remoteAudios,
    remoteParticipants: state.remoteParticipants,
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

async function startLocalServer(maxParticipants = 2) {
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
      MEETING_PASSWORD: testMeetingPassword,
      MAX_PARTICIPANTS: String(maxParticipants),
      RECONNECT_TIMEOUT_SECONDS: "1",
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

async function waitForPeerSignalingStable(page, timeout = 30000) {
  await page.waitForFunction(() => window.__slowMeetTest?.peerConnections.at(-1)?.signalingState === "stable",
    null, { timeout });
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
    const receivers = peer.getReceivers();
    const remoteVideos = await Promise.all([...document.querySelectorAll("#participants video[data-media-role]")]
      .map(async (video) => {
        const item = video.closest("li");
        const videoTracks = video.srcObject?.getVideoTracks?.() || [];
        const inboundVideoStats = [];
        for (const track of videoTracks) {
          const receiver = receivers.find((candidate) => candidate.track?.id === track.id);
          if (!receiver?.getStats) continue;
          try {
            const receiverReport = await receiver.getStats();
            for (const stat of receiverReport.values()) {
              if (stat.type !== "inbound-rtp" || (stat.kind || stat.mediaType) !== "video") continue;
              inboundVideoStats.push({
                trackIdentifier: stat.trackIdentifier || track.id,
                bytesReceived: stat.bytesReceived,
                packetsReceived: stat.packetsReceived,
                framesReceived: stat.framesReceived,
                framesDecoded: stat.framesDecoded,
                jitterBufferMinimumDelay: stat.jitterBufferMinimumDelay,
                jitterBufferTargetDelay: stat.jitterBufferTargetDelay,
                jitterBufferEmittedCount: stat.jitterBufferEmittedCount,
                supportsJitterBufferTarget: "jitterBufferTarget" in receiver,
                jitterBufferTarget: receiver.jitterBufferTarget ?? null,
                timestamp: stat.timestamp
              });
            }
          } catch (_) {}
        }
        return {
          role: video.dataset.mediaRole,
          width: video.videoWidth,
          height: video.videoHeight,
          currentTime: video.currentTime,
          paused: video.paused,
          participant: item?.textContent?.trim() || "",
          cameraState: item?.dataset.camera || "unknown",
          microphoneState: item?.dataset.mic || "unknown",
          receiveVideo: item?.dataset.receiveVideo,
          sharing: item?.dataset.sharing,
          trackIDs: videoTracks.map((track) => track.id),
          inboundVideoStats
        };
      }));
    const remoteParticipants = [...document.querySelectorAll("#participants li[data-participant-id]")]
      .map((item) => ({
        participantID: item.dataset.participantId,
        name: item.textContent?.trim() || "",
        local: item.classList.contains("is-local"),
        cameraState: item.dataset.camera || "unknown",
        microphoneState: item.dataset.mic || "unknown",
        receiveVideo: item.dataset.receiveVideo,
        sharing: item.dataset.sharing
      }));
    const remoteAudios = [...document.querySelectorAll("#participants li[data-participant-id] audio")]
      .map((audio) => ({
        participantID: audio.closest("li")?.dataset.participantId || "",
        participant: audio.closest("li")?.textContent?.trim() || "",
        currentTime: audio.currentTime,
        paused: audio.paused,
        readyState: audio.readyState,
        muted: audio.muted,
        volume: audio.volume,
        audioTracks: audio.srcObject?.getAudioTracks?.().map((track) => ({
          readyState: track.readyState,
          enabled: track.enabled,
          muted: track.muted
        })) || []
      }));
    const localAudioTrack = window.__slowMeetTest?.capturedTracks?.find((entry) =>
      entry.kind === "audio" && entry.track?.readyState === "live")?.track;
    const audioCaptureSettings = localAudioTrack?.getSettings?.() || null;
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
      trackIdentifier: item.trackIdentifier || report.get(item.trackId)?.trackIdentifier,
      trackId: item.trackId,
      mid: item.mid,
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
    const audioRtpStats = stats.filter((item) =>
      (item.type === "inbound-rtp" || item.type === "outbound-rtp") &&
      (item.kind || item.mediaType) === "audio").map((item) => ({
      type: item.type,
      ssrc: item.ssrc,
      packetsReceived: item.packetsReceived,
      packetsSent: item.packetsSent,
      packetsLost: item.packetsLost,
      bytesReceived: item.bytesReceived,
      bytesSent: item.bytesSent,
      trackIdentifier: item.trackIdentifier || report.get(item.trackId)?.trackIdentifier,
      trackId: item.trackId,
      mid: item.mid,
      jitter: item.jitter,
      jitterBufferDelay: item.jitterBufferDelay,
      jitterBufferEmittedCount: item.jitterBufferEmittedCount,
      totalSamplesReceived: item.totalSamplesReceived,
      concealedSamples: item.concealedSamples,
      concealmentEvents: item.concealmentEvents,
      audioLevel: item.audioLevel
    }));
    const summarizeAudioRtp = (type) => {
      const items = audioRtpStats.filter((item) => item.type === type);
      const sumField = (field) => items.reduce((total, item) => total + (Number(item[field]) || 0), 0);
      const sumOptionalField = (field) => {
        const values = items.map((item) => item[field]).filter(Number.isFinite);
        return values.length ? values.reduce((total, value) => total + value, 0) : null;
      };
      const jitterValues = items.map((item) => item.jitter).filter(Number.isFinite);
      const jitterBufferDelay = sumField("jitterBufferDelay");
      const jitterBufferDelayAvailable = items.some((item) => Number.isFinite(item.jitterBufferDelay));
      const jitterBufferEmittedCount = sumOptionalField("jitterBufferEmittedCount");
      const packetsReceived = sumField("packetsReceived");
      const packetsLost = type === "inbound-rtp" ? sumOptionalField("packetsLost") : null;
      const totalPackets = packetsReceived + (packetsLost || 0);
      return {
        streams: items.length,
        bytesSent: sumField("bytesSent"),
        bytesReceived: sumField("bytesReceived"),
        packetsSent: sumField("packetsSent"),
        packetsReceived,
        packetsLost,
        packetLossPct: totalPackets > 0 && packetsLost !== null
          ? Number((packetsLost / totalPackets * 100).toFixed(2)) : null,
        jitterMs: jitterValues.length ? Math.max(...jitterValues) * 1000 : null,
        jitterBufferDelayTotalMs: jitterBufferDelayAvailable ? jitterBufferDelay * 1000 : null,
        jitterBufferDelayMs: jitterBufferDelayAvailable && jitterBufferEmittedCount > 0
          ? jitterBufferDelay / jitterBufferEmittedCount * 1000 : null,
        jitterBufferEmittedCount,
        totalSamplesReceived: sumOptionalField("totalSamplesReceived"),
        concealedSamples: sumOptionalField("concealedSamples"),
        concealmentEvents: sumOptionalField("concealmentEvents")
      };
    };
    const audioStats = {
      outbound: summarizeAudioRtp("outbound-rtp"),
      inbound: summarizeAudioRtp("inbound-rtp")
    };
    const videoSenderStats = await Promise.all((window.__slowMeetTest?.videoSenders || []).map(async ({ senderID, sender }) => {
      try {
        const senderReport = await sender.getStats();
        const outbound = [...senderReport.values()].filter((item) => item.type === "outbound-rtp" &&
          (item.kind || item.mediaType) === "video");
        return {
          senderID,
          trackID: sender.track?.id || null,
          bytesSent: outbound.reduce((total, item) => total + (Number(item.bytesSent) || 0), 0),
          packetsSent: outbound.reduce((total, item) => total + (Number(item.packetsSent) || 0), 0),
          framesEncoded: outbound.reduce((total, item) => total + (Number(item.framesEncoded) || 0), 0),
          keyFramesEncoded: outbound.reduce((total, item) => total + (Number(item.keyFramesEncoded) || 0), 0)
        };
      } catch (_) {
        return { senderID, trackID: sender.track?.id || null, bytesSent: 0, packetsSent: 0, framesEncoded: 0 };
      }
    }));
    return {
      connectionState: peer.connectionState,
      iceConnectionState: peer.iceConnectionState,
      signalingState: peer.signalingState,
      peerConnectionCount: window.__slowMeetTest?.peerConnections.length || 0,
      socketCount: window.__slowMeetTest?.sockets.length || 0,
      localUfrag: peer.localDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "",
      remoteUfrag: peer.remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "",
      iceCandidateErrors: window.__slowMeetTest?.iceCandidateErrors || [],
      acceptedRemoteCandidates: window.__slowMeetTest?.acceptedRemoteCandidates || [],
      framesDecoded: sum("inbound-rtp", "video", "framesDecoded"),
      videoBytesReceived: sum("inbound-rtp", "video", "bytesReceived"),
      audioBytesReceived: sum("inbound-rtp", "audio", "bytesReceived"),
      audioBytesSent: sum("outbound-rtp", "audio", "bytesSent"),
      audioStats,
      audioRtpStats,
      videoBytesSent: sum("outbound-rtp", "video", "bytesSent"),
      networkQuality: {
        ...(window.__slowMeetTest?.networkQuality || {}),
        selectedPairAvailableOutgoingKbps: Number.isFinite(selectedPair?.availableOutgoingBitrate)
          ? Math.round(selectedPair.availableOutgoingBitrate / 1000) : null
      },
      connectionUI: {
        level: document.querySelector("#connection")?.className.split(/\s+/).at(-1) || "unknown",
        label: document.querySelector("#connection")?.getAttribute("aria-label") || "",
        warningVisible: Boolean(document.querySelector("#meeting-alert") &&
          !document.querySelector("#meeting-alert").hidden),
        warning: document.querySelector("#meeting-alert")?.textContent || ""
      },
      participantTiles: [...document.querySelectorAll("#participants li[data-participant-id]")].map((item) => ({
        name: item.querySelector(".participant-name")?.textContent?.trim() || item.textContent.trim(),
        local: item.classList.contains("is-local"),
        quality: item.dataset.quality || "unknown",
        connection: item.dataset.connection || "connected",
        mic: item.dataset.mic || "unknown",
        camera: item.dataset.camera || "unknown"
      })),
      adaptationState: {
        ...(window.__slowMeetTest?.adaptationState || {}),
        selectedProfile: window.__slowMeetTest?.adaptationState?.selectedProfile ??
          document.querySelector("#profile")?.value ?? null,
        effectiveProfile: window.__slowMeetTest?.adaptationState?.effectiveProfile ??
          document.querySelector("#effective-profile")?.textContent?.trim() ?? null
      },
      videoRtpStats,
      videoSenderStats,
      remoteVideos,
      remoteAudios,
      audioCaptureSettings: audioCaptureSettings ? {
        echoCancellation: audioCaptureSettings.echoCancellation ?? null,
        noiseSuppression: audioCaptureSettings.noiseSuppression ?? null,
        autoGainControl: audioCaptureSettings.autoGainControl ?? null
      } : null,
      remoteParticipants,
      candidatePair: selectedPair ? {
        state: selectedPair.state,
        nominated: selectedPair.nominated,
        requestsSent: selectedPair.requestsSent,
        responsesReceived: selectedPair.responsesReceived,
        packetsSent: selectedPair.packetsSent,
        packetsReceived: selectedPair.packetsReceived,
        packetsLost: selectedPair.packetsLost,
        bytesSent: selectedPair.bytesSent,
        bytesReceived: selectedPair.bytesReceived,
        currentRoundTripTime: selectedPair.currentRoundTripTime,
        availableOutgoingBitrate: selectedPair.availableOutgoingBitrate,
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
      capturedTracks: (window.__slowMeetTest?.capturedTracks || []).map(({ kind, id, track }) => ({
        kind,
        id,
        readyState: track.readyState,
        enabled: track.enabled,
        label: track.label,
        settings: track.getSettings?.() || {}
      })),
      replaceTrackEvents: window.__slowMeetTest?.replaceTrackEvents || [],
      connectionEvents: window.__slowMeetTest?.connectionEvents.slice(-80) || [],
      signalingMessages: window.__slowMeetTest?.signalingMessages.slice(-20) || [],
      cameraButton: document.querySelector("#camera")?.getAttribute("aria-pressed"),
      micButton: document.querySelector("#mic")?.getAttribute("aria-pressed"),
      incomingVideoButton: document.querySelector("#receive-video")?.getAttribute("aria-pressed"),
      cameraQualityCapture: window.__slowMeetTest?.cameraQualityCapture?.lastSummary ||
        window.__slowMeetTest?.cameraQualityCapture?.snapshot?.() || null
    };
  });
}

async function beginCameraQualityCapture(pageA, pageB, label, {
  requireMarkers = true,
  includeFrameObservations = false
} = {}) {
  const pages = { A: pageA, B: pageB };
  await Promise.all(Object.entries(pages).map(([pageRole, page]) =>
    page.evaluate(installCameraQualityRecorder, { label, pageRole, requireMarkers, includeFrameObservations })));
  return { label, pages, requireMarkers, includeFrameObservations };
}

async function waitForCameraQualityBaseline(capture, roles, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let readiness = [];
  do {
    readiness = await Promise.all(Object.values(capture.pages).map((page) => page.evaluate((expectedRoles) => {
      const recorder = window.__slowMeetTest?.cameraQualityCapture;
      if (!recorder?.active || typeof recorder.baselineReadiness !== "function") return [];
      return recorder.baselineReadiness(expectedRoles);
    }, roles)));
    if (readiness.length === 2 && readiness.every((page) =>
      page.length === roles.length && page.every((role) => role.ready))) return;
    if (Date.now() < deadline) await delay(50);
  } while (Date.now() < deadline);
  const baseline = capture.requireMarkers ? "live camera marker" : "live camera frame";
  throw new Error(`${capture.label}: ${baseline} baseline was not ready within ${timeoutMs}ms: ${JSON.stringify(readiness)}`);
}

async function waitForCameraQualityResume(capture, role, resumeIndex, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let readiness = [];
  do {
    readiness = await Promise.all(Object.entries(capture.pages).map(async ([pageRole, page]) =>
      page.evaluate(({ expectedRole, expectedResumeIndex }) => {
        const recorder = window.__slowMeetTest?.cameraQualityCapture;
        const expectedView = recorder?.pageRole === expectedRole ? "local" : "remote";
        const key = `${expectedRole}/${expectedView}`;
        const resumeEvents = recorder?.snapshot?.().resumeEvents || [];
        const resume = resumeEvents.filter((event) => event.role === expectedRole)[expectedResumeIndex];
        const firstFrame = resume?.firstFrames?.[key];
        return {
          pageRole: recorder?.pageRole,
          key,
          resumeAt: resume?.at ?? null,
          endAt: resume?.endAt ?? null,
          firstFrame: firstFrame || null,
          freshFrame: firstFrame?.frameAdvanced === true || firstFrame?.markerAdvanced === true
        };
      }, { expectedRole: role, expectedResumeIndex: resumeIndex })));
    if (readiness.length === Object.keys(capture.pages).length &&
        readiness.every((entry) => entry.freshFrame)) return readiness;
    if (Date.now() < deadline) await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`${capture.label} ${role} resume ${resumeIndex + 1} did not deliver fresh local and remote frames within ${timeoutMs}ms: ${JSON.stringify(readiness)}`);
}

async function waitForCameraQualityVisualSamples(capture, roles, minimumSamples = 8, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  let observations = [];
  do {
    observations = await Promise.all(Object.values(capture.pages).map((page) => page.evaluate(() => {
      const recorder = window.__slowMeetTest?.cameraQualityCapture;
      const report = recorder?.snapshot?.();
      return {
        pageRole: recorder?.pageRole,
        tiles: (report?.tiles || []).map(({ key, baselineVisual }) => ({ key, baselineVisual }))
      };
    })));
    const ready = roles.every((role) => {
      const localPage = observations.find((page) => page.pageRole === role);
      const remotePage = observations.find((page) => page.pageRole !== role);
      return [localPage, remotePage].every((page) => {
        const view = page?.pageRole === role ? "local" : "remote";
        const tile = page?.tiles.find((entry) => entry.key === `${role}/${view}`);
        return tile?.baselineVisual?.sampleCount >= minimumSamples;
      });
    });
    if (ready) return;
    if (Date.now() < deadline) await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`${capture.label}: camera image sampler did not collect ${minimumSamples} baseline samples: ${JSON.stringify(observations)}`);
}

async function endCameraQualityCapture(capture, options) {
  const { pages } = capture;
  let reports;
  try {
    await delay(cameraQualitySettleMs);
    await Promise.all(Object.values(pages).map((page) => page.evaluate(() => {
      const recorder = window.__slowMeetTest?.cameraQualityCapture;
      if (!recorder?.active) throw new Error("camera quality capture is not active");
      recorder.markStableStart();
    })));
    await delay(cameraQualityWindowMs);
    reports = await Promise.all(Object.values(pages).map((page) => page.evaluate(() =>
      window.__slowMeetTest?.cameraQualityCapture?.finish())));
    return validateCameraQualityReports(reports, {
      label: capture.label,
      requireMarkers: capture.requireMarkers,
      ...options
    });
  } catch (error) {
    if (reports) error.cameraQualityReports = reports;
    throw error;
  } finally {
    await Promise.all(Object.values(pages).map((page) => page.evaluate(() => {
      window.__slowMeetTest?.cameraQualityCapture?.stop();
    }).catch(() => {})));
  }
}

async function logRealCameraDiagnostics(fixture, label, stage) {
  const peers = await Promise.all(["A", "B"].map(async (role) => {
    const state = await fixture.diagnostics(role);
    return {
      role,
      connectionState: state.connectionState,
      iceConnectionState: state.iceConnectionState,
      signalingState: state.signalingState,
      peerConnectionCount: state.peerConnectionCount,
      socketCount: state.socketCount,
      framesDecoded: state.framesDecoded,
      videoBytesReceived: state.videoBytesReceived,
      videoBytesSent: state.videoBytesSent,
      videoRtpStats: state.videoRtpStats || [],
      videoSenderStats: state.videoSenderStats || [],
      cameraVideos: (state.remoteVideos || []).filter((video) => video.role === "camera").map((video) => ({
        participant: video.participant,
        width: video.width,
        height: video.height,
        currentTime: video.currentTime,
        paused: video.paused,
        cameraState: video.cameraState,
        trackIDs: video.trackIDs,
        inboundVideoStats: video.inboundVideoStats
      })),
      connectionEvents: state.connectionEvents,
      signalingMessages: state.signalingMessages,
      replaceTrackEvents: state.replaceTrackEvents
    };
  }));
  const snapshot = { label, stage, peers };
  console.log(`[real-camera diagnostics] ${JSON.stringify(snapshot)}`);
  return snapshot;
}

async function realCameraVideoSenderIDs(fixture) {
  const states = await Promise.all(["A", "B"].map((role) => fixture.diagnostics(role)));
  return Object.fromEntries(states.map((state, index) => {
    const sender = state.videoSenderStats.find((entry) => entry.trackID) || state.videoSenderStats[0];
    assert.ok(sender?.senderID, `${["A", "B"][index]}: video sender identity was not recorded`);
    return [["A", "B"][index], sender.senderID];
  }));
}

async function assertRealCameraCapture(fixture, role) {
  const state = await fixture.diagnostics(role);
  const capture = state.capturedTracks.find((track) => track.kind === "video" &&
    track.readyState === "live" && track.label && !/fake device/i.test(track.label) &&
    track.settings?.deviceId);
  assert.ok(capture,
    `${role}: expected a live camera capture from a real device, got ${JSON.stringify(state.capturedTracks)}`);
  console.log(`[pass] ${role} camera capture uses a live device (${capture.settings.width || "?"}x${capture.settings.height || "?"})`);
}

function decodedVideoKeyFrameCount(state) {
  return state.videoRtpStats.filter((stat) => stat.type === "inbound-rtp" && Number.isFinite(stat.keyFramesDecoded))
    .reduce((total, stat) => total + stat.keyFramesDecoded, 0);
}

async function waitForDecodedVideoKeyFrame(fixture, receiverRole, baseline, label, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  let latestCount = baseline;
  do {
    const state = await fixture.diagnostics(receiverRole);
    latestCount = decodedVideoKeyFrameCount(state);
    if (latestCount > baseline) {
      console.log(`[real-camera decoded keyframe] ${JSON.stringify({ label, receiverRole, baseline, latestCount })}`);
      return;
    }
    if (Date.now() < deadline) await delay(50);
  } while (Date.now() < deadline);
  throw new Error(`${label}: remote decoder did not decode a post-resume keyframe within ${timeoutMs}ms (before=${baseline}, after=${latestCount})`);
}

async function joinMeeting(context, name, baseURL, installDeviceFixtures = false, autoJoin = true,
  timeCodedCameraRole = undefined, timeCodedAudioRole = undefined) {
  const page = await context.newPage();
  const pageEvents = [];
  page.__mediaE2EEvents = pageEvents;
  page.on("pageerror", (error) => {
    pageEvents.push({ type: "pageerror", message: error.message, timestamp: Date.now() });
    console.error(`[${name}] browser error: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageEvents.push({ type: "console", level: "error", message: message.text(), timestamp: Date.now() });
      console.error(`[${name}] console error: ${message.text()}`);
    }
  });
  page.on("request", (request) => pageEvents.push({
    type: "request", method: request.method(), resourceType: request.resourceType(), url: request.url(), timestamp: Date.now()
  }));
  page.on("response", (response) => pageEvents.push({
    type: "response", status: response.status(), url: response.url(), timestamp: Date.now()
  }));
  page.on("requestfailed", (request) => pageEvents.push({
    type: "requestfailed", method: request.method(), url: request.url(), error: request.failure()?.errorText, timestamp: Date.now()
  }));
  await page.addInitScript(({ installDeviceFixtures, timeCodedCameraRole, timeCodedAudioRole }) => {
    const NativePeerConnection = window.RTCPeerConnection;
    const NativeWebSocket = window.WebSocket;
    const originalReplaceTrack = RTCRtpSender.prototype.replaceTrack;
    const senderIDs = new WeakMap();
    let nextSenderID = 1;
    window.__slowMeetTest = {
      peerConnections: [],
      sockets: [],
      replaceTrackEvents: [],
      videoSenders: [],
      connectionEvents: [],
      iceCandidateErrors: [],
      acceptedRemoteCandidates: [],
      signalingMessages: [],
      deviceSelectionRequests: [],
      capturedTracks: [],
      audioEchoCancellationRequested: null,
      cameraQualityCapture: null,
      timeCodedCamera: null,
      timeCodedAudio: null
    };
    const mediaDevices = navigator.mediaDevices;
    const nativeEnumerateDevices = mediaDevices.enumerateDevices.bind(mediaDevices);
    const nativeGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
    const nativeGetDisplayMedia = mediaDevices.getDisplayMedia?.bind(mediaDevices);
    const virtualDevices = [
      { kind: "audioinput", deviceId: "slowmeet-e2e-microphone", groupId: "slowmeet-e2e-audio", label: "E2E secondary microphone" },
      { kind: "videoinput", deviceId: "slowmeet-e2e-camera", groupId: "slowmeet-e2e-video", label: "E2E secondary camera" }
    ];
    if (installDeviceFixtures) {
      Object.defineProperty(mediaDevices, "enumerateDevices", {
        configurable: true,
        value: async () => [...await nativeEnumerateDevices(), ...virtualDevices]
      });
    }
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", {
      configurable: true,
      value: async (constraints = {}) => {
        let normalized = constraints;
        if (installDeviceFixtures) {
          normalized = structuredClone(constraints);
          for (const kind of ["audio", "video"]) {
            const constraint = normalized?.[kind];
            const requestedDevice = typeof constraint === "object"
              ? constraint.deviceId?.exact
              : undefined;
            if (typeof requestedDevice !== "string" || !requestedDevice.startsWith("slowmeet-e2e-")) continue;
            window.__slowMeetTest.deviceSelectionRequests.push({ kind, deviceId: requestedDevice, timestamp: Date.now() });
            delete constraint.deviceId;
          }
        }
        if (normalized?.audio) {
          window.__slowMeetTest.audioEchoCancellationRequested =
            typeof normalized.audio === "object" ? normalized.audio.echoCancellation ?? null : null;
        }
        let stream;
        if (timeCodedAudioRole && normalized?.audio) {
          const nativeConstraints = { ...normalized, audio: false };
          stream = nativeConstraints.video
            ? await nativeGetUserMedia(nativeConstraints)
            : new MediaStream();
          const audioContext = new AudioContext();
          const destination = audioContext.createMediaStreamDestination();
          const oscillator = audioContext.createOscillator();
          const gain = audioContext.createGain();
          oscillator.frequency.value = 997;
          gain.gain.value = 0;
          oscillator.connect(gain).connect(destination);
          oscillator.start();
          const audioTrack = destination.stream.getAudioTracks()[0];
          if (!audioTrack) throw new Error("the E2E time-coded audio source produced no audio track");
          stream.addTrack(audioTrack);
          audioTrack.addEventListener("ended", () => {
            oscillator.stop();
            audioContext.close().catch(() => {});
            if (window.__slowMeetTest.timeCodedAudio?.track === audioTrack) {
              window.__slowMeetTest.timeCodedAudio = null;
            }
          }, { once: true });
          window.__slowMeetTest.timeCodedAudio = {
            role: timeCodedAudioRole,
            context: audioContext,
            gain,
            track: audioTrack,
            async scheduleMarker() {
              await audioContext.resume();
              const now = audioContext.currentTime;
              const markerAt = now + 0.8;
              gain.gain.cancelScheduledValues(now);
              gain.gain.setValueAtTime(0, now);
              gain.gain.setValueAtTime(0.25, markerAt);
              gain.gain.setValueAtTime(0, markerAt + 0.18);
              return performance.timeOrigin + performance.now() + (markerAt - audioContext.currentTime) * 1000;
            }
          };
          window.__slowMeetTest.capturedTracks.push({
            source: "synthetic-test-audio",
            kind: "audio",
            id: audioTrack.id,
            track: audioTrack
          });
          return stream;
        }
        if (timeCodedCameraRole && normalized?.video) {
          const nativeConstraints = { ...normalized, video: false };
          stream = nativeConstraints.audio
            ? await nativeGetUserMedia(nativeConstraints)
            : new MediaStream();
          const canvas = document.createElement("canvas");
          canvas.width = 640;
          canvas.height = 480;
          const context = canvas.getContext("2d", { alpha: false });
          if (!context) throw new Error("could not create the E2E time-coded camera canvas");
          const roleBit = timeCodedCameraRole === "B" ? 1 : 0;
          let animationFrame = 0;
          let stopped = false;
          const drawFrame = () => {
            if (stopped) return;
            const epoch = Math.floor(performance.timeOrigin + performance.now());
            const marker = epoch % 16777216;
            context.fillStyle = "#16202a";
            context.fillRect(0, 0, canvas.width, canvas.height);
            context.fillStyle = "#243c50";
            context.fillRect(0, 100, canvas.width, 380);
            const phase = (epoch % 3000) / 3000;
            const centerX = 80 + Math.round(phase * 480);
            context.fillStyle = roleBit ? "#48d597" : "#f0b84d";
            context.beginPath();
            context.arc(centerX, 285, 58, 0, Math.PI * 2);
            context.fill();
            context.fillStyle = "#ffffff";
            context.font = "bold 36px sans-serif";
            context.fillText("E2E CAMERA " + timeCodedCameraRole, 24, 90);
            const bits = [1, 0, 1, 0, roleBit];
            for (let bit = 23; bit >= 0; bit -= 1) bits.push((marker >>> bit) & 1);
            bits.forEach((value, index) => {
              context.fillStyle = value ? "#ffffff" : "#000000";
              context.fillRect(12 + index * 20, 200, 16, 80);
            });
            animationFrame = requestAnimationFrame(drawFrame);
          };
          drawFrame();
          const syntheticStream = canvas.captureStream(30);
          const videoTrack = syntheticStream.getVideoTracks()[0];
          if (!videoTrack) throw new Error("the E2E time-coded camera produced no video track");
          videoTrack.addEventListener("ended", () => {
            stopped = true;
            cancelAnimationFrame(animationFrame);
            if (window.__slowMeetTest.timeCodedCamera?.videoTrack === videoTrack) {
              window.__slowMeetTest.timeCodedCamera = null;
            }
          }, { once: true });
          stream.addTrack(videoTrack);
          window.__slowMeetTest.timeCodedCamera = {
            role: timeCodedCameraRole,
            canvas,
            stream: syntheticStream,
            videoTrack,
            get animationFrame() { return animationFrame; }
          };
          window.__slowMeetTest.capturedTracks.push({
            source: "synthetic-test-camera",
            kind: "video",
            id: videoTrack.id,
            track: videoTrack
          });
          for (const track of stream.getTracks()) {
            if (track !== videoTrack) {
              window.__slowMeetTest.capturedTracks.push({ source: "user-media", kind: track.kind, id: track.id, track });
            }
          }
          return stream;
        }
        stream = await nativeGetUserMedia(normalized);
        for (const track of stream.getTracks()) {
          window.__slowMeetTest.capturedTracks.push({ source: "user-media", kind: track.kind, id: track.id, track });
        }
        return stream;
      }
    });
    if (nativeGetDisplayMedia) {
      Object.defineProperty(mediaDevices, "getDisplayMedia", {
        configurable: true,
        value: async (constraints = {}) => {
          const stream = await nativeGetDisplayMedia(constraints);
          for (const track of stream.getTracks()) {
            window.__slowMeetTest.capturedTracks.push({ source: "display-media", kind: track.kind, id: track.id, track });
          }
          return stream;
        }
      });
    }
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
              participantID: message.participant_id,
              screenShareActive: message.screen_share_active,
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
              participantID: message.participant_id,
              screenShareActive: message.screen_share_active,
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
      const kind = this.track?.kind || track?.kind || "unknown";
      if (kind === "video" && !window.__slowMeetTest.videoSenders.some((record) => record.sender === this)) {
        window.__slowMeetTest.videoSenders.push({ senderID, sender: this });
      }
      window.__slowMeetTest.replaceTrackEvents.push({
        senderID,
        kind,
        nextTrackId: track?.id || null
      });
      return originalReplaceTrack.call(this, track);
    };
  }, { installDeviceFixtures, timeCodedCameraRole, timeCodedAudioRole });
  await page.goto(`${baseURL}/`);
  if (!autoJoin) return page;
  await page.locator("#name").fill(name);
  if (testMeetingPassword) await page.locator("#password").fill(testMeetingPassword);
  await page.locator("#join").click();
  await page.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
  return page;
}

function pageForRole(fixture, role) {
  if (role !== "A" && role !== "B") throw new Error(`unknown participant role: ${role}`);
  return role === "A" ? fixture.pageA : fixture.pageB;
}

function contextForRole(fixture, role) {
  if (role !== "A" && role !== "B") throw new Error(`unknown participant role: ${role}`);
  return role === "A" ? fixture.contextA : fixture.contextB;
}

async function createScenarioFixture({
  browserA,
  browserB,
  baseURL,
  contexts,
  traceContexts,
  timeCodedCamera = false,
  timeCodedCameraRoles,
  timeCodedAudioRoles
}) {
  const generatedCameraRoles = new Set(timeCodedCameraRoles ?? (timeCodedCamera ? ["A", "B"] : []));
  const generatedAudioRoles = new Set(timeCodedAudioRoles ?? []);
  assert.ok([...generatedCameraRoles].every((role) => role === "A" || role === "B"),
    "time-coded camera roles must be A or B");
  assert.ok([...generatedAudioRoles].every((role) => role === "A" || role === "B"),
    "time-coded audio roles must be A or B");
  const contextA = await browserA.newContext({ viewport: { width: 1440, height: 960 } });
  contexts.push(contextA);
  const contextB = await browserB.newContext({ viewport: { width: 1440, height: 960 } });
  contexts.push(contextB);
  await Promise.all([contextA, contextB].map(async (context) => {
    await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
    traceContexts.add(context);
    await context.grantPermissions(["camera", "microphone"], { origin: new URL(baseURL).origin });
  }));

  const [pageA, pageB] = await Promise.all([
    joinMeeting(contextA, "Media A", baseURL, deviceFixtures, false,
      generatedCameraRoles.has("A") ? "A" : undefined, generatedAudioRoles.has("A") ? "A" : undefined),
    joinMeeting(contextB, "Media B", baseURL, deviceFixtures, false,
      generatedCameraRoles.has("B") ? "B" : undefined, generatedAudioRoles.has("B") ? "B" : undefined)
  ]);
  const joined = new Set();
  const expectedPeerCounts = new Map();
  const expectedSocketCounts = new Map();
  const baselineAt = new Map();
  const fixture = {
    baseURL,
    password: testMeetingPassword,
    browserA,
    browserB,
    timeCodedCamera,
    generatedCameraRoles,
    generatedAudioRoles,
    contextA,
    contextB,
    pageA,
    pageB,
    names: { A: "Media A", B: "Media B" },
    joined,
    page: (role) => pageForRole(fixture, role),
    context: (role) => contextForRole(fixture, role),
    async join(role, name = fixture.names[role], password = fixture.password) {
      const page = pageForRole(fixture, role);
      fixture.names[role] = name;
      if (await page.locator("#meeting").isVisible()) return page;
      await page.locator("#name").fill(name);
      if (password) await page.locator("#password").fill(password);
      await page.locator("#join").click();
      await page.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
      await waitForPeerConnection(page, "connected", 20000);
      joined.add(role);
      const state = await diagnostics(page);
      expectedPeerCounts.set(role, state.peerConnectionCount);
      expectedSocketCounts.set(role, state.socketCount);
      baselineAt.set(role, Date.now());
      return page;
    },
    async newPage(role) {
      return joinMeeting(contextForRole(fixture, role), fixture.names[role], baseURL, deviceFixtures, false,
        generatedCameraRoles.has(role) ? role : undefined, generatedAudioRoles.has(role) ? role : undefined);
    },
      async diagnostics(role) {
        return diagnostics(pageForRole(fixture, role));
      },
      async copyDiagnostics(role) {
        return pageForRole(fixture, role).evaluate(async () => {
          let copied = "";
          Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: async (value) => { copied = value; } }
          });
          document.querySelector("#copy-diagnostics").click();
          await new Promise((resolve) => setTimeout(resolve, 0));
          return copied;
        });
      },
      async assertHealthyParticipantTiles(receiverRole, senderRole, label) {
        const copied = JSON.parse(await fixture.copyDiagnostics(receiverRole));
        const samples = (copied.recentSamples || []).filter((sample) =>
          sample.tiles?.some((tile) => !tile.local && tile.mic === "on"));
        assert.ok(samples.length >= 2,
          `${label}: expected multiple receiver diagnostic samples with ${senderRole}'s microphone on`);
        const unhealthy = samples.filter((sample) => sample.warning || sample.tiles.some((tile) =>
          tile.quality === "degraded" || tile.quality === "poor"));
        assert.deepEqual(unhealthy, [],
          `${label}: healthy audio must not trigger connection warnings or degraded tiles: ${JSON.stringify(samples)}`);
        const renderedTiles = await pageForRole(fixture, receiverRole).evaluate(() =>
          [...document.querySelectorAll("#participants li[data-participant-id]")].map((tile) => {
            const badge = tile.querySelector(".participant-quality");
            return {
              local: tile.classList.contains("is-local"),
              quality: tile.dataset.quality || "unknown",
              poorConnectionClass: tile.classList.contains("is-poor-connection"),
              qualityBadge: badge ? {
                hidden: badge.hidden,
                label: badge.getAttribute("aria-label") || "",
                title: badge.title || ""
              } : null
            };
          }));
        assert.equal(renderedTiles.length, 2,
          `${label}: expected both participant tiles in the receiver browser`);
        assert.ok(renderedTiles.some((tile) => tile.local) && renderedTiles.some((tile) => !tile.local),
          `${label}: expected one local and one remote tile: ${JSON.stringify(renderedTiles)}`);
        const renderedUnhealthy = renderedTiles.filter((tile) =>
          tile.quality === "degraded" || tile.quality === "poor" || tile.poorConnectionClass ||
          /degraded|poor/i.test(`${tile.qualityBadge?.label || ""} ${tile.qualityBadge?.title || ""}`));
        assert.deepEqual(renderedUnhealthy, [],
          `${label}: neither rendered tile may show a degraded or red poor-connection state: ${JSON.stringify(renderedTiles)}`);
      },
      async captureConnectionTimeline(label, durationMs) {
        const startedAt = Date.now();
        const samples = [];
        while (Date.now() - startedAt < durationMs) {
          const roles = [...joined].sort();
          const states = await Promise.all(roles.map(async (role) => {
            const state = await diagnostics(pageForRole(fixture, role));
            return {
              role,
              connectionState: state.connectionState,
              iceConnectionState: state.iceConnectionState,
              signalingState: state.signalingState,
              networkQuality: state.networkQuality,
              connectionUI: state.connectionUI,
              participantTiles: state.participantTiles,
              audio: {
                bytesSent: state.audioBytesSent,
                bytesReceived: state.audioBytesReceived,
                outbound: state.audioStats?.outbound,
                inbound: state.audioStats?.inbound
              }
            };
          }));
          samples.push({ elapsedMs: Date.now() - startedAt, browsers: states });
          const remaining = durationMs - (Date.now() - startedAt);
          if (remaining > 0) await delay(Math.min(pollIntervalMs, remaining));
        }
        console.log(`[connection timeline] ${label}: ${JSON.stringify(samples)}`);
        return samples;
      },
    async beginCameraQualityCapture(label, options = {}) {
      const requireMarkers = options.requireMarkers ?? true;
      assert.ok(!requireMarkers || fixture.timeCodedCamera,
        `${label}: marker checks require time-coded synthetic cameras`);
      return beginCameraQualityCapture(fixture.pageA, fixture.pageB, label, {
        ...options,
        requireMarkers
      });
    },
    async waitForCameraQualityBaseline(capture, roles) {
      return waitForCameraQualityBaseline(capture, roles);
    },
    async waitForCameraQualityResume(capture, role, resumeIndex) {
      return waitForCameraQualityResume(capture, role, resumeIndex);
    },
    async waitForCameraQualityVisualSamples(capture, roles, minimumSamples) {
      return waitForCameraQualityVisualSamples(capture, roles, minimumSamples);
    },
    async endCameraQualityCapture(capture, options) {
      const summary = await endCameraQualityCapture(capture, options);
      await fixture.assertPeersConnected(`${capture.label} quality window`);
      console.log(`[camera quality] ${JSON.stringify(summary)}`);
      return summary;
    },
    async capturedTrackStates(role) {
      return pageForRole(fixture, role).evaluate(() =>
        (window.__slowMeetTest?.capturedTracks || []).map(({ source, kind, id, track }) => ({
          source,
          kind,
          id,
          readyState: track.readyState,
          enabled: track.enabled
        })));
    },
    async assertNoLiveCapturedTracks(role, label = `participant ${role} media cleanup`) {
      const tracks = await fixture.capturedTrackStates(role);
      assert.ok(tracks.length > 0, `${label}: no captured media tracks were recorded`);
      const liveTracks = tracks.filter((track) => track.readyState !== "ended");
      assert.deepEqual(liveTracks, [], `${label}: captured tracks remain live: ${JSON.stringify(liveTracks)}`);
    },
    async assertDisplayCaptureEnded(role, label = `participant ${role} screen-share cleanup`) {
      const tracks = (await fixture.capturedTrackStates(role))
        .filter((track) => track.source === "display-media" && track.kind === "video");
      assert.ok(tracks.length > 0, `${label}: no display-capture video tracks were recorded`);
      const liveTracks = tracks.filter((track) => track.readyState !== "ended");
      assert.deepEqual(liveTracks, [], `${label}: display-capture tracks remain live: ${JSON.stringify(liveTracks)}`);
    },
    async waitForConnected(role) {
      const roles = role ? [role] : [...joined];
      await Promise.all(roles.map((participantRole) =>
        waitForPeerConnection(pageForRole(fixture, participantRole), "connected", 30000)));
    },
    async waitForStability(stableMs = 1000, timeoutMs = 20000) {
      const peers = [...joined].map((role) => pageForRole(fixture, role));
      assert.ok(peers.length > 0, "at least one participant must join before checking peer stability");
      await waitForPeerStability(peers, stableMs, timeoutMs);
    },
    async waitForRemoteState(receiverRole, participantName, datasetKey, expectedValue) {
      await waitForRemoteParticipantState(pageForRole(fixture, receiverRole), participantName, datasetKey, expectedValue);
    },
    async setPressed(role, selector, pressed) {
      return setButtonPressed(pageForRole(fixture, role), selector, pressed);
    },
    async openSidebar(role, trigger = "#more") {
      return openMeetingSidebar(pageForRole(fixture, role), trigger);
    },
    async closeSidebar(role) {
      return closeMeetingSidebar(pageForRole(fixture, role));
    },
    async assertPeersConnected(label = "peer connectivity") {
      const states = [];
      for (const role of joined) {
        const state = await diagnostics(pageForRole(fixture, role));
        assert.equal(state.connectionState, "connected",
          `${label}: participant ${role} connection state is ${state.connectionState}`);
        assert.ok(["connected", "completed"].includes(state.iceConnectionState),
          `${label}: participant ${role} ICE state is ${state.iceConnectionState}`);
        const expectedPeerCount = expectedPeerCounts.get(role);
        const expectedSocketCount = expectedSocketCounts.get(role);
        if (expectedPeerCount !== undefined) {
          assert.equal(state.peerConnectionCount, expectedPeerCount,
            `${label}: participant ${role} unexpectedly replaced its peer connection`);
        }
        if (expectedSocketCount !== undefined) {
          assert.equal(state.socketCount, expectedSocketCount,
            `${label}: participant ${role} unexpectedly replaced its signaling socket`);
        }
        const interruption = persistentPeerInterruption(state.connectionEvents,
          baselineAt.get(role) || 0, Date.now(), transientDisconnectGraceMs);
        assert.ok(!interruption, `${label}: participant ${role} disconnected: ${JSON.stringify(interruption)}`);
        states.push(state);
      }
      return states;
    },
    async refreshPeerBaseline(role) {
      const roles = role ? [role] : [...joined];
      for (const participantRole of roles) {
        const state = await diagnostics(pageForRole(fixture, participantRole));
        expectedPeerCounts.set(participantRole, state.peerConnectionCount);
        expectedSocketCounts.set(participantRole, state.socketCount);
        baselineAt.set(participantRole, Date.now());
      }
    },
    async assertNoDuplicateParticipants() {
      for (const role of joined) {
        const summary = await pageForRole(fixture, role).locator("#participants li[data-participant-id]")
          .evaluateAll((items) => {
            const ids = items.map((item) => item.dataset.participantId);
            const videoKeys = [...document.querySelectorAll("#participants video[data-media-role]")]
              .map((video) => `${video.closest("li")?.dataset.participantId || "unknown"}:${video.dataset.mediaRole}`);
            return {
              participantIDs: ids,
              duplicateParticipantIDs: ids.filter((id, index) => ids.indexOf(id) !== index),
              videoKeys,
              duplicateVideoKeys: videoKeys.filter((key, index) => videoKeys.indexOf(key) !== index)
            };
          });
        assert.deepEqual(summary.duplicateParticipantIDs, [], `participant ${role} rendered a duplicate roster row`);
        assert.deepEqual(summary.duplicateVideoKeys, [], `participant ${role} rendered duplicate media elements`);
      }
    },
    async assertRemoteVideoMoves(senderRole, receiverRole, label = `${senderRole} camera -> ${receiverRole}`, mediaRole = "camera") {
      const before = await diagnostics(pageForRole(fixture, receiverRole));
      await assertRemoteVideoMoves(pageForRole(fixture, receiverRole), mediaRole, label);
      const after = await diagnostics(pageForRole(fixture, receiverRole));
      const frames = (state) => state.remoteVideos.filter((video) => video.role === mediaRole)
        .flatMap((video) => video.inboundVideoStats)
        .reduce((total, stat) => total + (Number(stat.framesDecoded) || 0), 0);
      assert.ok(frames(after) > frames(before), `${label}: decoded frame count did not advance`);
      await fixture.assertPeersConnected(label);
    },
    async assertAudioProgress(senderRole, receiverRole, label = `${senderRole} microphone -> ${receiverRole}`) {
      const [beforeSender, beforeReceiver] = await Promise.all([
        diagnostics(pageForRole(fixture, senderRole)), diagnostics(pageForRole(fixture, receiverRole))
      ]);
      await waitForAudioProgress(pageForRole(fixture, senderRole), pageForRole(fixture, receiverRole),
        beforeSender, beforeReceiver, label);
      await fixture.assertRemoteAudioPlayback(senderRole, receiverRole, label);
      await fixture.assertPeersConnected(label);
    },
    async assertRemoteAudioPlayback(senderRole, receiverRole, label = `${senderRole} audio playback -> ${receiverRole}`) {
      const receiverPage = pageForRole(fixture, receiverRole);
      const senderName = fixture.names[senderRole];
      const findRemoteAudios = (state) => state.remoteAudios.filter((audio) => audio.participant.includes(senderName));
      await receiverPage.waitForFunction((name) => [...document.querySelectorAll(
        "#participants li[data-participant-id] audio")].some((audio) =>
        audio.closest("li")?.textContent?.includes(name) &&
        !audio.paused && !audio.muted && audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
        audio.srcObject?.getAudioTracks?.().some((track) => track.readyState === "live")),
      senderName, { timeout: 10000 });
      const beforeAudio = findRemoteAudios(await diagnostics(receiverPage))[0];
      assert.ok(beforeAudio, `${label}: remote audio element was not present`);
      await delay(1000);
      const afterState = await diagnostics(receiverPage);
      const matchingAudios = findRemoteAudios(afterState);
      assert.equal(matchingAudios.length, 1, `${label}: expected one remote audio element for the sender`);
      const afterAudio = matchingAudios[0];
      assert.equal(afterAudio.audioTracks.filter((track) => track.readyState === "live").length, 1,
        `${label}: expected one live remote audio track`);
      assert.ok(afterAudio && !afterAudio.paused && !afterAudio.muted,
        `${label}: remote audio playback stopped: ${JSON.stringify(afterState.remoteAudios)}`);
      assert.ok(afterAudio.currentTime > beforeAudio.currentTime,
        `${label}: remote audio playback time did not advance (${beforeAudio.currentTime} -> ${afterAudio.currentTime})`);
      console.log(`[pass] ${label}: remote audio element playback advanced`);
    },
    async assertAudioMarkerDelay(senderRole, receiverRole, label = `${senderRole} audio marker -> ${receiverRole}`) {
      assert.ok(fixture.generatedAudioRoles.has(senderRole), `${label}: sender has no time-coded audio source`);
      const senderPage = pageForRole(fixture, senderRole);
      const receiverPage = pageForRole(fixture, receiverRole);
      const senderName = fixture.names[senderRole];
      const markerAt = await senderPage.evaluate(async () =>
        window.__slowMeetTest?.timeCodedAudio?.scheduleMarker());
      assert.ok(Number.isFinite(markerAt), `${label}: could not schedule a source audio marker`);
      const delayMs = await receiverPage.evaluate(async ({ senderName, markerAt }) => {
        const audio = [...document.querySelectorAll("#participants li[data-participant-id] audio")]
          .find((element) => element.closest("li")?.textContent?.includes(senderName));
        if (!audio?.srcObject) throw new Error("remote audio element has no stream");
        const context = new AudioContext();
        const source = context.createMediaStreamSource(audio.srcObject);
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.connect(analyser);
        await context.resume();
        const samples = new Float32Array(analyser.fftSize);
        const deadline = performance.now() + 5000;
        try {
          while (performance.now() < deadline) {
            analyser.getFloatTimeDomainData(samples);
            let power = 0;
            for (const sample of samples) power += sample * sample;
            if (Math.sqrt(power / samples.length) > 0.025) {
              return performance.timeOrigin + performance.now() - markerAt;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          throw new Error("remote audio marker was not detected within five seconds");
        } finally {
          source.disconnect();
          analyser.disconnect();
          await context.close();
        }
      }, { senderName, markerAt });
      assert.ok(Number.isFinite(delayMs) && delayMs >= -50 && delayMs < 5000,
        `${label}: invalid one-way audio marker delay (${delayMs}ms)`);
      console.log(`[audio delay] ${label}: ${delayMs.toFixed(1)}ms (synthetic source to remote Web Audio capture)`);
      return delayMs;
    },
    async assertCameraRTPContinues(senderRole, receiverRole, label = `${senderRole} camera RTP -> ${receiverRole}`) {
      const senderPage = pageForRole(fixture, senderRole);
      const receiverPage = pageForRole(fixture, receiverRole);
      const senderID = await activeVideoSenderID(senderPage);
      assert.ok(senderID, `${label}: no active camera sender`);
      const [beforeSenderState, beforeReceiverState] = await Promise.all([
        diagnostics(senderPage), diagnostics(receiverPage)
      ]);
      const beforeSender = videoSenderStats(beforeSenderState, senderID);
      const beforeReceiver = cameraObservation(beforeReceiverState, fixture.names[senderRole]);
      await delay(1200);
      const [afterSenderState, afterReceiverState] = await Promise.all([
        diagnostics(senderPage), diagnostics(receiverPage)
      ]);
      const afterSender = videoSenderStats(afterSenderState, senderID);
      const afterReceiver = cameraObservation(afterReceiverState, fixture.names[senderRole]);
      assert.ok(afterSender?.bytesSent > beforeSender?.bytesSent && afterSender?.packetsSent > beforeSender?.packetsSent,
        `${label}: sender RTP did not advance`);
      assert.ok(afterReceiver.bytesReceived > beforeReceiver.bytesReceived &&
        afterReceiver.framesDecoded > beforeReceiver.framesDecoded &&
        afterReceiver.currentTime > beforeReceiver.currentTime,
      `${label}: received RTP, decoded frames, and playback time must advance`);
      await fixture.assertPeersConnected(label);
    },
    async assertCameraRTPStopped(senderRole, receiverRole, label = `${senderRole} camera RTP stopped`) {
      const peerRoles = [...joined];
      await waitForCameraStopped(label, fixture.names[senderRole], pageForRole(fixture, receiverRole),
        peerRoles.map((role) => pageForRole(fixture, role)),
        peerRoles.map((role) => expectedPeerCounts.get(role)),
        peerRoles.map((role) => expectedSocketCounts.get(role)), Date.now());
    },
    async createChangingContentPage(role) {
      return createChangingContentPage(contextForRole(fixture, role));
    },
    async requestIceRestart(role) {
      return requestIceRestart(pageForRole(fixture, role));
    },
    async setViewport(role, width, height) {
      await pageForRole(fixture, role).setViewportSize({ width, height });
    },
    async checkAxe(role, surface) {
      if (!axeCore?.source) throw new Error("axe-core is required for the accessibility scenarios; install npm dependencies first");
      const page = pageForRole(fixture, role);
      const targetSelector = surface === "prejoin" ? "#join-form" : surface === "meeting" ? "#meeting" : surface;
      const axeScriptURL = new URL("/__media-e2e__/axe-core.js", baseURL).href;
      const fulfillAxeScript = (route) => route.fulfill({
        status: 200,
        contentType: "application/javascript; charset=utf-8",
        body: axeCore.source
      });
      await page.route(axeScriptURL, fulfillAxeScript);
      try {
        await page.addScriptTag({ url: axeScriptURL });
      } finally {
        await page.unroute(axeScriptURL, fulfillAxeScript);
      }
      const results = await page.evaluate(async (selector) => {
        const target = document.querySelector(selector);
        if (!target) throw new Error(`axe surface not found: ${selector}`);
        return window.axe.run(target);
      }, targetSelector);
      const violations = results.violations.filter((violation) =>
        violation.impact === "critical" || violation.impact === "serious");
      assert.deepEqual(violations.map(({ id, impact, help, nodes }) => ({
        id,
        impact,
        help,
        nodes: nodes.map((node) => ({
          target: node.target,
          html: node.html.slice(0, 240),
          failureSummary: node.failureSummary?.slice(0, 500),
          checks: node.any.map((check) => ({ id: check.id, data: check.data }))
        }))
      })), [], `${surface} has axe critical/serious violations`);
      return {
        surface,
        violations: results.violations.length,
        criticalOrSerious: violations.length,
        passes: results.passes.length,
        incomplete: results.incomplete.length
      };
    }
  };
  return fixture;
}

async function closeScenarioFixture(fixture, contexts, traceContexts) {
  for (const context of [fixture.contextA, fixture.contextB]) {
    await Promise.all(context.pages().map(leaveMeetingBeforeClose));
    if (traceContexts.has(context)) {
      await context.tracing.stop().catch(() => {});
      traceContexts.delete(context);
    }
    const index = contexts.indexOf(context);
    if (index >= 0) contexts.splice(index, 1);
    await context.close().catch(() => {});
  }
}

async function leaveMeetingBeforeClose(page) {
  if (page.isClosed()) return;
  const meeting = page.locator("#meeting");
  if (!await meeting.isVisible().catch(() => false)) return;
  try {
    await page.locator("#leave").click({ timeout: 1500 });
    await meeting.waitFor({ state: "hidden", timeout: 3000 });
  } catch (_) {
    // The local E2E server uses a short reconnect timeout as a fallback.
  }
}

async function waitForRemoteCamera(page, senderName) {
  await page.waitForFunction((name) => {
    return [...document.querySelectorAll("#participants video[data-media-role='camera']")]
      .some((video) => video.closest("li")?.textContent?.includes(name) &&
        video.videoWidth > 0 && video.videoHeight > 0);
  }, senderName, { timeout: 30000 });
}

async function waitForRemoteParticipantState(page, senderName, datasetKey, expectedValue) {
  await page.waitForFunction(({ name, key, value }) => [...document.querySelectorAll("#participants li[data-participant-id]")]
    .some((item) => !item.classList.contains("is-local") && item.textContent.includes(name) && item.dataset[key] === value),
  { name: senderName, key: datasetKey, value: expectedValue }, { timeout: 15000 });
}

async function setButtonPressed(page, selector, pressed) {
  const button = page.locator(selector);
  const expected = String(pressed);
  if (await button.getAttribute("aria-pressed") !== expected) await button.click();
  await page.waitForFunction(({ buttonSelector, value }) =>
    document.querySelector(buttonSelector)?.getAttribute("aria-pressed") === value,
  { buttonSelector: selector, value: expected }, { timeout: 15000 });
}

function cameraObservation(state, senderName) {
  const video = state.remoteVideos.find((entry) => entry.role === "camera" &&
    entry.participant.includes(senderName));
  const inbound = video?.inboundVideoStats || [];
  return {
    cameraState: video?.cameraState,
    currentTime: video?.currentTime,
    width: video?.width,
    height: video?.height,
    inboundStatsCount: inbound.length,
    bytesReceived: inbound.reduce((total, item) => total + (Number(item.bytesReceived) || 0), 0),
    framesReceived: inbound.reduce((total, item) => total + (Number(item.framesReceived) || 0), 0),
    framesDecoded: inbound.reduce((total, item) => total + (Number(item.framesDecoded) || 0), 0)
  };
}

function videoSenderStats(state, senderID) {
  return state.videoSenderStats.find((entry) => entry.senderID === senderID);
}

function persistentPeerInterruption(events, since, now = Date.now(), graceMs = 0) {
  const isHealthy = (event) => event.connectionState === "connected" &&
    ["connected", "completed"].includes(event.iceConnectionState);
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (event.timestamp < since || !["disconnected", "failed"].includes(event.connectionState) &&
        !["disconnected", "failed"].includes(event.iceConnectionState)) continue;
    if (event.connectionState === "failed" || event.iceConnectionState === "failed") {
      return { event, durationMs: 0 };
    }
    const recovered = events.slice(index + 1).find(isHealthy);
    const durationMs = Math.max(0, (recovered?.timestamp ?? now) - event.timestamp);
    if (durationMs > graceMs) return { event, durationMs };
  }
  return undefined;
}

async function assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts, label, since,
  transientGraceMs = 0) {
  const states = await Promise.all(peers.map(diagnostics));
  states.forEach((state, index) => {
    assert.equal(state.connectionState, "connected",
      `${label}: peer ${index + 1} connection state changed: ${JSON.stringify(summarizePeerState(state))}`);
    assert.ok(["connected", "completed"].includes(state.iceConnectionState),
      `${label}: peer ${index + 1} ICE state changed: ${JSON.stringify(summarizePeerState(state))}`);
    assert.equal(state.peerConnectionCount, expectedPeerConnectionCounts[index],
      `${label}: peer ${index + 1} created or replaced a peer connection`);
    assert.equal(state.socketCount, expectedSocketCounts[index],
      `${label}: peer ${index + 1} rejoined through a replacement signaling socket`);
    const interrupted = persistentPeerInterruption(state.connectionEvents, since, Date.now(), transientGraceMs);
    assert.ok(!interrupted,
      `${label}: peer ${index + 1} disconnected during media lifecycle: ${JSON.stringify(interrupted)}`);
  });
  return states;
}

async function waitForCameraStopped(label, senderName, receivingPage, peers,
  expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt) {
  await waitForRemoteParticipantState(receivingPage, senderName, "camera", "off");
  const deadline = Date.now() + cameraStopTimeoutMs;
  let previous;
  let quietSince;
  let lastState;
  while (Date.now() < deadline) {
    const states = await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts, label, mediaStartedAt);
    const receiver = states[peers.indexOf(receivingPage)];
    const current = cameraObservation(receiver, senderName);
    lastState = receiver;
    assert.equal(current.cameraState, "off", `${label}: remote camera state did not update to off`);
    assert.ok(current.inboundStatsCount > 0,
      `${label}: no receiver RTP stats are associated with the remote camera: ${JSON.stringify(summarizePeerState(receiver))}`);
    const progressed = previous && (current.bytesReceived > previous.bytesReceived ||
      current.framesReceived > previous.framesReceived || current.framesDecoded > previous.framesDecoded ||
      current.currentTime > previous.currentTime + 0.01);
    if (progressed) {
      quietSince = undefined;
    } else {
      quietSince ??= Date.now();
      if (Date.now() - quietSince >= cameraStopObservationMs) {
        console.log(`[pass] ${label}: remote camera state is off and camera RTP/frame time stopped`);
        return;
      }
    }
    previous = current;
    await delay(mediaProgressPollMs);
  }
  assert.fail(`${label}: remote camera kept progressing after pause: ${JSON.stringify({
    camera: cameraObservation(lastState, senderName),
    state: summarizePeerState(lastState)
  })}`);
}

async function waitForCameraProgress(label, senderName, receivingPage, peers,
  expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt) {
  await waitForRemoteParticipantState(receivingPage, senderName, "camera", "on");
  await waitForRemoteCamera(receivingPage, senderName);
  const statsDeadline = Date.now() + mediaProgressTimeoutMs;
  let initialState;
  let initial;
  while (Date.now() < statsDeadline) {
    const states = await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts, label, mediaStartedAt);
    initialState = states[peers.indexOf(receivingPage)];
    initial = cameraObservation(initialState, senderName);
    if (initial.inboundStatsCount > 0 && initial.width > 0 && initial.height > 0) break;
    await delay(mediaProgressPollMs);
  }
  assert.ok(initial?.inboundStatsCount > 0,
    `${label}: no receiver RTP stats are associated with the remote camera after renegotiation: ${JSON.stringify(summarizePeerState(initialState))}`);
  const deadline = Date.now() + mediaProgressTimeoutMs;
  let lastState = initialState;
  while (Date.now() < deadline) {
    const states = await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts, label, mediaStartedAt);
    const receiver = states[peers.indexOf(receivingPage)];
    lastState = receiver;
    const current = cameraObservation(receiver, senderName);
    assert.equal(current.cameraState, "on", `${label}: remote camera state is not on`);
    if (current.width > 0 && current.height > 0 && current.bytesReceived > initial.bytesReceived &&
        current.framesDecoded > initial.framesDecoded && current.currentTime > initial.currentTime + 0.05) {
      await waitForPeerStability(peers, 750, 5000);
      await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts, label, mediaStartedAt);
      console.log(`[pass] ${label}: camera RTP, decoded frames, and video time advanced`);
      return;
    }
    await delay(mediaProgressPollMs);
  }
  assert.fail(`${label}: remote camera did not resume decoded frames and video time: ${JSON.stringify({
    initial,
    current: cameraObservation(lastState, senderName),
    state: summarizePeerState(lastState)
  })}`);
}

async function getCameraSenderID(page) {
  return page.evaluate(() => {
    const event = window.__slowMeetTest.replaceTrackEvents
      .filter((entry) => entry.kind === "video" && entry.nextTrackId === null).at(-1);
    if (!event) throw new Error("camera sender has no replaceTrack(null) event to identify");
    window.__slowMeetTest.cameraSenderID = event.senderID;
    return event.senderID;
  });
}

async function assertVideoSenderProgress(page, senderID, label, durationMs = 1200) {
  const before = videoSenderStats(await diagnostics(page), senderID);
  assert.ok(before, `${label}: camera sender ${senderID} has no outbound video RTP stats`);
  await delay(durationMs);
  const after = videoSenderStats(await diagnostics(page), senderID);
  assert.ok(after && after.bytesSent > before.bytesSent && after.packetsSent > before.packetsSent,
    `${label}: camera sender RTP did not advance: ${JSON.stringify({ before, after })}`);
}

async function assertCameraRTPContinues(sharerPage, receiverPage, senderName, senderID, label,
  peers, expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt) {
  const [beforeSenderState, beforeReceiverState] = await Promise.all([
    diagnostics(sharerPage), diagnostics(receiverPage)
  ]);
  const beforeSender = videoSenderStats(beforeSenderState, senderID);
  const beforeReceiver = cameraObservation(beforeReceiverState, senderName);
  assert.ok(beforeSender && beforeReceiver.inboundStatsCount > 0,
    `${label}: missing camera sender or receiver RTP stats: ${JSON.stringify({ beforeSender, beforeReceiver })}`);
  await delay(1500);
  const [afterSenderState, afterReceiverState] = await Promise.all([
    diagnostics(sharerPage), diagnostics(receiverPage)
  ]);
  const afterSender = videoSenderStats(afterSenderState, senderID);
  const afterReceiver = cameraObservation(afterReceiverState, senderName);
  await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts, label, mediaStartedAt);
  assert.ok(afterSender && afterSender.bytesSent > beforeSender.bytesSent &&
    afterSender.packetsSent > beforeSender.packetsSent,
  `${label}: camera sender RTP stopped while screen video was main: ${JSON.stringify({ beforeSender, afterSender })}`);
  assert.ok(afterReceiver.bytesReceived > beforeReceiver.bytesReceived,
    `${label}: receiver camera RTP stopped while screen video was main: ${JSON.stringify({ beforeReceiver, afterReceiver })}`);
  console.log(`[pass] ${label}: camera sender and receiver RTP advanced while screen video was main`);
}

async function toggleCameraAndAssert(label, senderName, senderPage, receiverPage, peers,
  expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt) {
  const eventCount = await senderPage.evaluate(() => window.__slowMeetTest.replaceTrackEvents.length);
  await setButtonPressed(senderPage, "#camera", false);
  await senderPage.waitForFunction((previousCount) => {
    const events = window.__slowMeetTest.replaceTrackEvents;
    return events.length > previousCount && events.at(-1)?.kind === "video" && events.at(-1)?.nextTrackId === null;
  }, eventCount, { timeout: 15000 });
  const stoppedSenderID = await getCameraSenderID(senderPage);
  await waitForCameraStopped(`${label} paused`, senderName, receiverPage, peers,
    expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt);

  const resumeEventCount = await senderPage.evaluate(() => window.__slowMeetTest.replaceTrackEvents.length);
  await setButtonPressed(senderPage, "#camera", true);
  await senderPage.waitForFunction(({ previousCount, senderID }) =>
    window.__slowMeetTest.replaceTrackEvents.slice(previousCount).some((event) =>
      event.senderID === senderID && event.kind === "video" && event.nextTrackId !== null),
  { previousCount: resumeEventCount, senderID: stoppedSenderID }, { timeout: 15000 });
  const resumedSenderID = await senderPage.evaluate(({ previousCount }) =>
    window.__slowMeetTest.replaceTrackEvents.slice(previousCount)
      .filter((event) => event.kind === "video" && event.nextTrackId !== null).at(-1)?.senderID,
  { previousCount: resumeEventCount });
  assert.equal(resumedSenderID, stoppedSenderID, `${label}: camera resume must reuse the established video sender`);
  await senderPage.evaluate((senderID) => { window.__slowMeetTest.cameraSenderID = senderID; }, stoppedSenderID);
  await waitForCameraProgress(`${label} resumed`, senderName, receiverPage, peers,
    expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt);
  return stoppedSenderID;
}

async function toggleIncomingVideoAndAssert(label, senderName, senderPage, receiverPage, peers,
  senderID, expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt) {
  await setButtonPressed(receiverPage, "#receive-video", false);
  await waitForRemoteParticipantState(receiverPage, senderName, "receiveVideo", "false");
  await waitForPeerStability(peers, 750, 10000);
  await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts, `${label} incoming video off`, mediaStartedAt);
  const remote = (await diagnostics(receiverPage)).remoteParticipants.find((entry) =>
    !entry.local && entry.name.includes(senderName));
  assert.equal(remote?.cameraState, "on", `${label}: disabling incoming video changed the sender camera state`);
  await assertVideoSenderProgress(senderPage, senderID, `${label} sender continues while incoming video is off`);

  await setButtonPressed(receiverPage, "#receive-video", true);
  await waitForRemoteParticipantState(receiverPage, senderName, "receiveVideo", "true");
  await Promise.all(peers.map((page) => waitForPeerSignalingStable(page)));
  await waitForPeerStability(peers, 750, 10000);
  await waitForCameraProgress(`${label} incoming video resumed`, senderName, receiverPage, peers,
    expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt);
}

async function testParticipantLeaveAndRejoin(leavingPage, remainingPage, senderName, peers,
  expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt, baseURL) {
  const leavingIndex = peers.indexOf(leavingPage);
  const remainingIndex = peers.indexOf(remainingPage);

  await leavingPage.locator("#leave").click();
  await leavingPage.locator("#meeting").waitFor({ state: "hidden", timeout: 15000 });
  await remainingPage.waitForFunction((name) => ![...document.querySelectorAll("#participants li[data-participant-id]")]
    .some((item) => !item.classList.contains("is-local") && item.textContent.includes(name)),
  senderName, { timeout: 15000 });
  await waitForPeerStability([remainingPage], 1000, 10000);
  const remainingState = await diagnostics(remainingPage);
  assert.equal(remainingState.peerConnectionCount, expectedPeerConnectionCounts[remainingIndex],
    "the remaining participant should keep its established peer connection while the other leaves");
  assert.equal(remainingState.socketCount, expectedSocketCounts[remainingIndex],
    "the remaining participant should keep its signaling socket while the other leaves");

  await leavingPage.goto(baseURL);
  await leavingPage.locator("#name").fill(senderName);
  await leavingPage.locator("#join").click();
  await leavingPage.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
  await waitForPeerConnection(leavingPage, "connected", 15000);

  const nextPeerCounts = [...expectedPeerConnectionCounts];
  const nextSocketCounts = [...expectedSocketCounts];
  nextPeerCounts[leavingIndex] = 1;
  nextSocketCounts[leavingIndex] = 1;
  await waitForPeerStability(peers, 1000, 15000);
  const rejoinedAt = Date.now();
  const states = await assertPeersConnected(peers, nextPeerCounts, nextSocketCounts,
    `${senderName} rejoined`, mediaStartedAt, transientDisconnectGraceMs);
  assert.equal(states[remainingIndex].peerConnectionCount, expectedPeerConnectionCounts[remainingIndex],
    "the remaining participant must not reconnect when the other rejoins");
  assert.equal(states[remainingIndex].socketCount, expectedSocketCounts[remainingIndex],
    "the remaining participant must not reopen signaling when the other rejoins");

  await setButtonPressed(leavingPage, "#camera", true);
  await waitForRemoteParticipantState(remainingPage, senderName, "camera", "on");
  await waitForCameraProgress(`${senderName} rejoined first camera share`, senderName,
    remainingPage, peers, nextPeerCounts, nextSocketCounts, rejoinedAt);
  const senderID = await toggleCameraAndAssert(`${senderName} rejoined camera reuse`, senderName,
    leavingPage, remainingPage, peers, nextPeerCounts, nextSocketCounts, rejoinedAt);
  await waitForPeerStability(peers, 750, 10000);
  await assertPeersConnected(peers, nextPeerCounts, nextSocketCounts,
    `${senderName} rejoined camera resumed`, rejoinedAt);
  console.log(`[pass] ${senderName} leave/rejoin: remaining peer stayed connected and camera sender ${senderID} resumed`);
  return { peerConnectionCounts: nextPeerCounts, socketCounts: nextSocketCounts, mediaStartedAt: rejoinedAt };
}

async function monitorCamera(label, senderName, receivingPage, peers, expectedPeerConnectionCounts, durationMs = stabilityMs) {
  durationMs = Math.max(durationMs, noProgressLimitMs + pollIntervalMs);
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
        networkQuality: state.networkQuality,
        adaptationState: state.adaptationState,
        videoRtpStats: state.videoRtpStats.map(({ type, ssrc, packetsReceived, packetsSent, packetsLost,
          bytesReceived, bytesSent, framesDecoded: decoded, framesEncoded, keyFramesDecoded, keyFramesEncoded,
          nackCount, pliCount }) => ({
          type, ssrc, packetsReceived, packetsSent, packetsLost, bytesReceived, bytesSent,
          framesDecoded: decoded, framesEncoded, keyFramesDecoded, keyFramesEncoded, nackCount, pliCount
        })),
        audioStats: state.audioStats,
        audioRtpStats: state.audioRtpStats,
        remoteAudios: state.remoteAudios,
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
  try {
    await page.waitForFunction((mediaRole) => [...document.querySelectorAll(`#participants video[data-media-role='${mediaRole}']`)]
      .some((video) => video.videoWidth > 0 && video.videoHeight > 0 && !video.paused), role, { timeout: 30000 });
  } catch (error) {
    let state = {};
    try {
      const current = await diagnostics(page);
      state = {
        connectionState: current.connectionState,
        iceConnectionState: current.iceConnectionState,
        signalingState: current.signalingState,
        remoteVideos: current.remoteVideos.map(({ role: mediaRole, width, height, currentTime, paused, participant,
          inboundVideoStats }) => ({ mediaRole, width, height, currentTime, paused, participant, inboundVideoStats }))
      };
    } catch (diagnosticError) {
      state = { diagnosticError: diagnosticError.message };
    }
    throw new Error(`${label}: remote ${role} video did not become active; ${JSON.stringify(state)}`, { cause: error });
  }
  const startTime = await page.evaluate((mediaRole) => Math.max(0, ...[...document.querySelectorAll(`#participants video[data-media-role='${mediaRole}']`)]
    .map((video) => video.currentTime)), role);
  const before = await diagnostics(page);
  const beforeFrames = before.remoteVideos.filter((video) => video.role === role)
    .flatMap((video) => video.inboundVideoStats)
    .reduce((total, stat) => total + (Number(stat.framesDecoded) || 0), 0);
  await page.waitForFunction(({ mediaRole, previousTime }) => [...document.querySelectorAll(`#participants video[data-media-role='${mediaRole}']`)]
    .some((video) => video.videoWidth > 0 && video.videoHeight > 0 && video.currentTime > previousTime + 0.5),
  { mediaRole: role, previousTime: startTime }, { timeout: 15000 });
  await page.waitForFunction(async ({ mediaRole, previousFrames }) => {
    const peer = window.__slowMeetTest?.peerConnections.at(-1);
    if (!peer) return false;
    const videos = [...document.querySelectorAll(`#participants video[data-media-role='${mediaRole}']`)];
    let decodedFrames = 0;
    for (const video of videos) {
      for (const track of video.srcObject?.getVideoTracks?.() || []) {
        const receiver = peer.getReceivers().find((candidate) => candidate.track?.id === track.id);
        if (!receiver?.getStats) continue;
        const report = await receiver.getStats();
        for (const stat of report.values()) {
          if (stat.type === "inbound-rtp" && (stat.kind || stat.mediaType) === "video") {
            decodedFrames += Number(stat.framesDecoded) || 0;
          }
        }
      }
    }
    return decodedFrames > previousFrames && videos.some((video) =>
      video.videoWidth > 0 && video.videoHeight > 0 && !video.paused);
  }, { mediaRole: role, previousFrames: beforeFrames }, { timeout: 15000 });
  console.log(`[pass] ${label}: remote ${role} video time advanced`);
}

function audioQualitySample(state) {
  const rttSeconds = state.candidatePair?.currentRoundTripTime;
  return {
    rttMs: Number.isFinite(rttSeconds) ? Number((rttSeconds * 1000).toFixed(1)) : null,
    outbound: state.audioStats?.outbound || null,
    inbound: state.audioStats?.inbound || null
  };
}

function audioQualityDelta(before, after) {
  if (!before || !after) return null;
  const delta = (field) => Number.isFinite(before[field]) && Number.isFinite(after[field])
    ? after[field] - before[field] : null;
  const jitterBufferDelay = delta("jitterBufferDelayTotalMs");
  const emitted = delta("jitterBufferEmittedCount");
  const packetsReceived = delta("packetsReceived");
  const packetsLost = delta("packetsLost");
  return {
    bytesSent: delta("bytesSent"),
    bytesReceived: delta("bytesReceived"),
    packetsSent: delta("packetsSent"),
    packetsReceived: delta("packetsReceived"),
    packetsLost: delta("packetsLost"),
    packetLossPct: packetsReceived !== null && packetsLost !== null && packetsReceived + packetsLost > 0
      ? Number((packetsLost / (packetsReceived + packetsLost) * 100).toFixed(2)) : null,
    jitterMs: after.jitterMs,
    jitterBufferDelayMs: jitterBufferDelay !== null && emitted > 0 ? jitterBufferDelay / emitted : null,
    jitterBufferEmittedCount: emitted,
    totalSamplesReceived: delta("totalSamplesReceived"),
    concealedSamples: delta("concealedSamples"),
    concealmentEvents: delta("concealmentEvents")
  };
}

function reportAudioQuality(label, states, previousStates = null) {
  console.log(`[audio] ${label}: ${JSON.stringify(states.map((state, index) => ({
    participant: index === 0 ? "A" : "B",
    ...audioQualitySample(state),
    interval: previousStates ? {
      outbound: audioQualityDelta(previousStates[index]?.audioStats?.outbound, state.audioStats?.outbound),
      inbound: audioQualityDelta(previousStates[index]?.audioStats?.inbound, state.audioStats?.inbound)
    } : null
  })))}`);
}

async function waitForAudioProgress(sender, receiver, beforeSender, beforeReceiver, label) {
  const start = Date.now();
  while (Date.now() - start < 10000) {
    const [senderState, receiverState] = await Promise.all([diagnostics(sender), diagnostics(receiver)]);
    if (senderState.audioBytesSent > beforeSender.audioBytesSent &&
        receiverState.audioBytesReceived > beforeReceiver.audioBytesReceived) {
      assert.ok(senderState.audioStats?.outbound?.streams > 0,
        `${label}: outbound audio RTP stats were unavailable`);
      assert.ok(receiverState.audioStats?.inbound?.streams > 0,
        `${label}: inbound audio RTP stats were unavailable`);
      console.log(`[pass] ${label}: outbound and remote audio RTP advanced after unmute`);
      if (requestedScenario === "microphone mute and unmute with repeated toggles in both directions") {
        console.log(`[audio] ${label}: ${JSON.stringify({
          sender: audioQualitySample(senderState),
          receiver: audioQualitySample(receiverState)
        })}`);
      }
      return;
    }
    await delay(250);
  }
  assert.fail(`${label}: unmuted audio did not reach the other peer: ${JSON.stringify({
    sender: await diagnostics(sender),
    receiver: await diagnostics(receiver),
    beforeSender,
    beforeReceiver
  })}`);
}

async function monitorAudio(label, sender, receiver, durationMs = 6000) {
  const [beforeSender, beforeReceiver] = await Promise.all([diagnostics(sender), diagnostics(receiver)]);
  const startedAt = Date.now();
  let senderState = beforeSender;
  let receiverState = beforeReceiver;
  while (Date.now() - startedAt < durationMs) {
    [senderState, receiverState] = await Promise.all([diagnostics(sender), diagnostics(receiver)]);
    assert.equal(senderState.connectionState, "connected", `${label}: sender peer left connected state`);
    assert.equal(receiverState.connectionState, "connected", `${label}: receiver peer left connected state`);
    await delay(Math.min(pollIntervalMs, Math.max(1, durationMs - (Date.now() - startedAt))));
  }
  assert.ok(senderState.audioBytesSent > beforeSender.audioBytesSent,
    `${label}: sender audio RTP bytes did not advance (${beforeSender.audioBytesSent} -> ${senderState.audioBytesSent})`);
  assert.ok(receiverState.audioBytesReceived > beforeReceiver.audioBytesReceived,
    `${label}: receiver audio RTP bytes did not advance (${beforeReceiver.audioBytesReceived} -> ${receiverState.audioBytesReceived})`);
  assert.ok(senderState.audioStats?.outbound?.streams > 0, `${label}: outbound audio stats unavailable`);
  assert.ok(receiverState.audioStats?.inbound?.streams > 0, `${label}: inbound audio stats unavailable`);
  const beforePlayback = beforeReceiver.remoteAudios.find((audio) =>
    audio.audioTracks.some((track) => track.readyState === "live"));
  const afterPlayback = receiverState.remoteAudios.find((audio) =>
    audio.audioTracks.some((track) => track.readyState === "live"));
  assert.ok(afterPlayback && !afterPlayback.paused && !afterPlayback.muted && afterPlayback.volume > 0,
    `${label}: remote audio element is not actively playing: ${JSON.stringify(receiverState.remoteAudios)}`);
  assert.ok(beforePlayback && afterPlayback.currentTime > beforePlayback.currentTime,
    `${label}: remote audio playback time did not advance: ${JSON.stringify({ beforePlayback, afterPlayback })}`);
  console.log(`[pass] ${label}: audio RTP advanced; ${JSON.stringify({
    sender: audioQualitySample(senderState),
    receiver: audioQualitySample(receiverState)
  })}`);
}

async function testMicrophoneControls(pageA, pageB) {
  await setButtonPressed(pageA, "#mic", false);
  await waitForRemoteParticipantState(pageB, "Media A", "mic", "off");
  const [beforeSenderA, beforeReceiverB] = await Promise.all([diagnostics(pageA), diagnostics(pageB)]);
  await setButtonPressed(pageA, "#mic", true);
  await waitForRemoteParticipantState(pageB, "Media A", "mic", "on");
  await waitForAudioProgress(pageA, pageB, beforeSenderA, beforeReceiverB, "A microphone mute/unmute -> B");

  await setButtonPressed(pageB, "#mic", false);
  await waitForRemoteParticipantState(pageA, "Media B", "mic", "off");
  const [beforeSenderB, beforeReceiverA] = await Promise.all([diagnostics(pageB), diagnostics(pageA)]);
  await setButtonPressed(pageB, "#mic", true);
  await waitForRemoteParticipantState(pageA, "Media B", "mic", "on");
  await waitForAudioProgress(pageB, pageA, beforeSenderB, beforeReceiverA, "B microphone mute/unmute -> A");
}

async function activeVideoSenderID(page) {
  return page.evaluate(() => window.__slowMeetTest.videoSenders
    .find(({ sender }) => sender.track?.kind === "video")?.senderID ?? null);
}

async function openMeetingSidebar(page, trigger) {
  await page.locator(trigger).click();
  await page.waitForFunction(() => document.querySelector("#meeting-sidebar")?.getAttribute("aria-hidden") === "false",
    null, { timeout: 10000 });
}

async function closeMeetingSidebar(page) {
  await page.locator("#close-sidebar").click();
  await page.waitForFunction(() => document.querySelector("#meeting-sidebar")?.getAttribute("aria-hidden") === "true",
    null, { timeout: 10000 });
}

async function testParticipantFlows(pageA, pageB, peers, expectedPeerConnectionCounts,
  expectedSocketCounts, mediaStartedAt) {
  const firstMessage = `E2E chat A ${Date.now()}`;
  await pageA.locator("#chat").click();
  await pageA.locator("#chat-rail").waitFor({ state: "visible", timeout: 10000 });
  await pageA.locator("#chat-input").fill(firstMessage);
  await pageA.locator("#chat-form button[type='submit']").click();
  await pageB.waitForFunction((message) => [...document.querySelectorAll("#chat-messages .chat-message__body")]
    .some((entry) => entry.textContent === message), firstMessage, { timeout: 10000 });
  await pageB.waitForFunction(() => document.querySelector("#chat-badge")?.hidden === false, null, { timeout: 10000 });
  assert.match(await pageB.locator("#chat-badge").textContent(), /^[1-9]\d*$/, "received chat should update the unread badge");
  await pageB.locator("#chat").click();
  await pageB.locator("#chat-messages").getByText(firstMessage, { exact: true }).waitFor({ state: "visible", timeout: 10000 });

  const reply = `E2E chat B ${Date.now()}`;
  await pageB.locator("#chat-input").fill(reply);
  await pageB.locator("#chat-form button[type='submit']").click();
  await pageA.waitForFunction((message) => [...document.querySelectorAll("#chat-messages .chat-message__body")]
    .some((entry) => entry.textContent === message), reply, { timeout: 10000 });
  console.log("[pass] chat messages and unread state synchronized A -> B -> A");
  await pageA.locator("#close-chat").click();
  await pageB.locator("#close-chat").click();

  await pageA.locator("#reactions").click();
  await pageA.locator('#reaction-picker [data-reaction="👍"]').click();
  await pageB.waitForFunction(() => document.querySelector("#reaction-announcements")?.textContent.includes("Media A sent 👍"),
    null, { timeout: 10000 });
  await pageB.locator("#reactions").click();
  await pageB.locator('#reaction-picker [data-reaction="👏"]').click();
  await pageA.waitForFunction(() => document.querySelector("#reaction-announcements")?.textContent.includes("Media B sent 👏"),
    null, { timeout: 10000 });
  console.log("[pass] reaction announcements synchronized A -> B and B -> A");

  await setButtonPressed(pageA, "#raise-hand", true);
  await waitForRemoteParticipantState(pageB, "Media A", "handRaised", "true");
  await setButtonPressed(pageA, "#raise-hand", false);
  await waitForRemoteParticipantState(pageB, "Media A", "handRaised", "false");
  await setButtonPressed(pageB, "#raise-hand", true);
  await waitForRemoteParticipantState(pageA, "Media B", "handRaised", "true");
  await setButtonPressed(pageB, "#raise-hand", false);
  await waitForRemoteParticipantState(pageA, "Media B", "handRaised", "false");
  console.log("[pass] raised-hand state synchronized A -> B and B -> A");

  await openMeetingSidebar(pageA, "#participants-button");
  await pageA.waitForFunction(() => {
    const people = document.querySelector("#people-list")?.textContent || "";
    return people.includes("Media A") && people.includes("Media B");
  }, null, { timeout: 10000 });
  await closeMeetingSidebar(pageA);
  await openMeetingSidebar(pageB, "#participants-button");
  await pageB.waitForFunction(() => {
    const people = document.querySelector("#people-list")?.textContent || "";
    return people.includes("Media A") && people.includes("Media B");
  }, null, { timeout: 10000 });
  await closeMeetingSidebar(pageB);

  await pageA.locator("#connection").click();
  await pageA.locator("#connection-popover").waitFor({ state: "visible", timeout: 10000 });
  const connectionTitle = (await pageA.locator("#connection-popover-title").textContent())?.trim();
  assert.ok(connectionTitle, "connection details should have a status title");
  const oldRemoteUfrag = await pageA.evaluate(() => window.__slowMeetTest.peerConnections.at(-1)
    .remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "");
  await pageA.locator("#connection-popover-retry").click();
  await pageA.waitForFunction((previousUfrag) => {
    const peer = window.__slowMeetTest.peerConnections.at(-1);
    const nextUfrag = peer?.remoteDescription?.sdp.match(/^a=ice-ufrag:(.+)$/m)?.[1] || "";
    return nextUfrag && nextUfrag !== previousUfrag && peer.signalingState === "stable";
  }, oldRemoteUfrag, { timeout: 30000 });
  await waitForPeerStability(peers, 750, 15000);
  await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts,
    "connection panel retry", mediaStartedAt);
  console.log("[pass] connection details opened and retry completed an ICE restart");

  await openMeetingSidebar(pageA, "#more");
  await pageA.locator("#profile").selectOption("normal");
  await pageA.waitForFunction(() => localStorage.getItem("meeting.bandwidthProfile") === "normal");
  await pageA.locator("#camera-quality").selectOption("240p");
  await pageA.waitForFunction(() => localStorage.getItem("meeting.cameraQuality") === "240p");
  const senderID = await activeVideoSenderID(pageA);
  assert.ok(senderID, "quality controls require an active video sender");
  await assertVideoSenderProgress(pageA, senderID, "quality setting change");

  const beforeSelfViewToggle = await diagnostics(pageA);
  const senderBeforeSelfView = videoSenderStats(beforeSelfViewToggle, senderID);
  await pageA.locator("#self-view").uncheck();
  assert.equal(await pageA.locator("#self-view").isChecked(), false, "self-view should turn off");
  await delay(1200);
  const afterSelfViewToggle = await diagnostics(pageA);
  const senderAfterSelfView = videoSenderStats(afterSelfViewToggle, senderID);
  assert.equal(await pageA.locator("#camera").getAttribute("aria-pressed"), "true",
    "hiding self-view should leave camera intent enabled");
  assert.equal(senderAfterSelfView?.trackID, senderBeforeSelfView?.trackID,
    "hiding self-view should keep the active camera track attached to its sender");
  await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts,
    "self-view hidden", mediaStartedAt);
  if (afterSelfViewToggle.adaptationState.videoSuspendedAutomatically) {
    blockedScenarios.push("self-view RTP isolation was blocked because congestion control automatically suspended camera sending");
    console.log("[blocked] self-view RTP isolation: congestion control paused video during the observation window");
  } else {
    assert.ok(senderAfterSelfView && senderAfterSelfView.bytesSent > senderBeforeSelfView.bytesSent &&
      senderAfterSelfView.packetsSent > senderBeforeSelfView.packetsSent,
    "self-view hidden without stopping camera RTP: camera sender RTP did not advance");
    console.log("[pass] self-view hidden while camera RTP continued");
  }
  await pageA.locator("#self-view").check();

  await pageA.locator("#audio-only").check();
  await waitForRemoteParticipantState(pageB, "Media A", "camera", "off");
  await pageA.locator("#audio-only").uncheck();
  await waitForRemoteParticipantState(pageB, "Media A", "camera", "on");
  await waitForCameraProgress("Protect audio camera restore -> B", "Media A", pageB, peers,
    expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt);
  await pageA.locator("#camera-quality").selectOption("360p");
  await pageA.locator("#profile").selectOption("auto");
  await pageA.waitForFunction(() => localStorage.getItem("meeting.cameraQuality") === "360p" &&
    localStorage.getItem("meeting.bandwidthProfile") === "auto");
  await closeMeetingSidebar(pageA);

  const fullscreen = pageA.locator("#fullscreen");
  if (await fullscreen.isVisible()) {
    await fullscreen.click();
    await pageA.waitForFunction(() => document.fullscreenElement === document.querySelector("#meeting"), null, { timeout: 10000 });
    await pageA.keyboard.press("Escape");
    await pageA.waitForFunction(() => !document.fullscreenElement, null, { timeout: 10000 });
    console.log("[pass] fullscreen display control entered and exited");
  } else {
    blockedScenarios.push("fullscreen display control is unavailable in this Chromium environment");
    console.log("[blocked] fullscreen display control is unavailable in this Chromium environment");
  }

  console.log("[pass] participant roster, connection details, quality, and display settings exercised");
}

async function testDeviceSelectionForParticipant(pageA, participant) {
  await openMeetingSidebar(pageA, "#more");
  const { candidates, currentDeviceIDs } = await pageA.evaluate(() => ({
    candidates: {
      camera: [...document.querySelectorAll("#settings-camera option")].map(({ value, textContent }) => ({ value, label: textContent })),
      microphone: [...document.querySelectorAll("#settings-mic option")].map(({ value, textContent }) => ({ value, label: textContent }))
    },
    currentDeviceIDs: Object.fromEntries(window.__slowMeetTest.peerConnections.at(-1).getSenders()
      .filter((sender) => sender.track).map((sender) => [sender.track.kind, sender.track.getSettings?.().deviceId || ""]))
  }));

  for (const [kind, selector, options] of [
    ["video", "#settings-camera", candidates.camera],
    ["audio", "#settings-mic", candidates.microphone]
  ]) {
    const availableDevices = options.filter((option) => option.value && option.value !== "default");
    const currentDeviceID = currentDeviceIDs[kind];
    const alternatives = availableDevices.filter((option) => option.value !== currentDeviceID);
    const selected = alternatives.find((option) => option.value.startsWith("slowmeet-e2e-")) ||
      (currentDeviceID ? alternatives[0] : availableDevices.length > 1 ? alternatives[0] : undefined);
    if (!selected) {
      blockedScenarios.push(`${participant}'s ${kind} device selection was unavailable because Chromium exposed no alternate input`);
      console.log(`[blocked] ${participant} ${kind} device selection: Chromium exposed no alternate input`);
      continue;
    }
    const previousTrackID = await pageA.evaluate((mediaKind) => window.__slowMeetTest.peerConnections.at(-1)
      .getSenders().find((sender) => sender.track?.kind === mediaKind)?.track?.id || "", kind);
    const senderID = kind === "video" ? await activeVideoSenderID(pageA) : undefined;
    await pageA.locator(selector).selectOption(selected.value);
    await pageA.waitForFunction(({ mediaKind, deviceID }) => {
      const requests = window.__slowMeetTest.deviceSelectionRequests;
      return requests.some((request) => request.kind === mediaKind && request.deviceId === deviceID) ||
        window.__slowMeetTest.replaceTrackEvents.some((event) => event.kind === mediaKind);
    }, { mediaKind: kind, deviceID: selected.value }, { timeout: 15000 });
    await pageA.waitForFunction(({ mediaKind, previousID }) => {
      const trackID = window.__slowMeetTest.peerConnections.at(-1)
        .getSenders().find((sender) => sender.track?.kind === mediaKind)?.track?.id || "";
      return trackID && trackID !== previousID;
    }, { mediaKind: kind, previousID: previousTrackID }, { timeout: 15000 });
    if (kind === "video") {
      assert.equal(await activeVideoSenderID(pageA), senderID,
        "camera device selection should preserve the negotiated video sender");
    }
    console.log(`[pass] ${participant} ${kind} device selection replaced the active local track`);
  }
  for (const [kind, selector] of [["video", "#settings-camera"], ["audio", "#settings-mic"]]) {
    const previousTrackID = await pageA.evaluate((mediaKind) => window.__slowMeetTest.peerConnections.at(-1)
      .getSenders().find((sender) => sender.track?.kind === mediaKind)?.track?.id || "", kind);
    const senderID = kind === "video" ? await activeVideoSenderID(pageA) : undefined;
    const previousReplaceCount = await pageA.evaluate(() => window.__slowMeetTest.replaceTrackEvents.length);
    await pageA.locator(selector).selectOption("");
    await pageA.waitForFunction(({ mediaKind, previousID, replaceCount }) => {
      const peer = window.__slowMeetTest.peerConnections.at(-1);
      const trackID = peer.getSenders().find((sender) => sender.track?.kind === mediaKind)?.track?.id || "";
      const replacement = window.__slowMeetTest.replaceTrackEvents.slice(replaceCount)
        .some((event) => event.kind === mediaKind && event.nextTrackId === trackID);
      return trackID && trackID !== previousID && replacement;
    }, { mediaKind: kind, previousID: previousTrackID, replaceCount: previousReplaceCount }, { timeout: 15000 });
    if (kind === "video") {
      assert.equal(await activeVideoSenderID(pageA), senderID,
        "restoring the default camera should preserve the negotiated video sender");
    }
    console.log(`[pass] ${participant} ${kind} default device restored with a replacement track`);
  }
  await closeMeetingSidebar(pageA);
}

async function testDeviceSelection(pageA, pageB) {
  await testDeviceSelectionForParticipant(pageA, "A");
  await testDeviceSelectionForParticipant(pageB, "B");
}

async function testSignalingReconnect(pageA, pageB, peers, mediaStartedAt) {
  const before = await diagnostics(pageA);
  await pageA.evaluate(() => {
    const socket = window.__slowMeetTest.sockets.at(-1);
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("cannot force reconnect without an open signaling socket");
    socket.close(4001, "media e2e reconnect");
  });
  await pageA.waitForFunction((socketCount) => window.__slowMeetTest.sockets.length > socketCount,
    before.socketCount, { timeout: 25000 });
  await waitForPeerConnection(pageA, "connected", 30000);
  await waitForPeerConnection(pageB, "connected", 30000);
  await waitForPeerStability(peers, 1000, 30000);
  const states = await Promise.all(peers.map(diagnostics));
  assert.ok(states[0].peerConnectionCount > before.peerConnectionCount,
    "signaling reconnect should establish a new media peer connection for the reconnecting participant");
  assert.equal(states[0].socketCount, before.socketCount + 1,
    "signaling reconnect should establish one new WebSocket");
  await Promise.all([
    waitForCameraProgress("signaling reconnect A -> B", "Media A", pageB, peers,
      states.map((state) => state.peerConnectionCount), states.map((state) => state.socketCount), mediaStartedAt),
    waitForCameraProgress("signaling reconnect B -> A", "Media B", pageA, peers,
      states.map((state) => state.peerConnectionCount), states.map((state) => state.socketCount), mediaStartedAt)
  ]);
  console.log("[pass] signaling reconnect restored both cameras with connected peers");
  return {
    peerConnectionCounts: states.map((state) => state.peerConnectionCount),
    socketCounts: states.map((state) => state.socketCount)
  };
}

function applyNetworkProfile({ rate, delay: latency, loss }) {
  if (!testNetworkNamespace) throw new Error("network impairment is restricted to the isolated media E2E namespace");
  const args = ["qdisc", "replace", "dev", "lo", "root", "netem", "rate", rate, "delay", latency];
  if (loss && loss !== "0%") args.push("loss", loss);
  execFileSync("tc", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function clearNetworkProfile() {
  if (!testNetworkNamespace) return;
  try {
    execFileSync("tc", ["qdisc", "del", "dev", "lo", "root"], { stdio: "ignore" });
  } catch (_) {}
}

function networkQueueStats() {
  return execFileSync("tc", ["-s", "qdisc", "show", "dev", "lo"], { encoding: "utf8" });
}

function droppedPacketCount(output) {
  return [...output.matchAll(/dropped\s+(\d+)/g)].reduce((total, match) => total + Number(match[1]), 0);
}

function maximumRoundTripMs(states) {
  const samples = states.map((state) => state.candidatePair?.currentRoundTripTime)
    .filter((sample) => Number.isFinite(sample));
  return samples.length ? Math.max(...samples) * 1000 : null;
}

function receivedVideoLoss(states) {
  return states.reduce((total, state) => total + state.videoRtpStats
    .filter((stat) => stat.type === "inbound-rtp")
    .reduce((subtotal, stat) => subtotal + (Number(stat.packetsLost) || 0), 0), 0);
}

function receivedAudioLoss(states) {
  const samples = states.map((state) => state.audioStats?.inbound?.packetsLost)
    .filter(Number.isFinite);
  return samples.length ? samples.reduce((total, sample) => total + sample, 0) : null;
}

async function testNetworkImpairmentMode(pageA, pageB, peers, expectedPeerConnectionCounts,
  expectedSocketCounts, mediaStartedAt) {
  if (!testNetworkImpairment) return;
  if (!testNetworkNamespace) throw new Error("isolated network namespace is required for netem scenarios");

  const beforeStates = await Promise.all(peers.map(diagnostics));
  reportAudioQuality("baseline", beforeStates);
  const baselineRTT = maximumRoundTripMs(beforeStates);
  let maximumImpairedRTT = baselineRTT;
  let previousStates = beforeStates;
  let previousLoss = receivedVideoLoss(beforeStates);
  let previousAudioLoss = receivedAudioLoss(beforeStates);
  let sawImpairment = false;
  const profiles = [
    { label: "1mbit / 100ms", rate: "1mbit", delay: "100ms", loss: "0%" },
    { label: "200kbit / 200ms / 3% loss", rate: "200kbit", delay: "200ms", loss: "3%" }
  ];

  try {
    for (const profile of profiles) {
      const queueBefore = networkQueueStats();
      applyNetworkProfile(profile);
      await Promise.all([
        monitorCamera(`${profile.label} A -> B`, "Media A", pageB, peers, expectedPeerConnectionCounts, 6000),
        monitorCamera(`${profile.label} B -> A`, "Media B", pageA, peers, expectedPeerConnectionCounts, 6000),
        monitorAudio(`${profile.label} audio A -> B`, pageA, pageB, 6000),
        monitorAudio(`${profile.label} audio B -> A`, pageB, pageA, 6000)
      ]);
      const afterStates = await Promise.all(peers.map(diagnostics));
      const rtt = maximumRoundTripMs(afterStates);
      const loss = receivedVideoLoss(afterStates);
      const audioLoss = receivedAudioLoss(afterStates);
      const queueAfter = networkQueueStats();
      const queueDrops = droppedPacketCount(queueAfter) - droppedPacketCount(queueBefore);
      const rttIncreased = rtt !== null && baselineRTT !== null && rtt >= baselineRTT + 50;
      const rtpLossIncreased = loss > previousLoss;
      const audioLossIncreased = audioLoss !== null && previousAudioLoss !== null && audioLoss > previousAudioLoss;
      assert.match(queueAfter, /qdisc netem/, `${profile.label}: isolated netem profile was not installed`);
      maximumImpairedRTT = rtt === null ? maximumImpairedRTT : Math.max(maximumImpairedRTT ?? 0, rtt);
      previousLoss = loss;
      previousAudioLoss = audioLoss;
      sawImpairment ||= rttIncreased || rtpLossIncreased || audioLossIncreased || queueDrops > 0;
      reportAudioQuality(`impaired ${profile.label}`, afterStates, previousStates);
      previousStates = afterStates;
      console.log(`[pass] isolated network profile ${profile.label}: rtt=${rtt ?? "unavailable"}ms, inboundVideoLoss=${loss}, inboundAudioLoss=${audioLoss ?? "unavailable"}, qdiscDrops=${queueDrops}`);
    }
  } finally {
    clearNetworkProfile();
  }

  await waitForPeerStability(peers, 1500, 20000);
  await Promise.all([
    monitorCamera("network recovery A -> B", "Media A", pageB, peers, expectedPeerConnectionCounts, 6000),
    monitorCamera("network recovery B -> A", "Media B", pageA, peers, expectedPeerConnectionCounts, 6000),
    monitorAudio("network recovery audio A -> B", pageA, pageB, 6000),
    monitorAudio("network recovery audio B -> A", pageB, pageA, 6000)
  ]);
  const recovered = await Promise.all(peers.map(diagnostics));
  const recoveredRTT = maximumRoundTripMs(recovered);
  reportAudioQuality("recovery", recovered, previousStates);
  const queueAfterRecovery = networkQueueStats();
  assert.doesNotMatch(queueAfterRecovery, /qdisc netem/, "netem should be removed after recovery");
  if (maximumImpairedRTT !== null && recoveredRTT !== null) {
    assert.ok(recoveredRTT < maximumImpairedRTT,
      `RTT did not recover after impairment removal: impaired=${maximumImpairedRTT}ms recovered=${recoveredRTT}ms`);
  }
  assert.ok(sawImpairment, "at least one isolated network profile must measurably affect the media path");
  console.log(`[pass] isolated network impairment recovered: rtt=${recoveredRTT ?? "unavailable"}ms; both audio and video directions continued`);
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

async function createFailureTrackedContext(browser, baseURL, contexts, traceContexts) {
  const context = await browser.newContext();
  contexts.push(context);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: false });
  traceContexts.add(context);
  await context.grantPermissions(["camera", "microphone"], { origin: new URL(baseURL).origin });
  return context;
}

async function closeSuccessfulDiagnosticContext(context, contexts, traceContexts) {
  await Promise.all(context.pages().map(leaveMeetingBeforeClose));
  if (traceContexts.has(context)) {
    await context.tracing.stop().catch(() => {});
    traceContexts.delete(context);
  }
  const index = contexts.indexOf(context);
  if (index >= 0) contexts.splice(index, 1);
  await context.close().catch(() => {});
}

async function testUnavailableMicrophone(browser, baseURL, contexts, traceContexts) {
  const context = await createFailureTrackedContext(browser, baseURL, contexts, traceContexts);
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => {
      if (constraints?.audio) {
        return Promise.reject(new DOMException("Requested microphone is unavailable", "NotFoundError"));
      }
      return original(constraints);
    };
  });
  let passed = false;
  try {
    const page = await joinMeeting(context, "No microphone", baseURL);
    await waitForPeerConnection(page);
    await page.waitForFunction(() => document.querySelector("#mic")?.disabled === true);
    assert.equal(await page.locator("#mic").getAttribute("aria-label"), "Microphone unavailable");
    console.log("[pass] unavailable microphone: meeting joined and microphone control is disabled");
    passed = true;
  } finally {
    if (passed) await closeSuccessfulDiagnosticContext(context, contexts, traceContexts);
  }
}

async function testUnavailableCamera(browser, baseURL, contexts, traceContexts) {
  const context = await createFailureTrackedContext(browser, baseURL, contexts, traceContexts);
  await context.addInitScript(() => {
    const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = (constraints) => constraints?.video
      ? Promise.reject(new DOMException("Requested camera is unavailable", "NotFoundError"))
      : original(constraints);
  });
  let passed = false;
  try {
    const page = await joinMeeting(context, "No camera", baseURL);
    await waitForPeerConnection(page);
    await page.locator("#camera").click();
    await page.waitForFunction(() => document.querySelector("#status")?.textContent.includes("Camera unavailable"),
      null, { timeout: 15000 });
    assert.equal(await page.locator("#camera").getAttribute("aria-pressed"), "false");
    assert.equal(await page.locator("#camera").getAttribute("aria-busy"), null,
      "failed camera requests must clear the busy state");
    assert.equal(await page.locator("#camera").evaluate((button) =>
      button.classList.contains("control-button--pending")), false,
    "failed camera requests must clear the pending style");
    await waitForPeerConnection(page);
    console.log("[pass] unavailable camera: meeting stayed connected and continued without video");
    passed = true;
  } finally {
    if (passed) await closeSuccessfulDiagnosticContext(context, contexts, traceContexts);
  }
}

async function testCameraPendingState(browser, baseURL, contexts, traceContexts) {
  const context = await createFailureTrackedContext(browser, baseURL, contexts, traceContexts);
  let passed = false;
  try {
    const page = await joinMeeting(context, "Camera pending", baseURL);
    await waitForPeerConnection(page);
    await page.evaluate(() => {
      const originalApplyConstraints = MediaStreamTrack.prototype.applyConstraints;
      let shouldHold = true;
      MediaStreamTrack.prototype.applyConstraints = function (...args) {
        if (this.kind !== "video" || !shouldHold) return originalApplyConstraints.apply(this, args);
        shouldHold = false;
        return new Promise((resolve, reject) => {
          window.__releasePendingCameraCapture = () => {
            MediaStreamTrack.prototype.applyConstraints = originalApplyConstraints;
            Promise.resolve(originalApplyConstraints.apply(this, args)).then(resolve, reject);
          };
        });
      };
    });

    const cameraButton = page.locator("#camera");
    await cameraButton.click();
    await page.waitForFunction(() => typeof window.__releasePendingCameraCapture === "function" &&
      document.querySelector("#camera")?.getAttribute("aria-busy") === "true", null, { timeout: 10000 });
    const pendingState = await cameraButton.evaluate((button) => {
      const expectedWarning = getComputedStyle(button).getPropertyValue("--lm-warning").trim();
      const probe = document.createElement("span");
      probe.style.color = expectedWarning;
      document.body.append(probe);
      const warningColor = getComputedStyle(probe).color;
      probe.remove();
      return {
        busy: button.getAttribute("aria-busy"),
        pressed: button.getAttribute("aria-pressed"),
        pending: button.classList.contains("control-button--pending"),
        iconColor: getComputedStyle(button.querySelector(".control-icon")).color,
        warningColor
      };
    });
    assert.equal(pendingState.busy, "true", "camera capture should expose a busy state");
    assert.equal(pendingState.pressed, "true", "aria-pressed should reflect the locally active camera track");
    assert.equal(pendingState.pending, true, "camera capture should set the pending class");
    assert.equal(pendingState.iconColor, pendingState.warningColor,
      "camera icon should use the existing warning color while pending");

    await cameraButton.click();
    assert.equal(await cameraButton.getAttribute("aria-busy"), "true",
      "a queued camera target must not clear pending state");
    await page.evaluate(() => window.__releasePendingCameraCapture());
    await page.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-busy") !== "true" &&
      document.querySelector("#camera")?.getAttribute("aria-pressed") === "false", null, { timeout: 15000 });
    assert.equal(await cameraButton.evaluate((button) =>
      button.classList.contains("control-button--pending")), false,
    "pending state should clear after the queued camera target settles");

    await cameraButton.click();
    await page.waitForFunction(() => document.querySelector("#camera")?.getAttribute("aria-busy") !== "true" &&
      document.querySelector("#camera")?.getAttribute("aria-pressed") === "true", null, { timeout: 15000 });
    assert.equal(await cameraButton.evaluate((button) =>
      button.classList.contains("control-button--pending")), false,
    "successful camera requests must clear the pending style");
    console.log("[pass] camera pending UI: warning icon and busy state persist through queued targets, then clear on settle");
    passed = true;
  } finally {
    if (passed) await closeSuccessfulDiagnosticContext(context, contexts, traceContexts);
  }
}

async function testDeniedCapturePermissions(browser, baseURL, contexts, traceContexts) {
  const context = await createFailureTrackedContext(browser, baseURL, contexts, traceContexts);
  await context.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = (constraints) => {
      const kind = constraints?.video ? "camera" : "microphone";
      return Promise.reject(new DOMException(`${kind} permission denied by media E2E`, "NotAllowedError"));
    };
  });
  let passed = false;
  try {
    const page = await joinMeeting(context, "Denied media", baseURL, false, false);
    await page.locator("#test-media").click();
    await page.waitForFunction(() => document.querySelector("#test-camera")?.textContent.includes("Camera access denied") &&
      document.querySelector("#test-microphone")?.textContent.includes("Microphone access denied") &&
      document.querySelector("#device-test-status")?.textContent.includes("Camera access was denied") &&
      document.querySelector("#device-test-status")?.textContent.includes("Microphone access was denied"), null, { timeout: 15000 });
    assert.match(await page.locator("#device-test-status").textContent(), /Camera access was denied/);
    assert.match(await page.locator("#device-test-status").textContent(), /Microphone access was denied/);
    await page.locator("#name").fill("Denied media");
    if (testMeetingPassword) await page.locator("#password").fill(testMeetingPassword);
    await page.locator("#join").click();
    await page.locator("#meeting").waitFor({ state: "visible", timeout: 20000 });
    await waitForPeerConnection(page, "connected", 20000);
    console.log("[pass] denied camera and microphone permissions: device check reported denial and audio-only join connected");
    passed = true;
  } finally {
    if (passed) await closeSuccessfulDiagnosticContext(context, contexts, traceContexts);
  }
}

async function createChangingContentPage(context) {
  const page = await context.newPage();
  await page.setContent(`<!doctype html>
    <html><head><meta charset="utf-8"><title>${screenSourceTitle}</title>
      <style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#101827}canvas{display:block;width:100vw;height:100vh}</style>
    </head><body><canvas id="source" width="960" height="540"></canvas>
      <script>
        const canvas=document.querySelector('#source'); const context=canvas.getContext('2d'); let frame=0;
        function draw(){
          const hue=(frame*2)%360; context.fillStyle='hsl('+hue+' 65% 38%)'; context.fillRect(0,0,960,540);
          context.fillStyle='#f8fafc'; context.font='bold 44px sans-serif'; context.fillText('SlowMeet changing share source',36,70);
          const x=60+(frame*7)%820; context.beginPath(); context.arc(x,300,54,0,Math.PI*2); context.fillStyle='#f8fafc'; context.fill();
          context.font='28px monospace'; context.fillText('frame '+frame,36,500); frame++; window.__shareSourceFrame=frame;
          requestAnimationFrame(draw);
        } draw();
      </script></body></html>`);
  await page.evaluate((title) => { document.title = title; }, screenSourceTitle);
  await page.waitForFunction(() => window.__shareSourceFrame > 10, null, { timeout: 10000 });
  console.log(`[screen] changing-content source ready: ${screenSourceTitle}`);
  return page;
}

async function testAutoScreenShare(pageA, pageB, sourcePage, peers, expectedPeerConnectionCounts,
  expectedSocketCounts, mediaStartedAt) {
  for (const { sharerPage, receiverPage, senderName, direction, competingPage } of [
    { sharerPage: pageA, receiverPage: pageB, competingPage: pageB, senderName: "Media A", direction: "A -> B" },
    { sharerPage: pageB, receiverPage: pageA, competingPage: pageA, senderName: "Media B", direction: "B -> A" }
  ]) {
    const cameraSenderID = await activeVideoSenderID(sharerPage);
    assert.ok(cameraSenderID, `${direction}: camera sender identity was not recorded before screen sharing`);

    const startShare = async (label) => {
      await sourcePage.bringToFront();
      await sharerPage.bringToFront();
      await sharerPage.locator("#screen").click();
      await sharerPage.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true",
        null, { timeout: 60000 });
      await waitForRemoteParticipantState(receiverPage, senderName, "sharing", "true");
      await assertRemoteVideoMoves(receiverPage, "screen", `${direction} ${label}`);
      assert.equal(await sharerPage.locator("#camera").isDisabled(), true,
        `${direction}: camera control must stay disabled while screen sharing`);
      assert.equal(await sharerPage.locator("#camera").getAttribute("aria-pressed"), "false",
        `${direction}: camera must turn off when screen sharing starts`);
      await waitForCameraStopped(`${direction} camera during ${label}`, senderName, receiverPage,
        peers, expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt);
    };

    const stopShare = async (label) => {
      await sharerPage.locator("#screen").click();
      await sharerPage.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false",
        null, { timeout: 15000 });
      await waitForRemoteParticipantState(receiverPage, senderName, "sharing", "false");
      assert.equal(await sharerPage.locator("#camera").isDisabled(), false,
        `${direction}: camera control must be available after screen sharing stops`);
      assert.equal(await sharerPage.locator("#camera").getAttribute("aria-pressed"), "false",
        `${direction}: camera must remain off after screen sharing stops`);
      await waitForPeerStability(peers, 750, 10000);
      await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts,
        `${direction} ${label}`, mediaStartedAt);
    };

    await startShare("first automatic window share");
    if (direction === "A -> B") {
      assert.equal(await competingPage.locator("#screen").isDisabled(), true,
        "the other participant must not start a competing share while A owns the share");
      const startsBefore = await competingPage.evaluate(() => window.__slowMeetTest.signalingMessages
        .filter((message) => message.direction === "out" && message.type === "screen_share" && message.screenShareActive === true).length);
      await competingPage.locator("#screen").evaluate((button) => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await delay(500);
      const startsAfter = await competingPage.evaluate(() => window.__slowMeetTest.signalingMessages
        .filter((message) => message.direction === "out" && message.type === "screen_share" && message.screenShareActive === true).length);
      assert.equal(startsAfter, startsBefore, "a competing share click must not send a second share request");
      await waitForRemoteParticipantState(receiverPage, senderName, "sharing", "true");
      console.log("[pass] competing screen-share attempt was blocked while the first share remained active");
    }
    await stopShare("toolbar stop");
    await startShare("restart after toolbar stop");
    await stopShare("final toolbar stop");
    await setButtonPressed(sharerPage, "#camera", true);
    assert.equal(await activeVideoSenderID(sharerPage), cameraSenderID,
      `${direction}: manually re-enabling camera after screen share must reuse its sender`);
    await waitForCameraProgress(`${direction} camera manually re-enabled after screen share`, senderName,
      receiverPage, peers, expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt);
    console.log(`[pass] automatic screen share ${direction}: changing source delivered, stopped, and restarted`);
  }
}

async function testHeadedScreenShare(pageA, pageB, peers, expectedPeerConnectionCounts,
  expectedSocketCounts, mediaStartedAt) {
  for (const { sharerPage, receiverPage, senderName, direction } of [
    { sharerPage: pageA, receiverPage: pageB, senderName: "Media A", direction: "A -> B" },
    { sharerPage: pageB, receiverPage: pageA, senderName: "Media B", direction: "B -> A" }
  ]) {
    const startShare = async (label) => {
      console.log(`[screen] ${direction}: select a screen or window in Chromium's native picker for ${label}.`);
      await sharerPage.locator("#screen").click();
      await sharerPage.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true", null, { timeout: 60000 });
      await waitForRemoteParticipantState(receiverPage, senderName, "sharing", "true");
      await assertRemoteVideoMoves(receiverPage, "screen", `${direction} ${label}`);
      assert.equal(await sharerPage.locator("#camera").isDisabled(), true,
        `${direction}: camera control must stay disabled while screen sharing`);
      assert.equal(await sharerPage.locator("#camera").getAttribute("aria-pressed"), "false",
        `${direction}: camera must turn off when screen sharing starts`);
      await waitForCameraStopped(`${direction} camera during ${label}`, senderName, receiverPage,
        peers, expectedPeerConnectionCounts, expectedSocketCounts, mediaStartedAt);
    };

    const stopFromToolbar = async () => {
      await sharerPage.locator("#screen").click();
      await sharerPage.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false");
      await waitForRemoteParticipantState(receiverPage, senderName, "sharing", "false");
      assert.equal(await sharerPage.locator("#camera").isDisabled(), false,
        `${direction}: camera control must be available after screen sharing stops`);
      assert.equal(await sharerPage.locator("#camera").getAttribute("aria-pressed"), "false",
        `${direction}: camera must remain off after screen sharing stops`);
      await waitForPeerStability(peers, 750, 10000);
      await assertPeersConnected(peers, expectedPeerConnectionCounts, expectedSocketCounts,
        `${direction} toolbar screen stop`, mediaStartedAt);
    };

    await startShare("first screen share");
    await stopFromToolbar();
    await startShare("restart after toolbar stop");

    await sharerPage.evaluate(() => {
      const track = typeof screenStream === "undefined" ? undefined : screenStream?.getVideoTracks()[0];
      if (!track) throw new Error("active screen source track is missing");
      window.__slowMeetTest.browserStoppedScreenShare = false;
      track.addEventListener("ended", () => {
        window.__slowMeetTest.browserStoppedScreenShare = true;
      }, { once: true });
    });
    console.log(`[screen] ${direction}: stop sharing from Chromium's browser sharing indicator now.`);
    await sharerPage.waitForFunction(() => window.__slowMeetTest?.browserStoppedScreenShare === true, null, { timeout: 120000 });
    await sharerPage.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "false", null, { timeout: 15000 });
    await waitForRemoteParticipantState(receiverPage, senderName, "sharing", "false");
    await sharerPage.waitForFunction(() =>
      document.querySelector("#camera")?.disabled === false &&
      document.querySelector("#camera")?.getAttribute("aria-pressed") === "false");
    await startShare("restart after browser-indicator stop");
    await stopFromToolbar();
    console.log(`[pass] headed screen share ${direction}: native picker, toolbar stop, restart, indicator stop, and restart`);
  }
}

async function saveFailureArtifacts(contexts, error, traceContexts, server, scenarioName = "failure") {
  const configuredDirectory = process.env.MEDIA_E2E_ARTIFACT_DIR;
  const safeScenarioName = scenarioName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "failure";
  const artifactDirectory = configuredDirectory
    ? path.resolve(configuredDirectory, safeScenarioName)
    : fs.mkdtempSync(path.join(os.tmpdir(), "slowmeet-media-e2e-failure-"));
  fs.mkdirSync(artifactDirectory, { recursive: true });
  const failure = {
    scenario: scenarioName,
    error: { name: error?.name, message: error?.message, stack: error?.stack },
    serverLogs: server?.output?.slice(-300) || [],
    contexts: []
  };

  for (let contextIndex = 0; contextIndex < contexts.length; contextIndex += 1) {
    const context = contexts[contextIndex];
    const contextFailure = { pages: [] };
    const pages = context.pages();
    for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
      const page = pages[pageIndex];
      let state;
      try {
        state = await diagnostics(page);
      } catch (diagnosticError) {
        state = { error: diagnosticError.message };
      }
      if (!page.isClosed()) {
        await page.screenshot({
          path: path.join(artifactDirectory, `page-${contextIndex + 1}-${pageIndex + 1}.png`),
          fullPage: true
        }).catch(() => {});
      }
      contextFailure.pages.push({
        url: page.url(),
        diagnostics: state,
        events: page.__mediaE2EEvents || []
      });
    }
    if (traceContexts.has(context)) {
      await context.tracing.stop({ path: path.join(artifactDirectory, `context-${contextIndex + 1}.zip`) }).catch(() => {});
      traceContexts.delete(context);
    }
    failure.contexts.push(contextFailure);
  }
  fs.writeFileSync(path.join(artifactDirectory, "failure.json"), JSON.stringify(failure, null, 2));
  console.error(`[artifacts] failure screenshots, traces, network events, and peer stats: ${artifactDirectory}`);
}

async function main() {
  const server = externalBaseURL ? undefined : await startLocalServer();
  const baseURL = (externalBaseURL || server.url).replace(/\/$/, "");
  const targetHost = new URL(baseURL).hostname.replace(/^\[|\]$/g, "");
  const localTarget = ["localhost", "127.0.0.1", "::1"].includes(targetHost);
  if (!localTarget && process.env.MEDIA_E2E_ALLOW_EXTERNAL !== "1") {
    throw new Error("remote media E2E requires MEDIA_E2E_ALLOW_EXTERNAL=1 and a staging target");
  }
  if (externalBaseURL && suiteProfile === "full" && !testMeetingPassword) {
    console.warn("[media] external target has no MEDIA_E2E_MEETING_PASSWORD; password validation is environment-qualified");
  }

  console.log(`[media] profile=${suiteProfile}; ${realDevices ? "real capture devices" : "Chromium-generated camera/microphone"}; ${headed ? "headed" : "headless"} Chromium`);
  const chromePath = findChrome();
  const launchArgs = [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--force-webrtc-ip-handling-policy=default_public_interface_only",
    `--unsafely-treat-insecure-origin-as-secure=${baseURL}`,
    "--autoplay-policy=no-user-gesture-required",
    "--disable-features=WebRtcHideLocalIpsWithMdns"
  ];
  if (localTarget) launchArgs.push("--allow-loopback-in-peer-connection");
  if (!realDevices) launchArgs.push("--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream");
  if (testScreenShare) launchArgs.push(`--auto-select-desktop-capture-source=${screenSourceTitle}`);
  const launchOptions = { headless: !headed, args: launchArgs };
  if (chromePath) launchOptions.executablePath = chromePath;

  const runRealCameraToggleScenario = async (fixture, toggledRole, { sourceLabels = { A: "real", B: "real" } } = {}) => {
    const otherRole = toggledRole === "A" ? "B" : "A";
    const cameraName = (role) => `${sourceLabels[role]} camera`;
    const label = `${toggledRole} ${cameraName(toggledRole)} stop/resume while ${otherRole} remains live`;
    await fixture.join("A");
    await fixture.join("B");
    await fixture.waitForConnected();
    const physicalCameraRole = Object.entries(sourceLabels)
      .find(([, source]) => source === "physical")?.[0];
    if (physicalCameraRole) {
      await fixture.page(physicalCameraRole).evaluate(() => window.setVideoSending(false, true));
    }
    if (Object.values(sourceLabels).includes("physical")) {
      console.log(`[camera content motion] ${label}: sweep a bright, high-contrast object left and right across the physical camera view continuously, including the first second after resume`);
    }

    for (const role of ["A", "B"]) {
      const receiverRole = role === "A" ? "B" : "A";
      await fixture.setPressed(role, "#camera", true);
      await fixture.waitForRemoteState(receiverRole, fixture.names[role], "camera", "on");
      await fixture.assertRemoteVideoMoves(role, receiverRole,
        `${cameraName(role)} ${role} starts ${role === "A" ? "first" : "second"}`);
    }
    for (const role of ["A", "B"]) {
      if (sourceLabels[role] === "physical") await assertRealCameraCapture(fixture, role);
    }

    await fixture.assertPeersConnected(`${label} baseline`);
    const senderIDs = await realCameraVideoSenderIDs(fixture);
    const toggledPage = pageForRole(fixture, toggledRole);
    await toggledPage.evaluate(() => {
      const recorder = window.__slowMeetCameraLifecycleRecorder || { events: [] };
      if (!recorder.installed) {
        const originalReplaceTrack = RTCRtpSender.prototype.replaceTrack;
        RTCRtpSender.prototype.replaceTrack = function (track) {
          const cameraDetach = track === null && this.track?.kind === "video";
          const cameraAttach = track?.kind === "video";
          const eventTrackId = cameraDetach ? this.track?.id || null : track?.id || null;
          const result = originalReplaceTrack.call(this, track);
          if ((!cameraDetach && !cameraAttach) || !result || typeof result.then !== "function") return result;
          return result.then((value) => {
            recorder.events.push({
              type: cameraDetach ? "sender-detached" : "sender-attached",
              trackId: eventTrackId,
              at: performance.now()
            });
            return value;
          });
        };
        const originalApplyConstraints = MediaStreamTrack.prototype.applyConstraints;
        MediaStreamTrack.prototype.applyConstraints = function (...args) {
          if (this.kind !== "video") return originalApplyConstraints.apply(this, args);
          const trackId = this.id;
          const recordResult = (succeeded, error) => recorder.events.push({
            type: "video-track-constraints",
            trackId,
            succeeded,
            settings: this.getSettings?.() || null,
            errorName: error?.name || null,
            at: performance.now()
          });
          if (recorder.holdNextVideoConstraints) {
            recorder.holdNextVideoConstraints = false;
            return new Promise((resolve, reject) => {
              recorder.releaseHeldVideoConstraints = () => {
                recorder.releaseHeldVideoConstraints = undefined;
                let heldResult;
                try {
                  heldResult = originalApplyConstraints.apply(this, args);
                } catch (error) {
                  recordResult(false, error);
                  reject(error);
                  return;
                }
                Promise.resolve(heldResult).then((value) => {
                  recordResult(true);
                  resolve(value);
                }, (error) => {
                  recordResult(false, error);
                  reject(error);
                });
              };
            });
          }
          let result;
          try {
            result = originalApplyConstraints.apply(this, args);
          } catch (error) {
            recordResult(false, error);
            throw error;
          }
          return Promise.resolve(result).then((value) => {
            recordResult(true);
            return value;
          }, (error) => {
            recordResult(false, error);
            throw error;
          });
        };
        const originalStop = MediaStreamTrack.prototype.stop;
        MediaStreamTrack.prototype.stop = function (...args) {
          const trackId = this.id;
          const result = originalStop.apply(this, args);
          if (this.kind === "video") recorder.events.push({ type: "video-track-stopped", trackId, at: performance.now() });
          return result;
        };
        recorder.installed = true;
      }
      recorder.events.length = 0;
      recorder.holdNextVideoConstraints = false;
      recorder.releaseHeldVideoConstraints = undefined;
      window.__slowMeetCameraLifecycleRecorder = recorder;
    });
    const capture = await fixture.beginCameraQualityCapture(label, {
      requireMarkers: false,
      includeFrameObservations: true
    });
    await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
    await fixture.waitForCameraQualityVisualSamples(capture, [toggledRole]);
    await logRealCameraDiagnostics(fixture, label, "both participant video feeds live before toggle");

    if (sourceLabels[toggledRole] === "physical") {
      const visualObservationStart = Date.now();
      let visualReadiness;
      do {
        visualReadiness = await Promise.all(Object.values(capture.pages).map((page) => page.evaluate((role) => {
          const recorder = window.__slowMeetTest?.cameraQualityCapture;
          const report = recorder?.snapshot?.();
          const view = recorder?.pageRole === role ? "local" : "remote";
          const tile = report?.tiles?.find((entry) => entry.key === `${role}/${view}`);
          return { pageRole: recorder?.pageRole, key: tile?.key, baselineVisual: tile?.baselineVisual };
        }, toggledRole)));
        if (visualReadiness.every((entry) => entry.baselineVisual?.meaningfulMotionSampleCount >= 2)) break;
        if (Date.now() - visualObservationStart < 12000) await delay(100);
      } while (Date.now() - visualObservationStart < 12000);
      const visualEvidence = visualReadiness.map((entry) => ({
        ...entry,
        baselineVisual: entry.baselineVisual && {
          sampleCount: entry.baselineVisual.sampleCount,
          meaningfulMotionSampleCount: entry.baselineVisual.meaningfulMotionSampleCount,
          maxChangedPixelFraction: entry.baselineVisual.maxChangedPixelFraction,
          maxMeanLumaDelta: entry.baselineVisual.maxMeanLumaDelta
        }
      }));
      console.log(`[camera content readiness] ${JSON.stringify({ label, observations: visualEvidence })}`);
      assert.ok(visualReadiness.every((entry) => entry.baselineVisual?.meaningfulMotionSampleCount >= 2),
        `${label}: physical camera scene did not show movement before toggle; aim it at a moving subject and retry: ${JSON.stringify(visualEvidence)}`);
    }

    await fixture.setPressed(toggledRole, "#camera", false);
    await fixture.waitForRemoteState(otherRole, fixture.names[toggledRole], "camera", "off");
    await toggledPage.waitForFunction(() => {
      const events = window.__slowMeetCameraLifecycleRecorder?.events || [];
      return events.some((event) => event.type === "sender-detached") &&
        events.some((event) => event.type === "video-track-stopped");
    }, null, { timeout: 5000 });
    const detachEvents = await toggledPage.evaluate(() =>
      window.__slowMeetCameraLifecycleRecorder?.events || []);
    const detachEvent = detachEvents.find((event) => event.type === "sender-detached");
    const trackStopEvent = detachEvents.find((event) => event.type === "video-track-stopped");
    assert.ok(detachEvent, `${label}: sender detach did not complete: ${JSON.stringify(detachEvents)}`);
    assert.ok(trackStopEvent, `${label}: camera track was not stopped: ${JSON.stringify(detachEvents)}`);
    assert.equal(trackStopEvent.trackId, detachEvent.trackId,
      `${label}: stopped camera track did not match the detached sender track: ${JSON.stringify(detachEvents)}`);
    assert.ok(detachEvent.at <= trackStopEvent.at,
      `${label}: camera track stopped before sender detach completed: ${JSON.stringify(detachEvents)}`);
    console.log(`[camera sender lifecycle] ${JSON.stringify({
      label,
      events: detachEvents.map(({ type, at }) => ({ type, atMs: Math.round(at) }))
    })}`);
    await fixture.assertPeersConnected(`${label} camera off`);
    await logRealCameraDiagnostics(fixture, label, `${toggledRole} camera off`);
    const keyFramesBeforeResume = decodedVideoKeyFrameCount(await fixture.diagnostics(otherRole));

    if (sourceLabels[toggledRole] === "physical") {
      console.log(`[camera content motion] ${label}: keep sweeping the bright object while the camera is off and through the first second after you resume it`);
    }
    await toggledPage.evaluate(() => {
      window.__slowMeetCameraLifecycleRecorder.holdNextVideoConstraints = true;
    });
    await toggledPage.locator("#camera").click();
    await toggledPage.waitForFunction(() =>
      typeof window.__slowMeetCameraLifecycleRecorder?.releaseHeldVideoConstraints === "function",
    null, { timeout: 10000 });
    try {
      const localPreview = await toggledPage.evaluate(() => {
        const video = document.querySelector("video.local-camera-preview");
        return {
          buttonPressed: document.querySelector("#camera")?.getAttribute("aria-pressed"),
          previewVisible: Boolean(video && !video.hidden),
          previewHasStream: Boolean(video?.srcObject)
        };
      });
      assert.equal(localPreview.buttonPressed, "true",
        `${label}: camera button stayed off while capture constraints were pending`);
      assert.equal(localPreview.previewVisible, true,
        `${label}: local preview stayed hidden while capture constraints were pending`);
      assert.equal(localPreview.previewHasStream, true,
        `${label}: local preview had no stream while capture constraints were pending`);
    } finally {
      await toggledPage.evaluate(() =>
        window.__slowMeetCameraLifecycleRecorder.releaseHeldVideoConstraints?.());
    }
    await fixture.waitForRemoteState(otherRole, fixture.names[toggledRole], "camera", "on");
    const resumeLifecycle = await toggledPage.evaluate(() =>
      window.__slowMeetCameraLifecycleRecorder?.events || []);
    const senderAttachEvent = [...resumeLifecycle].reverse().find((event) => event.type === "sender-attached");
    const captureConstraintsEvent = resumeLifecycle.find((event) =>
      event.type === "video-track-constraints" && event.trackId === senderAttachEvent?.trackId);
    assert.ok(senderAttachEvent, `${label}: resumed camera did not reuse its established sender: ${JSON.stringify(resumeLifecycle)}`);
    assert.ok(captureConstraintsEvent?.succeeded,
      `${label}: resumed camera constraints did not complete successfully: ${JSON.stringify(resumeLifecycle)}`);
    assert.ok(captureConstraintsEvent.settings?.width > 0 && captureConstraintsEvent.settings?.height > 0,
      `${label}: resumed camera did not report usable capture settings: ${JSON.stringify(captureConstraintsEvent)}`);
    assert.ok(captureConstraintsEvent.at < senderAttachEvent.at,
      `${label}: camera capture was reconfigured after sender attachment: ${JSON.stringify(resumeLifecycle)}`);
    console.log(`[camera resume lifecycle] ${JSON.stringify({
      label,
      events: resumeLifecycle.map(({ type, trackId, at }) => ({ type, trackId, atMs: Math.round(at) }))
    })}`);
    await fixture.assertPeersConnected(`${label} camera resumed`);
    await waitForDecodedVideoKeyFrame(fixture, otherRole, keyFramesBeforeResume, label);
    await logRealCameraDiagnostics(fixture, label, `${toggledRole} camera resumed`);

    await fixture.endCameraQualityCapture(capture, {
      toggledRoles: [toggledRole],
      liveRoles: [otherRole],
      maxResumeFrameMs: 1000,
      requireVisualMotion: sourceLabels[toggledRole] === "physical"
    });
    await logRealCameraDiagnostics(fixture, label, "after stable quality window");
  assert.deepEqual(await realCameraVideoSenderIDs(fixture), senderIDs,
    `${label}: camera toggle replaced an established video sender`);
  await fixture.assertNoDuplicateParticipants();
  console.log(`[real-camera sender continuity] ${JSON.stringify({ label, senderIDs })}`);
  };

  const scenarios = [
    ...participantFlowScenarios,
    ...mediaLifecycleScenarios,
    {
      name: "camera control shows pending capture and settles queued toggles",
      async run(fixture) {
        await testCameraPendingState(fixture.browserA, baseURL, contexts, traceContexts);
        await testUnavailableCamera(fixture.browserA, baseURL, contexts, traceContexts);
      }
    },
    {
      name: "capture failures report device errors and keep participants usable",
      async run(fixture) {
        await testUnavailableMicrophone(fixture.browserA, baseURL, contexts, traceContexts);
        await testDeniedCapturePermissions(fixture.browserA, baseURL, contexts, traceContexts);
      }
    },
    {
      name: "native Chromium screen picker, browser stop, and share restart",
      when: "nativePicker",
      profile: "screen-share",
      required: false,
      async run(fixture) {
        await fixture.join("A");
        await fixture.join("B");
        await Promise.all(["A", "B"].map((role) => fixture.setPressed(role, "#camera", true)));
        await Promise.all([
          fixture.waitForRemoteState("B", fixture.names.A, "camera", "on"),
          fixture.waitForRemoteState("A", fixture.names.B, "camera", "on")
        ]);
        const peers = [fixture.pageA, fixture.pageB];
        const states = await Promise.all([fixture.diagnostics("A"), fixture.diagnostics("B")]);
        await testHeadedScreenShare(peers[0], peers[1], peers,
          states.map((state) => state.peerConnectionCount), states.map((state) => state.socketCount), Date.now());
        await fixture.assertPeersConnected("native screen-share picker recovery");
      }
    },
    {
      name: "real microphone first-enable echo and capture-processing acceptance",
      when: "realMedia",
      profile: "real-media",
      required: false,
      async run(fixture) {
        await fixture.join("A");
        await fixture.join("B");
        console.log("[manual audio check] A and B share this device's microphone and speakers. Speak a short phrase after each first mic enable; listen for echo, then repeat with headphones.");
        await Promise.all(["A", "B"].map((role) => fixture.setPressed(role, "#mic", false)));
        await Promise.all([
          fixture.waitForRemoteState("A", fixture.names.B, "mic", "off"),
          fixture.waitForRemoteState("B", fixture.names.A, "mic", "off")
        ]);
        await fixture.captureConnectionTimeline("five-second real-microphone baseline", 5000);
        for (const role of ["A", "B"]) {
          const receiverRole = role === "A" ? "B" : "A";
          if (role === "B") {
            await fixture.setPressed("A", "#mic", false);
            await fixture.waitForRemoteState("B", fixture.names.A, "mic", "off");
          }
          await fixture.setPressed(role, "#mic", true);
          await fixture.waitForRemoteState(receiverRole, fixture.names[role], "mic", "on");
          await fixture.assertAudioProgress(role, receiverRole, `${role} real microphone first enable`);
          await fixture.captureConnectionTimeline(`15 seconds after ${role} opens real microphone`, 15000);
          await fixture.assertPeersConnected(`${role} real microphone first enable`);
          await fixture.assertHealthyParticipantTiles(receiverRole, role,
            `${role} real microphone start at ${receiverRole}`);
          const state = await fixture.diagnostics(role);
          assert.equal(state.audioCaptureSettings?.echoCancellation, true,
            `${role}: real microphone capture should report echo cancellation enabled`);
        }
        await fixture.assertPeersConnected("real microphone first-enable echo acceptance");
        await fixture.assertNoDuplicateParticipants();
      }
    },
    {
      name: "real camera acceptance: moving video and connected peers",
      when: "realMedia",
      profile: "real-media",
      required: false,
      async run(fixture) {
        await fixture.join("A");
        await fixture.join("B");
        await Promise.all(["A", "B"].map((role) => fixture.setPressed(role, "#mic", true)));
        await Promise.all(["A", "B"].map((role) => fixture.setPressed(role, "#camera", true)));
        await Promise.all([
          fixture.waitForRemoteState("B", fixture.names.A, "camera", "on"),
          fixture.waitForRemoteState("A", fixture.names.B, "camera", "on")
        ]);
        await Promise.all([
          fixture.assertRemoteVideoMoves("A", "B", "real camera A -> B"),
          fixture.assertRemoteVideoMoves("B", "A", "real camera B -> A"),
          fixture.assertAudioProgress("A", "B", "real microphone A -> B"),
          fixture.assertAudioProgress("B", "A", "real microphone B -> A")
        ]);
        reportAudioQuality("real-media live", await Promise.all([fixture.diagnostics("A"), fixture.diagnostics("B")]));
        await fixture.waitForStability(stabilityMs, stabilityMs + 30000);
        await fixture.assertPeersConnected("real capture stability");
        await fixture.assertNoDuplicateParticipants();
      }
    },
      {
      name: "path RTT and video playback age are measured independently",
      profile: "full",
      timecodedCamera: true,
      timeCodedCameraRoles: ["A", "B"],
      async run(fixture) {
        await fixture.join("A");
        await fixture.join("B");
        await fixture.waitForConnected();
        await Promise.all(["A", "B"].map((role) => fixture.setPressed(role, "#camera", true)));
        await Promise.all([
          fixture.waitForRemoteState("A", fixture.names.B, "camera", "on"),
          fixture.waitForRemoteState("B", fixture.names.A, "camera", "on"),
          fixture.assertRemoteVideoMoves("A", "B", "path/playback delay measurement B -> A"),
          fixture.assertRemoteVideoMoves("B", "A", "path/playback delay measurement A -> B")
        ]);
        const capture = await fixture.beginCameraQualityCapture("path RTT versus playback age");
        await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
        const playback = await fixture.endCameraQualityCapture(capture, {
          toggledRoles: [],
          liveRoles: ["A", "B"],
          requireMarkers: true
        });
        const receiverState = await fixture.diagnostics("A");
        const pathRttMs = Number.isFinite(receiverState.candidatePair?.currentRoundTripTime)
          ? receiverState.candidatePair.currentRoundTripTime * 1000 : null;
        const remoteCamera = receiverState.remoteVideos.find((video) => video.role === "camera");
        const videoPlayout = remoteCamera?.inboundVideoStats.find((stat) =>
          Number.isFinite(stat.jitterBufferEmittedCount));
        const playbackAgeMs = playback.tiles.find((tile) => tile.role === "B" && tile.view === "remote")
          ?.stableMaxMarkerAgeMs;
        assert.ok(Number.isFinite(pathRttMs) && pathRttMs >= 0,
          `selected candidate-pair path RTT must be measured independently: ${JSON.stringify(receiverState.candidatePair)}`);
        assert.ok(Number.isFinite(playbackAgeMs) && playbackAgeMs >= -250 && playbackAgeMs <= 1000,
          `timestamp-coded source-to-render age must remain independently measurable: ${JSON.stringify(playback.tiles)}`);
        assert.ok(remoteCamera && (!videoPlayout || remoteCamera.inboundVideoStats.some((stat) => stat.framesDecoded > 0)),
          `inbound video must continue decoding when receiver stats are available: ${JSON.stringify(receiverState.remoteVideos)}`);
        assert.ok(!videoPlayout?.supportsJitterBufferTarget || Number.isFinite(videoPlayout.jitterBufferTarget),
          `supported video jitter-buffer targets must be applied safely: ${JSON.stringify(videoPlayout)}`);
        await fixture.assertPeersConnected("path RTT and playback age measurement");
        console.log(`[delay measurements] ${JSON.stringify({
          pathRttMs,
          playbackAgeMs,
          videoJitterBufferTargetMs: videoPlayout?.jitterBufferTarget ?? null,
          jitterBufferMinimumDelaySeconds: videoPlayout?.jitterBufferMinimumDelay ?? null,
          jitterBufferEmittedCount: videoPlayout?.jitterBufferEmittedCount ?? null
        })}`);
      }
    },
    {
      name: "A-first real camera stop/resume keeps B live",
      when: "realMedia",
      profile: "real-media",
      required: false,
      async run(fixture) {
        await runRealCameraToggleScenario(fixture, "A");
      }
    },
    {
      name: "B real camera stop/resume keeps A live as the comparison",
      when: "realMedia",
      profile: "real-media",
      required: false,
      async run(fixture) {
        await runRealCameraToggleScenario(fixture, "B");
      }
    },
    {
      name: "single physical camera A-first stop/resume with generated B control",
      when: "realMedia",
      profile: "real-media",
      required: false,
      timeCodedCameraRoles: ["B"],
      async run(fixture) {
        const sourceLabels = { A: "physical", B: "generated" };
        await runRealCameraToggleScenario(fixture, "A", { sourceLabels });
        await runRealCameraToggleScenario(fixture, "B", { sourceLabels });
      }
    },
    {
      name: "isolated network impairment and recovery",
      when: "networkImpairment",
      profile: "network",
      required: false,
      async run(fixture) {
        await fixture.join("A");
        await fixture.join("B");
        await Promise.all(["A", "B"].map((role) => fixture.setPressed(role, "#mic", true)));
        await Promise.all([
          fixture.waitForRemoteState("B", fixture.names.A, "mic", "on"),
          fixture.waitForRemoteState("A", fixture.names.B, "mic", "on"),
          fixture.assertAudioProgress("A", "B", "network profile baseline audio A -> B"),
          fixture.assertAudioProgress("B", "A", "network profile baseline audio B -> A")
        ]);
        await Promise.all(["A", "B"].map((role) => fixture.setPressed(role, "#camera", true)));
        await Promise.all([
          fixture.waitForRemoteState("B", fixture.names.A, "camera", "on"),
          fixture.waitForRemoteState("A", fixture.names.B, "camera", "on")
        ]);
        await Promise.all([
          fixture.assertRemoteVideoMoves("A", "B"),
          fixture.assertRemoteVideoMoves("B", "A")
        ]);
        const peers = [fixture.pageA, fixture.pageB];
        const states = await Promise.all([fixture.diagnostics("A"), fixture.diagnostics("B")]);
        await testNetworkImpairmentMode(peers[0], peers[1], peers,
          states.map((state) => state.peerConnectionCount), states.map((state) => state.socketCount), Date.now());
        await fixture.assertPeersConnected("network recovery");
      }
    }
  ];

  const names = scenarios.map((scenario) => scenario.name);
  assert.equal(new Set(names).size, names.length, "scenario names must be unique");
  assert.ok(scenarios.length > 0, "at least one scenario must be registered");
  if (requestedScenario && !names.includes(requestedScenario)) {
    throw new Error(`MEDIA_E2E_SCENARIO must match a registered scenario name: ${requestedScenario}`);
  }

  let browserA;
  let browserB;
  const contexts = [];
  const traceContexts = new Set();
  const results = [];
  const runGate = (gate) => {
    if (gate === "localCapacity") return !externalBaseURL;
    if (gate === "passwordValidation") return Boolean(testMeetingPassword);
    if (gate === "realMedia") return suiteProfile === "real-media";
    if (gate === "screenShare") return testScreenShare;
    if (gate === "nativePicker") return testNativeScreenShare;
    if (gate === "networkImpairment") return suiteProfile === "network" && testNetworkImpairment && testNetworkNamespace;
    return false;
  };
  const profileMatches = (scenario) => {
    if (suiteProfile === "full") return !scenario.profile || scenario.profile === "full";
    if (suiteProfile === "network") return scenario.profile === "network";
    if (suiteProfile === "screen-share") return ["screenShare", "nativePicker"].includes(scenario.when);
    if (suiteProfile === "real-media") return scenario.when === "realMedia";
    return false;
  };

  try {
    browserA = await chromium.launch({ ...launchOptions, args: [...launchArgs] });
    browserB = await chromium.launch({ ...launchOptions, args: [...launchArgs] });

    for (const scenario of scenarios) {
      const scenarioSelected = !requestedScenario || scenario.name === requestedScenario;
      const profileSelected = scenarioSelected && profileMatches(scenario);
      const gateSelected = !scenario.when || runGate(scenario.when);
      if (!profileSelected || !gateSelected) {
        let reason = `not selected by ${suiteProfile} profile`;
        if (!scenarioSelected) reason = `not selected by MEDIA_E2E_SCENARIO=${requestedScenario}`;
        if (scenario.when && !runGate(scenario.when)) {
          const gateNames = {
            localCapacity: "the local E2E server configured with MAX_PARTICIPANTS=2",
            passwordValidation: "a configured meeting password",
            realMedia: "MEDIA_E2E_PROFILE=real-media with real capture devices",
            screenShare: "the headed generated screen-share profile",
            nativePicker: "the headed native-picker profile",
            networkImpairment: "the isolated network profile"
          };
          reason = `requires ${gateNames[scenario.when] || `${scenario.when} environment gate`}`;
        }
        console.log(`NOT RUN | ${scenario.name} | ${reason}`);
        results.push({
          name: scenario.name,
          status: "NOT RUN",
          required: scenarioSelected && (Boolean(requestedScenario) || scenario.required !== false),
          reason
        });
        continue;
      }

      console.log(`\n[scenario] ${scenario.name}`);
      const scenarioContextStart = contexts.length;
      let fixture;
      let scenarioServer;
      let scenarioBaseURL = baseURL;
      const startedAt = Date.now();
      try {
        if (scenario.localCapacityLimit && !externalBaseURL) {
          scenarioServer = await startLocalServer(scenario.localCapacityLimit);
          scenarioBaseURL = scenarioServer.url;
        }
        fixture = await createScenarioFixture({
          browserA,
          browserB,
          baseURL: scenarioBaseURL,
          contexts,
          traceContexts,
          timeCodedCamera: scenario.timecodedCamera === true,
          timeCodedCameraRoles: scenario.timeCodedCameraRoles,
          timeCodedAudioRoles: scenario.timeCodedAudioRoles
        });
        await scenario.run(fixture);
        results.push({ name: scenario.name, status: "PASS", required: true, durationMs: Date.now() - startedAt });
        console.log(`PASS | ${scenario.name} | ${Date.now() - startedAt}ms`);
      } catch (error) {
        results.push({ name: scenario.name, status: "FAIL", required: true, durationMs: Date.now() - startedAt,
          error: error?.message || String(error) });
        console.error(`FAIL | ${scenario.name} | ${error?.stack || error}`);
        if (contexts.length > scenarioContextStart) {
          await delay(Math.min(diagnosticWaitMs, 1500));
          await saveFailureArtifacts(contexts.slice(scenarioContextStart), error, traceContexts, scenarioServer || server, scenario.name)
            .catch((artifactError) => console.error(`[artifacts] ${scenario.name}: ${artifactError.message}`));
        }
      } finally {
        if (fixture) {
          await closeScenarioFixture(fixture, contexts, traceContexts);
        }
        for (const context of contexts.splice(scenarioContextStart)) {
          await Promise.all(context.pages().map(leaveMeetingBeforeClose));
          if (traceContexts.has(context)) {
            await context.tracing.stop().catch(() => {});
            traceContexts.delete(context);
          }
          await context.close().catch(() => {});
        }
        if (scenarioServer) await scenarioServer.stop();
        else if (server) await delay(1100);
      }
    }

    const passed = results.filter((result) => result.status === "PASS").length;
    const failed = results.filter((result) => result.status === "FAIL").length;
    const notRun = results.filter((result) => result.status === "NOT RUN").length;
    const missingRequired = results.filter((result) => result.required && result.status !== "PASS");
    console.log(`\nScenario report: ${passed} PASS, ${failed} FAIL, ${notRun} NOT RUN`);
    for (const result of results) {
      if (result.status !== "PASS") console.log(`${result.status} | ${result.name} | ${result.reason || result.error}`);
    }
    if (failed || missingRequired.length) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error);
    if (contexts.length) {
      await saveFailureArtifacts(contexts, error, traceContexts, server, "suite-setup")
        .catch((artifactError) => console.error(`[artifacts] setup: ${artifactError.message}`));
    }
    process.exitCode = 1;
  } finally {
    for (const context of traceContexts) {
      await context.tracing.stop().catch(() => {});
      traceContexts.delete(context);
    }
    for (const context of contexts) await context.close().catch(() => {});
    await browserA?.close().catch(() => {});
    await browserB?.close().catch(() => {});
    await server?.stop();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
