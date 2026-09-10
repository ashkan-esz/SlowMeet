const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  parseMetrics,
  capacityState,
  formatBitrate,
  formatSampleAge,
  classifyNetworkHealth,
  displayKbps,
  bitrateFromKbps,
  validateSettings,
  buildDiagnostics
} = require('../web/js/admin-utils.js');

assert.deepEqual(parseMetrics('lowmeet_active_participants 4\nlowmeet_last_rtt_ms 280.0\n'), {
  active_participants: 4,
  last_rtt_ms: 280
});
assert.equal(capacityState(4, 5).fraction, 0.8);
assert.match(capacityState(5, 5).ariaLabel, /full/);
assert.match(capacityState(1, 1).label, /participant allowed/);
assert.equal(formatBitrate(500000), '500 kbps');
assert.equal(formatBitrate(null), 'No data');
assert.equal(formatSampleAge(new Date('2026-09-07T00:00:00Z'), new Date('2026-09-07T00:00:04Z')), 'just now');
assert.equal(formatSampleAge(new Date('2026-09-07T00:00:00Z'), new Date('2026-09-07T00:01:00Z')), '1 minute ago');
assert.equal(classifyNetworkHealth({network_samples_total: 0}).level, 'unknown');
assert.equal(classifyNetworkHealth({network_samples_total: 1, average_rtt_ms: 280, last_packet_loss_percent: 0.4}).label, 'Watch');
assert.equal(classifyNetworkHealth({network_samples_total: 1, average_rtt_ms: 84, last_packet_loss_percent: 0.4}).label, 'Good');
assert.equal(classifyNetworkHealth({network_samples_total: 1, average_rtt_ms: 600, last_packet_loss_percent: 12}).label, 'Critical');
assert.equal(classifyNetworkHealth({network_samples_total: 1, last_video_kbps: 500}).label, 'No sample');
assert.equal(displayKbps(64000), '64');
assert.equal(bitrateFromKbps('64'), 64000);
assert.equal(Object.keys(validateSettings({
  max_participants: 5,
  default_video_quality: 'high',
  max_video_quality: 'medium',
  max_video_bitrate: 500000,
  max_video_fps: 30,
  max_audio_bitrate: 64000
})).length, 1);
assert.equal(validateSettings({
  max_participants: 5,
  default_video_quality: 'low',
  max_video_quality: 'high',
  max_video_bitrate: 500000,
  max_video_fps: 10,
  max_audio_bitrate: 32000
}, {default_video_fps: 15, default_audio_bitrate: 48000}).max_video_fps,
  'Maximum video FPS cannot be below the default of 15 FPS.');
assert.equal(validateSettings({
  max_participants: 5,
  default_video_quality: 'low',
  max_video_quality: 'high',
  max_video_bitrate: 500000,
  max_video_fps: 30,
  max_audio_bitrate: 32000
}, {default_video_fps: 15, default_audio_bitrate: 48000}).max_audio_bitrate,
  'Maximum audio bitrate cannot be below the default audio bitrate.');

const diagnostics = buildDiagnostics({
  capturedAt: '2026-09-03T00:00:00Z',
  metrics: {
    active_participants: 1,
    max_participants: 5,
    last_audio_kbps: 32,
    last_network_sample_timestamp_seconds: 1788393600
  },
  settings: {
    default_video_quality: 'medium',
    max_video_quality: 'high',
    max_video_bitrate: 500000,
    max_video_fps: 30,
    max_audio_bitrate: 64000,
    screen_share_enabled: true
  }
});
assert.match(diagnostics, /active_participants/);
assert.match(diagnostics, /screen_share_enabled/);
assert.match(diagnostics, /last_network_sample_timestamp_seconds/);
assert.ok(!diagnostics.includes('password'));
assert.ok(!diagnostics.includes('reconnect_token'));

const adminSource = fs.readFileSync(path.join(__dirname, '..', 'web/js/admin.js'), 'utf8');
const adminMarkup = fs.readFileSync(path.join(__dirname, '..', 'web/admin.html'), 'utf8');
assert.match(adminSource, /fetch\("\/config", \{cache: "no-store"\}\)/);
assert.match(adminSource, /const confirmed = await response\.json\(\);/);
assert.match(adminSource, /last_network_sample_timestamp_seconds/);
assert.match(adminSource, /document\.addEventListener\("visibilitychange"/);
assert.match(adminSource, /applySettingsToForm\(settingsValues\)/);
assert.match(adminSource, /if \(!password\.value\) return Promise\.resolve\(false\);/);
assert.match(adminMarkup, /id="health-check"/);
assert.match(adminMarkup, /id="ready-check"/);
assert.match(adminMarkup, /id="network-health-status"/);
assert.match(adminMarkup, /id="password"[^>]+aria-describedby="password-help"/);
assert.match(adminMarkup, /id="service-label"[^>]+aria-live="polite"/);
assert.match(adminSource, /retain_chat_history/);
assert.match(adminMarkup, /id="retain-chat-history"/);
assert.match(adminMarkup, /removed 30 minutes after the room becomes empty/);
assert.ok(!adminMarkup.includes('Authenticate to view'));
console.log('Admin dashboard tests passed');
