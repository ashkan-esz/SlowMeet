const form = document.querySelector("#join-form");
const nameInput = document.querySelector("#name");
const passwordInput = document.querySelector("#password");
const status = document.querySelector("#status");
const meeting = document.querySelector("#meeting");
const participants = document.querySelector("#participants");
const mic = document.querySelector("#mic");
const camera = document.querySelector("#camera");
const screen = document.querySelector("#screen");
const leave = document.querySelector("#leave");
const connection = document.querySelector("#connection");
const diagnostics = document.querySelector("#diagnostics");
const profile = document.querySelector("#profile");
const storedName = localStorage.getItem("meeting.displayName");
if (storedName) nameInput.value = storedName;

let socket;
let peer;
let localStream;
let screenStream;
let cameraTrack;
let localParticipantID;
let remoteDescriptionSet = false;
let reconnectTimer;
let intentionalClose = false;
let restartRequested = false;
let statsTimer;
let previousStats;
let adaptationLevel = 2;
let poorSamples = 0;
let goodSamples = 0;
let criticalSamples = 0;
let videoSuspended = false;
let cameraRequested = true;
let hostLimits = {
  maxVideoBitrate: 500000,
  maxVideoFPS: 30,
  maxAudioBitrate: 64000
};
const pendingCandidates = [];
const participantElements = new Map();
const profiles = [
  { name: "very-slow", width: 240, height: 160, fps: 5, bitrate: 90000, audioBitrate: 24000 },
  { name: "slow", width: 360, height: 240, fps: 10, bitrate: 180000, audioBitrate: 32000 },
  { name: "normal", width: 640, height: 360, fps: 15, bitrate: 400000, audioBitrate: 48000 }
];
fetch("/config").then((response) => response.json()).then((config) => {
  hostLimits.maxVideoBitrate = config.max_video_bitrate || hostLimits.maxVideoBitrate;
  hostLimits.maxAudioBitrate = config.max_audio_bitrate || hostLimits.maxAudioBitrate;
  screen.disabled = config.screen_share_enabled === false;
}).catch(() => {});
form.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = nameInput.value.trim();
  localStorage.setItem("meeting.displayName", name);
  intentionalClose = false;
  connectSocket(name, passwordInput.value);
});

function connectSocket(name, password) {
  status.textContent = "Connecting...";
  socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  socket.addEventListener("open", () => {
    clearTimeout(reconnectTimer);
    socket.send(JSON.stringify({ version: 1, type: "join", name, password }));
  });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    handleWebRTCMessage(message);
    if (message.type === "error") { status.textContent = message.error; return; }
    if (message.type === "participant" || message.type === "participant_joined") {
      const participant = message.participant;
      addParticipant(participant);
      if (message.type === "participant") {
        localParticipantID = participant.id;
        form.hidden = true;
        meeting.hidden = false;
        status.textContent = "";
        startWebRTC();
      }
    }
    if (message.type === "participant_left") {
      participantElements.get(message.participant.id)?.item.remove();
      participantElements.delete(message.participant.id);
    }
  });
  socket.addEventListener("close", () => {
    if (intentionalClose || meeting.hidden) return;
    status.textContent = "Reconnecting...";
    reconnectTimer = setTimeout(() => {
      participants.replaceChildren();
      participantElements.clear();
      peer?.close();
      peer = undefined;
      remoteDescriptionSet = false;
      pendingCandidates.splice(0);
      previousStats = undefined;
      connectSocket(nameInput.value.trim(), passwordInput.value);
    }, 2000);
  });
  socket.addEventListener("error", () => { status.textContent = "Unable to connect."; });
}

