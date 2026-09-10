const form = document.querySelector("#join-form");
const nameInput = document.querySelector("#name");
const passwordInput = document.querySelector("#password");
const joinButton = document.querySelector("#join");
const status = document.querySelector("#status");
const brandBar = document.querySelector(".brand-bar");
const welcomeGrid = document.querySelector(".welcome-grid");
const meeting = document.querySelector("#meeting");
const meetingEnded = document.querySelector("#meeting-ended");
const rejoin = document.querySelector("#rejoin");
const participants = document.querySelector("#participants");
const stagePanel = document.querySelector(".stage-panel");
const meetingLayoutHost = document.querySelector("#meeting-layout-host");
const pinnedLayout = document.querySelector("#pinned-layout");
const pinnedMain = document.querySelector("#pinned-main");
const pinnedFilmstrip = document.querySelector("#pinned-filmstrip");
const screenShareLayout = document.querySelector("#screen-share-layout");
const screenShareMain = document.querySelector("#screen-share-main");
const screenShareFilmstrip = document.querySelector("#screen-share-filmstrip");
const layoutParking = document.querySelector("#layout-parking");
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
const settingsMic = document.querySelector("#settings-mic");
const settingsCamera = document.querySelector("#settings-camera");
const settingsSpeaker = document.querySelector("#settings-speaker");
const settingsPreview = document.querySelector("#settings-preview");
const micLevelMeter = document.querySelector("#mic-level-meter");
const peopleList = document.querySelector("#people-list");
const peopleCount = document.querySelector("#people-count");
const selfView = document.querySelector("#self-view");
const connectionSummary = document.querySelector("#connection-summary");
const connectionSummaryTitle = document.querySelector("#connection-summary-title");
const connectionSummaryCopy = document.querySelector("#connection-summary-copy");
const connectionPreference = document.querySelector("#connection-preference");
const connectionPopover = document.querySelector("#connection-popover");
const closeConnectionPopover = document.querySelector("#close-connection-popover");
const connectionPopoverTitle = document.querySelector("#connection-popover-title");
const connectionPopoverCopy = document.querySelector("#connection-popover-copy");
const connectionPopoverEmpty = document.querySelector("#connection-popover-empty");
const connectionPopoverControls = document.querySelector("#connection-popover-controls");
const meetingAlert = document.querySelector("#meeting-alert");
const testMedia = document.querySelector("#test-media");
const devicePreview = document.querySelector("#device-preview");
const testCamera = document.querySelector("#test-camera");
const testMicrophone = document.querySelector("#test-microphone");
const stopMediaTest = document.querySelector("#stop-media-test");
const deviceTestStatus = document.querySelector("#device-test-status");
const chatToggle = document.querySelector("#chat");
const participantsButton = document.querySelector("#participants-button");
const mobileChat = document.querySelector("#mobile-chat");
const mobilePeople = document.querySelector("#mobile-people");
const chatRail = document.querySelector("#chat-rail");
const closeChat = document.querySelector("#close-chat");
const chatMessages = document.querySelector("#chat-messages");
const chatForm = document.querySelector("#chat-form");
const chatInput = document.querySelector("#chat-input");
const chatBadge = document.querySelector("#chat-badge");
const newMessages = document.querySelector("#new-messages");
const participantCount = document.querySelector("#participant-count");
const participantCountBadge = document.querySelector("#participant-count-badge");
const audioOnly = document.querySelector("#audio-only");
const toastRegion = document.querySelector("#toast-region");
const connectionMessage = document.querySelector("#connection-message");
const participantPagination = document.querySelector("#participant-pagination");
const participantPagePrevious = document.querySelector("#participant-page-previous");
const participantPageNext = document.querySelector("#participant-page-next");
const participantPageStatus = document.querySelector("#participant-page-status");
const participantFocusStatus = document.querySelector("#participant-focus-status");
const participantMenu = document.querySelector("#participant-menu");
const participantMenuPin = document.querySelector("#participant-menu-pin");
const participantMenuSelfView = document.querySelector("#participant-menu-self-view");
const networkLabel = document.querySelector("[data-network-label]");
const statRTT = document.querySelector("#stat-rtt");
const statJitter = document.querySelector("#stat-jitter");
const statLoss = document.querySelector("#stat-loss");
const statBitrate = document.querySelector("#stat-bitrate");
const statResolution = document.querySelector("#stat-resolution");
const more = document.querySelector("#more");
const moreStateBadge = document.querySelector("#more-state-badge");

function updateControlLabel(button, label) {
  if (!button) return;
  button.setAttribute("aria-label", label);
  button.setAttribute("title", label);
}

