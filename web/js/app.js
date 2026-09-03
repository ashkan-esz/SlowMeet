const form = document.querySelector("#join-form");
const nameInput = document.querySelector("#name");
const passwordInput = document.querySelector("#password");
const joinButton = document.querySelector("#join");
const status = document.querySelector("#status");
const meeting = document.querySelector("#meeting");
const participants = document.querySelector("#participants");
const mic = document.querySelector("#mic");
const camera = document.querySelector("#camera");
const receiveVideo = document.querySelector("#receive-video");
const screen = document.querySelector("#screen");
const screenStatus = document.querySelector("#screen-status");
const leave = document.querySelector("#leave");
const connection = document.querySelector("#connection");
const diagnostics = document.querySelector("#diagnostics");
const copyDiagnostics = document.querySelector("#copy-diagnostics");
const diagnosticsStatus = document.querySelector("#diagnostics-status");
const enableAudio = document.querySelector("#enable-audio");
const profile = document.querySelector("#profile");
const effectiveProfile = document.querySelector("#effective-profile");
function readStoredValue(key) {
  try {
    return localStorage.getItem(key);
  } catch (_) {
    return null;
  }
}

function writeStoredValue(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (_) {
    // Storage is optional; a blocked storage policy must not break the call.
  }
}

const storedName = readStoredValue("meeting.displayName");
if (storedName) nameInput.value = storedName;

let socket;
let socketGeneration = 0;
let peer;
let videoTransceiver;
let renegotiationChain = Promise.resolve();
let renegotiationPending = false;
let localStream;
let screenStream;
let cameraTrack;
let localParticipantID;
let reconnectToken;
let screenShareOwner;
let screenShareRequest;
let screenShareEnabled = true;
let serverDefaultProfile = false;
let remoteDescriptionSet = false;
let reconnectTimer;
let intentionalClose = false;
let restartRequested = false;
let reconnectAttempts = 0;
const maxReconnectAttempts = 5;
let statsTimer;
let previousStats;
let adaptationLevel = 2;
let poorSamples = 0;
let goodSamples = 0;
let criticalSamples = 0;
let recoverySamples = 0;
let videoSuspended = false;
let cameraRequested = true;
let receiveVideoEnabled = true;
let hostLimits = {
  maxVideoBitrate: 500000,
  maxVideoFPS: 30,
  maxAudioBitrate: 64000,
  maxVideoQuality: "high"
};
const hostDefaults = {
  videoFPS: 15,
  audioBitrate: 32000
};
let iceServers = [];
const iceConfigReady = fetch("/ice-config", { cache: "no-store" })
  .then((response) => {
    if (!response.ok) throw new Error("ICE configuration unavailable");
    return response.json();
  })
  .then((config) => {
    if (!Array.isArray(config.ice_servers)) return;
    iceServers = config.ice_servers.map((server) => {
      const urls = Array.isArray(server.urls) ?
        server.urls.filter((url) => typeof url === "string" && url.length > 0) : [];
      if (urls.length === 0) return null;
      const normalized = { urls };
      if (typeof server.username === "string" && server.username) normalized.username = server.username;
      if (typeof server.credential === "string" && server.credential) normalized.credential = server.credential;
      return normalized;
    }).filter(Boolean);
  })
  .catch(() => {
    iceServers = [];
  });
const pendingCandidates = [];
const participantElements = new Map();
const remoteAudioElements = new Set();
const storedProfile = readStoredValue("meeting.bandwidthProfile");
const profiles = [
  { name: "very-slow", width: 240, height: 160, fps: 5, bitrate: 90000, audioBitrate: 24000 },
  { name: "slow", width: 360, height: 240, fps: 10, bitrate: 180000, audioBitrate: 32000 },
  { name: "normal", width: 640, height: 360, fps: 15, bitrate: 400000, audioBitrate: 48000 },
  { name: "high", width: 854, height: 480, fps: 24, bitrate: 650000, audioBitrate: 64000 }
];
copyDiagnostics.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(diagnostics.textContent || "");
    diagnosticsStatus.textContent = "Diagnostics copied.";
  } catch (_) {
    diagnosticsStatus.textContent = "Clipboard access is unavailable.";
  }
});
enableAudio.addEventListener("click", async () => {
  let blocked = false;
  for (const audio of remoteAudioElements) {
    try {
      await audio.play();
    } catch (_) {
      blocked = true;
    }
  }
  enableAudio.hidden = blocked || remoteAudioElements.size === 0;
  if (!blocked) status.textContent = "Remote audio enabled.";
});
fetch("/config").then((response) => response.json()).then((config) => {
  hostLimits.maxVideoBitrate = config.max_video_bitrate || hostLimits.maxVideoBitrate;
  hostLimits.maxVideoFPS = config.max_video_fps || hostLimits.maxVideoFPS;
  hostLimits.maxAudioBitrate = config.max_audio_bitrate || hostLimits.maxAudioBitrate;
  if (config.max_video_quality) hostLimits.maxVideoQuality = config.max_video_quality;
  if (Number.isFinite(config.default_video_fps) && config.default_video_fps > 0) {
    hostDefaults.videoFPS = config.default_video_fps;
  }
  if (Number.isFinite(config.default_audio_bitrate) && config.default_audio_bitrate > 0) {
    hostDefaults.audioBitrate = config.default_audio_bitrate;
  }
  screenShareEnabled = config.screen_share_enabled !== false;
  screen.disabled = !screenShareEnabled;
  if (!storedProfile && config.default_video_quality) {
    profile.value = config.default_video_quality === "high" ? "high" :
      config.default_video_quality === "medium" ? "normal" :
      config.default_video_quality === "low" ? "slow" : "very-slow";
    serverDefaultProfile = true;
  }
  if (peer) applyProfile(profile.value);
}).catch(() => {});
if (storedProfile && [...profile.options].some((option) => option.value === storedProfile)) {
  profile.value = storedProfile;
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (joinButton.disabled) return;
  const name = nameInput.value.trim();
  writeStoredValue("meeting.displayName", name);
  intentionalClose = false;
  joinButton.disabled = true;
  connectSocket(name, passwordInput.value);
});

