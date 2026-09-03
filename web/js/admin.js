const form = document.querySelector("#admin-form");
const password = document.querySelector("#password");
const status = document.querySelector("#status");
const save = document.querySelector("#save");
const refresh = document.querySelector("#refresh");
const serviceLabel = document.querySelector("#service-label");
const serviceDetail = document.querySelector("#service-detail");
const signalRail = document.querySelector(".signal-rail");
const updatedAt = document.querySelector("#updated-at");
const policySummary = document.querySelector("#policy-summary");
const recentEvents = document.querySelector("#recent-events");
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
let settingsValues = {};
let metricsStale = false;

function recordEvent(label) {
  if (!recentEvents) return;
  recentEvents.querySelector(".empty-event")?.remove();
  const item = document.createElement("li");
  const eventLabel = document.createElement("strong");
  const timestamp = document.createElement("time");
  const now = new Date();
  eventLabel.textContent = label;
  timestamp.dateTime = now.toISOString();
  timestamp.textContent = now.toLocaleTimeString([], {hour: "2-digit", minute: "2-digit"});
  item.append(eventLabel, timestamp);
  recentEvents.prepend(item);
  while (recentEvents.children.length > 4) recentEvents.lastElementChild.remove();
}

function renderPolicySummary(values) {
  if (!policySummary) return;
  const summaryValues = policySummary.querySelectorAll("dd");
  if (summaryValues.length < 3) return;
  const videoQuality = values.default_video_quality || "unknown";
  const maxVideoQuality = values.max_video_quality || "unknown";
  const videoBitrate = Number.isFinite(values.max_video_bitrate) ?
    `${Math.round(values.max_video_bitrate / 1000)} kbps max` : "bitrate unavailable";
  const audioBitrate = Number.isFinite(values.max_audio_bitrate) ?
    `${Math.round(values.max_audio_bitrate / 1000)} kbps max` : "bitrate unavailable";
  summaryValues[0].textContent = `${videoQuality} default · ${maxVideoQuality} max · ${videoBitrate}`;
  summaryValues[1].textContent = audioBitrate;
  summaryValues[2].textContent = values.screen_share_enabled ? "Screen sharing allowed" : "Screen sharing disabled";
}

function setServiceState(level, label, detail) {
  const changed = serviceLabel.textContent !== label || serviceDetail.textContent !== detail;
  signalRail.className = `signal-rail ${level}`;
  serviceLabel.textContent = label;
  serviceDetail.textContent = detail;
  if (changed && label !== "Checking service") recordEvent(label);
}

function formatMetric(value, suffix = "") {
  return Number.isFinite(value) && value >= 0 ? `${value}${suffix}` : "No sample yet";
}

function renderMetrics(values) {
  latestMetrics = values;
  latestMetricsAt = new Date();
  const active = values.active_participants;
  const max = values.max_participants;
  metricFields.active.textContent = Number.isFinite(active) ? active : "—";
  const capacity = capacityState(active, max);
  metricFields.capacity.textContent = capacity.label;
  metricFields.capacityMeter.value = capacity.fraction;
  metricFields.capacityMeter.setAttribute("aria-label", capacity.ariaLabel);
  metricFields.peers.textContent = Number.isFinite(values.peer_connections) ? values.peer_connections : "—";
  metricFields.reconnects.textContent = `${values.reconnects_total || 0} reconnects`;
  const hasSamples = values.network_samples_total > 0;
  metricFields.averageRtt.textContent = hasSamples ? formatMetric(values.average_rtt_ms, " ms") : "No sample yet";
  metricFields.latestRtt.textContent = hasSamples ? formatMetric(values.last_rtt_ms, " ms") : "No sample yet";
  metricFields.packetLoss.textContent = hasSamples && Number.isFinite(values.last_packet_loss_percent) ?
    `${values.last_packet_loss_percent.toFixed(1)}%` : "No sample yet";
  metricFields.jitter.textContent = hasSamples ? formatMetric(values.last_jitter_ms, " ms") : "No sample yet";
  metricFields.video.textContent = hasSamples ? formatMetric(values.last_video_kbps, " kbps") : "No sample yet";
  metricFields.audio.textContent = hasSamples ? formatMetric(values.last_audio_kbps, " kbps") : "No sample yet";
  metricFields.samples.textContent = values.network_samples_total || 0;
  metricFields.failures.textContent = values.connection_failures_total || 0;
  const degraded = values.last_packet_loss_percent > 5 || values.average_rtt_ms > 250;
  metricFields.network.textContent = degraded ? "Video may be degrading" : "Audio is prioritized";
  if (serviceLabel.textContent !== "Service unavailable") {
    setServiceState(degraded ? "warning" : "success", degraded ? "Network watch" : "Service ready",
      degraded ? "Video may reduce quality" : "Meeting path is available");
  }
}