function mediaAccessMessage(kind, error) {
  const denied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
  if (kind === "audio") {
    return denied
      ? "Microphone access was denied. Check your browser permissions or join muted."
      : "Microphone unavailable; continuing without audio.";
  }
  return denied
    ? "Camera access was denied. You can still join without video."
    : "Camera unavailable; continuing audio-only.";
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
let pinnedParticipantID;
let participantMenuOwner;
let layoutFrame;
let preferredLayoutColumns = 0;
let participantResizeObserver;
const meetingViewState = {
  openPanel: "none",
  pinnedParticipantId: null,
  activeSpeakerId: null,
  showSelfView: true,
  cameraEnabled: false,
  incomingVideoEnabled: true,
  activeScreenShareId: null
};
const participantOrder = [];

function currentMeetingLayoutMode() {
  return typeof deriveMeetingLayoutMode === "function"
    ? deriveMeetingLayoutMode(meetingViewState)
    : (meetingViewState.activeScreenShareId ? "screen-share" : meetingViewState.pinnedParticipantId ? "pinned" : "grid");
}

function renderMeetingLayout() {
  if (!meetingLayoutHost) return;
  const mode = currentMeetingLayoutMode();
  meetingLayoutHost.dataset.layoutMode = mode;
  participants.hidden = mode !== "grid";
  pinnedLayout.hidden = mode !== "pinned";
  screenShareLayout.hidden = mode !== "screen-share";
  const visible = participantOrder
    .map((id) => participantElements.get(id))
    .filter((element) => element && !element.item.hidden &&
      (meetingViewState.showSelfView || !element.item.classList.contains("is-local")));
  const excluded = participantOrder
    .map((id) => participantElements.get(id))
    .filter((element) => element && !visible.includes(element));
  const append = (container, element, className = "") => {
    if (!container || !element) return;
    element.item.classList.toggle("is-layout-main", className === "main");
    element.item.classList.toggle("is-screen-main", className === "screen-main");
    container.append(element.item);
    updateParticipantVideoVisibility(element);
  };
  if (mode === "grid") {
    visible.forEach((element) => append(participants, element));
  } else if (mode === "pinned") {
    const pinned = participantElements.get(meetingViewState.pinnedParticipantId);
    append(pinnedMain, pinned, "main");
    visible.filter((element) => element !== pinned).forEach((element) => append(pinnedFilmstrip, element));
  } else {
    const owner = participantElements.get(meetingViewState.activeScreenShareId);
    const pinned = participantElements.get(meetingViewState.pinnedParticipantId);
    append(screenShareMain, pinned || owner, pinned ? "main" : "screen-main");
    visible.filter((element) => element !== pinned && element !== owner).forEach((element) => append(screenShareFilmstrip, element));
    if (owner && owner !== pinned) append(screenShareFilmstrip, owner);
  }
  excluded.forEach((element) => append(layoutParking, element));
  positionParticipantMenu();
  requestParticipantLayout();
}

function requestParticipantLayout() {
  if (layoutFrame || typeof requestAnimationFrame !== "function") return;
  layoutFrame = requestAnimationFrame(() => {
    layoutFrame = undefined;
    updateParticipantLayout();
  });
}

function updateParticipantLayout() {
  if (!participants) return;
  const mode = currentMeetingLayoutMode();
  const layoutContainer = mode === "grid" ? participants : mode === "pinned" ? pinnedMain : screenShareMain;
  if (!layoutContainer || layoutContainer.hidden) return;
  const visibleItems = [...layoutContainer.querySelectorAll(":scope > .participant-tile")].filter((item) => !item.hidden);
  if (visibleItems.length === 0) {
    participants.style.removeProperty("--tile-width");
    participants.style.removeProperty("--tile-height");
    return;
  }
  const bounds = layoutContainer.getBoundingClientRect();
  if (bounds.width <= 0 || bounds.height <= 0 || typeof chooseParticipantLayout !== "function") return;
  const computed = getComputedStyle(participants);
  const gap = parseFloat(computed.columnGap) || 12;
  const layout = chooseParticipantLayout({
    width: bounds.width,
    height: bounds.height,
    count: visibleItems.length,
    gap,
    preferredColumns: preferredLayoutColumns,
    minTileWidth: Math.min(180, Math.max(132, bounds.width / 2.6)),
    minTileHeight: 82
  });
  preferredLayoutColumns = layout.columns;
  layoutContainer.style.setProperty("--tile-width", `${Math.floor(layout.tileWidth)}px`);
  layoutContainer.style.setProperty("--tile-height", `${Math.floor(layout.tileHeight)}px`);
  participants.dataset.columns = String(layout.columns);
  participants.dataset.rows = String(layout.rows);
  positionParticipantMenu();
}

if (typeof ResizeObserver !== "undefined" && stagePanel) {
  participantResizeObserver = new ResizeObserver(requestParticipantLayout);
  participantResizeObserver.observe(stagePanel);
}

function remoteParticipantCount() {
  let count = 0;
  participantElements.forEach((_, participantID) => {
    if (participantID !== localParticipantID) count += 1;
  });
  return count;
}

function participantCameraLabel(element) {
  if (!element?.item) return "unknown";
  const cameraState = element.item.dataset.camera || "unknown";
  if (cameraState === "on" && !element.item.classList.contains("is-local") && !receiveVideoEnabled) {
    return "incoming video off";
  }
  if (cameraState === "paused") return "video paused";
  return cameraState;
}

function updateParticipantTileState(element) {
  if (!element?.state) return;
  const cameraState = element.item.dataset.camera || "unknown";
  const connectionState = element.item.dataset.connection || "connected";
  let label = "";
  if (connectionState === "left") label = "Participant left";
  else if (connectionState === "disconnected") label = "Reconnecting…";
  else if (cameraState === "paused") label = "Video paused to protect audio";
  else if (cameraState === "on" && !element.item.classList.contains("is-local") && !receiveVideoEnabled) {
    label = "Incoming video off for you";
  } else if (cameraState === "off") {
    label = "Camera off";
  } else if (cameraState === "unknown") {
    label = "Connecting…";
  }
  element.state.textContent = label;
  element.state.hidden = !label;
}

function renderPeopleList() {
  if (!peopleList) return;
  peopleList.replaceChildren();
  participantElements.forEach((element, participantID) => {
    const row = document.createElement("li");
    row.className = "people-list__item";
    const name = document.createElement("span");
    name.className = "people-list__name";
    name.textContent = element.name.textContent;
    if (participantID === localParticipantID) {
      const you = document.createElement("small");
      you.textContent = "You";
      name.append(" ", you);
    }
    const state = document.createElement("span");
    state.className = "people-list__state";
    const cameraState = participantCameraLabel(element);
    state.textContent = element.item.dataset.connection === "left" ? "Left" :
      element.item.dataset.connection === "disconnected" ? "Reconnecting" :
        element.item.dataset.mic === "off" ? "Muted" :
          cameraState === "incoming video off" ? "Incoming video off" :
            cameraState === "video paused" ? "Video paused" :
              cameraState === "off" ? "Camera off" :
                cameraState === "unknown" ? "Connecting" : "Connected";
    row.append(name, state);
    peopleList.append(row);
  });
  if (peopleCount) peopleCount.textContent = String(participantElements.size);
}

function updateParticipantCount() {
  const count = participantElements.size;
  updateParticipantPagination();
  if (participantCount) participantCount.textContent = `${count} participant${count === 1 ? "" : "s"}`;
  if (participantCountBadge) participantCountBadge.textContent = String(count);
  renderPeopleList();
}

function updateParticipantAriaLabel(element) {
  if (!element?.item) return;
  const cameraState = participantCameraLabel(element);
  const microphoneState = element.item.dataset.mic || "unknown";
  const qualityState = participantQualityLabels[element.item.dataset.quality] || "unknown";
  const pinnedState = element.item.classList.contains("is-pinned") ? " Pinned." : "";
  const localState = element.item.classList.contains("is-local") ? " (You)" : "";
  const selfView = element.item.classList.contains("is-local") && participants.classList.contains("is-pip-mode")
    ? " Self-view. Use arrow keys to move it between corners."
    : "";
  element.item.setAttribute("aria-label",
    `${element.name.textContent}${localState}: camera ${cameraState}; microphone ${microphoneState}; ` +
    `connection quality ${qualityState}.${pinnedState}${selfView}`);
}

function updateParticipantVideoVisibility(element) {
  if (!element?.item) return;
  const videoOn = element.item.dataset.camera === "on";
  const isLocal = element.item.classList.contains("is-local");
  const hasCameraTrack = Boolean(element.cameraVideo?.srcObject?.getVideoTracks?.()
    .some((track) => track.readyState !== "ended"));
  const visible = videoOn && hasCameraTrack && (isLocal || receiveVideoEnabled);
  const hasScreen = Boolean(element.screenVideo?.srcObject) && element.item.dataset.sharing === "true";
  const screenMain = element.item.classList.contains("is-screen-main");
  element.item.dataset.receiveVideo = String(visible);
  element.avatar.hidden = visible || hasScreen;
  element.cameraVideo.hidden = !visible || screenMain;
  element.screenVideo.hidden = !hasScreen;
  if (visible && !screenMain) element.cameraVideo.play().catch(() => {});
  else element.cameraVideo.pause();
  if (hasScreen) element.screenVideo.play().catch(() => {});
  else element.screenVideo.pause();
  updateParticipantTileState(element);
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
  if (pinnedParticipantID && pinnedParticipantID !== localParticipantID && remoteEntries.length > participantPageSize) {
    const pinnedIndex = remoteEntries.findIndex(([participantID]) => participantID === pinnedParticipantID);
    if (pinnedIndex >= 0 && Math.floor(pinnedIndex / participantPageSize) !== participantPage) {
      participantPage = Math.floor(pinnedIndex / participantPageSize);
    }
  }
  participantPage = Math.min(Math.max(participantPage, 0), pageCount - 1);
  const first = participantPage * participantPageSize;
  const visibleEntries = remoteEntries.slice(first, first + participantPageSize);
  const visibleRemoteIDs = new Set(visibleEntries.map(([participantID]) => participantID));
  participantElements.forEach((element, participantID) => {
    const localVisible = participantID === localParticipantID && selfViewVisible;
    const visible = localVisible || (participantID !== localParticipantID &&
      (remoteEntries.length === 0 || visibleRemoteIDs.has(participantID)));
    element.item.hidden = !visible;
    if (!visible && participantID === focusedParticipantID) {
      element.item.classList.remove("is-focused");
      focusedParticipantID = undefined;
    }
    updateParticipantAriaLabel(element);
  });
  const visibleCount = [...participantElements.values()].filter((element) => !element.item.hidden).length;
  participants.dataset.count = String(visibleCount);
  participants.dataset.remoteCount = String(visibleEntries.length);
  participants.classList.toggle("has-remote", remoteEntries.length > 0);
  const pinnedIsVisible = pinnedParticipantID && participantElements.get(pinnedParticipantID) &&
    !participantElements.get(pinnedParticipantID).item.hidden;
  participants.classList.toggle("has-pinned", Boolean(pinnedIsVisible));
  participants.dataset.pinned = pinnedIsVisible ? "true" : "false";
  if (participantMenuOwner?.item.hidden) closeParticipantMenu(false);
  const paginated = remoteEntries.length > participantPageSize;
  if (participantPagination) participantPagination.hidden = !paginated;
  if (participantPageStatus) {
    participantPageStatus.textContent = paginated
      ? `Page ${participantPage + 1} of ${pageCount}; showing ${visibleEntries.length} participants`
      : "";
  }
  if (participantPagePrevious) participantPagePrevious.disabled = !paginated || participantPage === 0;
  if (participantPageNext) participantPageNext.disabled = !paginated || participantPage >= pageCount - 1;
  requestParticipantLayout();
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
  if (element.youBadge) element.youBadge.hidden = false;
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

function closeParticipantMenu(restoreFocus = true) {
  if (!participantMenu) return;
  const owner = participantMenuOwner;
  participantMenu.hidden = true;
  participantMenuOwner = undefined;
  if (!owner?.trigger) return;
  owner.trigger.setAttribute("aria-expanded", "false");
  if (!restoreFocus) return;
  if (owner.trigger.isConnected && !owner.item.hidden) owner.trigger.focus();
  else if (owner.participantID === localParticipantID) toggleSidebar?.focus();
}

function positionParticipantMenu() {
  if (!participantMenu || participantMenu.hidden || !participantMenuOwner?.trigger || !stagePanel) return;
  const stageBounds = stagePanel.getBoundingClientRect();
  const triggerBounds = participantMenuOwner.trigger.getBoundingClientRect();
  if (stageBounds.width <= 0 || stageBounds.height <= 0) return;
  const padding = 8;
  const menuWidth = participantMenu.offsetWidth;
  const menuHeight = participantMenu.offsetHeight;
  const triggerLeft = triggerBounds.left - stageBounds.left;
  const triggerTop = triggerBounds.top - stageBounds.top;
  let left = triggerLeft + triggerBounds.width - menuWidth;
  let top = triggerTop + triggerBounds.height + 6;
  if (top + menuHeight > stageBounds.height - padding) {
    top = triggerTop - menuHeight - 6;
  }
  left = Math.max(padding, Math.min(left, stageBounds.width - menuWidth - padding));
  top = Math.max(padding, Math.min(top, stageBounds.height - menuHeight - padding));
  participantMenu.style.insetInlineStart = `${left}px`;
  participantMenu.style.insetBlockStart = `${top}px`;
}

function setPinnedParticipant(participantID) {
  const nextID = participantID && participantElements.has(participantID) &&
    (participantID !== localParticipantID || selfViewVisible) ? participantID : undefined;
  pinnedParticipantID = nextID;
  meetingViewState.pinnedParticipantId = nextID || null;
  participantElements.forEach((element, currentID) => {
    element.item.classList.toggle("is-pinned", currentID === pinnedParticipantID);
    updateParticipantAriaLabel(element);
  });
  participants.classList.toggle("has-pinned", Boolean(pinnedParticipantID));
  participants.dataset.pinned = pinnedParticipantID ? "true" : "false";
  updateParticipantPagination();
  renderMeetingLayout();
}

function openParticipantMenu(participantID, trigger) {
  const element = participantElements.get(participantID);
  if (!element || !participantMenu || !participantMenuPin || !participantMenuSelfView) return;
  if (participantMenuOwner?.trigger === trigger) {
    closeParticipantMenu(false);
    return;
  }
  closeParticipantMenu(false);
  participantMenuOwner = { participantID, trigger, item: element.item };
  participantMenu.setAttribute("aria-label", `${element.name.textContent} actions`);
  participantMenuPin.textContent = pinnedParticipantID === participantID
    ? "Unpin participant" : "Pin participant";
  participantMenuSelfView.hidden = participantID !== localParticipantID;
  participantMenuSelfView.textContent = selfViewVisible ? "Hide self-view" : "Show self-view";
  participantMenu.hidden = false;
  trigger.setAttribute("aria-expanded", "true");
  requestAnimationFrame(() => {
    positionParticipantMenu();
    const firstItem = [...participantMenu.querySelectorAll('[role="menuitem"]')]
      .find((item) => !item.hidden && !item.disabled);
    firstItem?.focus();
  });
}

function pipTileFromEvent(event) {
  const tile = event.target.closest?.(".participant-tile.is-local");
  return tile && participants?.contains(tile) && participants.classList.contains("has-remote") &&
    participants.classList.contains("is-pip-mode") ? tile : undefined;
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

meetingLayoutHost.addEventListener("click", (event) => {
  const trigger = event.target.closest?.(".participant-menu-trigger");
  if (!trigger) return;
  event.preventDefault();
  event.stopPropagation();
  openParticipantMenu(trigger.dataset.participantId, trigger);
});

participantMenu?.addEventListener("click", (event) => {
  const action = event.target.closest?.("[data-action]")?.dataset.action;
  const owner = participantMenuOwner;
  if (!action || !owner) return;
  if (action === "pin") {
    const shouldPin = pinnedParticipantID !== owner.participantID;
    setPinnedParticipant(shouldPin ? owner.participantID : undefined);
    if (participantFocusStatus) participantFocusStatus.textContent = shouldPin
      ? `${owner.item.querySelector(".participant-name")?.textContent || "Participant"} pinned.`
      : `${owner.item.querySelector(".participant-name")?.textContent || "Participant"} unpinned.`;
  } else if (action === "self-view" && owner.participantID === localParticipantID) {
    setSelfViewVisibility(false);
  }
  closeParticipantMenu(true);
});

participantMenu?.addEventListener("keydown", (event) => {
  const items = [...participantMenu.querySelectorAll('[role="menuitem"]')]
    .filter((item) => !item.hidden && !item.disabled);
  if (!items.length) return;
  const currentIndex = items.indexOf(document.activeElement);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    event.stopPropagation();
    const delta = event.key === "ArrowDown" ? 1 : -1;
    items[(currentIndex + delta + items.length) % items.length].focus();
  } else if (event.key === "Home" || event.key === "End") {
    event.preventDefault();
    event.stopPropagation();
    items[event.key === "Home" ? 0 : items.length - 1].focus();
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeParticipantMenu(true);
  } else if (event.key === "Tab") {
    closeParticipantMenu(false);
  } else if (event.key.length === 1 && /\S/.test(event.key)) {
    const match = items.find((item) => item.textContent.trim().toLowerCase()
      .startsWith(event.key.toLowerCase()));
    if (match) {
      event.preventDefault();
      event.stopPropagation();
      match.focus();
    }
  }
});

document.addEventListener("pointerdown", (event) => {
  if (!participantMenu || participantMenu.hidden) return;
  if (participantMenu.contains(event.target) || event.target.closest?.(".participant-menu-trigger")) return;
  closeParticipantMenu(false);
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
let chatFocusTrigger;

function isVisibleFocusTarget(element) {
  return Boolean(
    element?.isConnected &&
      !element.disabled &&
      !element.closest("[hidden]") &&
      !element.closest('[aria-hidden="true"]') &&
      element.getClientRects().length
  );
}

function restoreFocusTo(target, fallback) {
  if (isVisibleFocusTarget(target)) {
    target.focus();
    return;
  }
  if (isVisibleFocusTarget(fallback)) fallback.focus();
}

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
  try {
    socket.send(JSON.stringify({
      version: 1,
      type: "chat_message",
      participant_id: localParticipantID,
      text
    }));
  } catch (_) {
    addChatSystem("Message could not be sent. Try again.");
    return false;
  }
  return true;
}

function setChatOpen(open, trigger = null, restoreFocus = true) {
  if (!chatRail) return;
  clearTimeout(chatCloseTimer);
  if (open) {
    setConnectionPopoverOpen(false, null, false);
    chatFocusTrigger = trigger || document.activeElement;
    setSidebarOpen(false);
    chatRail.hidden = false;
    chatRail.setAttribute("aria-hidden", "false");
    meeting.classList.add("has-rail");
    setTimeout(() => chatRail.classList.add("is-open"), 0);
  } else {
    const hasFocusInside = chatRail.contains(document.activeElement);
    const focusTarget = chatFocusTrigger;
    chatFocusTrigger = undefined;
    chatRail.classList.remove("is-open");
    const closeDelay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180;
    chatCloseTimer = setTimeout(() => {
      chatRail.hidden = true;
      chatRail.setAttribute("aria-hidden", "true");
      meeting.classList.toggle("has-rail", meeting.classList.contains("sidebar-open"));
      if (restoreFocus && hasFocusInside && chatRail.contains(document.activeElement)) {
        restoreFocusTo(focusTarget, chatToggle);
      }
    }, closeDelay);
  }
  chatToggle?.setAttribute("aria-pressed", String(open));
  if (chatToggle) {
    updateControlLabel(chatToggle, open ? "Close chat" : "Open chat");
    chatToggle.title = `${open ? "Close" : "Open"} chat (C)`;
  }
  if (open) {
    unreadMessages = 0;
    if (chatBadge) chatBadge.hidden = true;
    setTimeout(() => chatInput?.focus(), 0);
  }
}

/** @param {MeetingPanel} panel */
function setOpenPanel(panel, trigger = null) {
  const nextPanel = panel === meetingViewState.openPanel ? "none" : panel;
  meetingViewState.openPanel = nextPanel;
  if (nextPanel === "chat") {
    setSidebarOpen(false, null, false);
    setChatOpen(true, trigger || chatToggle);
    return;
  }
  setChatOpen(false, null, false);
  if (nextPanel === "none") {
    closeOpenPanel();
    return;
  }
  setSidebarOpen(true, trigger, true);
  const sidebarTitle = document.querySelector("#sidebar-title");
  if (sidebarTitle) sidebarTitle.textContent = nextPanel === "people" ? "People" : "Settings";
  document.querySelectorAll("#meeting-sidebar > .settings-section").forEach((section) => {
    section.hidden = section.id === "people-section" ? nextPanel !== "people" : nextPanel !== "settings";
  });
  if (nextPanel === "people") renderPeopleList();
}

function closeOpenPanel(restoreFocus = true) {
  const chatWasOpen = Boolean(chatRail && !chatRail.hidden);
  const sidebarWasOpen = meeting.classList.contains("sidebar-open");
  meetingViewState.openPanel = "none";
  if (chatWasOpen) setChatOpen(false, null, restoreFocus);
  setSidebarOpen(false, null, restoreFocus && sidebarWasOpen && !chatWasOpen);
}

function autoGrowChat() {
  if (!chatInput) return;
  chatInput.style.height = "auto";
  chatInput.style.height = `${Math.min(chatInput.scrollHeight, 96)}px`;
}

chatToggle?.addEventListener("click", () => setOpenPanel("chat", chatToggle));
mobileChat?.addEventListener("click", () => setOpenPanel("chat", mobileChat));
closeChat?.addEventListener("click", () => closeOpenPanel());
connection?.addEventListener("click", () => {
  setConnectionPopoverOpen(connectionPopover?.hidden !== false, connection);
});
closeConnectionPopover?.addEventListener("click", () => setConnectionPopoverOpen(false));
connectionPopoverControls?.addEventListener("click", () => {
  setConnectionPopoverOpen(false, null, false);
  setOpenPanel("settings", connectionPopoverControls);
});
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
    cameraBeforeAudioOnly = cameraRequested;
    cameraRequested = false;
    const videoStop = screenStream ? stopScreenShare() : setVideoSending(false);
    videoStop.catch(() => {});
    showToast("Video paused to protect audio");
  } else {
    cameraRequested = cameraBeforeAudioOnly && selectedCameraQuality !== "off";
    setVideoSending(cameraRequested).catch(() => {});
  }
  updateConnectionSummary(lastConnectionLevel || "connecting", networkLabel?.textContent || "Connecting");
});

