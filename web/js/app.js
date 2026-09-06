const form = document.querySelector("#join-form");
const nameInput = document.querySelector("#name");
const passwordInput = document.querySelector("#password");
const joinButton = document.querySelector("#join");
const status = document.querySelector("#status");
const brandBar = document.querySelector(".brand-bar");
const welcomeGrid = document.querySelector(".welcome-grid");
const meeting = document.querySelector("#meeting");
const participants = document.querySelector("#participants");
const mic = document.querySelector("#mic");
const camera = document.querySelector("#camera");
const receiveVideo = document.querySelector("#receive-video");
const screen = document.querySelector("#screen");
const leave = document.querySelector("#leave");
const connection = document.querySelector("#connection");
const toggleSidebar = document.querySelector("#toggle-sidebar");
const toggleSidebarLabel = document.querySelector("#toggle-sidebar-label");
const meetingSidebar = document.querySelector("#meeting-sidebar");
const closeSidebar = document.querySelector("#close-sidebar");
const sidebarBackdrop = document.querySelector("#sidebar-backdrop");
const diagnostics = document.querySelector("#diagnostics");
const copyDiagnostics = document.querySelector("#copy-diagnostics");
const diagnosticsStatus = document.querySelector("#diagnostics-status");
const enableAudio = document.querySelector("#enable-audio");
const profile = document.querySelector("#profile");
const cameraQuality = document.querySelector("#camera-quality");
const effectiveProfile = document.querySelector("#effective-profile");
const testMedia = document.querySelector("#test-media");
const devicePreview = document.querySelector("#device-preview");
const testCamera = document.querySelector("#test-camera");
const testMicrophone = document.querySelector("#test-microphone");
const stopMediaTest = document.querySelector("#stop-media-test");
const deviceTestStatus = document.querySelector("#device-test-status");
const chatToggle = document.querySelector("#chat");
const chatRail = document.querySelector("#chat-rail");
const closeChat = document.querySelector("#close-chat");
const chatMessages = document.querySelector("#chat-messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatBadge = document.querySelector("#chat-badge");
const newMessages = document.querySelector("#new-messages");
const participantCount = document.querySelector("#participant-count");
const participantCountBadge = document.querySelector("#participant-count-badge");
const pauseAll = document.querySelector("#pause-all");
const audioOnly = document.querySelector("#audio-only");
const toastRegion = document.querySelector("#toast-region");
const connectionMessage = document.querySelector("#connection-message");
const participantPagination = document.querySelector("#participant-pagination");
const participantPagePrevious = document.querySelector("#participant-page-previous");
const participantPageNext = document.querySelector("#participant-page-next");
const participantPageStatus = document.querySelector("#participant-page-status");
const participantFocusStatus = document.querySelector("#participant-focus-status");
const networkLabel = document.querySelector("[data-network-label]");
const statRTT = document.querySelector("#stat-rtt");
const statJitter = document.querySelector("#stat-jitter");
const statLoss = document.querySelector("#stat-loss");
const statBitrate = document.querySelector("#stat-bitrate");
const statResolution = document.querySelector("#stat-resolution");

function updateControlLabel(button, label) {
  const target = button?.querySelector("[data-control-label]");
  if (target) target.textContent = label;
  else if (button) button.textContent = label;
}

function hashName(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) - hash + value.charCodeAt(index)) | 0;
  return Math.abs(hash);
}

function initialsFor(name) {
  return name.trim().split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase() || "?";
}

const pipPositions = ["top-left", "top-right", "bottom-left", "bottom-right"];
const participantPageSize = 9;
let participantPage = 0;
let focusedParticipantID;
let pipDragState;

function remoteParticipantCount() {
  let count = 0;
  participantElements.forEach((_, participantID) => {
    if (participantID !== localParticipantID) count += 1;
  });
  return count;
}

function updateParticipantCount() {
  const count = participantElements.size;
  updateParticipantPagination();
  if (participantCount) participantCount.textContent = `${count} participant${count === 1 ? "" : "s"}`;
  if (participantCountBadge) participantCountBadge.textContent = String(count);
}

function updateParticipantAriaLabel(element) {
  if (!element?.item) return;
  const cameraState = element.item.dataset.camera || "unknown";
  const microphoneState = element.item.dataset.mic || "unknown";
  const qualityState = participantQualityLabels[element.item.dataset.quality] || "unknown";
  const selfView = element.item.classList.contains("is-local")
    ? " Self-view. Use arrow keys to move it between corners."
    : "";
  element.item.setAttribute("aria-label",
    `${element.name.textContent}: camera ${cameraState}; microphone ${microphoneState}; ` +
    `connection quality ${qualityState}.${selfView}`);
}

function updateParticipantVideoVisibility(element) {
  if (!element?.item) return;
  const videoOn = element.item.dataset.camera === "on";
  const isLocal = element.item.classList.contains("is-local");
  const visible = videoOn && (isLocal || receiveVideoEnabled);
  element.item.dataset.receiveVideo = String(visible);
  element.avatar.hidden = visible;
  element.video.hidden = !visible;
}

function updateParticipantPagination() {
  if (!participants) return;
  const remoteEntries = [...participantElements.entries()]
    .filter(([participantID]) => participantID !== localParticipantID);
  const pageCount = Math.max(1, Math.ceil(remoteEntries.length / participantPageSize));
  if (screenShareOwner && remoteEntries.length > participantPageSize) {
    const ownerIndex = remoteEntries.findIndex(([participantID]) => participantID === screenShareOwner);
    if (ownerIndex >= 0 && Math.floor(ownerIndex / participantPageSize) !== participantPage) {
      participantPage = Math.floor(ownerIndex / participantPageSize);
    }
  }
  participantPage = Math.min(Math.max(participantPage, 0), pageCount - 1);
  const first = participantPage * participantPageSize;
  const visibleEntries = remoteEntries.slice(first, first + participantPageSize);
  const visibleRemoteIDs = new Set(visibleEntries.map(([participantID]) => participantID));
  participantElements.forEach((element, participantID) => {
    const visible = participantID === localParticipantID ||
      (remoteEntries.length === 0 || visibleRemoteIDs.has(participantID));
    element.item.hidden = !visible;
    if (!visible && participantID === focusedParticipantID) {
      element.item.classList.remove("is-focused");
      focusedParticipantID = undefined;
    }
    updateParticipantAriaLabel(element);
  });
  const visibleCount = remoteEntries.length > 0 ? visibleEntries.length : participantElements.size;
  participants.dataset.count = String(Math.min(visibleCount, participantPageSize));
  participants.dataset.remoteCount = String(Math.min(remoteEntries.length, participantPageSize));
  participants.classList.toggle("has-remote", remoteEntries.length > 0);
  const paginated = remoteEntries.length > participantPageSize;
  if (participantPagination) participantPagination.hidden = !paginated;
  if (participantPageStatus) {
    participantPageStatus.textContent = paginated
      ? `Page ${participantPage + 1} of ${pageCount}; showing ${visibleEntries.length} participants`
      : "";
  }
  if (participantPagePrevious) participantPagePrevious.disabled = !paginated || participantPage === 0;
  if (participantPageNext) participantPageNext.disabled = !paginated || participantPage >= pageCount - 1;
}