function connectSocket(name, password) {
  const generation = ++socketGeneration;
  if (socket && socket.readyState !== WebSocket.CLOSED) {
    socket.close();
  }
  status.textContent = "Connecting...";
  const currentSocket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket = currentSocket;
  currentSocket.addEventListener("open", () => {
    if (generation !== socketGeneration) return;
    clearTimeout(reconnectTimer);
    reconnectAttempts = 0;
    currentSocket.send(JSON.stringify({
      version: 1, type: "join", name, password, reconnect_token: reconnectToken
    }));
  });
  currentSocket.addEventListener("message", ({ data }) => {
    if (generation !== socketGeneration) return;
    const message = parseSignalingMessage(data);
    if (!message) {
      status.textContent = "Received an invalid server message.";
      return;
    }
    handleWebRTCMessage(message, generation);
    if (message.type === "screen_share_state") {
      screenShareOwner = message.screen_share_active === true ? message.screen_share_owner : undefined;
      updateScreenShareUI();
      if (screenShareRequest) {
        const granted = screenShareRequest.active
          ? screenShareOwner === localParticipantID
          : !screenShareOwner;
        if (granted) {
          clearTimeout(screenShareRequest.timer);
          screenShareRequest.resolve();
          screenShareRequest = undefined;
        } else if (screenShareRequest.active && screenShareOwner &&
            screenShareOwner !== localParticipantID) {
          clearTimeout(screenShareRequest.timer);
          screenShareRequest.reject(new Error("screen sharing is already active"));
          screenShareRequest = undefined;
        }
      }
      return;
    }
    if (message.type === "config_update") {
      if (Number.isFinite(message.max_video_bitrate) && message.max_video_bitrate > 0) {
        hostLimits.maxVideoBitrate = message.max_video_bitrate;
      }
      if (Number.isFinite(message.max_video_fps) && message.max_video_fps > 0) {
        hostLimits.maxVideoFPS = message.max_video_fps;
      }
      if (Number.isFinite(message.max_audio_bitrate) && message.max_audio_bitrate > 0) {
        hostLimits.maxAudioBitrate = message.max_audio_bitrate;
      }
      if (message.max_video_quality) hostLimits.maxVideoQuality = message.max_video_quality;
      if (message.screen_share_enabled === false) {
        screenShareEnabled = false;
        if (screenStream) stopScreenShare();
      } else if (message.screen_share_enabled === true) {
        screenShareEnabled = true;
      }
      updateScreenShareUI();
      applyProfile(profile.value);
      return;
    }
    if (message.type === "error") {
      if (screenShareRequest) {
        clearTimeout(screenShareRequest.timer);
        screenShareRequest.reject(new Error(message.error || "screen share request failed"));
        screenShareRequest = undefined;
      }
      status.textContent = message.error;
      if (meeting.hidden) joinButton.disabled = false;
      return;
    }
    if (message.type === "participant" || message.type === "participant_joined") {
      const participant = message.participant;
      addParticipant(participant);
      if (message.type === "participant") {
        localParticipantID = participant.id;
        reconnectToken = message.reconnect_token;
        form.hidden = true;
        meeting.hidden = false;
        status.textContent = "";
        startWebRTC();
      }
    }
    if (message.type === "participant_left") {
      const element = participantElements.get(message.participant.id);
      if (element) {
        remoteAudioElements.delete(element.audio);
        element.item.remove();
      }
      participantElements.delete(message.participant.id);
    }
  });
  currentSocket.addEventListener("close", () => {
    if (generation !== socketGeneration) return;
    if (intentionalClose || meeting.hidden) {
      if (meeting.hidden) joinButton.disabled = false;
      return;
    }
    reconnectAttempts++;
    setConnection("fair", "Reconnecting");
    if (reconnectAttempts > maxReconnectAttempts) {
      resetMediaConnection();
      setConnection("poor", "Connection lost");
      status.textContent = "Connection lost. Select Leave to try again.";
      return;
    }
    const delay = Math.min(30000, 2000 * 2 ** Math.min(reconnectAttempts - 1, 4));
    status.textContent = `Reconnecting in ${Math.ceil(delay / 1000)}s...`;
    reconnectTimer = setTimeout(() => {
      resetMediaConnection();
      connectSocket(nameInput.value.trim(), passwordInput.value);
    }, delay);
  });
  currentSocket.addEventListener("error", () => {
    if (generation === socketGeneration) status.textContent = "Unable to connect.";
  });
}