function setSelfViewVisibility(visible, notify = true) {
  selfViewVisible = Boolean(visible);
  meetingViewState.showSelfView = selfViewVisible;
  if (selfView) selfView.checked = selfViewVisible;
  writeStoredValue("meeting.showSelfView", String(selfViewVisible));
  if (!selfViewVisible && pinnedParticipantID === localParticipantID) setPinnedParticipant();
  updateParticipantPagination();
  renderMeetingLayout();
  if (notify) showToast(selfViewVisible ? "Self-view shown" : "Self-view hidden; your camera is still on");
}
selfView?.addEventListener("change", () => setSelfViewVisibility(selfView.checked));
more?.addEventListener("click", () => setOpenPanel("settings", more));
function openPeoplePanel(trigger = participantsButton) {
  setOpenPanel("people", trigger);
  setTimeout(() => {
    if (!peopleList) return;
    peopleList.tabIndex = -1;
    peopleList.focus({ preventScroll: true });
  }, 0);
}
participantsButton?.addEventListener("click", openPeoplePanel);
mobilePeople?.addEventListener("click", () => openPeoplePanel(mobilePeople));
document.addEventListener("keydown", (event) => {
  if (meeting.hidden) return;
  const isFormField = event.target.matches("input, textarea, select");
  if (event.key === "Escape") {
    if (connectionPopover && !connectionPopover.hidden) setConnectionPopoverOpen(false);
    closeOpenPanel();
    return;
  }
  if (event.key === "Tab" && meeting.classList.contains("sidebar-open")) {
    const focusable = [...meetingSidebar.querySelectorAll("button, select, input, summary, textarea, [tabindex]")].filter((element) => !element.disabled && element.offsetParent !== null);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    return;
  }
  if (event.key === "Tab" && chatRail && !chatRail.hidden && chatRail.classList.contains("is-open")) {
    const focusable = [...chatRail.querySelectorAll("button, textarea, input, select, summary, [tabindex]")]
      .filter((element) => !element.disabled && element.offsetParent !== null);
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
document.addEventListener("pointerdown", (event) => {
  if (!connectionPopover || connectionPopover.hidden) return;
  if (connectionPopover.contains(event.target) || event.target.closest?.("#connection")) return;
  setConnectionPopoverOpen(false, null, false);
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
let localAudioStream;
let localCameraStream;
let localScreenStream;
let screenStream;
let localCameraTrack;
let localScreenTrack;
let cameraSender;
let screenSender;
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
const connectionMetrics = {
  status: "Connecting",
  iceState: "new",
  audioState: "No sample",
  incomingVideoState: "No sample",
  outgoingVideoState: "Not active",
  lastSampleAt: null,
  rttMs: null,
  jitterMs: null,
  packetLossPct: null,
  incomingVideoKbps: null,
  outgoingVideoKbps: null,
  incomingAudioKbps: null,
  outgoingAudioKbps: null,
  incomingCameraResolution: null,
  incomingCameraFps: null,
  incomingScreenResolution: null,
  incomingScreenFps: null,
  reconnects: 0
};
let adaptationLevel = 2;
let poorSamples = 0;
let goodSamples = 0;
let criticalSamples = 0;
let recoverySamples = 0;
let videoSuspended = false;
let videoSuspendedAutomatically = false;
let cameraRequested = false;
let receiveVideoEnabled = true;
let selfViewVisible = readStoredValue("meeting.showSelfView") !== "false";
let cameraBeforeAudioOnly = false;
const selectedDeviceIDs = { audio: "", video: "", speaker: "" };
if (selfView) selfView.checked = selfViewVisible;
meetingViewState.showSelfView = selfViewVisible;
let mediaTestStream;
let audioContext;
let speakerAnimationFrame;
let speakerUpdateTimer;
let lastSpeakerUpdateAt = 0;
let lastConnectionLevel = "";
let pendingConnectionLevel = "";
let pendingConnectionSamples = 0;
let connectionPopoverFocusTrigger;
const speakerAnalyzers = new Map();
const activeSpeakers = new Set();
const speakerLevels = new Map();
const pendingSpeakerStates = new Map();
const speakerThresholdDb = -50;
const speakerStartHoldMs = 200;
const speakerStopHoldMs = 300;
const speakerActivationDelayMs = 300;
const speakerDeactivationHoldMs = 1000;
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
const participantRemovalTimers = new Map();
const remoteAudioElements = new Set();
const remoteTrackOwners = new Map();
const remoteTrackRoles = new Map();
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

function setDeviceOptions(select, devices, defaultLabel) {
  if (!select) return;
  const previous = select.value;
  select.replaceChildren(new Option(defaultLabel, ""));
  devices.forEach((device, index) => {
    const option = new Option(device.label || `${defaultLabel.replace("System ", "")} ${index + 1}`, device.deviceId);
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === previous)) select.value = previous;
}

async function refreshDeviceSelectors() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  setDeviceOptions(settingsMic, devices.filter((device) => device.kind === "audioinput"), "System default");
  setDeviceOptions(settingsCamera, devices.filter((device) => device.kind === "videoinput"), "System default");
  setDeviceOptions(settingsSpeaker, devices.filter((device) => device.kind === "audiooutput"), "System default");
  if (settingsMic) settingsMic.value = selectedDeviceIDs.audio || settingsMic.value;
  if (settingsCamera) settingsCamera.value = selectedDeviceIDs.video || settingsCamera.value;
  if (settingsSpeaker) settingsSpeaker.value = selectedDeviceIDs.speaker || settingsSpeaker.value;
}

async function setSpeakerOutput(deviceID) {
  selectedDeviceIDs.speaker = deviceID;
  let unsupported = false;
  for (const audio of remoteAudioElements) {
    if (typeof audio.setSinkId !== "function") {
      unsupported = true;
      continue;
    }
    await audio.setSinkId(deviceID || "").catch(() => { unsupported = true; });
  }
  if (unsupported && deviceID) showToast("This browser cannot change the speaker output.");
}

async function replaceLocalDevice(kind, deviceID) {
  selectedDeviceIDs[kind] = deviceID;
  if (!localStream || !navigator.mediaDevices?.getUserMedia) return;
  const targetStream = localStream;
  const targetPeer = peer;
  const targetParticipantID = localParticipantID;
  if (kind === "video" && screenStream) {
    showToast("The camera will switch after screen sharing stops.");
  }
  const constraints = kind === "audio"
    ? { audio: deviceID ? { deviceId: { exact: deviceID } } : true }
    : { video: { ...cameraConstraints, ...(deviceID ? { deviceId: { exact: deviceID } } : {}) } };
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    if (localStream !== targetStream || peer !== targetPeer ||
        localParticipantID !== targetParticipantID || meeting.hidden) {
      stream.getTracks().forEach((track) => track.stop());
      return;
    }
    const nextTrack = kind === "audio" ? stream.getAudioTracks()[0] : stream.getVideoTracks()[0];
    if (!nextTrack) throw new Error(`${kind} device is unavailable`);
    const previousTrack = kind === "audio"
      ? localStream.getAudioTracks()[0]
      : localStream.getVideoTracks()[0];
    const sender = peer?.getSenders().find((item) => item.track?.kind === kind);
    if (kind === "audio" && sender) await sender.replaceTrack(nextTrack);
    if (kind === "video") {
      cameraTrack = nextTrack;
      if (sender && !screenStream) await sender.replaceTrack(nextTrack);
    }
    if (previousTrack) {
      localStream.removeTrack(previousTrack);
      previousTrack.stop();
    }
    localStream.addTrack(nextTrack);
    nextTrack.enabled = kind === "audio"
      ? localStream.getAudioTracks()[0] === nextTrack && previousTrack?.enabled !== false
      : cameraRequested && !videoSuspended && !audioOnly?.checked;
    if (kind === "audio") {
      removeSpeakerAnalyzer(localParticipantID);
      attachSpeakerAnalyzer(localParticipantID, localStream);
    } else {
      const local = participantElements.get(localParticipantID);
      if (local && !screenStream) local.video.srcObject = localStream;
      if (!screenStream) setLocalVideoMirror(true);
      await applyProfile(profile.value, peer, screenStream || localStream);
    }
    if (settingsPreview) {
      settingsPreview.srcObject = localStream;
      settingsPreview.hidden = !localStream.getVideoTracks().length;
    }
    setLocalMediaControls();
    sendMediaState();
    await refreshDeviceSelectors();
  } catch (error) {
    showToast(mediaAccessMessage(kind, error));
    await refreshDeviceSelectors();
  }
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
  let cameraDenied = false;
  let microphoneDenied = false;

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
  } catch (error) {
    cameraDenied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
    setDeviceResult(testCamera, "error", cameraDenied ? "Camera access denied" : "Camera unavailable");
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
  } catch (error) {
    microphoneDenied = error?.name === "NotAllowedError" || error?.name === "SecurityError";
    setDeviceResult(testMicrophone, "error", microphoneDenied ? "Microphone access denied" : "Microphone unavailable");
  }

  if (mediaTestStream !== testStream) {
    testStream.getTracks().forEach((track) => track.stop());
    return;
  }
  devicePreview.srcObject = testStream;
  devicePreview.hidden = !cameraReady;
  await refreshDeviceSelectors();
  if (cameraDenied || microphoneDenied) {
    const messages = [];
    if (cameraDenied) messages.push("Camera access was denied. You can still join without video.");
    if (microphoneDenied) messages.push("Microphone access was denied. Check your browser permissions or join muted.");
    deviceTestStatus.textContent = messages.join(" ");
  } else {
    deviceTestStatus.textContent = cameraReady && microphoneReady
      ? "Your devices are ready. The test will stop when you join."
      : "Some devices need attention. You can still join and use the available media.";
  }
}

testMedia.addEventListener("click", runDeviceTest);
stopMediaTest.addEventListener("click", () => {
  stopDeviceTest();
  deviceTestStatus.textContent = "Device test stopped.";
});
settingsMic?.addEventListener("change", () => replaceLocalDevice("audio", settingsMic.value));
settingsCamera?.addEventListener("change", () => replaceLocalDevice("video", settingsCamera.value));
settingsSpeaker?.addEventListener("change", () => setSpeakerOutput(settingsSpeaker.value));
navigator.mediaDevices?.addEventListener?.("devicechange", refreshDeviceSelectors);

function setLocalMediaControls() {
  const audioTrack = localStream?.getAudioTracks()[0];
  const videoTrack = localCameraTrack;
  const audioAvailable = Boolean(audioTrack);
  const videoAvailable = Boolean(videoTrack);
  const audioOn = audioAvailable && audioTrack.enabled;
  const cameraOn = videoAvailable && cameraRequested && !videoSuspended && !audioOnly?.checked;
  mic.disabled = !audioAvailable;
  camera.disabled = meeting.hidden || !peer;
  updateControlLabel(mic, audioOn ? "Mute microphone" : "Unmute microphone");
  mic.setAttribute("aria-pressed", String(audioAvailable && audioTrack.enabled));
  updateControlLabel(camera, cameraOn ? "Turn camera off" : "Turn camera on");
  camera.setAttribute("aria-pressed", String(cameraOn));
  if (!audioAvailable) updateControlLabel(mic, "Microphone unavailable");
  if (!videoAvailable) updateControlLabel(camera, "Turn camera on");
  const local = participantElements.get(localParticipantID);
  if (local) {
    local.item.dataset.mic = audioOn ? "on" : "off";
    local.item.dataset.camera = cameraOn ? "on" :
      (videoSuspendedAutomatically ? "paused" : "off");
    updateParticipantVideoVisibility(local);
    local.micIndicator.hidden = audioOn;
    local.micIndicator.classList.toggle("is-on", audioOn);
    local.micIndicator.classList.toggle("is-off", !audioOn);
    updateParticipantTileState(local);
    updateParticipantAriaLabel(local);
  }
  if (settingsPreview) {
    settingsPreview.srcObject = localStream || null;
    settingsPreview.hidden = !videoAvailable;
  }
  renderPeopleList();
}

async function renegotiateLocalMedia() {
  const generation = socketGeneration;
  const targetPeer = peer;
  const targetSocket = socket;
  if (!targetPeer || !isCurrentWebRTC(generation, targetPeer, targetSocket) ||
      targetPeer.signalingState !== "stable") return;
  renegotiationChain = renegotiationChain.catch(() => {}).then(async () => {
    if (!isCurrentWebRTC(generation, targetPeer, targetSocket)) return;
    const offer = await targetPeer.createOffer();
    await targetPeer.setLocalDescription(offer);
    if (isCurrentWebRTC(generation, targetPeer, targetSocket)) {
      targetSocket.send(JSON.stringify({ version: 1, type: "offer", sdp: offer.sdp }));
    }
  }).catch(() => {});
  return renegotiationChain;
}

async function enableCamera() {
  if (localCameraTrack || !navigator.mediaDevices?.getUserMedia || !peer) return;
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      ...cameraConstraints,
      ...(selectedDeviceIDs.video ? { deviceId: { exact: selectedDeviceIDs.video } } : {})
    }
  });
  const track = stream.getVideoTracks()[0];
  if (!track) throw new Error("camera is unavailable");
  localCameraStream = stream;
  localCameraTrack = track;
  cameraTrack = track;
  track.enabled = !videoSuspended && !audioOnly?.checked;
  localStream?.addTrack(track);
  cameraSender = peer.addTrack(track, stream);
  const local = participantElements.get(localParticipantID);
  if (local) local.cameraVideo.srcObject = stream;
  cameraRequested = true;
  meetingViewState.cameraEnabled = true;
  setLocalVideoMirror(true);
  setLocalMediaControls();
  await applyProfile(profile.value, peer, stream);
  await renegotiateLocalMedia();
  sendMediaState();
}

