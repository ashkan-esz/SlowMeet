const form = document.querySelector("#admin-form");
const password = document.querySelector("#password");
const status = document.querySelector("#status");
const save = document.querySelector("#save");
const refresh = document.querySelector("#refresh");
const serviceLabel = document.querySelector("#service-label");
const serviceDetail = document.querySelector("#service-detail");
const signalRail = document.querySelector(".signal-rail");
const healthCheck = document.querySelector("#health-check");
const healthLabel = document.querySelector("#health-label");
const healthDetail = document.querySelector("#health-detail");
const readyCheck = document.querySelector("#ready-check");
const readyLabel = document.querySelector("#ready-label");
const readyDetail = document.querySelector("#ready-detail");
const updatedAt = document.querySelector("#updated-at");
const policySummary = document.querySelector("#policy-summary");
const recentEvents = document.querySelector("#recent-events");
const validationSummary = document.querySelector("#validation-summary");
const networkSampleAge = document.querySelector("#network-sample-age");
const networkHealthStatus = document.querySelector("#network-health-status");
const diagnosticsPreview = document.querySelector("#diagnostics-preview");
const adminNavLinks = [...document.querySelectorAll(".admin-nav .nav-link")];
const fields = {
  max_participants: document.querySelector("#participants"),
  default_video_quality: document.querySelector("#video-quality"),
  max_video_quality: document.querySelector("#max-video-quality"),
  max_video_bitrate: document.querySelector("#video-bitrate"),
  max_video_fps: document.querySelector("#video-fps"),
  max_audio_bitrate: document.querySelector("#audio-bitrate"),
  screen_share_enabled: document.querySelector("#screen-share")
};

const metricFields = {
  active: document.querySelector("#active-participants"),
  capacity: document.querySelector("#capacity-detail"),
  capacityMeter: document.querySelector("#capacity-meter"),
  peers: document.querySelector("#peer-connections"),
  reconnects: document.querySelector("#reconnect-count"),
  averageRtt: document.querySelector("#average-rtt"),
  latestRtt: document.querySelector("#latest-rtt"),
  latestPacketLoss: document.querySelector("#latest-packet-loss"),
  packetLoss: document.querySelector("#packet-loss"),
  jitter: document.querySelector("#jitter"),
  video: document.querySelector("#video-kbps"),
  audio: document.querySelector("#audio-kbps"),
  samples: document.querySelector("#network-samples"),
  failures: document.querySelector("#connection-failures"),
  network: document.querySelector("#network-detail")
};
let latestMetrics = {};
let latestMetricsAt = null;
let latestSampleAt = null;
let settingsValues = {};
let metricsStale = false;
let serviceAvailability = "checking";
let refreshTimer;
let refreshInFlight;
let settingsRequest;
let publicPolicyRequest;

