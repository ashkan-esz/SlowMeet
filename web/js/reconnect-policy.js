// Decides what the client does after its signaling socket closes
// unexpectedly. attempts is the number of consecutive failed signaling
// sessions including this one (app.js increments it before asking and resets
// it only once media connects). Past maxAttempts the client gives up and goes
// Offline until the user leaves and rejoins; before that it retries with an
// exponential backoff of 2, 4, 8, 16 and then 30 seconds.
function nextReconnectStep(attempts, maxAttempts = 5) {
  if (attempts > maxAttempts) return { offline: true };
  return { offline: false, delayMs: Math.min(30000, 2000 * 2 ** Math.min(attempts - 1, 4)) };
}

// The full retry schedule for a run of failures that never reaches connected
// media: one delay per attempt before the client goes Offline.
function reconnectSchedule(maxAttempts = 5) {
  const delays = [];
  for (let attempts = 1; ; attempts++) {
    const step = nextReconnectStep(attempts, maxAttempts);
    if (step.offline) return delays;
    delays.push(step.delayMs);
  }
}

if (typeof module !== "undefined") {
  module.exports = { nextReconnectStep, reconnectSchedule };
}
