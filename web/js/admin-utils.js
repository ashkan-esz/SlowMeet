(function (global) {
  function parseMetrics(body) {
    return body.split('\n').reduce((values, line) => {
      const match = line.match(/^lowmeet_([a-z0-9_]+)\s+([-+]?[0-9]*\.?[0-9]+)$/);
      if (match) values[match[1]] = Number(match[2]);
      return values;
    }, {});
  }

  function capacityState(active, max) {
    if (!Number.isFinite(active) || !Number.isFinite(max) || max <= 0) {
      return {fraction: 0, label: 'Waiting for metrics', ariaLabel: 'Capacity unavailable'};
    }
    const fraction = Math.min(1, Math.max(0, active / max));
    const countLabel = `${active} of ${max} participant${max === 1 ? '' : 's'} allowed`;
    if (fraction >= 1) {
      return {fraction, label: `${countLabel} · full`, ariaLabel: `${countLabel}; meeting is full`};
    }
    if (fraction >= 0.8) {
      return {fraction, label: `${countLabel} · nearly full`, ariaLabel: `${countLabel}; meeting is nearly full`};
    }
    return {fraction, label: countLabel, ariaLabel: `${countLabel}; capacity available`};
  }

  function buildDiagnostics(input) {
    const metrics = input.metrics || {};
    const settings = input.settings || {};
    return JSON.stringify({
      captured_at: input.capturedAt,
      service: {
        active_participants: metrics.active_participants ?? null,
        max_participants: metrics.max_participants ?? null,
        peer_connections: metrics.peer_connections ?? null,
        reconnects_total: metrics.reconnects_total ?? null,
        connection_failures_total: metrics.connection_failures_total ?? null
      },
      network: {
        network_samples_total: metrics.network_samples_total ?? null,
        average_rtt_ms: metrics.average_rtt_ms ?? null,
        last_rtt_ms: metrics.last_rtt_ms ?? null,
        last_packet_loss_percent: metrics.last_packet_loss_percent ?? null,
        last_jitter_ms: metrics.last_jitter_ms ?? null,
        last_video_kbps: metrics.last_video_kbps ?? null,
        last_audio_kbps: metrics.last_audio_kbps ?? null
      },
      policy: {
        max_video_bitrate: settings.max_video_bitrate ?? metrics.max_video_bitrate ?? null,
        max_audio_bitrate: settings.max_audio_bitrate ?? metrics.max_audio_bitrate ?? null
      }
    }, null, 2);
  }

  global.parseMetrics = parseMetrics;
  global.capacityState = capacityState;
  global.buildDiagnostics = buildDiagnostics;
  if (typeof module !== 'undefined') {
    module.exports = {parseMetrics, capacityState, buildDiagnostics};
  }
})(typeof window !== 'undefined' ? window : globalThis);
