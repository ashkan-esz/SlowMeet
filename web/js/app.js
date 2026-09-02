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
const leave = document.querySelector("#leave");
const connection = document.querySelector("#connection");
const diagnostics = document.querySelector("#diagnostics");
const copyDiagnostics = document.querySelector("#copy-diagnostics");
const diagnosticsStatus = document.querySelector("#diagnostics-status");
const enableAudio = document.querySelector("#enable-audio");
const profile = document.querySelector("#profile");
const effectiveProfile = document.querySelector("#effective-profile");
const storedName = localStorage.getItem("meeting.displayName");
if (storedName) nameInput.value = storedName;

let socket;
let socketGeneration = 0;
let peer;
let videoTransceiver;
let renegotiationChain = Promise.resolve();
let localStream;
let screenStream;
let cameraTrack;
let localParticipantID;
let reconnectToken;
let remoteDescriptionSet = false;
let reconnectTimer;
let intentionalClose = false;
let restartRequested = false;
let reconnectAttempts = 0;
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
  maxAudioBitrate: 64000
};
const pendingCandidates = [];
const participantElements = new Map();
const remoteAudioElements = new Set();
const storedProfile = localStorage.getItem("meeting.bandwidthProfile");
const profiles = [
  { name: "very-slow", width: 240, height: 160, fps: 5, bitrate: 90000, audioBitrate: 24000 },
  { name: "slow", width: 360, height: 240, fps: 10, bitrate: 180000, audioBitrate: 32000 },
  { name: "normal", width: 640, height: 360, fps: 15, bitrate: 400000, audioBitrate: 48000 }
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
  screen.disabled = config.screen_share_enabled === false;
  if (!storedProfile && config.default_video_quality) {
    profile.value = config.default_video_quality === "high" ? "normal" :
      config.default_video_quality === "medium" || config.default_video_quality === "low" ? "slow" : "very-slow";
  }
}).catch(() => {});
if (storedProfile && [...profile.options].some((option) => option.value === storedProfile)) {
  profile.value = storedProfile;
}
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (joinButton.disabled) return;
  const name = nameInput.value.trim();
  localStorage.setItem("meeting.displayName", name);
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
      if (message.screen_share_enabled === false) {
        screen.disabled = true;
        if (screenStream) stopScreenShare();
      } else if (message.screen_share_enabled === true) {
        screen.disabled = false;
      }
      applyProfile(profile.value);
      return;
    }
    if (message.type === "error") {
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
    const delay = Math.min(30000, 2000 * 2 ** Math.min(reconnectAttempts - 1, 4));
    status.textContent = `Reconnecting in ${Math.ceil(delay / 1000)}s...`;
    reconnectTimer = setTimeout(() => {
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
      remoteDescriptionSet = false;
      pendingCandidates.splice(0);
      previousStats = undefined;
      criticalSamples = 0;
      recoverySamples = 0;
      connectSocket(nameInput.value.trim(), passwordInput.value);
    }, delay);
  });
  currentSocket.addEventListener("error", () => {
    if (generation === socketGeneration) status.textContent = "Unable to connect.";
  });
}