function setParticipantPage(delta) {
  participantPage += delta;
  updateParticipantPagination();
}

function setPipPosition(item, position, persist = true) {
  const normalized = pipPositions.includes(position) ? position : "bottom-right";
  item.dataset.pipPosition = normalized;
  const element = participantElements.get(item.dataset.participantId);
  if (element) updateParticipantAriaLabel(element);
  if (persist) writeStoredValue("meeting.pipPosition", normalized);
}

function markLocalParticipant(participantID) {
  const element = participantElements.get(participantID);
  if (!element) return;
  element.item.classList.add("is-local");
  element.item.tabIndex = 0;
  element.item.setAttribute("aria-keyshortcuts", "ArrowUp ArrowDown ArrowLeft ArrowRight");
  setPipPosition(element.item, readStoredValue("meeting.pipPosition") || "bottom-right", false);
  updateParticipantCount();
}

function pipPositionForPoint(clientX, clientY) {
  const stage = participants?.closest(".stage-panel");
  const bounds = stage?.getBoundingClientRect();
  if (!bounds) return "bottom-right";
  const left = clientX < bounds.left + bounds.width / 2;
  const top = clientY < bounds.top + bounds.height / 2;
  return `${top ? "top" : "bottom"}-${left ? "left" : "right"}`;
}

function pipPositionForKey(position, key) {
  const [vertical, horizontal] = position.split("-");
  if (key === "ArrowUp") return `top-${horizontal}`;
  if (key === "ArrowDown") return `bottom-${horizontal}`;
  if (key === "ArrowLeft") return `${vertical}-left`;
  if (key === "ArrowRight") return `${vertical}-right`;
  return undefined;
}

function pipTileFromEvent(event) {
  const tile = event.target.closest?.(".participant-tile.is-local");
  return tile && participants?.contains(tile) && participants.classList.contains("has-remote") ? tile : undefined;
}

function finishPipDrag() {
  if (!pipDragState) return;
  const { item, pointerId } = pipDragState;
  if (item.hasPointerCapture?.(pointerId)) item.releasePointerCapture(pointerId);
  item.classList.remove("is-dragging");
  item.style.removeProperty("transform");
  pipDragState = undefined;
}

participants.addEventListener("pointerdown", (event) => {
  const item = pipTileFromEvent(event);
  if (!item || event.button !== 0) return;
  event.preventDefault();
  pipDragState = {
    item,
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    moved: false
  };
  item.classList.add("is-dragging");
  item.setPointerCapture?.(event.pointerId);
});

participants.addEventListener("pointermove", (event) => {
  if (!pipDragState || event.pointerId !== pipDragState.pointerId) return;
  const deltaX = event.clientX - pipDragState.startX;
  const deltaY = event.clientY - pipDragState.startY;
  if (!pipDragState.moved && Math.hypot(deltaX, deltaY) < 6) return;
  pipDragState.moved = true;
  pipDragState.item.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
});

participants.addEventListener("pointerup", (event) => {
  if (!pipDragState || event.pointerId !== pipDragState.pointerId) return;
  const { item, moved } = pipDragState;
  if (moved) setPipPosition(item, pipPositionForPoint(event.clientX, event.clientY));
  finishPipDrag();
});

participants.addEventListener("pointercancel", finishPipDrag);
participants.addEventListener("keydown", (event) => {
  const item = event.target.closest?.(".participant-tile");
  if (!item) return;
  if (event.key === "Enter") {
    event.preventDefault();
    focusedParticipantID = item.dataset.participantId;
    participantElements.forEach((element, participantID) => {
      element.item.classList.toggle("is-focused", participantID === focusedParticipantID);
    });
    if (participantFocusStatus) participantFocusStatus.textContent =
      `${item.querySelector(".participant-name")?.textContent || "Participant"} focused.`;
    return;
  }
  if (!item.classList.contains("is-local") || !participants.classList.contains("has-remote")) return;
  const position = pipPositionForKey(item.dataset.pipPosition || "bottom-right", event.key);
  if (!position) return;
  event.preventDefault();
  setPipPosition(item, position);
});

participantPagePrevious?.addEventListener("click", () => setParticipantPage(-1));
participantPageNext?.addEventListener("click", () => setParticipantPage(1));

function showToast(message) {
  if (!toastRegion) return;
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  toastRegion.append(toast);
  setTimeout(() => toast.remove(), 4000);
}

let unreadMessages = 0;
let chatPinnedToBottom = true;
let pushToTalkActive = false;
let chatCloseTimer;