async function disableCamera() {
  cameraRequested = false;
  meetingViewState.cameraEnabled = false;
  if (cameraSender && peer) {
    peer.removeTrack(cameraSender);
    cameraSender = undefined;
    await renegotiateLocalMedia();
  }
  localCameraTrack?.stop();
  localStream?.removeTrack(localCameraTrack);
  localCameraStream?.getTracks().forEach((track) => track.stop());
  localCameraTrack = undefined;
  localCameraStream = undefined;
  cameraTrack = undefined;
  const local = participantElements.get(localParticipantID);
  if (local) local.cameraVideo.srcObject = null;
  setLocalMediaControls();
  sendMediaState();
}

let sidebarFocusTrigger;

function setSidebarOpen(open, trigger = null, restoreFocus = true) {
  closeParticipantMenu(false);
  if (open) setConnectionPopoverOpen(false, null, false);
  if (open) sidebarFocusTrigger = trigger || document.activeElement;
  if (open && chatRail && !chatRail.hidden) setChatOpen(false, null, false);
  meeting.classList.toggle("sidebar-open", open);
  toggleSidebar.setAttribute("aria-expanded", String(open));
  connection.setAttribute("aria-expanded", String(open));
  participantsButton?.setAttribute("aria-expanded", String(open));
  if (participantsButton) updateControlLabel(participantsButton, open ? "Close meeting controls" : "Open participants");
  more?.setAttribute("aria-expanded", String(open));
  if (more) {
    const moreLabel = open
      ? "Close meeting controls"
      : moreStateBadge?.hidden === false
        ? "Open more meeting controls. Incoming video is off."
        : "Open more meeting controls";
    updateControlLabel(more, moreLabel);
  }
  const sidebarLabel = open ? "Close meeting controls" : "Open meeting controls";
  toggleSidebar.setAttribute("aria-label", sidebarLabel);
  toggleSidebar.title = sidebarLabel;
  toggleSidebarLabel.textContent = sidebarLabel;
  meetingSidebar.setAttribute("aria-hidden", String(!open));
  meeting.classList.toggle("has-rail", open || !chatRail?.hidden);
  sidebarBackdrop.hidden = !open;
  requestParticipantLayout();
  if (open) {
    closeSidebar.focus();
  } else {
    const focusTarget = sidebarFocusTrigger;
    sidebarFocusTrigger = undefined;
    if (restoreFocus) restoreFocusTo(focusTarget, toggleSidebar);
  }
}