function resetMediaConnection() {
  participants.replaceChildren();
  participantElements.clear();
  remoteAudioElements.clear();
  enableAudio.hidden = true;
  peer?.close();
  peer = undefined;
  videoTransceiver = undefined;
  clearInterval(statsTimer);
  statsTimer = undefined;
  localStream?.getTracks().forEach((track) => track.stop());
  screenStream?.getTracks().forEach((track) => track.stop());
  localStream = undefined;
  screenStream = undefined;
  cameraTrack = undefined;
  screenShareOwner = undefined;
  if (screenShareRequest) {
    clearTimeout(screenShareRequest.timer);
    screenShareRequest.reject(new Error("signaling connection closed"));
    screenShareRequest = undefined;
  }
  updateScreenShareUI();
  remoteDescriptionSet = false;
  pendingCandidates.splice(0);
  renegotiationPending = false;
  restartRequested = false;
  previousStats = undefined;
  criticalSamples = 0;
  recoverySamples = 0;
}

async function startWebRTC() {
  const generation = socketGeneration;
  const currentSocket = socket;
  await iceConfigReady;
  if (generation !== socketGeneration || socket !== currentSocket) return;
  const currentPeer = new RTCPeerConnection({ iceServers });
  restartRequested = false;
  peer = currentPeer;
  currentPeer.oniceconnectionstatechange = () => {
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    if (currentPeer.iceConnectionState === "connected" || currentPeer.iceConnectionState === "completed") {
      setConnection("good", "Connected");
    } else if (currentPeer.iceConnectionState === "checking") {
      setConnection("", "Connecting");
    } else if (currentPeer.iceConnectionState === "disconnected") {
      setConnection("fair", "Reconnecting");
    } else if (currentPeer.iceConnectionState === "failed") {
      setConnection("poor", "Poor");
    }
  };
  currentPeer.onconnectionstatechange = () => {
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    if (currentPeer.connectionState === "connected") {
      restartRequested = false;
      status.textContent = "Connected";
    }
    if (currentPeer.connectionState === "disconnected") {
      status.textContent = "Reconnecting media...";
    }
    if (currentPeer.connectionState === "failed" && !restartRequested) {
      restartRequested = true;
      status.textContent = "Restarting media...";
      currentSocket.send(JSON.stringify({ version: 1, type: "ice_restart" }));
    }
  };
  currentPeer.addTransceiver("audio", { direction: "recvonly" });
  videoTransceiver = currentPeer.addTransceiver("video", {
    direction: receiveVideoEnabled ? "recvonly" : "inactive"
  });
  renegotiationChain = Promise.resolve();
  renegotiationPending = false;
  currentPeer.ontrack = ({ streams, track }) => {
    if (!streams[0]) return;
    const participantID = track.id.split("|")[0];
    const element = participantElements.get(participantID);
    if (!element) return;
    if (track.kind === "video") {
      element.video.srcObject = streams[0];
      element.video.autoplay = true;
      element.video.playsInline = true;
      element.video.hidden = !receiveVideoEnabled && participantID !== localParticipantID;
    } else {
      element.audio.srcObject = streams[0];
      element.audio.autoplay = true;
      remoteAudioElements.add(element.audio);
      Promise.resolve(element.audio.play()).then(() => {
        if (remoteAudioElements.size > 0) enableAudio.hidden = true;
      }).catch(() => {
        enableAudio.hidden = false;
        status.textContent = "Click “Enable remote audio” to hear participants.";
      });
    }
  };
  currentPeer.onicecandidate = ({ candidate }) => {
    if (candidate && isCurrentWebRTC(generation, currentPeer, currentSocket)) currentSocket.send(JSON.stringify({
      version: 1, type: "candidate", candidate: candidate.candidate,
      sdp_mid: candidate.sdpMid, sdp_mline_index: candidate.sdpMLineIndex
    }));
  };
  try {
    const setupStream = new MediaStream();
    const abortIfStale = () => {
      if (isCurrentWebRTC(generation, currentPeer, currentSocket)) return false;
      setupStream.getTracks().forEach((track) => track.stop());
      currentPeer.close();
      return true;
    };
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStream.getAudioTracks().forEach((track) => setupStream.addTrack(track));
      if (abortIfStale()) return;
    } catch (_) {
      status.textContent = "Microphone unavailable; continuing without audio.";
    }
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: {
        width: { ideal: 360, max: 640 },
        height: { ideal: 240, max: 360 },
        frameRate: { ideal: 15, max: 30 }
      }});
      videoStream.getVideoTracks().forEach((track) => setupStream.addTrack(track));
      if (abortIfStale()) return;
      camera.disabled = false;
      camera.textContent = cameraRequested ? "Turn camera off" : "Turn camera on";
      camera.setAttribute("aria-pressed", String(cameraRequested && !videoSuspended));
    } catch (_) {
      cameraRequested = false;
      camera.disabled = true;
      camera.textContent = "Camera unavailable";
      camera.setAttribute("aria-pressed", "false");
      status.textContent = "Camera unavailable; continuing audio-only.";
    }
    if (abortIfStale()) return;
    if (setupStream.getTracks().length === 0) throw new Error("No microphone or camera is available");
    localStream = setupStream;
    cameraTrack = setupStream.getVideoTracks()[0];
    const local = participantElements.get(localParticipantID);
    if (local) {
      local.video.srcObject = localStream;
      local.video.autoplay = true;
      local.video.muted = true;
    }
    sendMediaState();
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    for (const track of localStream.getTracks()) currentPeer.addTrack(track, localStream);
    await setVideoSending(!videoSuspended);
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    await applyProfile(profile.value, currentPeer, localStream);
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    clearInterval(statsTimer);
    previousStats = undefined;
    statsTimer = setInterval(updateDiagnostics, 2000);
    const offer = await currentPeer.createOffer();
    await currentPeer.setLocalDescription(offer);
    if (isCurrentWebRTC(generation, currentPeer, currentSocket)) {
      currentSocket.send(JSON.stringify({ version: 1, type: "offer", sdp: offer.sdp }));
    }
  } catch (error) {
    status.textContent = `Media unavailable: ${error.message}`;
  }
}

