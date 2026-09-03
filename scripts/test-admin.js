const assert = require('node:assert/strict');
const {parseMetrics, capacityState, buildDiagnostics} = require('../web/js/admin-utils.js');

assert.deepEqual(parseMetrics('lowmeet_active_participants 4\nlowmeet_last_rtt_ms 280.0\n'), {
  active_participants: 4,
  last_rtt_ms: 280
});
assert.equal(capacityState(4, 5).fraction, 0.8);
assert.match(capacityState(5, 5).ariaLabel, /full/);
assert.match(capacityState(1, 1).label, /participant allowed/);

const diagnostics = buildDiagnostics({
  capturedAt: '2026-09-03T00:00:00Z',
  metrics: {active_participants: 1, max_participants: 5, last_audio_kbps: 32},
  settings: {max_video_bitrate: 500000}
});
assert.match(diagnostics, /active_participants/);
assert.ok(!diagnostics.includes('password'));
assert.ok(!diagnostics.includes('reconnect_token'));
console.log('Admin dashboard tests passed');