toggleSidebar.addEventListener("click", () => setOpenPanel("settings", toggleSidebar));
closeSidebar.addEventListener("click", () => {
  closeOpenPanel();
});
sidebarBackdrop.addEventListener("click", () => {
  closeOpenPanel();
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
  if (streamID.startsWith(streamPrefix)) {
    return streamID.slice(streamPrefix.length).replace(/-(?:audio|camera|screen)$/, "");
  }
  return track.id?.split("|")[0] || "";
}

function remoteMediaRole(streams, track) {
  const streamID = streams?.[0]?.id || track?.streamId || track?.StreamID?.() || "";
  if (/-screen$/.test(streamID) || /\|screen$/.test(track?.id || "")) return "screen";
  if (/-camera$/.test(streamID) || /\|camera$/.test(track?.id || "")) return "camera";
  return track?.kind === "audio" ? "audio" : "camera";
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
  const eligible = new Map([...speakerLevels].filter(([id]) => {
    const item = participantElements.get(id)?.item;
    return activeSpeakers.has(id) && item?.dataset.mic !== "off";
  }));
  meetingViewState.activeSpeakerId = typeof chooseActiveSpeaker === "function"
    ? chooseActiveSpeaker(eligible)
    : [...eligible.keys()].sort()[0] || null;
  participantElements.forEach((participant) => {
    participant.item.classList.toggle("is-primary-speaker", participant.item.dataset.participantId === meetingViewState.activeSpeakerId);
  });
  renderMeetingLayout();
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
      if (element.item.dataset.camera !== "unknown" || element.item.dataset.mic !== "unknown") {
        updateMediaState({
          participant_id: participantID,
          audio_enabled: element.item.dataset.mic !== "off",
          video_enabled: element.item.dataset.camera === "on",
          video_paused: element.item.dataset.camera === "paused"
        });
      } else {
        updateParticipantTileState(element);
        updateParticipantAriaLabel(element);
      }
    }
    updateParticipantTileState(element);
  });
  renderPeopleList();
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
    speakerLevels.set(participantID, entry.level);
    const levelDb = 20 * Math.log10(Math.max(entry.level, 0.000001));
    if (participantID === localParticipantID && micLevelMeter) {
      const level = Math.max(0, Math.min(100, Math.round(((levelDb + 60) / 60) * 100)));
      micLevelMeter.setAttribute("aria-valuenow", String(level));
      micLevelMeter.firstElementChild.style.width = `${level}%`;
    }
    const muted = participantElements.get(participantID)?.item.dataset.mic === "off";
    const aboveThreshold = !muted && levelDb > speakerThresholdDb;
    if (aboveThreshold) {
      entry.quietSince = 0;
      if (!entry.speaking && !entry.speakingSince) entry.speakingSince = now;
      if (!entry.speaking && now - entry.speakingSince >= speakerActivationDelayMs) {
        entry.speaking = true;
        setSpeakerState(participantID, true);
      }
    } else {
      entry.speakingSince = 0;
      if (entry.speaking && !entry.quietSince) entry.quietSince = now;
      if (entry.speaking && now - entry.quietSince >= speakerDeactivationHoldMs) {
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
  if (micLevelMeter) {
    micLevelMeter.setAttribute("aria-valuenow", "0");
    if (micLevelMeter.firstElementChild) micLevelMeter.firstElementChild.style.width = "0%";
  }
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
  status.textContent = "Joining meeting…";
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
      meetingViewState.activeScreenShareId = screenShareOwner || (screenStream ? localParticipantID : null);
      updateVideoOrientation(previousScreenShareOwner);
      updateVideoOrientation(screenShareOwner);
      updateScreenShareUI();
      renderMeetingLayout();
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
        if (meetingEnded) meetingEnded.hidden = true;
        status.textContent = "";
        startWebRTC();
      }
    }
    if (message.type === "participant_left") {
      addChatSystem(`${message.participant.name} left the room`);
      const element = participantElements.get(message.participant.id);
      if (element) {
        if (participantMenuOwner?.participantID === message.participant.id) closeParticipantMenu(false);
        if (pinnedParticipantID === message.participant.id) setPinnedParticipant();
        remoteAudioElements.delete(element.audio);
        removeSpeakerAnalyzer(message.participant.id);
        forgetRemoteTracks(element, message.participant.id);
        element.item.classList.remove("is-speaking");
        element.item.classList.add("is-disconnected");
        element.item.dataset.connection = "left";
        element.micIndicator.setAttribute("aria-label", `${message.participant.name} disconnected`);
        updateParticipantTileState(element);
        renderPeopleList();
        const removalTimer = setTimeout(() => {
          participantRemovalTimers.delete(message.participant.id);
          if (participantElements.get(message.participant.id)?.item === element.item) {
            element.item.remove();
            participantElements.delete(message.participant.id);
            const orderIndex = participantOrder.indexOf(message.participant.id);
            if (orderIndex >= 0) participantOrder.splice(orderIndex, 1);
            updateParticipantCount();
            renderMeetingLayout();
          }
        }, 1200);
        const previousRemovalTimer = participantRemovalTimers.get(message.participant.id);
        if (previousRemovalTimer) clearTimeout(previousRemovalTimer);
        participantRemovalTimers.set(message.participant.id, removalTimer);
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
      setConnection("poor", "Offline");
      status.textContent = "Offline. Select Leave to try again.";
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
  closeParticipantMenu(false);
  pinnedParticipantID = undefined;
  participants.classList.remove("has-pinned");
  participants.dataset.pinned = "false";
  for (const timer of participantRemovalTimers.values()) clearTimeout(timer);
  participantRemovalTimers.clear();
  participants.replaceChildren();
  participantElements.clear();
  participantOrder.splice(0);
  participantPage = 0;
  focusedParticipantID = undefined;
  updateParticipantPagination();
  remoteAudioElements.clear();
  remoteTrackOwners.clear();
  remoteTrackRoles.clear();
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
  localAudioStream = undefined;
  localCameraStream = undefined;
  localScreenStream = undefined;
  screenStream = undefined;
  localCameraTrack = undefined;
  localScreenTrack = undefined;
  cameraSender = undefined;
  screenSender = undefined;
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
      setConnection("poor", "Offline");
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
    const role = remoteMediaRole(streams, track);
    const element = participantElements.get(participantID);
    if (!element) return;
    rememberRemoteTrack(participantID, track, receiver);
    const stream = remoteMediaStream(streams, track);
    if (track.kind === "video") {
      const video = role === "screen" ? element.screenVideo : element.cameraVideo;
      video.srcObject = stream;
      video.autoplay = true;
      video.playsInline = true;
      video.dataset.mediaRole = role;
      remoteTrackRoles.set(track.id, role);
      video.classList.toggle("is-screen-content", role === "screen");
      updateParticipantVideoVisibility(element);
      updateVideoOrientation(participantID);
      video.play().catch(() => {});
      if (role === "camera") element.video.play().catch(() => {});
    } else {
      element.audio.srcObject = stream;
      element.audio.autoplay = true;
      remoteAudioElements.add(element.audio);
      if (selectedDeviceIDs.speaker && typeof element.audio.setSinkId === "function") {
        element.audio.setSinkId(selectedDeviceIDs.speaker).catch(() => {});
      }
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
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: selectedDeviceIDs.audio ? { deviceId: { exact: selectedDeviceIDs.audio } } : true
      });
      audioStream.getAudioTracks().forEach((track) => {
        track.enabled = false;
        setupStream.addTrack(track);
      });
      if (abortIfStale()) return;
    } catch (error) {
      status.textContent = mediaAccessMessage("audio", error);
    }
    if (abortIfStale()) return;
    localStream = setupStream;
    localAudioStream = setupStream.getAudioTracks().length ? setupStream : undefined;
    localCameraStream = undefined;
    localCameraTrack = undefined;
    localScreenStream = undefined;
    localScreenTrack = undefined;
    cameraTrack = undefined;
    cameraSender = undefined;
    screenSender = undefined;
    setLocalMediaControls();
    if (localStream.getAudioTracks().length) attachSpeakerAnalyzer(localParticipantID, localStream);
    const local = participantElements.get(localParticipantID);
    if (local) {
      local.cameraVideo.srcObject = null;
      local.video.srcObject = null;
      local.video.autoplay = true;
      local.video.muted = true;
    }
    if (settingsPreview) {
      settingsPreview.srcObject = localStream;
      settingsPreview.hidden = !localStream.getVideoTracks().length;
    }
    await refreshDeviceSelectors();
    mountDebugParticipants();
    setLocalVideoMirror(true);
    sendMediaState();
    if (!isCurrentWebRTC(generation, currentPeer, currentSocket)) return;
    for (const track of localStream.getAudioTracks()) currentPeer.addTrack(track, localStream);
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