async function startWebRTC() {
  peer = new RTCPeerConnection();
  peer.oniceconnectionstatechange = () => {
    if (peer.iceConnectionState === "connected" || peer.iceConnectionState === "completed") {
      setConnection("good", "Connected");
    } else if (peer.iceConnectionState === "checking") {
      setConnection("", "Connecting");
    } else if (peer.iceConnectionState === "disconnected") {
      setConnection("fair", "Reconnecting");
    } else if (peer.iceConnectionState === "failed") {
      setConnection("poor", "Poor");
    }
  };
  peer.onconnectionstatechange = () => {
    if (peer.connectionState === "connected") {
      restartRequested = false;
      status.textContent = "Connected";
    }
    if (peer.connectionState === "disconnected") {
      status.textContent = "Reconnecting media...";
    }
    if (peer.connectionState === "failed" && !restartRequested) {
      restartRequested = true;
      status.textContent = "Restarting media...";
      socket.send(JSON.stringify({ version: 1, type: "ice_restart" }));
    }
  };
  peer.addTransceiver("audio", { direction: "recvonly" });
  peer.addTransceiver("video", { direction: "recvonly" });
  peer.ontrack = ({ streams, track }) => {
    if (!streams[0]) return;
    const participantID = track.id.split("|")[0];
    const element = participantElements.get(participantID);
    if (!element) return;
    if (track.kind === "video") {
      element.video.srcObject = streams[0];
      element.video.autoplay = true;
      element.video.playsInline = true;
    } else {
      element.audio.srcObject = streams[0];
      element.audio.autoplay = true;
    }
  };
  peer.onicecandidate = ({ candidate }) => {
    if (candidate) socket.send(JSON.stringify({
      version: 1, type: "candidate", candidate: candidate.candidate,
      sdp_mid: candidate.sdpMid, sdp_mline_index: candidate.sdpMLineIndex
    }));
  };
  try {
    localStream = new MediaStream();
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStream.getAudioTracks().forEach((track) => localStream.addTrack(track));
    } catch (_) {
      status.textContent = "Microphone unavailable; continuing without audio.";
    }
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: {
        width: { ideal: 360, max: 640 },
        height: { ideal: 240, max: 360 },
        frameRate: { ideal: 15, max: 30 }
      }});
      videoStream.getVideoTracks().forEach((track) => localStream.addTrack(track));
    } catch (_) {
      cameraRequested = false;
      camera.disabled = true;
      camera.textContent = "Camera unavailable";
      status.textContent = "Camera unavailable; continuing audio-only.";
    }
    if (localStream.getTracks().length === 0) throw new Error("No microphone or camera is available");
    cameraTrack = localStream.getVideoTracks()[0];
    const local = participantElements.get(localParticipantID);
    if (local) {
      local.video.srcObject = localStream;
      local.video.autoplay = true;
      local.video.muted = true;
    }
    for (const track of localStream.getTracks()) peer.addTrack(track, localStream);
    await applyProfile(profile.value);
    clearInterval(statsTimer);
    previousStats = undefined;
    statsTimer = setInterval(updateDiagnostics, 2000);
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    socket.send(JSON.stringify({ version: 1, type: "offer", sdp: offer.sdp }));
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
    packetLoss: 0,
    outboundKbps: 0,
    inboundKbps: 0,
    sentFps: null,
    receivedFps: null,
    resolution: null,
    codec: null,
    ice: peer.iceConnectionState,
    connection: peer.connectionState
  };
  let sentBytes = 0;
  let receivedBytes = 0;
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
      if (stat.frameWidth && stat.frameHeight) values.resolution = `${stat.frameWidth}x${stat.frameHeight}`;
      values.codec = stat.codecId || values.codec;
    }
    if (stat.type === "inbound-rtp" && stat.kind === "video") {
      receivedBytes += stat.bytesReceived || 0;
      values.receivedFps = stat.framesPerSecond ?? null;
      if (stat.frameWidth && stat.frameHeight) values.resolution = `${stat.frameWidth}x${stat.frameHeight}`;
      totalLost += stat.packetsLost || 0;
      totalReceived += stat.packetsReceived || 0;
    }
  });
  if (previousStats && timestamp > previousStats.timestamp) {
    const seconds = (timestamp - previousStats.timestamp) / 1000;
    values.outboundKbps = Math.round((sentBytes - previousStats.sentBytes) * 8 / seconds / 1000);
    values.inboundKbps = Math.round((receivedBytes - previousStats.receivedBytes) * 8 / seconds / 1000);
  }
  if (totalLost + totalReceived > 0) {
    values.packetLoss = Number((totalLost / (totalLost + totalReceived) * 100).toFixed(1));
  }
  previousStats = { timestamp, sentBytes, receivedBytes };
  if (values.rttMs != null && values.rttMs > 250) setConnection("poor", "Poor");
  else if (values.rttMs != null && values.rttMs > 120) setConnection("fair", "Fair");
  const poor = (values.rttMs != null && values.rttMs > 250) || values.packetLoss > 5 || values.inboundKbps < 80;
  const critical = (values.rttMs != null && values.rttMs > 500) || values.packetLoss > 10 || values.inboundKbps < 40;
  const good = (values.rttMs == null || values.rttMs < 120) && values.packetLoss < 1;
  criticalSamples = critical ? criticalSamples + 1 : 0;
  if (criticalSamples >= 2) {
    criticalSamples = 0;
    await setVideoSending(false);
  } else if (!critical && videoSuspended && good) {
    await setVideoSending(true);
  }
  if (profile.value === "auto") {
    poorSamples = poor ? poorSamples + 1 : 0;
    goodSamples = good ? goodSamples + 1 : 0;
    if (poorSamples >= 2 && adaptationLevel < profiles.length - 1) {
      adaptationLevel++;
      poorSamples = 0;
      await applyProfile(profiles[adaptationLevel].name);
    } else if (goodSamples >= 5 && adaptationLevel > 0) {
      adaptationLevel--;
      goodSamples = 0;
      await applyProfile(profiles[adaptationLevel].name);
    }
  }
  diagnostics.textContent = JSON.stringify(values, null, 2);
}