async function startWebRTC() {
  const generation = socketGeneration;
  const currentSocket = socket;
  const currentPeer = new RTCPeerConnection();
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
    } catch (_) {
      cameraRequested = false;
      camera.disabled = true;
      camera.textContent = "Camera unavailable";
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
    inboundKbps: 0,
    outboundAudioKbps: 0,
    inboundAudioKbps: 0,
    sentFps: null,
    receivedFps: null,
    framesDropped: 0,
    resolution: null,
    codec: null,
    ice: peer.iceConnectionState,
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
  report.forEach((stat) => {
    timestamp = Math.max(timestamp, stat.timestamp || 0);
    if (stat.type === "candidate-pair" && stat.state === "succeeded") {
      values.rttMs = stat.currentRoundTripTime == null ? null : Math.round(stat.currentRoundTripTime * 1000);
    }
    if (stat.type === "outbound-rtp" && stat.kind === "video") {
      sentBytes += stat.bytesSent || 0;
      values.sentFps = stat.framesPerSecond ?? null;
      framesDropped += stat.framesDropped || 0;
      if (stat.frameWidth && stat.frameHeight) values.resolution = `${stat.frameWidth}x${stat.frameHeight}`;
      values.codec = stat.codecId || values.codec;
    }
    if (stat.type === "outbound-rtp" && stat.kind === "audio") {
      sentAudioBytes += stat.bytesSent || 0;
    }
    if (stat.type === "inbound-rtp" && stat.kind === "video") {
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
  if (previousStats && timestamp > previousStats.timestamp) {
    const seconds = (timestamp - previousStats.timestamp) / 1000;
    values.outboundKbps = Math.round((sentBytes - previousStats.sentBytes) * 8 / seconds / 1000);
    values.inboundKbps = Math.round((receivedBytes - previousStats.receivedBytes) * 8 / seconds / 1000);
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
  const poor = (values.rttMs != null && values.rttMs > 250) || values.packetLoss > 5 || values.inboundKbps < 80;
  const critical = (values.rttMs != null && values.rttMs > 500) || values.packetLoss > 10 || values.inboundKbps < 40;
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
}

async function applyProfile(name, targetPeer = peer, targetStream = localStream) {
  const requested = name === "auto" ? profiles[adaptationLevel] : profiles.find((item) => item.name === name);
  if (!requested || !targetPeer) return;
  const bitrate = Math.min(requested.bitrate, hostLimits.maxVideoBitrate);
  const fps = Math.min(requested.fps, hostLimits.maxVideoFPS);
  const audioBitrate = Math.min(requested.audioBitrate, hostLimits.maxAudioBitrate);
  if (effectiveProfile) {
    effectiveProfile.textContent =
      `Requested: ${requested.name}; effective: ${Math.round(requested.width)}x${Math.round(requested.height)} / ` +
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
  localStorage.setItem("meeting.bandwidthProfile", profile.value);
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
  socket?.send(JSON.stringify(message));
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
  if (!enabled) setConnection("poor", "Audio only");
  sendMediaState();
}

function setReceiveVideo(enabled) {
  receiveVideoEnabled = enabled;
  receiveVideo.textContent = enabled ? "Pause remote video" : "Resume remote video";
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

async function toggleScreenShare() {
  if (screenStream) {
    await stopScreenShare();
    return;
  }
  if (screen.disabled || !peer) return;
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    const sender = peer.getSenders().find((item) => item.track?.kind === "video");
    if (!sender) return;
    await sender.replaceTrack(screenTrack);
    const local = participantElements.get(localParticipantID);
    if (local) local.video.srcObject = screenStream;
    screen.textContent = "Stop sharing";
    screenTrack.addEventListener("ended", stopScreenShare, { once: true });
  } catch (error) {
    if (error.name !== "NotAllowedError") status.textContent = `Screen share unavailable: ${error.message}`;
  }
}

async function stopScreenShare() {
  if (!screenStream) return;
  const sender = peer?.getSenders().find((item) => item.track?.kind === "video");
  if (sender && cameraTrack) await sender.replaceTrack(cameraTrack);
  screenStream.getTracks().forEach((track) => track.stop());
  screenStream = undefined;
  const local = participantElements.get(localParticipantID);
  if (local && localStream) local.video.srcObject = localStream;
  screen.textContent = "Share screen";
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
    currentPeer.setRemoteDescription({ type: "offer", sdp: message.sdp })
      .then(() => {
        if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) throw new Error("stale WebRTC connection");
        remoteDescriptionSet = true;
        return Promise.all(pendingCandidates.splice(0).map((candidate) => currentPeer.addIceCandidate(candidate)));
      })
      .then(() => currentPeer.createAnswer())
      .then((answer) => currentPeer.setLocalDescription(answer))
      .then(() => {
        if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
        currentSocket.send(JSON.stringify({
          version: 1, type: "answer", sdp: currentPeer.localDescription.sdp
        }));
      })
      .catch(() => {});
  }
  if (message.type === "answer") {
    const currentPeer = peer;
    const currentSocket = socket;
    if (!currentPeer || !currentSocket || generation !== socketGeneration) return;
    currentPeer.setRemoteDescription({ type: "answer", sdp: message.sdp })
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
  camera.textContent = "Turn camera off";
  camera.disabled = false;
  screen.textContent = "Share screen";
  setConnection("", "Connecting");
  diagnostics.textContent = "Waiting for media statistics…";
  participantElements.clear();
  participants.replaceChildren();
  meeting.hidden = true;
  form.hidden = false;
  joinButton.disabled = false;
});