function syncConnectionPopoverStats() {
  if (!connectionPopover) return;
  const statMap = {
    "stat-rtt": "popover-stat-rtt",
    "stat-jitter": "popover-stat-jitter",
    "stat-loss": "popover-stat-loss",
    "stat-bitrate": "popover-stat-bitrate",
    "stat-resolution": "popover-stat-resolution"
  };
  let available = false;
  Object.entries(statMap).forEach(([sourceID, targetID]) => {
    const source = document.querySelector(`#${sourceID}`);
    const sourceRow = source?.closest("div");
    const target = document.querySelector(`#${targetID}`);
    const targetRow = target?.closest("div");
    const visible = Boolean(source && target && sourceRow && !sourceRow.hidden);
    if (target) target.textContent = source?.textContent || "";
    if (targetRow) targetRow.hidden = !visible;
    available ||= visible;
  });
  if (connectionPopoverEmpty) connectionPopoverEmpty.hidden = available;
}

function updateConnectionPopover(level, label) {
  if (!connectionPopover) return;
  if (connectionPopoverTitle) connectionPopoverTitle.textContent = label;
  const audioAvailable = Boolean(localStream?.getAudioTracks().length);
  const audioText = !audioAvailable ? "Audio is not available yet." : "Audio is connected.";
  const videoText = receiveVideoEnabled ? "Incoming video is on for this device." : "Incoming video is off for this device.";
  if (connectionPopoverCopy) {
    connectionPopoverCopy.textContent = `${audioText} ${videoText}`;
  }
  connectionPopover.dataset.level = level || "connecting";
  syncConnectionPopoverStats();
}

function setConnectionPopoverOpen(open, trigger = null, restoreFocus = true) {
  if (!connectionPopover) return;
  if (open) {
    if (meetingViewState.openPanel !== "none" || meeting.classList.contains("sidebar-open") || (chatRail && !chatRail.hidden)) {
      closeOpenPanel(false);
    }
    connectionPopoverFocusTrigger = trigger || document.activeElement || connection;
    connectionPopover.hidden = false;
    connectionPopover.setAttribute("aria-hidden", "false");
    connection.setAttribute("aria-expanded", "true");
    updateConnectionPopover(lastConnectionLevel || "connecting", networkLabel?.textContent || "Connecting");
    setTimeout(() => {
      connectionPopover.classList.add("is-open");
      closeConnectionPopover?.focus();
    }, 0);
    return;
  }
  const focusTarget = connectionPopoverFocusTrigger;
  connectionPopoverFocusTrigger = undefined;
  connectionPopover.classList.remove("is-open");
  connectionPopover.hidden = true;
  connectionPopover.setAttribute("aria-hidden", "true");
  connection.setAttribute("aria-expanded", "false");
  if (restoreFocus) restoreFocusTo(focusTarget, connection);
}

function updateConnectionSummary(level, label) {
  if (connectionSummaryTitle) connectionSummaryTitle.textContent = label;
  if (connectionSummaryCopy) {
    const audioAvailable = Boolean(localStream?.getAudioTracks().length);
    const mediaConnected = peer?.connectionState === "connected" ||
      peer?.iceConnectionState === "connected" || peer?.iceConnectionState === "completed";
    const audioText = !audioAvailable
      ? "Audio is not available yet."
      : mediaConnected ? "Audio is connected." : "Audio is ready on this device.";
    const videoText = receiveVideoEnabled
      ? "Incoming video is on for this device."
      : "Incoming video is off for this device.";
    connectionSummaryCopy.textContent = `${audioText} ${videoText}`;
  }
  if (connectionPreference) {
    connectionPreference.textContent = `Data preference: ${audioOnly?.checked ? "Protect audio" : "Automatic"}`;
  }
  updateConnectionPopover(level, label);
  if (!meetingAlert) return;
  const shouldAlert = level === "fair" || level === "poor";
  meetingAlert.hidden = !shouldAlert;
  meetingAlert.dataset.level = level || "connecting";
  if (shouldAlert) {
    meetingAlert.textContent = videoSuspendedAutomatically && !audioOnly?.checked
      ? "Your camera was paused to keep audio connected."
      : label === "Reconnecting"
      ? "Reconnecting media…"
      : level === "poor"
        ? "Connection unstable. Video may be reduced to keep audio connected."
        : "Connection unstable. Audio is prioritized.";
  }
}

function setConnection(level, label) {
  const normalizedLevel = level || "connecting";
  const normalizedLabel = label || "Connecting";
  connection.className = `network-chip connection ${normalizedLevel}`;
  connectionSummary?.setAttribute("data-level", normalizedLevel);
  connection.setAttribute("aria-label", `Connection status: ${normalizedLabel}`);
  if (networkLabel) networkLabel.textContent = normalizedLabel;
  if (connectionMessage) connectionMessage.textContent = normalizedLabel;
  updateConnectionSummary(normalizedLevel, normalizedLabel);
  lastConnectionLevel = normalizedLevel;
  connectionMetrics.status = normalizedLabel;
  updateConnectionMetrics({ ice: peer?.iceConnectionState, timestamp: Date.now() });
  pendingConnectionLevel = "";
  pendingConnectionSamples = 0;
}

function setMeasuredConnection(level, label) {
  if (level === lastConnectionLevel) {
    pendingConnectionLevel = "";
    pendingConnectionSamples = 0;
    updateConnectionSummary(level, networkLabel?.textContent || label);
    return;
  }
  if (pendingConnectionLevel === level) pendingConnectionSamples += 1;
  else {
    pendingConnectionLevel = level;
    pendingConnectionSamples = 1;
  }
  if (pendingConnectionSamples >= 2) setConnection(level, label);
}

function setStatValue(element, value) {
  if (!element) return;
  const available = value !== null && value !== undefined && value !== "";
  const row = element.closest("div");
  if (row) row.hidden = !available;
  if (available) element.textContent = value;
  syncConnectionPopoverStats();
}