function setConnection(level, label) {
  connection.className = `connection ${level}`;
  connection.textContent = `● ${label}`;
}

async function updateDiagnostics() {
  if (!peer) return;
  const report = await peer.getStats();
  const values = {
    rttMs: null,
    jitterMs: null,
    packetLoss: 0,
    outboundKbps: 0,
    inboundKbps: null,
    outboundAudioKbps: 0,
    inboundAudioKbps: 0,
    sentFps: null,
    receivedFps: null,
    framesDropped: 0,
    resolution: null,
    codec: null,
    ice: peer.iceConnectionState,
    iceCandidateType: null,
    iceTransport: null,
    connection: peer.connectionState
  };
  let sentBytes = 0;
  let receivedBytes = 0;
  let sentAudioBytes = 0;
  let receivedAudioBytes = 0;
  let framesDropped = 0;
  let totalLost = 0;
  let totalReceived = 0;
  let timestamp = 0;
  let hasInboundVideo = false;
  const codecById = new Map();
  const candidatesById = new Map();
  let selectedCandidatePair;
  report.forEach((stat) => {
    if (stat.type === "codec" && stat.id && stat.mimeType) {
      codecById.set(stat.id, stat.mimeType);
    }
    if ((stat.type === "local-candidate" || stat.type === "remote-candidate") && stat.id) {
      candidatesById.set(stat.id, stat);
    }
  });
  report.forEach((stat) => {
    timestamp = Math.max(timestamp, stat.timestamp || 0);
    if (stat.type === "candidate-pair" && stat.state === "succeeded") {
      if (stat.nominated || stat.selected || !selectedCandidatePair) selectedCandidatePair = stat;
      values.rttMs = stat.currentRoundTripTime == null ? null : Math.round(stat.currentRoundTripTime * 1000);
    }
    if (stat.type === "outbound-rtp" && stat.kind === "video") {
      sentBytes += stat.bytesSent || 0;
      values.sentFps = stat.framesPerSecond ?? null;
      framesDropped += stat.framesDropped || 0;
      if (stat.frameWidth && stat.frameHeight) values.resolution = `${stat.frameWidth}x${stat.frameHeight}`;
      values.codec = resolveCodecName(codecById, stat.codecId) || values.codec;
    }
    if (stat.type === "outbound-rtp" && stat.kind === "audio") {
      sentAudioBytes += stat.bytesSent || 0;
    }
    if (stat.type === "inbound-rtp" && stat.kind === "video") {
      hasInboundVideo = true;
      receivedBytes += stat.bytesReceived || 0;
      values.receivedFps = stat.framesPerSecond ?? null;
      framesDropped += stat.framesDropped || 0;
      if (stat.jitter != null) values.jitterMs = Math.round(stat.jitter * 1000);
      if (stat.frameWidth && stat.frameHeight) values.resolution = `${stat.frameWidth}x${stat.frameHeight}`;
      totalLost += stat.packetsLost || 0;
      totalReceived += stat.packetsReceived || 0;
    }
    if (stat.type === "inbound-rtp" && stat.kind === "audio") {
      receivedAudioBytes += stat.bytesReceived || 0;
      if (stat.jitter != null && values.jitterMs == null) values.jitterMs = Math.round(stat.jitter * 1000);
      totalLost += stat.packetsLost || 0;
      totalReceived += stat.packetsReceived || 0;
    }
  });
  if (selectedCandidatePair) {
    const localCandidate = candidatesById.get(selectedCandidatePair.localCandidateId);
    const remoteCandidate = candidatesById.get(selectedCandidatePair.remoteCandidateId);
    if (localCandidate?.candidateType || remoteCandidate?.candidateType) {
      values.iceCandidateType = `${localCandidate?.candidateType || "unknown"}/` +
        `${remoteCandidate?.candidateType || "unknown"}`;
    }
    values.iceTransport = localCandidate?.protocol || remoteCandidate?.protocol || null;
  }
  if (previousStats && timestamp > previousStats.timestamp && hasInboundVideo) {
    const seconds = (timestamp - previousStats.timestamp) / 1000;
    values.outboundKbps = Math.round((sentBytes - previousStats.sentBytes) * 8 / seconds / 1000);
    values.inboundKbps = Math.round((receivedBytes - previousStats.receivedBytes) * 8 / seconds / 1000);
    values.outboundAudioKbps = Math.round((sentAudioBytes - previousStats.sentAudioBytes) * 8 / seconds / 1000);
    values.inboundAudioKbps = Math.round((receivedAudioBytes - previousStats.receivedAudioBytes) * 8 / seconds / 1000);
  } else if (previousStats && timestamp > previousStats.timestamp) {
    const seconds = (timestamp - previousStats.timestamp) / 1000;
    values.outboundKbps = Math.round((sentBytes - previousStats.sentBytes) * 8 / seconds / 1000);
    values.outboundAudioKbps = Math.round((sentAudioBytes - previousStats.sentAudioBytes) * 8 / seconds / 1000);
    values.inboundAudioKbps = Math.round((receivedAudioBytes - previousStats.receivedAudioBytes) * 8 / seconds / 1000);
  }
  if (totalLost + totalReceived > 0) {
    values.packetLoss = Number((totalLost / (totalLost + totalReceived) * 100).toFixed(1));
  }
  values.framesDropped = framesDropped;
  previousStats = { timestamp, sentBytes, receivedBytes, sentAudioBytes, receivedAudioBytes };
  if (values.rttMs != null && values.rttMs > 250) setConnection("poor", "Poor");
  else if (values.rttMs != null && values.rttMs > 120) setConnection("fair", "Fair");
  const poor = (values.rttMs != null && values.rttMs > 250) || values.packetLoss > 5 ||
    isBelowBitrate(values.inboundKbps, 80);
  const critical = (values.rttMs != null && values.rttMs > 500) || values.packetLoss > 10 ||
    isBelowBitrate(values.inboundKbps, 40);
  const good = (values.rttMs == null || values.rttMs < 120) && values.packetLoss < 1;
  criticalSamples = critical ? criticalSamples + 1 : 0;
  recoverySamples = good ? recoverySamples + 1 : 0;
  if (criticalSamples >= 2) {
    criticalSamples = 0;
    recoverySamples = 0;
    await setVideoSending(false);
  } else if (!critical && videoSuspended && shouldRecoverVideo(recoverySamples, good)) {
    recoverySamples = 0;
    await setVideoSending(true);
  }
  if (profile.value === "auto") {
    poorSamples = poor ? poorSamples + 1 : 0;
    goodSamples = good ? goodSamples + 1 : 0;
    const transition = chooseAdaptationLevel(adaptationLevel, poorSamples, goodSamples, profiles.length);
    if (transition.reset === "poor") {
      adaptationLevel = transition.level;
      poorSamples = 0;
      await applyProfile(profiles[adaptationLevel].name);
    } else if (transition.reset === "good") {
      adaptationLevel = transition.level;
      goodSamples = 0;
      await applyProfile(profiles[adaptationLevel].name);
    }
  }
  diagnostics.textContent = JSON.stringify(values, null, 2);
  if (socket?.readyState === WebSocket.OPEN && localParticipantID) {
    socket.send(JSON.stringify({
      version: 1,
      type: "network_state",
      participant_id: localParticipantID,
      rtt_ms: values.rttMs ?? -1,
      packet_loss10: Math.round(values.packetLoss * 10),
      jitter_ms: values.jitterMs ?? -1,
      video_kbps: values.outboundKbps,
      audio_kbps: values.outboundAudioKbps
    }));
  }
}

