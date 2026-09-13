(function (global) {
  function parseMetrics(body) {
    return body.split('\n').reduce((values, line) => {
      const match = line.match(/^slowmeet_([a-z0-9_]+)\s+([-+]?[0-9]*\.?[0-9]+)$/);
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

  function formatBitrate(value) {
    if (!Number.isFinite(value) || value < 0) return 'No data';
    const kbps = value / 1000;
    if (kbps >= 1000) return `${(kbps / 1000).toFixed(kbps % 1000 === 0 ? 0 : 1)} Mbps`;
    return `${Number.isInteger(kbps) ? kbps : kbps.toFixed(1)} kbps`;
  }

  function formatSampleAge(sampleAt, now = new Date()) {
    if (!(sampleAt instanceof Date) || Number.isNaN(sampleAt.getTime()) ||
        !(now instanceof Date) || Number.isNaN(now.getTime())) return 'Unknown age';
    const seconds = Math.max(0, Math.floor((now.getTime() - sampleAt.getTime()) / 1000));
    if (seconds < 5) return 'just now';
    if (seconds < 60) return `${seconds} seconds ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  }

  function classifyNetworkHealth(values = {}) {
    if (!(values.network_samples_total > 0)) {
      return {level: 'unknown', label: 'No sample', detail: 'Awaiting network sample'};
    }
    const rtt = Number.isFinite(values.average_rtt_ms) ? values.average_rtt_ms : values.last_rtt_ms;
    const loss = values.last_packet_loss_percent;
    const jitter = values.last_jitter_ms;
    if (![rtt, loss, jitter].some(Number.isFinite)) {
      return {level: 'unknown', label: 'No sample', detail: 'No quality sample available'};
    }
    if ((Number.isFinite(rtt) && rtt > 500) || (Number.isFinite(loss) && loss > 10)) {
      return {level: 'danger', label: 'Critical', detail: 'Video may be reduced to protect audio'};
    }
    if ((Number.isFinite(rtt) && rtt > 250) || (Number.isFinite(loss) && loss >= 2)) {
      return {level: 'warning', label: 'Watch', detail: 'Video may reduce quality'};
    }
    return {level: 'success', label: 'Good', detail: 'Audio is prioritized'};
  }

  function displayKbps(value) {
    if (!Number.isFinite(value) || value < 0) return '';
    const kbps = value / 1000;
    return Number.isInteger(kbps) ? String(kbps) : kbps.toFixed(1);
  }

  function bitrateFromKbps(value) {
    const kbps = Number(value);
    return Number.isFinite(kbps) && kbps > 0 ? Math.round(kbps * 1000) : kbps;
  }

  function validateSettings(values, defaults = {}) {
    const errors = {};
    const qualityRank = {low: 0, medium: 1, high: 2};
    if (!Number.isInteger(values.max_participants) || values.max_participants < 1 || values.max_participants > 100) {
      errors.max_participants = 'Maximum participants must be a whole number from 1 to 100.';
    }
    if (!(values.default_video_quality in qualityRank)) {
      errors.default_video_quality = 'Choose a supported default video quality.';
    }
    if (!(values.max_video_quality in qualityRank)) {
      errors.max_video_quality = 'Choose a supported maximum video quality.';
    } else if (values.default_video_quality in qualityRank &&
      qualityRank[values.default_video_quality] > qualityRank[values.max_video_quality]) {
      errors.default_video_quality = 'Default quality cannot exceed the maximum quality.';
    }
    if (!Number.isInteger(values.max_video_bitrate) || values.max_video_bitrate < 1) {
      errors.max_video_bitrate = 'Maximum video bitrate must be positive.';
    }
    const defaultVideoFPS = Number(defaults.default_video_fps);
    if (!Number.isInteger(values.max_video_fps) || values.max_video_fps < 1 || values.max_video_fps > 60) {
      errors.max_video_fps = 'Maximum video FPS must be a whole number from 1 to 60.';
    } else if (Number.isFinite(defaultVideoFPS) && values.max_video_fps < defaultVideoFPS) {
      errors.max_video_fps = `Maximum video FPS cannot be below the default of ${defaultVideoFPS} FPS.`;
    }
    const defaultAudioBitrate = Number(defaults.default_audio_bitrate);
    if (!Number.isInteger(values.max_audio_bitrate) || values.max_audio_bitrate < 1) {
      errors.max_audio_bitrate = 'Maximum audio bitrate must be positive.';
    } else if (Number.isFinite(defaultAudioBitrate) && values.max_audio_bitrate < defaultAudioBitrate) {
      errors.max_audio_bitrate = 'Maximum audio bitrate cannot be below the default audio bitrate.';
    }
    return errors;
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
        last_network_sample_timestamp_seconds: metrics.last_network_sample_timestamp_seconds ?? null,
        average_rtt_ms: metrics.average_rtt_ms ?? null,
        last_rtt_ms: metrics.last_rtt_ms ?? null,
        last_packet_loss_percent: metrics.last_packet_loss_percent ?? null,
        last_jitter_ms: metrics.last_jitter_ms ?? null,
        last_video_kbps: metrics.last_video_kbps ?? null,
        last_audio_kbps: metrics.last_audio_kbps ?? null
      },
      policy: {
        default_video_quality: settings.default_video_quality ?? null,
        max_video_quality: settings.max_video_quality ?? null,
        max_video_bitrate: settings.max_video_bitrate ?? metrics.max_video_bitrate ?? null,
        max_video_fps: settings.max_video_fps ?? null,
        max_audio_bitrate: settings.max_audio_bitrate ?? metrics.max_audio_bitrate ?? null,
        screen_share_enabled: settings.screen_share_enabled ?? null
      }
    }, null, 2);
  }

  global.parseMetrics = parseMetrics;
  global.capacityState = capacityState;
  global.formatBitrate = formatBitrate;
  global.formatSampleAge = formatSampleAge;
  global.classifyNetworkHealth = classifyNetworkHealth;
  global.displayKbps = displayKbps;
  global.bitrateFromKbps = bitrateFromKbps;
  global.validateSettings = validateSettings;
  global.buildDiagnostics = buildDiagnostics;
  if (typeof module !== 'undefined') {
    module.exports = {
      parseMetrics,
      capacityState,
      formatBitrate,
      formatSampleAge,
      classifyNetworkHealth,
      displayKbps,
      bitrateFromKbps,
      validateSettings,
      buildDiagnostics
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