function updateConnectionMetrics(values) {
  const next = {
    ...connectionMetrics,
    iceState: values.ice || connectionMetrics.iceState,
    lastSampleAt: values.timestamp || Date.now(),
    rttMs: values.rttMs,
    jitterMs: values.jitterMs,
    packetLossPct: values.packetLoss,
    incomingVideoKbps: values.inboundKbps,
    outgoingVideoKbps: values.outboundKbps,
    incomingAudioKbps: values.inboundAudioKbps,
    outgoingAudioKbps: values.outboundAudioKbps,
    incomingVideoState: values.inboundKbps == null ? "No sample" : "Receiving",
    outgoingVideoState: values.outboundKbps == null ? (cameraRequested ? "No sample" : "Not active") : "Sending",
    audioState: values.inboundAudioKbps == null && values.outboundAudioKbps == null ? "No sample" : "Connected"
  };
  Object.assign(connectionMetrics, next);
  const text = (id, value) => {
    const node = document.querySelector(`#${id}`);
    if (!node) return;
    const rendered = String(value);
    if (node.textContent !== rendered) node.textContent = rendered;
  };
  text("metric-status", connectionMetrics.status);
  text("metric-ice-state", connectionMetrics.iceState || "No sample");
  text("metric-rtt", connectionMetrics.rttMs == null ? "No sample" : `${connectionMetrics.rttMs} ms`);
  text("metric-jitter-loss", connectionMetrics.jitterMs == null && connectionMetrics.packetLossPct == null
    ? "No sample"
    : `${connectionMetrics.jitterMs == null ? "Unavailable" : `${connectionMetrics.jitterMs} ms`} / ` +
      `${connectionMetrics.packetLossPct == null ? "Unavailable" : `${connectionMetrics.packetLossPct}%`}`);
  text("metric-video-bitrate", connectionMetrics.incomingVideoKbps == null && connectionMetrics.outgoingVideoKbps == null
    ? "No sample" : `${connectionMetrics.incomingVideoKbps ?? "Unavailable"} / ${connectionMetrics.outgoingVideoKbps ?? "Unavailable"} kbps`);
  text("metric-audio-bitrate", connectionMetrics.incomingAudioKbps == null && connectionMetrics.outgoingAudioKbps == null
    ? "No sample" : `${connectionMetrics.incomingAudioKbps ?? "Unavailable"} / ${connectionMetrics.outgoingAudioKbps ?? "Unavailable"} kbps`);
  text("metric-camera-format", connectionMetrics.incomingCameraResolution
    ? `${connectionMetrics.incomingCameraResolution} / ${connectionMetrics.incomingCameraFps ?? "Unavailable"} FPS` : "Not active");
  text("metric-screen-format", connectionMetrics.incomingScreenResolution
    ? `${connectionMetrics.incomingScreenResolution} / ${connectionMetrics.incomingScreenFps ?? "Unavailable"} FPS` : "Not active");
  text("metric-reconnects", connectionMetrics.reconnects);
  const summary = document.querySelector("#connection-metrics-status");
  if (summary) summary.textContent = connectionMetrics.lastSampleAt ? "Live" : "No sample";
}

async function updateDiagnostics() {
  const currentPeer = peer;
  if (!currentPeer) return;
  const report = await currentPeer.getStats().catch(() => undefined);
  if (!report || peer !== currentPeer) return;
  const values = {
    rttMs: null,
    jitterMs: null,
    packetLoss: null,
    outboundKbps: null,
    inboundKbps: null,
    outboundAudioKbps: null,
    inboundAudioKbps: null,
    sentFps: null,
    receivedFps: null,
    framesDropped: null,
    resolution: null,
    codec: null,
    ice: currentPeer.iceConnectionState,
    iceCandidateType: null,
    iceTransport: null,
    connection: currentPeer.connectionState
  };
  values.timestamp = Date.now();
  let sentBytes = 0;
  let receivedBytes = 0;
  let sentAudioBytes = 0;
  let receivedAudioBytes = 0;
  let framesDropped = 0;
  let hasFrameDropStats = false;
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
      if (stat.framesDropped != null) {
        hasFrameDropStats = true;
        framesDropped += stat.framesDropped;
      }
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
      if (stat.framesDropped != null) {
        hasFrameDropStats = true;
        framesDropped += stat.framesDropped;
      }
      if (stat.jitter != null) values.jitterMs = Math.round(stat.jitter * 1000);
      if (stat.frameWidth && stat.frameHeight) values.resolution = `${stat.frameWidth}x${stat.frameHeight}`;
      const role = remoteTrackRoles.get(stat.trackIdentifier);
      if (role === "screen") {
        values.screenResolution = `${stat.frameWidth || "?"}x${stat.frameHeight || "?"}`;
        values.screenFps = stat.framesPerSecond ?? null;
      } else if (role === "camera") {
        values.cameraResolution = `${stat.frameWidth || "?"}x${stat.frameHeight || "?"}`;
        values.cameraFps = stat.framesPerSecond ?? null;
      }
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
  values.framesDropped = hasFrameDropStats ? framesDropped : null;
  previousStats = { timestamp, sentBytes, receivedBytes, sentAudioBytes, receivedAudioBytes };
  const lossKnown = values.packetLoss != null;
  const connectionHasMetrics = values.rttMs != null || lossKnown;
  if (connectionHasMetrics) {
    if ((values.rttMs != null && values.rttMs > 250) || (lossKnown && values.packetLoss > 5)) {
      setMeasuredConnection("poor", "Unstable connection");
    } else if ((values.rttMs != null && values.rttMs > 120) || (lossKnown && values.packetLoss >= 2)) {
      setMeasuredConnection("fair", "Unstable connection");
    } else {
      setMeasuredConnection("good", "Connected");
    }
  }
  setStatValue(statRTT, values.rttMs == null ? null : `${values.rttMs} ms`);
  setStatValue(statJitter, values.jitterMs == null ? null : `${values.jitterMs} ms`);
  setStatValue(statLoss, values.packetLoss == null ? null : `${values.packetLoss.toFixed(1)}%`);
  setStatValue(statBitrate, values.inboundKbps == null && values.outboundKbps == null
    ? null
    : `${values.inboundKbps == null ? "-" : values.inboundKbps} / ${values.outboundKbps == null ? "-" : values.outboundKbps} kbps`);
  setStatValue(statResolution, values.resolution || null);
  connectionMetrics.incomingCameraResolution = values.cameraResolution || connectionMetrics.incomingCameraResolution;
  connectionMetrics.incomingCameraFps = values.cameraFps ?? connectionMetrics.incomingCameraFps;
  connectionMetrics.incomingScreenResolution = values.screenResolution || connectionMetrics.incomingScreenResolution;
  connectionMetrics.incomingScreenFps = values.screenFps ?? connectionMetrics.incomingScreenFps;
  updateConnectionMetrics(values);
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
      hasData: values.rttMs != null || values.packetLoss != null,
      lostPackets: 0,
      receivedPackets: 0,
      totalPackets: 0
    };
    setParticipantQuality(element, classifyParticipantQuality(remoteStats, values.rttMs));
  });
  const packetLoss = values.packetLoss ?? 0;
  const poor = (values.rttMs != null && values.rttMs > 250) || (lossKnown && packetLoss > 5) ||
    isBelowBitrate(values.inboundKbps, 80);
  const critical = (values.rttMs != null && values.rttMs > 500) || (lossKnown && packetLoss > 10) ||
    isBelowBitrate(values.inboundKbps, 40);
  const good = (values.rttMs == null || values.rttMs < 120) && (!lossKnown || packetLoss < 1);
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
      packet_loss10: values.packetLoss == null ? -1 : Math.round(packetLoss * 10),
      jitter_ms: values.jitterMs ?? -1,
      video_kbps: values.outboundKbps == null ? -1 : Math.max(0, values.outboundKbps),
      audio_kbps: values.outboundAudioKbps == null ? -1 : Math.max(0, values.outboundAudioKbps)
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
  if (value === "off") cameraRequested = false;
  if (!screenStream) {
    await setVideoSending(cameraRequested);
  }
  await applyProfile(profile.value, peer, screenStream || localStream);
  showToast(value === "off" ? "Camera turned off" : `Camera quality set to ${value}`);
});

function addParticipant(participant) {
  const existing = participantElements.get(participant.id);
  if (existing) {
    const removalTimer = participantRemovalTimers.get(participant.id);
    if (removalTimer) {
      clearTimeout(removalTimer);
      participantRemovalTimers.delete(participant.id);
      if (participantMenuOwner?.participantID === participant.id) closeParticipantMenu(false);
      existing.item.classList.remove("is-disconnected");
      existing.item.dataset.connection = "connected";
      existing.item.dataset.camera = "unknown";
      existing.item.dataset.mic = "unknown";
      existing.video.srcObject = null;
      existing.audio.srcObject = null;
      existing.item.dataset.receiveVideo = "false";
      existing.video.hidden = true;
      existing.avatar.hidden = false;
      existing.pausedChip.hidden = true;
      existing.quality.hidden = true;
      existing.menuTrigger.setAttribute("aria-expanded", "false");
      updateParticipantTileState(existing);
      updateParticipantAriaLabel(existing);
      updateParticipantCount();
    }
    return;
  }
  const item = document.createElement("li");
  item.className = "participant-tile";
  item.tabIndex = 0;
  item.setAttribute("role", "group");
  if (participant.id === localParticipantID) item.classList.add("is-local");
  item.dataset.participantId = participant.id;
  item.dataset.connection = "connected";
  item.dataset.sharing = "false";
  item.dataset.camera = "unknown";
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
  name.title = participant.name;
  const youBadge = document.createElement("span");
  youBadge.className = "participant-you";
  youBadge.textContent = "You";
  youBadge.hidden = participant.id !== localParticipantID;
  const menuTrigger = document.createElement("button");
  menuTrigger.type = "button";
  menuTrigger.className = "participant-menu-trigger";
  menuTrigger.dataset.participantId = participant.id;
  menuTrigger.setAttribute("aria-haspopup", "menu");
  menuTrigger.setAttribute("aria-expanded", "false");
  menuTrigger.setAttribute("aria-label", `${participant.name} participant actions`);
  menuTrigger.title = `Participant actions for ${participant.name}`;
  menuTrigger.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/></svg>';
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
  const state = document.createElement("span");
  state.className = "participant-state";
  state.hidden = true;
  state.setAttribute("role", "status");
  const shareLabel = document.createElement("span");
  shareLabel.className = "participant-share-label";
  shareLabel.hidden = true;
  shareLabel.textContent = "Screen sharing";
  const video = document.createElement("video");
  const screenVideo = document.createElement("video");
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
  video.className = "camera-video";
  screenVideo.playsInline = true;
  screenVideo.hidden = true;
  screenVideo.className = "screen-video";
  meta.append(name, youBadge, micIndicator);
  videoStage.append(avatar, video, pausedChip, quality);
  videoStage.insertBefore(screenVideo, pausedChip);
  videoStage.append(state, shareLabel, meta);
  videoStage.append(menuTrigger);
  item.append(videoStage, audio);
  participants.append(item);
  participantOrder.push(participant.id);
  participantElements.set(participant.id, {
    item, name, youBadge, video, cameraVideo: video, screenVideo, audio, micIndicator, avatar, pausedChip, quality, state, shareLabel, menuTrigger,
    trackIDs: new Set()
  });
  item.dataset.mic = "unknown";
  setParticipantQuality(participantElements.get(participant.id), "unknown");
  updateParticipantTileState(participantElements.get(participant.id));
  updateParticipantAriaLabel(participantElements.get(participant.id));
  updateParticipantCount();
  updateScreenShareUI();
  renderMeetingLayout();
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
  updateParticipantTileState(element);
  updateParticipantAriaLabel(element);
  renderPeopleList();
}