function addChatMessage(author, body, system = false, own = false) {
  if (!chatMessages) return;
  const message = document.createElement("article");
  message.className = `chat-message${system ? " chat-message--system" : ""}${own ? " chat-message--own" : ""}`;
  message.dataset.author = author;
  const previous = chatMessages.lastElementChild;
  if (previous?.dataset.author && previous.dataset.author !== author) {
    message.classList.add("chat-message--new-speaker");
  }
  const meta = document.createElement("div");
  meta.className = "chat-message__meta";
  const authorLabel = document.createElement("span");
  authorLabel.textContent = system ? "System" : author;
  const timestamp = document.createElement("time");
  timestamp.dateTime = new Date().toISOString();
  timestamp.textContent = new Date(timestamp.dateTime).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
  meta.append(authorLabel, timestamp);
  const content = document.createElement("div");
  content.className = "chat-message__body";
  content.textContent = body;
  message.append(meta, content);
  chatMessages.append(message);
  const chatClosed = chatRail?.hidden === true;
  if (!system && chatClosed) {
    unreadMessages += 1;
    if (chatBadge) {
      chatBadge.hidden = false;
      chatBadge.textContent = String(unreadMessages);
    }
  } else if (!chatPinnedToBottom && !chatClosed && newMessages) {
    newMessages.hidden = false;
  }
  if (chatPinnedToBottom && !chatClosed) chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addChatSystem(message) { addChatMessage("System", message, true); }

function sendChatMessage(body) {
  const text = body.trim();
  if (!text) return false;
  if (socket?.readyState !== WebSocket.OPEN || !localParticipantID) {
    addChatSystem("Chat is unavailable while the meeting reconnects.");
    return false;
  }
  socket.send(JSON.stringify({
    version: 1,
    type: "chat_message",
    participant_id: localParticipantID,
    text
  }));
  return true;
}

function setChatOpen(open) {
  if (!chatRail) return;
  clearTimeout(chatCloseTimer);
  if (open) {
    setSidebarOpen(false);
    chatRail.hidden = false;
    meeting.classList.add("has-rail");
    requestAnimationFrame(() => chatRail.classList.add("is-open"));
  } else {
    const restoreFocus = chatRail.contains(document.activeElement);
    chatRail.classList.remove("is-open");
    const closeDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    chatCloseTimer = setTimeout(() => {
      chatRail.hidden = true;
      meeting.classList.toggle("has-rail", meeting.classList.contains("sidebar-open"));
      if (restoreFocus && chatRail.contains(document.activeElement)) chatToggle?.focus();
    }, closeDelay);
  }
  chatToggle?.setAttribute("aria-pressed", String(open));
  if (open) {
    unreadMessages = 0;
    if (chatBadge) chatBadge.hidden = true;
    requestAnimationFrame(() => chatInput?.focus());
  }
}

function autoGrowChat() {
  if (!chatInput) return;
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 96)}px`;
}

chatToggle?.addEventListener("click", () => setChatOpen(chatRail.hidden || !chatRail.classList.contains("is-open")));
closeChat?.addEventListener("click", () => setChatOpen(false));
connection?.addEventListener("click", () => setSidebarOpen(true));
chatMessages?.addEventListener("scroll", () => {
  chatPinnedToBottom = chatMessages.scrollHeight - chatMessages.scrollTop - chatMessages.clientHeight < 24;
  if (chatPinnedToBottom && newMessages) newMessages.hidden = true;
});
newMessages?.addEventListener("click", () => {
  chatMessages.scrollTop = chatMessages.scrollHeight;
  newMessages.hidden = true;
});
chatInput?.addEventListener("input", autoGrowChat);
chatInput?.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    chatForm?.requestSubmit();
  }
});
chatForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const message = chatInput.value.trim();
  if (!message) return;
  if (!sendChatMessage(message)) return;
  addChatMessage(nameInput.value.trim() || "You", message, false, true);
  chatInput.value = "";
  autoGrowChat();
});

audioOnly?.addEventListener("change", () => {
  if (audioOnly.checked) {
    cameraRequested = false;
    const videoStop = screenStream ? stopScreenShare() : setVideoSending(false);
    videoStop.catch(() => {});
    showToast("Video paused to protect audio");
  } else {
    cameraRequested = selectedCameraQuality !== "off";
    setVideoSending(cameraRequested).catch(() => {});
  }
});

pauseAll?.addEventListener("click", () => setReceiveVideo(!receiveVideoEnabled));
document.querySelector("#more")?.addEventListener("click", () => setSidebarOpen(true));
document.querySelector("#participants-button")?.addEventListener("click", () => {
  if (window.matchMedia("(max-width: 900px)").matches) setChatOpen(false);
  const firstVisibleTile = [...participants.querySelectorAll(".participant-tile")]
    .find((item) => !item.hidden);
  (firstVisibleTile || participants)?.focus({ preventScroll: true });
});
document.addEventListener("keydown", (event) => {
  if (meeting.hidden) return;
  const isFormField = event.target.matches("input, textarea, select");
  if (event.key === "Escape") {
    if (!chatRail?.hidden) setChatOpen(false);
    if (meeting.classList.contains("sidebar-open")) {
      setSidebarOpen(false);
      toggleSidebar.focus();
    }
    return;
  }
  if (event.key === "Tab" && meeting.classList.contains("sidebar-open")) {
    const focusable = [...meetingSidebar.querySelectorAll("button, select, input, summary, textarea")].filter((element) => !element.disabled && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    return;
  }
  if (isFormField) return;
  const key = event.key.toLowerCase();
  if (key === "m") mic.click();
  else if (key === "v") camera.click();
  else if (key === "c") chatToggle?.click();
  else if (key === "s") screen.click();
  else if (event.key === " " && !event.repeat && mic.getAttribute("aria-pressed") === "false") {
    event.preventDefault();
    mic.click();
    pushToTalkActive = true;
  } else if ((event.ctrlKey || event.metaKey) && key === "d") {
    event.preventDefault();
    mic.click();
  }
});
document.addEventListener("keyup", (event) => {
  if (event.key === " " && pushToTalkActive) {
    event.preventDefault();
    mic.click();
    pushToTalkActive = false;
  }
});

function mountDebugParticipants() {
  if (new URLSearchParams(window.location.search).get("debug") !== "6" || !localStream) return;
  for (let index = 1; index < 6; index += 1) {
    const id = `debug-${index}`;
    if (participantElements.has(id)) continue;
    addParticipant({ id, name: `Guest ${index}` });
    const element = participantElements.get(id);
    if (!element) continue;
    element.video.srcObject = localStream;
    element.video.autoplay = true;
    element.video.muted = true;
    element.item.dataset.camera = "on";
    element.avatar.hidden = true;
    if (index === 2) element.item.classList.add("is-speaking");
    updateMediaState({ participant_id: id, audio_enabled: index !== 4, video_enabled: true });
  }
  addChatSystem("Debug mode: six local preview tiles mounted");
}

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
let videoSuspendedAutomatically = false;
let cameraRequested = false;
let receiveVideoEnabled = true;
let mediaTestStream;
let audioContext;
let speakerAnimationFrame;
let speakerUpdateTimer;
let lastSpeakerUpdateAt = 0;
const speakerAnalyzers = new Map();
const activeSpeakers = new Set();
const pendingSpeakerStates = new Map();
const speakerThresholdDb = -50;
const speakerStartHoldMs = 200;
const speakerStopHoldMs = 300;
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
const remoteTrackOwners = new Map();
const remoteReceiverOwners = new Map();
const participantQualityLabels = {
  good: "good",
  degraded: "degraded",
  poor: "poor",
  unknown: "unknown"
};
const storedProfile = readStoredValue("meeting.bandwidthProfile");
const cameraQualityPresets = {
  "720p": { width: 1280, height: 720, fps: 30 },
  "480p": { width: 854, height: 480, fps: 24 },
  "360p": { width: 640, height: 360, fps: 15 },
  "240p": { width: 426, height: 240, fps: 15 }
};
const cameraQualityOptions = Object.keys(cameraQualityPresets).concat("off");
const storedCameraQuality = readStoredValue("meeting.cameraQuality");
let selectedCameraQuality = cameraQualityOptions.includes(storedCameraQuality) ? storedCameraQuality : "360p";
const profiles = [
  { name: "very-slow", width: 240, height: 160, fps: 5, bitrate: 90000, audioBitrate: 24000 },
  { name: "slow", width: 360, height: 240, fps: 10, bitrate: 180000, audioBitrate: 32000 },
  { name: "normal", width: 640, height: 360, fps: 15, bitrate: 400000, audioBitrate: 48000 },
  { name: "high", width: 854, height: 480, fps: 24, bitrate: 650000, audioBitrate: 64000 }
];
function cameraConstraintsForQuality(quality) {
  const preset = cameraQualityPresets[quality] || cameraQualityPresets["360p"];
  return {
    width: { ideal: preset.width, max: preset.width },
    height: { ideal: preset.height, max: preset.height },
    frameRate: { ideal: preset.fps, max: preset.fps }
  };
}
let cameraConstraints = cameraConstraintsForQuality(selectedCameraQuality);

function setDeviceResult(element, state, label) {
  element.className = `device-result device-result--${state}`;
  element.textContent = label;
}

function stopDeviceTest() {
  mediaTestStream?.getTracks().forEach((track) => track.stop());
  mediaTestStream = undefined;
  devicePreview.srcObject = null;
  devicePreview.hidden = true;
  stopMediaTest.hidden = true;
  testMedia.disabled = false;
}

async function runDeviceTest() {
  stopDeviceTest();
  setDeviceResult(testCamera, "pending", "Checking camera…");
  setDeviceResult(testMicrophone, "pending", "Checking microphone…");
  deviceTestStatus.textContent = "Requesting temporary access. Nothing is recorded.";
  testMedia.disabled = true;
  stopMediaTest.hidden = false;
  const testStream = new MediaStream();
  mediaTestStream = testStream;
  let cameraReady = false;
  let microphoneReady = false;

  if (!navigator.mediaDevices?.getUserMedia) {
    setDeviceResult(testCamera, "error", "Camera unavailable");
    setDeviceResult(testMicrophone, "error", "Microphone unavailable");
    deviceTestStatus.textContent = "This browser does not support camera and microphone checks.";
    stopMediaTest.hidden = true;
    testMedia.disabled = false;
    return;
  }

  try {
    const videoStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints });
    if (mediaTestStream !== testStream) {
      videoStream.getTracks().forEach((track) => track.stop());
      return;
    }
    videoStream.getTracks().forEach((track) => testStream.addTrack(track));
    cameraReady = videoStream.getVideoTracks().length > 0;
    setDeviceResult(testCamera, cameraReady ? "ready" : "error",
      cameraReady ? "Camera ready" : "Camera unavailable");
  } catch (_) {
    setDeviceResult(testCamera, "error", "Camera unavailable");
  }

  try {
    const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (mediaTestStream !== testStream) {
      audioStream.getTracks().forEach((track) => track.stop());
      return;
    }
    audioStream.getTracks().forEach((track) => testStream.addTrack(track));
    microphoneReady = audioStream.getAudioTracks().length > 0;
    setDeviceResult(testMicrophone, microphoneReady ? "ready" : "error",
      microphoneReady ? "Microphone ready" : "Microphone unavailable");
  } catch (_) {
    setDeviceResult(testMicrophone, "error", "Microphone unavailable");
  }

  if (mediaTestStream !== testStream) {
    testStream.getTracks().forEach((track) => track.stop());
    return;
  }
  devicePreview.srcObject = testStream;
  devicePreview.hidden = !cameraReady;
  deviceTestStatus.textContent = cameraReady && microphoneReady
    ? "Your devices are ready. The test will stop when you join."
    : "Some devices need attention. You can still join and use the available media.";
}

testMedia.addEventListener("click", runDeviceTest);
stopMediaTest.addEventListener("click", () => {
  stopDeviceTest();
  deviceTestStatus.textContent = "Device test stopped.";
});

function setLocalMediaControls() {
  const audioTrack = localStream?.getAudioTracks()[0];
  const videoTrack = localStream?.getVideoTracks()[0];
  const audioAvailable = Boolean(audioTrack);
  const videoAvailable = Boolean(videoTrack);
  const audioOn = audioAvailable && audioTrack.enabled;
  const cameraOn = videoAvailable && cameraRequested && !videoSuspended && !audioOnly?.checked;
  mic.disabled = !audioAvailable;
  camera.disabled = !videoAvailable;
  updateControlLabel(mic, audioOn ? "Mic on" : "Muted");
  mic.setAttribute("aria-pressed", String(audioAvailable && audioTrack.enabled));
  updateControlLabel(camera, cameraOn ? "Camera on" : "Camera off");
  camera.setAttribute("aria-pressed", String(cameraOn));
  if (!audioAvailable) updateControlLabel(mic, "Mic unavailable");
  if (!videoAvailable) updateControlLabel(camera, "Camera unavailable");
  const local = participantElements.get(localParticipantID);
  if (local) {
    local.item.dataset.mic = audioOn ? "on" : "off";
    local.item.dataset.camera = cameraOn ? "on" :
      (videoSuspendedAutomatically ? "paused" : "off");
    updateParticipantVideoVisibility(local);
    local.micIndicator.hidden = audioOn;
    local.micIndicator.classList.toggle("is-on", audioOn);
    local.micIndicator.classList.toggle("is-off", !audioOn);
    updateParticipantAriaLabel(local);
  }
}

function setSidebarOpen(open) {
  if (open && chatRail && !chatRail.hidden) setChatOpen(false);
  meeting.classList.toggle("sidebar-open", open);
  toggleSidebar.setAttribute("aria-expanded", String(open));
  connection.setAttribute("aria-expanded", String(open));
  toggleSidebar.setAttribute("aria-label", open ? "Close meeting settings" : "Open meeting settings");
  toggleSidebarLabel.textContent = open ? "Hide tools" : "Show tools";
  meetingSidebar.setAttribute("aria-hidden", String(!open));
  meeting.classList.toggle("has-rail", open || !chatRail?.hidden);
  sidebarBackdrop.hidden = !open;
  if (open) closeSidebar.focus();
}

toggleSidebar.addEventListener("click", () => setSidebarOpen(!meeting.classList.contains("sidebar-open")));
closeSidebar.addEventListener("click", () => {
  setSidebarOpen(false);
  toggleSidebar.focus();
});
sidebarBackdrop.addEventListener("click", () => {
  setSidebarOpen(false);
  toggleSidebar.focus();
});
function setLocalVideoMirror(enabled) {
  const local = participantElements.get(localParticipantID);
  if (!local) return;
  local.video.classList.toggle("local-camera-preview", enabled);
  local.video.classList.remove("remote-camera-preview");
}

function updateVideoOrientation(participantID) {
  if (!participantID) return;
  const element = participantElements.get(participantID);
  if (!element) return;
  const isScreenShare = participantID === screenShareOwner;
  element.video.classList.toggle(
    "local-camera-preview",
    participantID === localParticipantID && !isScreenShare
  );
  element.video.classList.toggle(
    "remote-camera-preview",
    participantID !== localParticipantID && !isScreenShare
  );
}

function ensureAudioContext() {
  if (!audioContext) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return undefined;
    audioContext = new AudioContextClass();
  }
  audioContext.resume().catch(() => {});
  return audioContext;
}

function remoteParticipantID(streams, track) {
  const streamID = streams?.[0]?.id || "";
  const streamPrefix = "lowmeet-";
  if (streamID.startsWith(streamPrefix)) return streamID.slice(streamPrefix.length);
  return track.id?.split("|")[0] || "";
}

function rememberRemoteTrack(participantID, track, receiver) {
  const element = participantElements.get(participantID);
  if (!element) return;
  if (track?.id) {
    element.trackIDs.add(track.id);
    remoteTrackOwners.set(track.id, participantID);
  }
  if (receiver?.id) remoteReceiverOwners.set(receiver.id, participantID);
}

function forgetRemoteTracks(element, participantID) {
  for (const trackID of element?.trackIDs || []) remoteTrackOwners.delete(trackID);
  for (const [receiverID, owner] of remoteReceiverOwners) {
    if (owner === participantID) remoteReceiverOwners.delete(receiverID);
  }
}

function setParticipantQuality(element, quality) {
  const normalized = participantQualityLabels[quality] ? quality : "unknown";
  const label = participantQualityLabels[normalized];
  element.item.dataset.quality = normalized;
  element.quality.hidden = normalized === "unknown";
  element.quality.setAttribute("aria-label", `${element.name.textContent} connection quality: ${label}`);
  element.quality.title = `Connection quality: ${label}`;
  updateParticipantAriaLabel(element);
}

function participantForInboundStat(stat, trackStatsOwners) {
  for (const key of [stat.trackIdentifier, stat.trackId, stat.receiverId]) {
    if (!key) continue;
    const directOwner = remoteTrackOwners.get(key) || remoteReceiverOwners.get(key);
    if (directOwner) return directOwner;
    const statOwner = trackStatsOwners.get(key);
    if (statOwner) return statOwner;
  }
  return undefined;
}

function classifyParticipantQuality(stats, rttMs) {
  if (!stats || !stats.hasData) return "unknown";
  const loss = stats.totalPackets > 0 ? stats.lostPackets / stats.totalPackets * 100 : null;
  if ((loss != null && loss > 5) || (rttMs != null && rttMs > 300)) return "poor";
  if ((loss != null && loss >= 2) || (rttMs != null && rttMs >= 150)) return "degraded";
  if (loss != null || rttMs != null) return "good";
  return "unknown";
}

function remoteMediaStream(streams, track) {
  if (streams?.[0]) return streams[0];
  const stream = new MediaStream();
  stream.addTrack(track);
  return stream;
}

function applySpeakerState(participantID, speaking) {
  const element = participantElements.get(participantID);
  if (!element) return;
  element.item.classList.toggle("is-speaking", speaking);
  element.item.dataset.speaking = String(speaking);
  if (speaking) activeSpeakers.add(participantID);
  else activeSpeakers.delete(participantID);
}

function flushSpeakerStates() {
  speakerUpdateTimer = undefined;
  lastSpeakerUpdateAt = performance.now();
  for (const [participantID, speaking] of pendingSpeakerStates) {
    applySpeakerState(participantID, speaking);
  }
  pendingSpeakerStates.clear();
}

function setSpeakerState(participantID, speaking, immediate = false) {
  if (immediate) {
    pendingSpeakerStates.delete(participantID);
    applySpeakerState(participantID, speaking);
    return;
  }
  pendingSpeakerStates.set(participantID, speaking);
  const elapsed = performance.now() - lastSpeakerUpdateAt;
  if (elapsed >= 300) {
    flushSpeakerStates();
  } else if (!speakerUpdateTimer) {
    speakerUpdateTimer = setTimeout(flushSpeakerStates, 300 - elapsed);
  }
}

function setParticipantConnectionState(state) {
  participantElements.forEach((element, participantID) => {
    if (participantID === localParticipantID) return;
    const disconnected = state === "disconnected";
    element.item.dataset.connection = state;
    element.item.classList.toggle("is-disconnected", disconnected);
    if (disconnected) {
      setParticipantQuality(element, "poor");
      element.micIndicator.setAttribute("aria-label", `${element.name.textContent} disconnected`);
      updateParticipantAriaLabel(element);
    } else {
      setParticipantQuality(element, "unknown");
      updateMediaState({
        participant_id: participantID,
        audio_enabled: element.item.dataset.mic !== "off",
        video_enabled: element.item.dataset.camera === "on",
        video_paused: element.item.dataset.camera === "paused"
      });
    }
  });
}

function runSpeakerDetection(timestamp) {
  const now = typeof timestamp === "number" ? timestamp : performance.now();
  speakerAnalyzers.forEach((entry, participantID) => {
    entry.analyser.getByteTimeDomainData(entry.data);
    let total = 0;
    for (const value of entry.data) {
      const normalized = (value - 128) / 128;
      total += normalized * normalized;
    }
    const rms = Math.sqrt(total / entry.data.length);
    entry.level = entry.level * 0.78 + rms * 0.22;
    const levelDb = 20 * Math.log10(Math.max(entry.level, 0.000001));
    const aboveThreshold = levelDb > speakerThresholdDb;
    if (aboveThreshold) {
      entry.quietSince = 0;
      if (!entry.speaking && !entry.speakingSince) entry.speakingSince = now;
      if (!entry.speaking && now - entry.speakingSince >= speakerStartHoldMs) {
        entry.speaking = true;
        setSpeakerState(participantID, true);
      }
    } else {
      entry.speakingSince = 0;
      if (entry.speaking && !entry.quietSince) entry.quietSince = now;
      if (entry.speaking && now - entry.quietSince >= speakerStopHoldMs) {
        entry.speaking = false;
        setSpeakerState(participantID, false);
      }
    }
  });
  speakerAnimationFrame = speakerAnalyzers.size > 0
    ? requestAnimationFrame(runSpeakerDetection) : undefined;
}

function attachSpeakerAnalyzer(participantID, source, preserveOutput = false) {
  const context = ensureAudioContext();
  if (!context || !source || speakerAnalyzers.has(participantID)) return;
  try {
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.75;
    const sourceNode = source instanceof MediaStream
      ? context.createMediaStreamSource(source)
      : context.createMediaElementSource(source);
    sourceNode.connect(analyser);
    if (preserveOutput) analyser.connect(context.destination);
    speakerAnalyzers.set(participantID, {
      analyser,
      data: new Uint8Array(analyser.fftSize),
      level: 0,
      speaking: false,
      speakingSince: 0,
      quietSince: 0,
      sourceNode
    });
    if (!speakerAnimationFrame) speakerAnimationFrame = requestAnimationFrame(runSpeakerDetection);
  } catch (_) {
    // Audio analysis is a visual enhancement; media playback must continue if it is unavailable.
  }
}

function removeSpeakerAnalyzer(participantID) {
  const entry = speakerAnalyzers.get(participantID);
  if (!entry) return;
  try {
    entry.sourceNode.disconnect();
    entry.analyser.disconnect();
  } catch (_) {}
  speakerAnalyzers.delete(participantID);
  setSpeakerState(participantID, false, true);
  if (speakerAnalyzers.size === 0 && speakerAnimationFrame) {
    cancelAnimationFrame(speakerAnimationFrame);
    speakerAnimationFrame = undefined;
  }
}

function resetSpeakerDetection() {
  if (speakerAnimationFrame) cancelAnimationFrame(speakerAnimationFrame);
  if (speakerUpdateTimer) clearTimeout(speakerUpdateTimer);
  speakerAnimationFrame = undefined;
  speakerUpdateTimer = undefined;
  lastSpeakerUpdateAt = 0;
  pendingSpeakerStates.clear();
  for (const entry of speakerAnalyzers.values()) {
    try {
      entry.sourceNode.disconnect();
      entry.analyser.disconnect();
    } catch (_) {}
  }
  speakerAnalyzers.clear();
  activeSpeakers.clear();
  participantElements.forEach((element) => {
    element.item.classList.remove("is-speaking");
  });
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = undefined;
  }
}
copyDiagnostics.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(diagnostics.textContent || "");
    diagnosticsStatus.textContent = "Diagnostics copied.";
  } catch (_) {
    diagnosticsStatus.textContent = "Clipboard access is unavailable.";
  }
});
enableAudio.addEventListener("click", async () => {
  audioContext?.resume().catch(() => {});
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
if (cameraQuality) cameraQuality.value = selectedCameraQuality;
form.addEventListener("submit", (event) => {
  event.preventDefault();
  if (joinButton.disabled) return;
  const name = nameInput.value.trim();
  writeStoredValue("meeting.displayName", name);
  stopDeviceTest();
  deviceTestStatus.textContent = "";
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
      const previousScreenShareOwner = screenShareOwner;
      screenShareOwner = message.screen_share_active === true ? message.screen_share_owner : undefined;
      updateVideoOrientation(previousScreenShareOwner);
      updateVideoOrientation(screenShareOwner);
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
    if (message.type === "chat_message") {
      if (message.text) addChatMessage(message.name || "Participant", message.text);
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
      if (message.type === "participant_joined") addChatSystem(`${participant.name} joined the room`);
      if (message.type === "participant") {
        localParticipantID = participant.id;
        markLocalParticipant(participant.id);
        reconnectToken = message.reconnect_token;
        brandBar.hidden = true;
        welcomeGrid.hidden = true;
        form.hidden = true;
        meeting.hidden = false;
        status.textContent = "";
        startWebRTC();
      }
    }
    if (message.type === "participant_left") {
      addChatSystem(`${message.participant.name} left the room`);
      const element = participantElements.get(message.participant.id);
      if (element) {
        remoteAudioElements.delete(element.audio);
        removeSpeakerAnalyzer(message.participant.id);
        forgetRemoteTracks(element, message.participant.id);
        element.item.classList.remove("is-speaking");
        element.item.classList.add("is-disconnected");
        element.item.dataset.connection = "disconnected";
        element.micIndicator.setAttribute("aria-label", `${message.participant.name} disconnected`);
        setTimeout(() => {
          if (participantElements.get(message.participant.id)?.item === element.item) {
            element.item.remove();
            participantElements.delete(message.participant.id);
            updateParticipantCount();
          }
        }, 1200);
      }
    if (message.participant.id === screenShareOwner) {
        screenShareOwner = undefined;
        updateScreenShareUI();
      }
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
  const preserveVideoSuspension = videoSuspended;
  const preserveAutomaticSuspension = videoSuspendedAutomatically;
  resetSpeakerDetection();
  participants.replaceChildren();
  participantElements.clear();
  participantPage = 0;
  focusedParticipantID = undefined;
  updateParticipantPagination();
  remoteAudioElements.clear();
  remoteTrackOwners.clear();
  remoteReceiverOwners.clear();
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
  setLocalMediaControls();
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
  videoSuspended = preserveVideoSuspension || Boolean(audioOnly?.checked);
  videoSuspendedAutomatically = preserveAutomaticSuspension && !audioOnly?.checked;
}

async function startWebRTC() {
  const generation = socketGeneration;
  const currentSocket = socket;
  if (new URLSearchParams(window.location.search).get("debug") === "6" && selectedCameraQuality !== "off") {
    cameraRequested = true;
  }
  await iceConfigReady;
  if (generation !== socketGeneration || socket !== currentSocket) return;
  const currentPeer = new RTCPeerConnection({ iceServers });
  restartRequested = false;
  peer = currentPeer;
  currentPeer.oniceconnectionstatechange = () => {
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    if (currentPeer.iceConnectionState === "connected" || currentPeer.iceConnectionState === "completed") {
      setConnection("good", "Connected");
      setParticipantConnectionState("connected");
    } else if (currentPeer.iceConnectionState === "checking") {
      setConnection("", "Connecting");
    } else if (currentPeer.iceConnectionState === "disconnected") {
      setConnection("fair", "Reconnecting");
      setParticipantConnectionState("disconnected");
    } else if (currentPeer.iceConnectionState === "failed") {
      setConnection("poor", "Poor");
      setParticipantConnectionState("disconnected");
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
  currentPeer.ontrack = ({ streams, track, receiver }) => {
    const participantID = remoteParticipantID(streams, track);
    const element = participantElements.get(participantID);
    if (!element) return;
    rememberRemoteTrack(participantID, track, receiver);
    const stream = remoteMediaStream(streams, track);
    if (track.kind === "video") {
      element.video.srcObject = stream;
      element.video.autoplay = true;
      element.video.playsInline = true;
      updateParticipantVideoVisibility(element);
      updateVideoOrientation(participantID);
      element.video.play().catch(() => {});
    } else {
      element.audio.srcObject = stream;
      element.audio.autoplay = true;
      remoteAudioElements.add(element.audio);
      attachSpeakerAnalyzer(participantID, element.audio, true);
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
    mic.disabled = true;
    camera.disabled = true;
    const abortIfStale = () => {
      if (isCurrentWebRTC(generation, currentPeer, currentSocket)) return false;
      setupStream.getTracks().forEach((track) => track.stop());
      currentPeer.close();
      return true;
    };
    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioStream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        setupStream.addTrack(track);
      });
      if (abortIfStale()) return;
    } catch (_) {
      status.textContent = "Microphone unavailable; continuing without audio.";
    }
    try {
      const videoStream = await navigator.mediaDevices.getUserMedia({ video: cameraConstraints });
      videoStream.getVideoTracks().forEach((track) => {
        track.enabled = cameraRequested && !videoSuspended && !audioOnly?.checked;
        setupStream.addTrack(track);
      });
      if (abortIfStale()) return;
    } catch (_) {
      cameraRequested = false;
      status.textContent = "Camera unavailable; continuing audio-only.";
    }
    if (abortIfStale()) return;
    if (setupStream.getTracks().length === 0) throw new Error("No microphone or camera is available");
    localStream = setupStream;
    cameraTrack = setupStream.getVideoTracks()[0];
    setLocalMediaControls();
    attachSpeakerAnalyzer(localParticipantID, localStream);
    const local = participantElements.get(localParticipantID);
    if (local) {
      local.video.srcObject = localStream;
      local.video.autoplay = true;
      local.video.muted = true;
    }
    mountDebugParticipants();
    setLocalVideoMirror(true);
    sendMediaState();
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    for (const track of localStream.getTracks()) currentPeer.addTrack(track, localStream);
    await setVideoSending(!videoSuspended, videoSuspendedAutomatically);
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    await applyProfile(profile.value, currentPeer, localStream);
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    clearInterval(statsTimer);
    previousStats = undefined;
    statsTimer = setInterval(updateDiagnostics, 1000);
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
  connection.className = `network-chip connection ${level}`;
  connection.setAttribute("aria-label", `Network status: ${label}`);
  if (networkLabel) networkLabel.textContent = label;
  if (connectionMessage) connectionMessage.textContent = label;
}

async function updateDiagnostics() {
  const currentPeer = peer;
  if (!currentPeer) return;
  const report = await currentPeer.getStats().catch(() => undefined);
  if (!report || peer !== currentPeer) return;
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
    ice: currentPeer.iceConnectionState,
    iceCandidateType: null,
    iceTransport: null,
    connection: currentPeer.connectionState
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
  const trackStatsOwners = new Map();
  const participantStats = new Map();
  let selectedCandidatePair;
  report.forEach((stat) => {
    if (stat.type === "codec" && stat.id && stat.mimeType) {
      codecById.set(stat.id, stat.mimeType);
    }
    if ((stat.type === "local-candidate" || stat.type === "remote-candidate") && stat.id) {
      candidatesById.set(stat.id, stat);
    }
    if (stat.type === "track" && stat.id) {
      const owner = remoteTrackOwners.get(stat.trackIdentifier) ||
        remoteReceiverOwners.get(stat.receiverId);
      if (owner) trackStatsOwners.set(stat.id, owner);
    }
  });
  report.forEach((stat) => {
    timestamp = Math.max(timestamp, stat.timestamp || 0);
    if (stat.type === "candidate-pair" && stat.state === "succeeded") {
      if (stat.nominated || stat.selected || !selectedCandidatePair) {
        selectedCandidatePair = stat;
        values.rttMs = stat.currentRoundTripTime == null ? null : Math.round(stat.currentRoundTripTime * 1000);
      }
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
      const participantID = participantForInboundStat(stat, trackStatsOwners);
      if (participantID) {
        const stats = participantStats.get(participantID) || {
          hasData: false, lostPackets: 0, receivedPackets: 0, totalPackets: 0
        };
        stats.hasData = true;
        stats.lostPackets += Math.max(0, Number(stat.packetsLost) || 0);
        stats.receivedPackets += Math.max(0, Number(stat.packetsReceived) || 0);
        stats.totalPackets = stats.lostPackets + stats.receivedPackets;
        participantStats.set(participantID, stats);
      }
    }
    if (stat.type === "inbound-rtp" && stat.kind === "audio") {
      receivedAudioBytes += stat.bytesReceived || 0;
      if (stat.jitter != null && values.jitterMs == null) values.jitterMs = Math.round(stat.jitter * 1000);
      totalLost += stat.packetsLost || 0;
      totalReceived += stat.packetsReceived || 0;
      const participantID = participantForInboundStat(stat, trackStatsOwners);
      if (participantID) {
        const stats = participantStats.get(participantID) || {
          hasData: false, lostPackets: 0, receivedPackets: 0, totalPackets: 0
        };
        stats.hasData = true;
        stats.lostPackets += Math.max(0, Number(stat.packetsLost) || 0);
        stats.receivedPackets += Math.max(0, Number(stat.packetsReceived) || 0);
        stats.totalPackets = stats.lostPackets + stats.receivedPackets;
        participantStats.set(participantID, stats);
      }
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
  else setConnection("good", "Good");
  if (statRTT) statRTT.textContent = values.rttMs == null ? "—" : `${values.rttMs} ms`;
  if (statJitter) statJitter.textContent = values.jitterMs == null ? "—" : `${values.jitterMs} ms`;
  if (statLoss) statLoss.textContent = `${values.packetLoss.toFixed(1)}%`;
  if (statBitrate) statBitrate.textContent = `${values.inboundKbps ?? 0} / ${values.outboundKbps} kbps`;
  if (statResolution) statResolution.textContent = values.resolution || "—";
  participantElements.forEach((element, id) => {
    if (id === localParticipantID) {
      const localStats = {
        hasData: totalLost + totalReceived > 0 || values.rttMs != null,
        lostPackets: totalLost,
        receivedPackets: totalReceived,
        totalPackets: totalLost + totalReceived
      };
      setParticipantQuality(element, classifyParticipantQuality(localStats, values.rttMs));
      return;
    }
    const remoteStats = participantStats.get(id) || {
      hasData: values.rttMs != null,
      lostPackets: 0,
      receivedPackets: 0,
      totalPackets: 0
    };
    setParticipantQuality(element, classifyParticipantQuality(remoteStats, values.rttMs));
  });
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
    if (!videoSuspended) {
      await setVideoSending(false, true);
      addChatSystem("Auto quality dropped to audio only");
      showToast("Your video paused to protect audio");
    }
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
  const capturePreset = targetStream === screenStream ? undefined : cameraQualityPresets[selectedCameraQuality];
  const bitrate = Math.min(requested.bitrate, hostLimits.maxVideoBitrate);
  const fps = Math.min(requested.fps, hostLimits.maxVideoFPS, capturePreset?.fps || requested.fps);
  const width = capturePreset ? Math.min(requested.width, capturePreset.width) : requested.width;
  const height = capturePreset ? Math.min(requested.height, capturePreset.height) : requested.height;
  const audioBitrate = Math.min(requested.audioBitrate, hostLimits.maxAudioBitrate);
  if (effectiveProfile) {
    effectiveProfile.textContent =
      `Requested: ${selected?.name || "unknown"}; effective: ${requested.name} ` +
      `${Math.round(width)}x${Math.round(height)} / ` +
      `${fps} FPS / ${Math.round(bitrate / 1000)} kbps video / ${Math.round(audioBitrate / 1000)} kbps audio`;
  }
  const videoTrack = targetStream?.getVideoTracks()[0];
  if (videoTrack && capturePreset) {
    await videoTrack.applyConstraints({
      width: { ideal: width, max: width },
      height: { ideal: height, max: height },
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

cameraQuality?.addEventListener("change", async () => {
  const value = cameraQualityOptions.includes(cameraQuality.value) ? cameraQuality.value : "360p";
  selectedCameraQuality = value;
  cameraConstraints = cameraConstraintsForQuality(value);
  writeStoredValue("meeting.cameraQuality", value);
  cameraRequested = value !== "off" && !audioOnly?.checked;
  if (!screenStream) {
    await setVideoSending(cameraRequested);
  }
  await applyProfile(profile.value, peer, screenStream || localStream);
  showToast(value === "off" ? "Camera turned off" : `Camera quality set to ${value}`);
});

function addParticipant(participant) {
  if (participantElements.has(participant.id)) return;
  const item = document.createElement("li");
  item.className = "participant-tile";
  item.tabIndex = 0;
  item.setAttribute("role", "group");
  if (participant.id === localParticipantID) item.classList.add("is-local");
  item.dataset.participantId = participant.id;
  item.dataset.connection = "connected";
  item.dataset.sharing = "false";
  item.dataset.camera = "off";
  item.dataset.quality = "unknown";
  const avatarSeed = hashName(participant.name);
  item.style.setProperty("--avatar-angle", `${120 + avatarSeed % 121}deg`);
  const avatar = document.createElement("span");
  avatar.className = "participant-avatar";
  avatar.textContent = initialsFor(participant.name);
  avatar.setAttribute("aria-hidden", "true");
  const name = document.createElement("strong");
  name.className = "participant-name";
  name.textContent = participant.name;
  const meta = document.createElement("div");
  meta.className = "participant-meta";
  const videoStage = document.createElement("div");
  videoStage.className = "participant-video";
  const pausedChip = document.createElement("span");
  pausedChip.className = "participant-video-paused";
  pausedChip.hidden = true;
  pausedChip.setAttribute("role", "status");
  pausedChip.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M9 8v8M15 8v8"/></svg><span>Low bandwidth</span>';
  const quality = document.createElement("span");
  quality.className = "participant-quality";
  quality.hidden = true;
  quality.setAttribute("role", "img");
  quality.setAttribute("aria-label", `${participant.name} connection quality: unknown`);
  quality.title = "Connection quality: unknown";
  const video = document.createElement("video");
  const audio = document.createElement("audio");
  const micIndicator = document.createElement("span");
  micIndicator.className = "participant-mic is-off";
  micIndicator.hidden = true;
  micIndicator.setAttribute("role", "img");
  micIndicator.setAttribute("aria-label", `${participant.name}: microphone status unknown`);
  micIndicator.title = "Microphone status unknown";
  micIndicator.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>';
  video.playsInline = true;
  video.hidden = true;
  videoStage.append(avatar, video, pausedChip, quality);
  meta.append(name, micIndicator);
  item.append(videoStage, meta, audio);
  participants.append(item);
  participantElements.set(participant.id, {
    item, name, video, audio, micIndicator, avatar, pausedChip, quality, trackIDs: new Set()
  });
  item.dataset.mic = "unknown";
  setParticipantQuality(participantElements.get(participant.id), "unknown");
  updateParticipantAriaLabel(participantElements.get(participant.id));
  updateParticipantCount();
  updateScreenShareUI();
}

function updateMediaState(message) {
  const element = participantElements.get(message.participant_id);
  if (!element) return;
  const audioOn = message.audio_enabled !== false;
  const videoOn = message.video_enabled !== false;
  const videoPaused = !videoOn && message.video_paused === true;
  element.item.dataset.mic = audioOn ? "on" : "off";
  element.item.dataset.camera = videoOn ? "on" : (videoPaused ? "paused" : "off");
  updateParticipantVideoVisibility(element);
  element.pausedChip.hidden = !videoPaused;
  element.micIndicator.hidden = audioOn;
  element.micIndicator.classList.toggle("is-on", audioOn);
  element.micIndicator.classList.toggle("is-off", !audioOn);
  element.micIndicator.innerHTML = audioOn
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="3" width="8" height="12" rx="4"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6M4 4l16 16"/></svg>';
  const cameraStatus = videoPaused ? "paused for low bandwidth" : (videoOn ? "on" : "off");
  element.micIndicator.setAttribute("aria-label",
    `${element.name.textContent}: microphone ${audioOn ? "on" : "off"}; camera ${cameraStatus}`);
  element.micIndicator.title = `Microphone ${audioOn ? "on" : "off"} · Camera ${cameraStatus}`;
  updateParticipantAriaLabel(element);
}

function sendMediaState() {
  const audioEnabled = localStream?.getAudioTracks()[0]?.enabled === true;
  const videoTrack = screenStream?.getVideoTracks()[0] || localStream?.getVideoTracks()[0];
  const videoEnabled = !audioOnly?.checked && videoTrack?.enabled === true &&
    (Boolean(screenStream) || (cameraRequested && !videoSuspended));
  const videoPaused = !audioOnly?.checked && videoSuspendedAutomatically;
  const message = {
    version: 1, type: "media_state", participant_id: localParticipantID,
    audio_enabled: audioEnabled, video_enabled: videoEnabled, video_paused: videoPaused
  };
  updateMediaState(message);
  if (socket?.readyState === WebSocket.OPEN && localParticipantID) {
    socket.send(JSON.stringify(message));
  }
}

async function setVideoSending(enabled, automatic = false) {
  const sendingEnabled = enabled && !audioOnly?.checked;
  videoSuspended = !sendingEnabled;
  videoSuspendedAutomatically = !sendingEnabled && automatic && !audioOnly?.checked;
  for (const sender of peer?.getSenders() || []) {
    if (sender.track?.kind !== "video") continue;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].active = sendingEnabled && cameraRequested;
    await sender.setParameters(parameters).catch(() => {});
  }
  const track = localStream?.getVideoTracks()[0];
  if (track) track.enabled = sendingEnabled && cameraRequested;
  setLocalMediaControls();
  if (!sendingEnabled && automatic) setConnection("poor", "Audio only");
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
  updateControlLabel(receiveVideo, enabled ? "Pause all" : "Resume all");
  if (pauseAll) {
    const pauseLabel = pauseAll.querySelector("span");
    if (pauseLabel) pauseLabel.textContent = enabled ? "Pause remote video" : "Resume remote video";
  }
  receiveVideo.setAttribute("aria-pressed", String(enabled));
  for (const [participantID, element] of participantElements) {
    if (participantID !== localParticipantID) updateParticipantVideoVisibility(element);
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
  participantElements.forEach((element, participantID) => {
    element.item.dataset.sharing = String(participantID === screenShareOwner);
  });
  updateParticipantPagination();
  if (participants) {
    participants.dataset.sharingOwner = String(Boolean(screenShareOwner));
    participants.dataset.sharingLocal = String(screenShareOwner === localParticipantID);
  }
  const ownedByOther = Boolean(screenShareOwner && screenShareOwner !== localParticipantID);
  screen.disabled = !screenShareEnabled || ownedByOther || Boolean(audioOnly?.checked);
  screen.setAttribute("aria-pressed", String(Boolean(screenStream)));
  if (ownedByOther) {
    updateControlLabel(screen, "In use");
  } else if (screenStream) {
    updateControlLabel(screen, "Stop sharing");
  } else {
    updateControlLabel(screen, "Share screen");
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
  if (screen.disabled || audioOnly?.checked || !peer || (screenShareOwner && screenShareOwner !== localParticipantID)) return;
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
    setLocalVideoMirror(false);
    sendMediaState();
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
  const wasAutomaticallySuspended = videoSuspended && videoSuspendedAutomatically;
  const sender = peer?.getSenders().find((item) => item.track?.kind === "video");
  if (sender && cameraTrack) await sender.replaceTrack(cameraTrack).catch(() => {});
  await setVideoSending(!videoSuspended, wasAutomaticallySuspended).catch(() => {});
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
  setLocalVideoMirror(true);
  sendMediaState();
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
  audioContext?.resume().catch(() => {});
  const track = localStream?.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  setLocalMediaControls();
  sendMediaState();
});

camera.addEventListener("click", () => {
  audioContext?.resume().catch(() => {});
  const track = localStream?.getVideoTracks()[0];
  if (!track) return;
  if (audioOnly?.checked) {
    showToast("Turn off Audio only before enabling the camera");
    return;
  }
  if (!cameraRequested && selectedCameraQuality === "off") {
    cameraQuality?.focus();
    showToast("Choose a camera quality before turning the camera on");
    return;
  }
  cameraRequested = !cameraRequested;
  setVideoSending(cameraRequested).catch(() => {});
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
  resetSpeakerDetection();
  localStream = undefined;
  screenStream = undefined;
  cameraTrack = undefined;
  peer = undefined;
  videoTransceiver = undefined;
  localParticipantID = undefined;
  remoteDescriptionSet = false;
  criticalSamples = 0;
  videoSuspended = false;
  videoSuspendedAutomatically = false;
  cameraRequested = false;
  remoteTrackOwners.clear();
  remoteReceiverOwners.clear();
  previousStats = undefined;
  criticalSamples = 0;
  recoverySamples = 0;
  adaptationLevel = 2;
  poorSamples = 0;
  goodSamples = 0;
  participantPage = 0;
  focusedParticipantID = undefined;
  profile.value = "auto";
  pendingCandidates.splice(0);
  mic.textContent = "Unmute";
  mic.setAttribute("aria-pressed", "false");
  camera.textContent = "Turn camera on";
  camera.setAttribute("aria-pressed", "false");
  mic.disabled = false;
  camera.disabled = false;
  receiveVideoEnabled = true;
  updateControlLabel(receiveVideo, "Pause all");
  receiveVideo.setAttribute("aria-pressed", "true");
  updateControlLabel(screen, "Share screen");
  screen.setAttribute("aria-pressed", "false");
  screenShareOwner = undefined;
  screenShareEnabled = true;
  updateScreenShareUI();
  setSidebarOpen(false);
  setConnection("", "Connecting");
  diagnostics.textContent = "Waiting for media statistics…";
  participantElements.clear();
  participants.replaceChildren();
  updateParticipantPagination();
  brandBar.hidden = false;
  welcomeGrid.hidden = false;
  meeting.hidden = true;
  form.hidden = false;
  joinButton.disabled = false;
});