function updateActiveNav() {
  const currentHash = location.hash || "#overview";
  adminNavLinks.forEach((link) => {
    const active = link.getAttribute("href") === currentHash;
    link.classList.toggle("nav-link--active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function activityLevel(label) {
  if (/unavailable|rejected|failed|error|offline|critical/i.test(label)) return "danger";
  if (/watch|stale|retry|degrad|reconnect|not ready/i.test(label)) return "warning";
  return "success";
}

function recordEvent(label, level = activityLevel(label)) {
  if (!recentEvents) return;
  recentEvents.querySelector(".empty-event")?.remove();
  const item = document.createElement("li");
  item.className = `activity-event activity-event--${level}`;
  item.dataset.level = level;
  const content = document.createElement("span");
  content.className = "activity-event__content";
  const indicator = document.createElement("span");
  indicator.className = "activity-event__indicator";
  indicator.setAttribute("aria-hidden", "true");
  const levelLabel = document.createElement("span");
  levelLabel.className = "sr-only";
  levelLabel.textContent = level === "danger" ? "Error: " : level === "warning" ? "Warning: " : "Success: ";
  const eventLabel = document.createElement("strong");
  const timestamp = document.createElement("time");
  const now = new Date();
  eventLabel.textContent = label;
  timestamp.dateTime = now.toISOString();
  timestamp.textContent = now.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  content.append(indicator, levelLabel, eventLabel);
  item.append(content, timestamp);
  recentEvents.prepend(item);
  while (recentEvents.children.length > 4) recentEvents.lastElementChild.remove();
}

function renderPolicySummary(values) {
  if (!policySummary) return;
  const summaryValues = policySummary.querySelectorAll("dd");
  if (summaryValues.length < 3) return;
  if (!values.default_video_quality && !values.max_video_quality) {
    summaryValues.forEach((value) => { value.textContent = "Enter admin password below"; });
    return;
  }
  const videoQuality = values.default_video_quality || "Unknown";
  const maxVideoQuality = values.max_video_quality || "Unknown";
  const videoBitrate = formatBitrate(values.max_video_bitrate);
  const audioBitrate = formatBitrate(values.max_audio_bitrate);
  const qualityLabel = (value) => value.charAt(0).toUpperCase() + value.slice(1);
  summaryValues[0].textContent = `${qualityLabel(videoQuality)} default · ${qualityLabel(maxVideoQuality)} max · ${videoBitrate}`;
  summaryValues[1].textContent = `${audioBitrate} max${Number.isFinite(values.max_video_fps) ? ` · ${values.max_video_fps} fps video` : ""}`;
  summaryValues[2].textContent = values.screen_share_enabled == null
    ? "Not available"
    : values.screen_share_enabled ? "Screen sharing allowed" : "Screen sharing disabled";
}

function setServiceState(level, label, detail, record = true) {
  const changed = serviceLabel.textContent !== label || serviceDetail.textContent !== detail;
  signalRail.className = `signal-rail ${level}`;
  serviceLabel.textContent = label;
  serviceDetail.textContent = detail;
  if (changed && record && label !== "Checking service") recordEvent(label, level);
}

function setServiceCheck(element, labelElement, detailElement, level, label, detail) {
  if (!element || !labelElement || !detailElement) return;
  element.dataset.level = level;
  labelElement.textContent = label;
  detailElement.textContent = detail;
}

function setChecksChecking() {
  setServiceCheck(healthCheck, healthLabel, healthDetail, "checking", "Health check", "Checking");
  setServiceCheck(readyCheck, readyLabel, readyDetail, "checking", "Meeting path", "Checking");
}

function renderServiceChecks(health, ready) {
  const healthOK = health.ok;
  const readyOK = ready.ok;
  setServiceCheck(healthCheck, healthLabel, healthDetail, healthOK ? "success" : "danger",
    healthOK ? "Health check" : "Health unavailable",
    healthOK ? "Responding" : health.detail);
  setServiceCheck(readyCheck, readyLabel, readyDetail, readyOK ? "success" : "danger",
    readyOK ? "Meeting path" : "Meeting path unavailable",
    readyOK ? "Ready" : ready.detail);
  serviceAvailability = !healthOK ? "unavailable" : !readyOK ? "degraded" : "available";
  const level = !healthOK ? "danger" : !readyOK ? "warning" : "success";
  const label = !healthOK ? "Service unavailable" : !readyOK ? "Service degraded" : "Service ready";
  const detail = !healthOK ? health.detail : !readyOK ? ready.detail : "Meeting path is available";
  setServiceState(level, label, detail);
}

function formatMetric(value, suffix = "") {
  return Number.isFinite(value) && value >= 0 ? `${value}${suffix}` : "No sample";
}

function formatCount(value, suffix = "") {
  return Number.isFinite(value) && value >= 0 ? `${value.toLocaleString()}${suffix}` : "No data";
}

function loadPublicPolicy() {
  if (publicPolicyRequest) return publicPolicyRequest;
  publicPolicyRequest = (async () => {
    try {
      const response = await fetch("/config", {cache: "no-store"});
      if (!response.ok) return false;
      const values = await response.json();
      settingsValues = {...values, ...settingsValues};
      applySettingsToForm(settingsValues);
      renderPolicySummary(settingsValues);
      return true;
    } catch (_) {
      return false;
    }
  })().finally(() => {
    publicPolicyRequest = undefined;
  });
  return publicPolicyRequest;
}

function collectSettings() {
  return {
    max_participants: Number(fields.max_participants.value),
    default_video_quality: fields.default_video_quality.value,
    max_video_quality: fields.max_video_quality.value,
    max_video_bitrate: bitrateFromKbps(fields.max_video_bitrate.value),
    max_video_fps: Number(fields.max_video_fps.value),
    max_audio_bitrate: bitrateFromKbps(fields.max_audio_bitrate.value),
    screen_share_enabled: fields.screen_share_enabled.checked
  };
}

function applySettingsToForm(values) {
  if (values.max_participants != null) fields.max_participants.value = values.max_participants;
  if (values.default_video_quality) fields.default_video_quality.value = values.default_video_quality;
  if (values.max_video_quality) fields.max_video_quality.value = values.max_video_quality;
  if (values.max_video_bitrate != null) fields.max_video_bitrate.value = displayKbps(values.max_video_bitrate);
  if (values.max_video_fps != null) fields.max_video_fps.value = values.max_video_fps;
  if (values.max_audio_bitrate != null) fields.max_audio_bitrate.value = displayKbps(values.max_audio_bitrate);
  if (values.screen_share_enabled != null) fields.screen_share_enabled.checked = values.screen_share_enabled;
}

function renderValidation(errors) {
  Object.entries(fields).forEach(([name, field]) => {
    if (!field) return;
    const invalid = Boolean(errors[name]);
    field.setAttribute("aria-invalid", String(invalid));
    field.setCustomValidity(errors[name] || "");
  });
  const messages = Object.values(errors);
  if (!validationSummary) return messages.length;
  validationSummary.hidden = messages.length === 0;
  validationSummary.textContent = messages.length ? messages.join(" ") : "";
  return messages.length;
}

function renderMetrics(values) {
  latestMetrics = values;
  latestMetricsAt = new Date();
  latestSampleAt = Number.isFinite(values.last_network_sample_timestamp_seconds) &&
    values.last_network_sample_timestamp_seconds > 0
    ? new Date(values.last_network_sample_timestamp_seconds * 1000)
    : null;
  const active = values.active_participants;
  const max = values.max_participants;
  metricFields.active.textContent = formatCount(active);
  const capacity = capacityState(active, max);
  metricFields.capacity.textContent = capacity.label;
  metricFields.capacityMeter.value = capacity.fraction;
  metricFields.capacityMeter.setAttribute("aria-label", capacity.ariaLabel);
  metricFields.peers.textContent = formatCount(values.peer_connections);
  metricFields.reconnects.textContent = formatCount(values.reconnects_total, " reconnects");
  const hasSamples = values.network_samples_total > 0;
  const packetLoss = hasSamples && Number.isFinite(values.last_packet_loss_percent)
    ? `${values.last_packet_loss_percent.toFixed(1)}%` : "No sample";
  metricFields.averageRtt.textContent = hasSamples ? formatMetric(values.average_rtt_ms, " ms") : "No sample";
  metricFields.latestRtt.textContent = hasSamples ? formatMetric(values.last_rtt_ms, " ms") : "No sample";
  metricFields.latestPacketLoss.textContent = packetLoss;
  metricFields.packetLoss.textContent = packetLoss;
  metricFields.jitter.textContent = hasSamples ? formatMetric(values.last_jitter_ms, " ms") : "No sample";
  metricFields.video.textContent = hasSamples ? formatMetric(values.last_video_kbps, " kbps") : "No sample";
  metricFields.audio.textContent = hasSamples ? formatMetric(values.last_audio_kbps, " kbps") : "No sample";
  metricFields.samples.textContent = formatCount(values.network_samples_total);
  metricFields.failures.textContent = formatCount(values.connection_failures_total);
  const networkHealth = classifyNetworkHealth(values);
  const sampleAgeSeconds = latestSampleAt
    ? Math.max(0, Math.floor((latestMetricsAt.getTime() - latestSampleAt.getTime()) / 1000))
    : null;
  if (networkSampleAge) {
    networkSampleAge.classList.toggle("is-stale", sampleAgeSeconds != null && sampleAgeSeconds >= 60);
    networkSampleAge.textContent = latestSampleAt
      ? `Last sample: ${formatSampleAge(latestSampleAt, latestMetricsAt)}`
      : hasSamples ? "Sample time unavailable" : "No network sample collected.";
  }
  if (networkHealthStatus) {
    networkHealthStatus.textContent = networkHealth.label;
    networkHealthStatus.dataset.level = networkHealth.level;
  }
  const degraded = networkHealth.level === "warning" || networkHealth.level === "danger";
  metricFields.network.textContent = !hasSamples
    ? "Awaiting network sample"
    : networkHealth.detail;
  if (serviceAvailability === "available") {
    setServiceState(degraded ? "warning" : "success", degraded ? "Network watch" : "Service ready",
      degraded ? networkHealth.detail : "Meeting path is available");
  }
}

async function refreshHealth() {
  const check = async (path) => {
    try {
      const response = await fetch(path, {cache: "no-store"});
      return {
        ok: response.ok,
        detail: response.ok ? "Responding" : `HTTP ${response.status}`
      };
    } catch (_) {
      return {ok: false, detail: "Request failed"};
    }
  };
  const [health, ready] = await Promise.all([check("/health"), check("/ready")]);
  renderServiceChecks(health, ready);
  if (!health.ok || !ready.ok) throw new Error("Service is not ready");
}

async function refreshMetrics() {
  const response = await fetch("/metrics", {cache: "no-store"});
  if (!response.ok) throw new Error(`Metrics unavailable (${response.status})`);
  renderMetrics(parseMetrics(await response.text()));
  updatedAt.textContent = `Updated ${latestMetricsAt.toLocaleTimeString()}`;
}

async function refreshStatus() {
  if (refreshInFlight) return refreshInFlight;
  refresh.disabled = true;
  refresh.textContent = "Refreshing…";
  serviceAvailability = "checking";
  setChecksChecking();
  setServiceState("checking", "Checking service", "Refreshing health and readiness", false);
  refreshInFlight = (async () => {
    const [healthResult, metricsResult] = await Promise.allSettled([refreshHealth(), refreshMetrics()]);
    if (healthResult.status === "rejected") {
      if (serviceLabel.textContent === "Checking service") {
        serviceAvailability = "unavailable";
        setServiceState("danger", "Service unavailable", healthResult.reason.message);
      }
    }
    if (metricsResult.status === "rejected") {
      updatedAt.textContent = latestMetricsAt ?
        `Stale · last updated ${latestMetricsAt.toLocaleTimeString()}` : "Metrics unavailable";
      metricFields.network.textContent = "Metrics unavailable; retry refresh";
      if (!metricsStale) recordEvent("Metrics unavailable; showing last known values");
      metricsStale = true;
    } else if (metricsStale) {
      recordEvent("Metrics recovered");
      metricsStale = false;
    }
  })().finally(() => {
    refresh.disabled = false;
    refresh.textContent = "Refresh status";
    refreshInFlight = undefined;
    scheduleRefresh();
  });
  return refreshInFlight;
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  if (document.hidden) return;
  refreshTimer = setTimeout(() => refreshStatus(), 10000);
}

function loadSettings({silent = false} = {}) {
  if (!password.value) return Promise.resolve(false);
  if (settingsRequest) return settingsRequest;
  settingsRequest = (async () => {
    try {
      const response = await fetch("/admin/config", {
        cache: "no-store",
        headers: {"X-Admin-Password": password.value}
      });
      if (response.status === 401) {
        renderPolicySummary(settingsValues);
        document.querySelector("#save-state").textContent = "Protected";
        password.value = "";
        if (!silent) status.textContent = "Admin password rejected.";
        return false;
      }
      if (!response.ok) {
        if (!silent) status.textContent = `Could not load settings (${response.status}).`;
        return false;
      }
      const values = await response.json();
      settingsValues = {...settingsValues, ...values};
      applySettingsToForm(values);
      renderValidation({});
      renderPolicySummary(values);
      if (!silent) status.textContent = "Loaded.";
      document.querySelector("#save-state").textContent = "Authenticated";
      recordEvent("Settings loaded");
      return true;
    } catch (_) {
      if (!silent) status.textContent = "Could not reach the service. Settings were not loaded.";
      return false;
    }
  })().finally(() => {
    settingsRequest = undefined;
  });
  return settingsRequest;
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const body = collectSettings();
  const errors = validateSettings(body, settingsValues);
  if (renderValidation(errors)) {
    status.textContent = "Review the highlighted settings before saving.";
    return;
  }
  save.disabled = true;
  status.textContent = "Saving…";
  save.textContent = "Saving settings…";
  try {
    const response = await fetch("/admin/config", {
      method: "POST",
      headers: {"Content-Type": "application/json", "X-Admin-Password": password.value},
      body: JSON.stringify(body)
    });
    if (response.status === 401) {
      status.textContent = "Admin password rejected.";
      password.value = "";
      document.querySelector("#save-state").textContent = "Protected";
    } else if (response.status === 400) {
      status.textContent = `Settings rejected: ${await response.text()}`;
      recordEvent("Settings rejected", "danger");
    } else if (!response.ok) {
      status.textContent = `Could not save settings (${response.status}).`;
    } else {
      const confirmed = await response.json();
      settingsValues = {...settingsValues, ...confirmed};
      applySettingsToForm(confirmed);
      renderValidation({});
      renderPolicySummary(settingsValues);
      status.textContent = "Settings saved. Changes are live.";
      document.querySelector("#save-state").textContent = "Saved";
      recordEvent("Settings saved");
      await refreshStatus();
    }
  } catch (_) {
    status.textContent = "Could not reach the service. Settings were not changed.";
  } finally {
    save.disabled = false;
    save.textContent = "Save settings";
  }
});

password.addEventListener("change", loadSettings);
password.addEventListener("blur", loadSettings);
Object.values(fields).forEach((field) => field?.addEventListener("input", () => {
  if (validationSummary && !validationSummary.hidden) renderValidation({});
}));
refresh.addEventListener("click", refreshStatus);
document.querySelector("#copy-diagnostics").addEventListener("click", async () => {
  const report = buildDiagnostics({
    capturedAt: latestMetricsAt ? latestMetricsAt.toISOString() : null,
    metrics: latestMetrics,
    settings: settingsValues
  });
  if (diagnosticsPreview) {
    diagnosticsPreview.hidden = false;
    diagnosticsPreview.textContent = report;
  }
  try {
    await navigator.clipboard.writeText(report);
    document.querySelector("#diagnostics-status").textContent = "Diagnostics copied.";
  } catch (_) {
    document.querySelector("#diagnostics-status").textContent =
      "Clipboard unavailable; select the redacted snapshot below and copy it manually.";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(refreshTimer);
    return;
  }
  refreshStatus();
});
window.addEventListener("hashchange", updateActiveNav);
updateActiveNav();
loadPublicPolicy();
refreshStatus();