async function applyProfile(name, targetPeer = peer, targetStream = localStream) {
  const selected = name === "auto" ? profiles[adaptationLevel] : profiles.find((item) => item.name === name);
  const selectedIndex = selected ? profiles.findIndex((item) => item.name === selected.name) : -1;
  const maximumIndex = profiles.findIndex((item) => item.name === profileNameForQuality(hostLimits.maxVideoQuality));
  const capped = maximumIndex >= 0 && selectedIndex > maximumIndex ? profiles[maximumIndex] : selected;
  const requested = applyServerDefaults(capped, hostDefaults, serverDefaultProfile && name !== "auto");
  if (!requested || !targetPeer) return;
  const bitrate = Math.min(requested.bitrate, hostLimits.maxVideoBitrate);
  const fps = Math.min(requested.fps, hostLimits.maxVideoFPS);
  const audioBitrate = Math.min(requested.audioBitrate, hostLimits.maxAudioBitrate);
  if (effectiveProfile) {
    effectiveProfile.textContent =
      `Requested: ${selected?.name || "unknown"}; effective: ${requested.name} ` +
      `${Math.round(requested.width)}x${Math.round(requested.height)} / ` +
      `${fps} FPS / ${Math.round(bitrate / 1000)} kbps video / ${Math.round(audioBitrate / 1000)} kbps audio`;
  }
  const videoTrack = targetStream?.getVideoTracks()[0];
  if (videoTrack) {
    await videoTrack.applyConstraints({
      width: { ideal: requested.width, max: requested.width },
      height: { ideal: requested.height, max: requested.height },
      frameRate: { ideal: fps, max: fps }
    }).catch(() => {});
  }
  for (const sender of targetPeer.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const parameters = sender.getParameters();
    parameters.degradationPreference = "maintain-framerate";
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = bitrate;
    parameters.encodings[0].maxFramerate = fps;
    await sender.setParameters(parameters).catch(() => {});
  }
  for (const sender of targetPeer.getSenders()) {
    if (sender.track?.kind !== "audio") continue;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = audioBitrate;
    await sender.setParameters(parameters).catch(() => {});
  }
}