function sendMediaState() {
  const audioEnabled = localStream?.getAudioTracks()[0]?.enabled === true;
  const videoTrack = localCameraTrack;
  const videoEnabled = !audioOnly?.checked && videoTrack?.enabled === true &&
    cameraRequested && !videoSuspended;
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
  for (const sender of [cameraSender, screenSender]) {
    if (!sender) continue;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].active = sender === screenSender
      ? sendingEnabled
      : sendingEnabled && cameraRequested;
    await sender.setParameters(parameters).catch(() => {});
  }
  if (localCameraTrack) localCameraTrack.enabled = sendingEnabled && cameraRequested;
  if (localScreenTrack) localScreenTrack.enabled = sendingEnabled;
  setLocalMediaControls();
  if (!sendingEnabled && automatic) setConnection("poor", "Unstable connection");
  sendMediaState();
}

async function setVideoSenderActive(enabled) {
  for (const sender of [cameraSender, screenSender]) {
    if (!sender) continue;
    const parameters = sender.getParameters();
    parameters.encodings = parameters.encodings?.length ? parameters.encodings : [{}];
    parameters.encodings[0].active = enabled;
    await sender.setParameters(parameters).catch(() => {});
  }
}

function setReceiveVideoControlLabel(button, enabled) {
  if (!button) return;
  const label = enabled ? "Incoming video" : "Incoming video off";
  const tooltip = enabled
    ? "Turn off video received by this device. Other participants can still see your camera."
    : "Turn on video received by this device.";
  const target = button.querySelector("[data-control-label]") || button.querySelector("span:not(.control-icon)");
  if (target) target.textContent = label;
  else button.textContent = label;
  updateControlLabel(button, enabled ? "Turn off incoming video" : "Turn on incoming video");
  button.dataset.tooltip = tooltip;
  button.setAttribute("aria-pressed", String(enabled));
  button.dataset.receiveVideo = enabled ? "on" : "off";
}

function setMoreIncomingVideoState(enabled) {
  if (moreStateBadge) moreStateBadge.hidden = enabled;
  if (!more) return;
  const label = meeting?.classList.contains("sidebar-open")
    ? "Close meeting controls"
    : enabled
      ? "Open more meeting controls"
      : "Open more meeting controls. Incoming video is off.";
  updateControlLabel(more, label);
  more.title = meeting?.classList.contains("sidebar-open")
    ? "Close meeting controls"
    : enabled ? "More controls" : "More controls. Incoming video is off";
}

function setReceiveVideo(enabled) {
  receiveVideoEnabled = enabled;
  setReceiveVideoControlLabel(receiveVideo, enabled);
  receiveVideo.setAttribute("aria-pressed", String(enabled));
  setMoreIncomingVideoState(enabled);
  for (const [participantID, element] of participantElements) {
    if (participantID !== localParticipantID) updateParticipantVideoVisibility(element);
  }
  renderPeopleList();
  updateConnectionSummary(lastConnectionLevel || "connecting", networkLabel?.textContent || "Connecting");
  showToast(enabled ? "Incoming video is on for this device." : "Incoming video is off for this device.");
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
    if (element.shareLabel) element.shareLabel.hidden = participantID !== screenShareOwner;
  });
  updateParticipantPagination();
  if (participants) {
    participants.dataset.sharingOwner = String(Boolean(screenShareOwner));
    participants.dataset.sharingLocal = String(screenShareOwner === localParticipantID);
  }
  meetingViewState.activeScreenShareId = screenShareOwner || (screenStream ? localParticipantID : null);
  participantElements.forEach((element) => updateParticipantVideoVisibility(element));
  renderMeetingLayout();
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

function requestScreenShare(active, mediaStreamID = "") {
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
        screen_share_active: false, media_stream_id: ""
        }));
      }
      reject(new Error("screen share request timed out"));
    }, 5000);
    screenShareRequest = { active, resolve, reject, timer };
    socket?.send(JSON.stringify({
      version: 1, type: "screen_share", participant_id: localParticipantID,
      screen_share_active: active, media_stream_id: mediaStreamID
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
    localScreenStream = screenStream;
    localScreenTrack = screenStream.getVideoTracks()[0];
    if (!localScreenTrack) throw new Error("screen capture is unavailable");
    await requestScreenShare(true, screenStream.id);
    screenSender = peer.addTrack(localScreenTrack, screenStream);
    await setVideoSenderActive(true);
    const local = participantElements.get(localParticipantID);
    if (local) local.screenVideo.srcObject = screenStream;
    setLocalVideoMirror(false);
    meetingViewState.activeScreenShareId = localParticipantID;
    sendMediaState();
    updateScreenShareUI();
    renderMeetingLayout();
    localScreenTrack.addEventListener("ended", stopScreenShare, { once: true });
  } catch (error) {
    screenStream?.getTracks().forEach((track) => track.stop());
    screenStream = undefined;
    localScreenStream = undefined;
    localScreenTrack = undefined;
    if (screenShareOwner === localParticipantID) {
      socket?.send(JSON.stringify({
        version: 1, type: "screen_share", participant_id: localParticipantID,
        screen_share_active: false, media_stream_id: ""
      }));
    }
    updateScreenShareUI();
    if (error.name !== "NotAllowedError") status.textContent = `Screen share unavailable: ${error.message}`;
  }
}

async function stopScreenShare() {
  if (!screenStream) return;
  const wasAutomaticallySuspended = videoSuspended && videoSuspendedAutomatically;
  if (screenSender && peer) {
    peer.removeTrack(screenSender);
    screenSender = undefined;
    await renegotiateLocalMedia();
  }
  localScreenTrack?.stop();
  screenStream.getTracks().forEach((track) => track.stop());
  screenStream = undefined;
  localScreenStream = undefined;
  localScreenTrack = undefined;
  meetingViewState.activeScreenShareId = screenShareOwner === localParticipantID ? localParticipantID : null;
  if (socket?.readyState === WebSocket.OPEN && localParticipantID) {
    socket.send(JSON.stringify({
      version: 1, type: "screen_share", participant_id: localParticipantID,
      screen_share_active: false
    }));
  }
  const local = participantElements.get(localParticipantID);
  if (local) local.screenVideo.srcObject = null;
  setLocalVideoMirror(true);
  await setVideoSending(!videoSuspended, wasAutomaticallySuspended).catch(() => {});
  sendMediaState();
  updateScreenShareUI();
  renderMeetingLayout();
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

camera.addEventListener("click", async () => {
  audioContext?.resume().catch(() => {});
  if (audioOnly?.checked) {
    showToast("Turn off Protect audio before enabling the camera");
    return;
  }
  if (!cameraRequested && selectedCameraQuality === "off") {
    cameraQuality?.focus();
    showToast("Choose a camera quality before turning the camera on");
    return;
  }
  try {
    if (cameraRequested) await disableCamera();
    else await enableCamera();
  } catch (error) {
    cameraRequested = false;
    meetingViewState.cameraEnabled = false;
    setLocalMediaControls();
    status.textContent = mediaAccessMessage("video", error);
  }
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
  closeParticipantMenu(false);
  pinnedParticipantID = undefined;
  participants.classList.remove("has-pinned");
  participants.dataset.pinned = "false";
  for (const timer of participantRemovalTimers.values()) clearTimeout(timer);
  participantRemovalTimers.clear();
  localStream = undefined;
  localAudioStream = undefined;
  localCameraStream = undefined;
  localScreenStream = undefined;
  screenStream = undefined;
  localCameraTrack = undefined;
  localScreenTrack = undefined;
  cameraSender = undefined;
  screenSender = undefined;
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
  remoteTrackRoles.clear();
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
  cameraQuality.value = selectedCameraQuality;
  audioOnly.checked = false;
  cameraBeforeAudioOnly = false;
  pendingCandidates.splice(0);
  updateControlLabel(mic, "Unmute microphone");
  mic.setAttribute("aria-pressed", "false");
  updateControlLabel(camera, "Turn camera on");
  camera.setAttribute("aria-pressed", "false");
  mic.disabled = false;
  camera.disabled = false;
  receiveVideoEnabled = true;
  setReceiveVideoControlLabel(receiveVideo, true);
  setMoreIncomingVideoState(true);
  updateControlLabel(screen, "Share screen");
  screen.setAttribute("aria-pressed", "false");
  screenShareOwner = undefined;
  screenShareEnabled = true;
  updateScreenShareUI();
  closeOpenPanel(false);
  setConnection("", "Connecting");
  lastConnectionLevel = "";
  pendingConnectionLevel = "";
  pendingConnectionSamples = 0;
  diagnostics.textContent = "Waiting for media statistics…";
  if (settingsPreview) {
    settingsPreview.srcObject = null;
    settingsPreview.hidden = true;
  }
  if (meetingAlert) meetingAlert.hidden = true;
  if (selfView) selfView.checked = selfViewVisible;
  participantElements.clear();
  participantOrder.splice(0);
  participants.replaceChildren();
  updateParticipantPagination();
  brandBar.hidden = false;
  welcomeGrid.hidden = true;
  meeting.hidden = true;
  form.hidden = true;
  if (meetingEnded) meetingEnded.hidden = false;
  joinButton.disabled = false;
});

rejoin?.addEventListener("click", () => {
  meetingEnded.hidden = true;
  welcomeGrid.hidden = false;
  form.hidden = false;
  joinButton.disabled = false;
  nameInput.focus();
});