async function refreshHealth() {
  const response = await fetch("/ready", {cache: "no-store"});
  if (!response.ok) throw new Error("Service is not ready");
  if (signalRail.classList.contains("warning")) return;
  setServiceState("success", "Service ready", "Meeting path is available");
}

async function refreshMetrics() {
  const response = await fetch("/metrics", {cache: "no-store"});
  if (!response.ok) throw new Error(`Metrics unavailable (${response.status})`);
  renderMetrics(parseMetrics(await response.text()));
  updatedAt.textContent = `Updated ${latestMetricsAt.toLocaleTimeString()}`;
}

async function refreshStatus() {
  refresh.disabled = true;
  const [healthResult, metricsResult] = await Promise.allSettled([refreshHealth(), refreshMetrics()]);
  if (healthResult.status === "rejected") {
    setServiceState("danger", "Service unavailable", healthResult.reason.message);
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
  refresh.disabled = false;
}

async function loadSettings() {
  if (!password.value) return;
  try {
    const response = await fetch("/admin/config", {
      cache: "no-store",
      headers: {"X-Admin-Password": password.value}
    });
    if (response.status === 401) {
      status.textContent = "Admin password rejected.";
      document.querySelector("#save-state").textContent = "Protected";
      password.value = "";
      return;
    }
    if (!response.ok) {
      status.textContent = `Could not load settings (${response.status}).`;
      return;
    }
    const values = await response.json();
    settingsValues = values;
    fields.max_participants.value = values.max_participants;
    fields.default_video_quality.value = values.default_video_quality;
    fields.max_video_quality.value = values.max_video_quality;
    fields.max_video_bitrate.value = values.max_video_bitrate;
    fields.max_video_fps.value = values.max_video_fps;
    fields.max_audio_bitrate.value = values.max_audio_bitrate;
    fields.screen_share_enabled.checked = values.screen_share_enabled;
    renderPolicySummary(values);
    status.textContent = "Loaded.";
    document.querySelector("#save-state").textContent = "Authenticated";
    recordEvent("Settings loaded");
  } catch (_) {
    status.textContent = "Could not reach the service. Settings were not loaded.";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  save.disabled = true;
  status.textContent = "Saving…";
  save.textContent = "Saving settings…";
  const body = {
    max_participants: Number(fields.max_participants.value),
    default_video_quality: fields.default_video_quality.value,
    max_video_quality: fields.max_video_quality.value,
    max_video_bitrate: Number(fields.max_video_bitrate.value),
    max_video_fps: Number(fields.max_video_fps.value),
    max_audio_bitrate: Number(fields.max_audio_bitrate.value),
    screen_share_enabled: fields.screen_share_enabled.checked
  };
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
    } else if (!response.ok) {
      status.textContent = `Could not save settings (${response.status}).`;
    } else {
      settingsValues = body;
      renderPolicySummary(body);
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
refresh.addEventListener("click", refreshStatus);
document.querySelector("#copy-diagnostics").addEventListener("click", async () => {
  const report = buildDiagnostics({
    capturedAt: latestMetricsAt ? latestMetricsAt.toISOString() : null,
    metrics: latestMetrics,
    settings: settingsValues
  });
  try {
    await navigator.clipboard.writeText(report);
    document.querySelector("#diagnostics-status").textContent = "Diagnostics copied.";
  } catch (_) {
    document.querySelector("#diagnostics-status").textContent =
      "Clipboard unavailable; select the metrics manually.";
  }
});
refreshStatus();
setInterval(refreshStatus, 10000);