profile.addEventListener("change", async () => {
  writeStoredValue("meeting.bandwidthProfile", profile.value);
  serverDefaultProfile = false;
  if (profile.value !== "auto") {
    adaptationLevel = profiles.findIndex((item) => item.name === profile.value);
    poorSamples = 0;
    goodSamples = 0;
  }
  await applyProfile(profile.value);
});

function addParticipant(participant) {
  if (participantElements.has(participant.id)) return;
  const item = document.createElement("li");
  const name = document.createElement("strong");
  name.textContent = participant.name;
  const state = document.createElement("small");
  state.className = "media-state";
  state.textContent = "Mic on · Camera on";
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  video.playsInline = true;
  item.append(name, state, video, audio);
  participants.append(item);
  participantElements.set(participant.id, { item, name, state, video, audio });
}

function updateMediaState(message) {
  const element = participantElements.get(message.participant_id);
  if (!element) return;
  const audioOn = message.audio_enabled !== false;
  const videoOn = message.video_enabled !== false;
  element.state.textContent = `${audioOn ? "Mic on" : "Mic off"} · ${videoOn ? "Camera on" : "Camera off"}`;
}

function sendMediaState() {
  const audioEnabled = localStream?.getAudioTracks()[0]?.enabled === true;
  const videoEnabled = localStream?.getVideoTracks()[0]?.enabled === true && cameraRequested;
  const message = {
    version: 1, type: "media_state", participant_id: localParticipantID,
    audio_enabled: audioEnabled, video_enabled: videoEnabled
  };
  updateMediaState(message);
  if (socket?.readyState === WebSocket.OPEN && localParticipantID) {
    socket.send(JSON.stringify(message));
  }
}

async function setVideoSending(enabled) {
  videoSuspended = !enabled;
  for (const sender of peer?.getSenders() || []) {
    if (sender.track?.kind !== "video") continue;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].active = enabled && cameraRequested;
    await sender.setParameters(parameters).catch(() => {});
  }
  const track = localStream?.getVideoTracks()[0];
  if (track) track.enabled = enabled && cameraRequested;
  camera.textContent = enabled && cameraRequested ? "Turn camera off" : "Turn camera on";
  camera.setAttribute("aria-pressed", String(enabled && cameraRequested));
  if (!enabled) setConnection("poor", "Audio only");
  sendMediaState();
}

async function setVideoSenderActive(enabled) {
  for (const sender of peer?.getSenders() || []) {
    if (sender.track?.kind !== "video") continue;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].active = enabled;
    await sender.setParameters(parameters).catch(() => {});
  }
}

function setReceiveVideo(enabled) {
  receiveVideoEnabled = enabled;
  receiveVideo.textContent = enabled ? "Pause remote video" : "Resume remote video";
  receiveVideo.setAttribute("aria-pressed", String(enabled));
  for (const [participantID, element] of participantElements) {
    if (participantID !== localParticipantID) element.video.hidden = !enabled;
  }
  const targetPeer = peer;
  const targetSocket = socket;
  const targetTransceiver = videoTransceiver;
  const generation = socketGeneration;
  if (!targetPeer || !targetTransceiver || !isCurrentWebRTC(generation, targetPeer, targetSocket)) return;
  renegotiationChain = renegotiationChain
    .catch(() => {})
    .then(async () => {
      if (!isCurrentWebRTC(generation, targetPeer, targetSocket)) return;
      targetTransceiver.direction = enabled ? "recvonly" : "inactive";
      const offer = await targetPeer.createOffer();
      await targetPeer.setLocalDescription(offer);
      if (isCurrentWebRTC(generation, targetPeer, targetSocket)) {
        targetSocket.send(JSON.stringify({ version: 1, type: "offer", sdp: offer.sdp }));
      }
    })
    .catch(() => {
      if (generation === socketGeneration) status.textContent = "Unable to change remote video.";
    });
}

