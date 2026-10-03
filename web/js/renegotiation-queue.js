function createRenegotiationQueue({
  isCurrent,
  isStable,
  sendOffer,
  onTimeout = () => {},
  offerTimeoutMs = 15000,
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  let pending = [];
  let inFlight = null;
  let pumping = false;
  let closed = false;
  let watchdogTimer;

  function clearWatchdog() {
    if (watchdogTimer === undefined) return;
    clearTimer(watchdogTimer);
    watchdogTimer = undefined;
  }

  function armWatchdog(message) {
    if (watchdogTimer !== undefined) return;
    watchdogTimer = setTimer(() => {
      watchdogTimer = undefined;
      if (closed || (!inFlight && pending.length === 0)) return;
      const error = new Error(message);
      close(error);
      onTimeout(error);
    }, offerTimeoutMs);
  }

  function settle(batch, method, value) {
    batch.forEach((request) => request[method](value));
  }

  function close(error = new Error("renegotiation queue closed")) {
    if (closed) return;
    closed = true;
    clearWatchdog();
    if (inFlight) settle(inFlight, "reject", error);
    settle(pending, "reject", error);
    inFlight = null;
    pending = [];
  }

  function pump() {
    if (closed || pumping || inFlight || pending.length === 0) return;
    if (!isCurrent()) {
      close(new Error("stale WebRTC connection"));
      return;
    }
    if (!isStable()) {
      armWatchdog("renegotiation timed out waiting for signaling stability");
      return;
    }

    clearWatchdog();
    const batch = pending;
    pending = [];
    inFlight = batch;
    armWatchdog("renegotiation attempt timed out");
    pumping = true;
    Promise.resolve()
      .then(sendOffer)
      .then((sent) => {
        if (inFlight !== batch) return;
        if (sent !== false) return;
        clearWatchdog();
        inFlight = null;
        pending = batch.concat(pending);
      })
      .catch((error) => {
        if (inFlight !== batch) return;
        clearWatchdog();
        inFlight = null;
        settle(batch, "reject", error);
      })
      .finally(() => {
        pumping = false;
        if (pending.length > 0 && !inFlight && !closed) pump();
      });
  }

  function request() {
    if (closed) return Promise.reject(new Error("renegotiation queue is closed"));
    if (!isCurrent()) {
      const error = new Error("stale WebRTC connection");
      close(error);
      return Promise.reject(error);
    }
    const requestPromise = new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
    });
    pump();
    return requestPromise;
  }

  function answer() {
    if (closed) return;
    if (!isCurrent()) {
      close(new Error("stale WebRTC connection"));
      return;
    }
    clearWatchdog();
    if (inFlight) {
      settle(inFlight, "resolve");
      inFlight = null;
    }
    pump();
  }

  function rollback() {
    if (closed || !inFlight) return;
    clearWatchdog();
    pending = inFlight.concat(pending);
    inFlight = null;
    armWatchdog("renegotiation timed out while resolving glare");
  }

  function fail(error) {
    if (closed || !inFlight) return;
    clearWatchdog();
    settle(inFlight, "reject", error);
    inFlight = null;
    pump();
  }

  function resume() {
    pump();
  }

  function hasPending() {
    return Boolean(inFlight) || pending.length > 0;
  }

  return { request, answer, rollback, fail, resume, close, hasPending };
}

if (typeof module !== "undefined") {
  module.exports = { createRenegotiationQueue };
}