async function applyProfile(name) {
  const requested = name === "auto" ? profiles[adaptationLevel] : profiles.find((item) => item.name === name);
  if (!requested || !peer) return;
  const bitrate = Math.min(requested.bitrate, hostLimits.maxVideoBitrate);
  const fps = Math.min(requested.fps, hostLimits.maxVideoFPS);
  const audioBitrate = Math.min(requested.audioBitrate, hostLimits.maxAudioBitrate);
  const videoTrack = localStream?.getVideoTracks()[0];
  if (videoTrack) {
    await videoTrack.applyConstraints({
      width: { ideal: requested.width, max: requested.width },
      height: { ideal: requested.height, max: requested.height },
      frameRate: { ideal: fps, max: fps }
    }).catch(() => {});
  }
  for (const sender of peer.getSenders()) {
    if (sender.track?.kind !== "video") continue;
    const parameters = sender.getParameters();
    parameters.degradationPreference = "maintain-framerate";
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = bitrate;
    parameters.encodings[0].maxFramerate = fps;
    await sender.setParameters(parameters).catch(() => {});
  }
  for (const sender of peer.getSenders()) {
    if (sender.track?.kind !== "audio") continue;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].maxBitrate = audioBitrate;
    await sender.setParameters(parameters).catch(() => {});
  }
}

profile.addEventListener("change", async () => {
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
  item.textContent = participant.name;
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  video.playsInline = true;
  item.append(video, audio);
  participants.append(item);
  participantElements.set(participant.id, { item, video, audio });
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

function handleWebRTCMessage(message) {
  if (message.type === "offer") {
    peer?.setRemoteDescription({ type: "offer", sdp: message.sdp })
      .then(() => {
        remoteDescriptionSet = true;
        return Promise.all(pendingCandidates.splice(0).map((candidate) => peer.addIceCandidate(candidate)));
      })
      .then(() => peer.createAnswer())
      .then((answer) => peer.setLocalDescription(answer))
      .then(() => socket.send(JSON.stringify({
        version: 1, type: "answer", sdp: peer.localDescription.sdp
      })));
  }
  if (message.type === "answer") {
    peer?.setRemoteDescription({ type: "answer", sdp: message.sdp })
      .then(() => {
        remoteDescriptionSet = true;
        return Promise.all(pendingCandidates.splice(0).map((candidate) => peer.addIceCandidate(candidate)));
      });
  }
  if (message.type === "candidate") {
    const candidate = {
      candidate: message.candidate,
      sdpMid: message.sdp_mid,
      sdpMLineIndex: message.sdp_mline_index
    };
    if (remoteDescriptionSet) peer?.addIceCandidate(candidate);
    else pendingCandidates.push(candidate);
  }
}

mic.addEventListener("click", () => {
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  mic.textContent = track.enabled ? "Mute microphone" : "Unmute microphone";
});

camera.addEventListener("click", () => {
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  cameraRequested = !cameraRequested;
  setVideoSending(!videoSuspended);
});

screen.addEventListener("click", toggleScreenShare);

leave.addEventListener("click", () => {
  intentionalClose = true;
  clearTimeout(reconnectTimer);
  clearInterval(statsTimer);
  socket?.close();
  localStream?.getTracks().forEach((track) => track.stop());
  screenStream?.getTracks().forEach((track) => track.stop());
  peer?.close();
  localStream = undefined;
  screenStream = undefined;
  cameraTrack = undefined;
  peer = undefined;
  localParticipantID = undefined;
  remoteDescriptionSet = false;
  criticalSamples = 0;
  videoSuspended = false;
  cameraRequested = true;
  previousStats = undefined;
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
});