async function createAndSendLocalOffer(targetPeer, targetSocket, generation) {
  if (!isCurrentWebRTC(generation, targetPeer, targetSocket) ||
      targetPeer.signalingState !== "stable") return;
  const offer = await targetPeer.createOffer();
  await targetPeer.setLocalDescription(offer);
  if (isCurrentWebRTC(generation, targetPeer, targetSocket)) {
    targetSocket.send(JSON.stringify({ version: 1, type: "offer", sdp: offer.sdp }));
  }
}

function updateScreenShareUI() {
  const owner = participantElements.get(screenShareOwner);
  const ownerName = owner?.name?.textContent || "Someone";
  const ownedByOther = Boolean(screenShareOwner && screenShareOwner !== localParticipantID);
  screen.disabled = !screenShareEnabled || ownedByOther;
  screen.setAttribute("aria-pressed", String(Boolean(screenStream)));
  if (ownedByOther) {
    screen.textContent = "Screen share in use";
    screenStatus.textContent = `${ownerName} is sharing their screen.`;
  } else if (screenStream) {
    screen.textContent = "Stop sharing";
    screenStatus.textContent = "You are sharing your screen.";
  } else {
    screen.textContent = "Share screen";
    screenStatus.textContent = "No one is sharing their screen.";
  }
}

function requestScreenShare(active) {
  if (screenShareRequest) {
    return Promise.reject(new Error("screen share request already in progress"));
  }
  if (socket?.readyState !== WebSocket.OPEN || !localParticipantID) {
    return Promise.reject(new Error("signaling connection is unavailable"));
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!screenShareRequest) return;
      screenShareRequest = undefined;
      if (active && socket?.readyState === WebSocket.OPEN && localParticipantID) {
        socket.send(JSON.stringify({
          version: 1, type: "screen_share", participant_id: localParticipantID,
          screen_share_active: false
        }));
      }
      reject(new Error("screen share request timed out"));
    }, 5000);
    screenShareRequest = { active, resolve, reject, timer };
    socket?.send(JSON.stringify({
      version: 1, type: "screen_share", participant_id: localParticipantID,
      screen_share_active: active
    }));
  });
}

async function toggleScreenShare() {
  if (screenStream) {
    await stopScreenShare();
    return;
  }
  if (screen.disabled || !peer || (screenShareOwner && screenShareOwner !== localParticipantID)) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    await requestScreenShare(true);
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) throw new Error("video sender is unavailable");
    await sender.replaceTrack(screenTrack);
    await setVideoSenderActive(true);
    await applyProfile(profile.value, peer, screenStream);
    const local = participantElements.get(localParticipantID);
    if (local) local.video.srcObject = screenStream;
    updateScreenShareUI();
    screenTrack.addEventListener("ended", stopScreenShare, { once: true });
  } catch (error) {
    screenStream?.getTracks().forEach((track) => track.stop());
    screenStream = undefined;
    if (screenShareOwner === localParticipantID) {
      socket?.send(JSON.stringify({
        version: 1, type: "screen_share", participant_id: localParticipantID,
        screen_share_active: false
      }));
    }
    updateScreenShareUI();
    if (error.name !== "NotAllowedError") status.textContent = `Screen share unavailable: ${error.message}`;
  }
}

async function stopScreenShare() {
  if (!screenStream) return;
  const sender = peer?.getSenders().find((item) => item.track?.kind === "video");
  if (sender && cameraTrack) await sender.replaceTrack(cameraTrack).catch(() => {});
  await setVideoSending(!videoSuspended).catch(() => {});
  screenStream.getTracks().forEach((track) => track.stop());
  screenStream = undefined;
  if (socket?.readyState === WebSocket.OPEN && localParticipantID) {
    socket.send(JSON.stringify({
      version: 1, type: "screen_share", participant_id: localParticipantID,
      screen_share_active: false
    }));
  }
  await applyProfile(profile.value);
  const local = participantElements.get(localParticipantID);
  if (local && localStream) local.video.srcObject = localStream;
  updateScreenShareUI();
}

function isCurrentWebRTC(generation, currentPeer, currentSocket) {
  return generation === socketGeneration && peer === currentPeer && socket === currentSocket &&
    currentSocket.readyState === WebSocket.OPEN;
}

function handleWebRTCMessage(message, generation = socketGeneration) {
  if (message.type === "media_state") {
    updateMediaState(message);
    return;
  }
  if (message.type === "offer") {
    const currentPeer = peer;
    const currentSocket = socket;
    if (!currentPeer || !currentSocket || generation !== socketGeneration) return;
    renegotiationChain = renegotiationChain
      .catch(() => {})
      .then(async () => {
        const collided = currentPeer.signalingState === "have-local-offer";
        if (collided) {
          renegotiationPending = true;
          await currentPeer.setLocalDescription({ type: "rollback" });
        }
        await currentPeer.setRemoteDescription({ type: "offer", sdp: message.sdp });
      })
      .then(() => {
        if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) throw new Error("stale WebRTC connection");
        remoteDescriptionSet = true;
        return Promise.all(pendingCandidates.splice(0).map((candidate) => currentPeer.addIceCandidate(candidate)));
      })
      .then(() => currentPeer.createAnswer())
      .then((answer) => currentPeer.setLocalDescription(answer))
      .then(async () => {
        if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
        currentSocket.send(JSON.stringify({
          version: 1, type: "answer", sdp: currentPeer.localDescription.sdp
        }));
        if (renegotiationPending && videoTransceiver) {
          renegotiationPending = false;
          videoTransceiver.direction = receiveVideoEnabled ? "recvonly" : "inactive";
          await createAndSendLocalOffer(currentPeer, currentSocket, generation);
        }
      })
      .catch(() => {});
  }
  if (message.type === "answer") {
    const currentPeer = peer;
    const currentSocket = socket;
    if (!currentPeer || !currentSocket || generation !== socketGeneration) return;
    if (currentPeer.signalingState !== "have-local-offer") return;
    renegotiationChain = renegotiationChain
      .catch(() => {})
      .then(() => currentPeer.setRemoteDescription({ type: "answer", sdp: message.sdp }))
      .then(() => {
        if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) throw new Error("stale WebRTC connection");
        remoteDescriptionSet = true;
        return Promise.all(pendingCandidates.splice(0).map((candidate) => currentPeer.addIceCandidate(candidate)));
      })
      .catch(() => {});
  }
  if (message.type === "candidate") {
    const candidate = {
      candidate: message.candidate,
      sdpMid: message.sdp_mid,
      sdpMLineIndex: message.sdp_mline_index
    };
    if (remoteDescriptionSet) {
      const currentPeer = peer;
      if (currentPeer && isCurrentWebRTC(generation, currentPeer, socket)) currentPeer.addIceCandidate(candidate);
    }
    else pendingCandidates.push(candidate);
  }
}

mic.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  mic.textContent = track.enabled ? "Mute microphone" : "Unmute microphone";
  mic.setAttribute("aria-pressed", String(track.enabled));
  sendMediaState();
});

camera.addEventListener("click", () => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  cameraRequested = !cameraRequested;
  setVideoSending(!videoSuspended);
  sendMediaState();
});

screen.addEventListener("click", toggleScreenShare);
receiveVideo.addEventListener("click", () => setReceiveVideo(!receiveVideoEnabled));

leave.addEventListener("click", () => {
  intentionalClose = true;
  socketGeneration++;
  clearTimeout(reconnectTimer);
  clearInterval(statsTimer);
  if (socket?.readyState === WebSocket.OPEN && localParticipantID) {
    socket.send(JSON.stringify({
      version: 1, type: "leave", participant_id: localParticipantID
    }));
  }
  socket?.close();
  reconnectToken = undefined;
  localStream?.getTracks().forEach((track) => track.stop());
  screenStream?.getTracks().forEach((track) => track.stop());
  if (screenShareRequest) {
    clearTimeout(screenShareRequest.timer);
    screenShareRequest.reject(new Error("meeting left"));
    screenShareRequest = undefined;
  }
  remoteAudioElements.clear();
  enableAudio.hidden = true;
  peer?.close();
  localStream = undefined;
  screenStream = undefined;
  cameraTrack = undefined;
  peer = undefined;
  videoTransceiver = undefined;
  localParticipantID = undefined;
  remoteDescriptionSet = false;
  criticalSamples = 0;
  videoSuspended = false;
  cameraRequested = true;
  previousStats = undefined;
  criticalSamples = 0;
  recoverySamples = 0;
  adaptationLevel = 2;
  poorSamples = 0;
  goodSamples = 0;
  profile.value = "auto";
  pendingCandidates.splice(0);
  mic.textContent = "Mute microphone";
  mic.setAttribute("aria-pressed", "true");
  camera.textContent = "Turn camera off";
  camera.setAttribute("aria-pressed", "true");
  camera.disabled = false;
  receiveVideoEnabled = true;
  receiveVideo.textContent = "Pause remote video";
  receiveVideo.setAttribute("aria-pressed", "true");
  screen.textContent = "Share screen";
  screen.setAttribute("aria-pressed", "false");
  screenShareOwner = undefined;
  screenShareEnabled = true;
  updateScreenShareUI();
  setConnection("", "Connecting");
  diagnostics.textContent = "Waiting for media statistics…";
  participantElements.clear();
  participants.replaceChildren();
  meeting.hidden = true;
  form.hidden = false;
  joinButton.disabled = false;
});
