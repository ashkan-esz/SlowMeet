const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRenegotiationQueue } = require("../web/js/renegotiation-queue.js");

const tick = () => new Promise((resolve) => setImmediate(resolve));

function createManualTimers() {
  let nextID = 0;
  const timers = new Map();
  return {
    setTimer(callback, delay) {
      const id = ++nextID;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    count() {
      return timers.size;
    },
    activeIDs() {
      return [...timers.keys()];
    },
    fireAll() {
      const callbacks = [...timers.values()].map(({ callback }) => callback);
      timers.clear();
      callbacks.forEach((callback) => callback());
    }
  };
}

function createHarness({ timers, offerTimeoutMs = 15000, onTimeout = () => {}, sendOffer } = {}) {
  const peer = {
    signalingState: "stable",
    current: true,
    offers: 0,
    async createOffer() {
      this.offers += 1;
      return { type: "offer", sdp: `offer-${this.offers}` };
    },
    async setLocalDescription(description) {
      this.signalingState = description.type === "rollback" ? "stable" : "have-local-offer";
    }
  };
  const sentOffers = [];
  const queue = createRenegotiationQueue({
    isCurrent: () => peer.current,
    isStable: () => peer.signalingState === "stable",
    offerTimeoutMs,
    onTimeout,
    ...(timers ? { setTimer: timers.setTimer, clearTimer: timers.clearTimer } : {}),
    sendOffer: sendOffer || (async () => {
      if (peer.signalingState !== "stable") return false;
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sentOffers.push(offer.sdp);
      return true;
    })
  });
  return { peer, queue, sentOffers };
}

async function testRequestResolvesOnlyAfterItsAnswer() {
  const timers = createManualTimers();
  let timeoutCount = 0;
  const { peer, queue, sentOffers } = createHarness({ timers, onTimeout: () => { timeoutCount += 1; } });
  let resolved = false;
  const request = queue.request().then(() => { resolved = true; });
  await tick();
  assert.deepEqual(sentOffers, ["offer-1"]);
  assert.equal(timers.count(), 1, "a sent offer should have one answer watchdog");
  const firstWatchdog = timers.activeIDs()[0];
  assert.equal(resolved, false, "sending the offer must not resolve the request");

  const secondRequest = queue.request();
  await tick();
  assert.equal(sentOffers.length, 1, "track changes must wait while an offer is outstanding");
  peer.signalingState = "stable";
  queue.answer();
  assert.equal(timers.count(), 1, "answer should replace the completed attempt watchdog for the next offer");
  assert.notEqual(timers.activeIDs()[0], firstWatchdog);
  await request;
  await tick();
  assert.deepEqual(sentOffers, ["offer-1", "offer-2"]);

  let secondResolved = false;
  secondRequest.then(() => { secondResolved = true; });
  await tick();
  assert.equal(secondResolved, false);
  peer.signalingState = "stable";
  queue.answer();
  await secondRequest;
  assert.equal(secondResolved, true);
  assert.equal(timers.count(), 0);
  assert.equal(timeoutCount, 0);
}

async function testBusyPeerCoalescesAndResumesAfterRemoteOffer() {
  const { peer, queue, sentOffers } = createHarness();
  peer.signalingState = "have-local-offer";
  let resolved = false;
  const first = queue.request().then(() => { resolved = true; });
  const second = queue.request();
  await tick();
  assert.deepEqual(sentOffers, []);
  assert.equal(resolved, false);

  peer.signalingState = "have-remote-offer";
  peer.signalingState = "stable"; // Remote offer has been answered.
  queue.resume();
  await tick();
  assert.deepEqual(sentOffers, ["offer-1"], "queued changes should share one local offer");
  assert.equal(resolved, false);
  queue.answer();
  await Promise.all([first, second]);
}

async function testGlareRollsBackAndRetriesWithoutSettling() {
  const timers = createManualTimers();
  const { peer, queue, sentOffers } = createHarness({ timers });
  let resolved = false;
  const request = queue.request().then(() => { resolved = true; });
  await tick();
  assert.deepEqual(sentOffers, ["offer-1"]);
  assert.equal(timers.count(), 1);

  peer.signalingState = "have-local-offer";
  await peer.setLocalDescription({ type: "rollback" });
  queue.rollback();
  assert.deepEqual(sentOffers, ["offer-1"], "rollback must not send during the transition to the remote offer");
  assert.equal(timers.count(), 1, "rolled-back requests should remain covered while glare is resolved");
  peer.signalingState = "have-remote-offer";
  peer.signalingState = "stable"; // Answer the colliding remote offer.
  queue.resume();
  await tick();
  assert.deepEqual(sentOffers, ["offer-1", "offer-2"]);
  assert.equal(timers.count(), 1, "retry should get a fresh watchdog");
  assert.equal(resolved, false, "a rolled-back offer must not settle the request");

  queue.answer();
  await request;
  assert.equal(timers.count(), 0);
  assert.equal(resolved, true);
}

async function testTimeoutRejectsAllRequestsAndSignalsReconnect() {
  const timers = createManualTimers();
  const timeoutErrors = [];
  const { peer, queue, sentOffers } = createHarness({
    timers,
    offerTimeoutMs: 15000,
    onTimeout: (error) => {
      timeoutErrors.push(error);
      peer.current = false;
    }
  });
  const first = queue.request();
  await tick();
  const second = queue.request();
  await tick();
  assert.deepEqual(sentOffers, ["offer-1"]);
  assert.equal(timers.count(), 1);

  timers.fireAll();
  await assert.rejects(first, /renegotiation attempt timed out/);
  await assert.rejects(second, /renegotiation attempt timed out/);
  assert.equal(timeoutErrors.length, 1);
  assert.equal(peer.current, false, "timeout callback should invalidate the peer connection");
  assert.equal(timers.count(), 0);
  await assert.rejects(queue.request(), /renegotiation queue is closed/);
}

async function testDeadlineStartsBeforeOfferCreationCompletes() {
  const timers = createManualTimers();
  let finishOffer;
  const { queue } = createHarness({
    timers,
    sendOffer: () => new Promise((resolve) => { finishOffer = resolve; })
  });
  const request = queue.request();
  await tick();
  assert.equal(typeof finishOffer, "function");
  assert.equal(timers.count(), 1, "deadline should run while offer creation is pending");

  timers.fireAll();
  await assert.rejects(request, /renegotiation attempt timed out/);
  finishOffer(true);
  await tick();
  assert.equal(timers.count(), 0);
}

async function testBlockedRequestsAlsoHaveAWatchdog() {
  const timers = createManualTimers();
  let timeoutCount = 0;
  const { peer, queue, sentOffers } = createHarness({
    timers,
    onTimeout: () => {
      timeoutCount += 1;
      peer.current = false;
    }
  });
  peer.signalingState = "have-local-offer";
  const first = queue.request();
  const second = queue.request();
  await tick();
  assert.deepEqual(sentOffers, [], "unstable signaling should keep requests queued");
  assert.equal(timers.count(), 1, "blocked requests should share one stability watchdog");

  timers.fireAll();
  await assert.rejects(first, /timed out waiting for signaling stability/);
  await assert.rejects(second, /timed out waiting for signaling stability/);
  assert.equal(timeoutCount, 1);
  assert.equal(timers.count(), 0);
}

async function testOfferFailureAndPeerResetRejectRequests() {
  let shouldFail = true;
  const { peer, queue, sentOffers } = createHarness();
  const failedQueue = createRenegotiationQueue({
    isCurrent: () => peer.current,
    isStable: () => peer.signalingState === "stable",
    sendOffer: async () => {
      if (shouldFail) throw new Error("offer failed");
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      sentOffers.push(offer.sdp);
      return true;
    }
  });
  await assert.rejects(failedQueue.request(), /offer failed/);
  shouldFail = false;
  const recovered = failedQueue.request();
  await tick();
  assert.deepEqual(sentOffers, ["offer-1"]);
  peer.signalingState = "stable";
  failedQueue.answer();
  await recovered;

  const pending = queue.request();
  await tick();
  queue.close(new Error("peer reset"));
  await assert.rejects(pending, /peer reset/);
}

async function testStartAndStopChangesRemainOrdered() {
  const { peer, queue, sentOffers } = createHarness();
  const start = queue.request();
  await tick();
  const stop = queue.request();
  await tick();
  assert.deepEqual(sentOffers, ["offer-1"]);

  peer.signalingState = "stable";
  queue.answer();
  await start;
  await tick();
  assert.deepEqual(sentOffers, ["offer-1", "offer-2"]);
  let stopResolved = false;
  stop.then(() => { stopResolved = true; });
  await tick();
  assert.equal(stopResolved, false, "stop waits for its corresponding answer");
  peer.signalingState = "stable";
  queue.answer();
  await stop;
  assert.equal(stopResolved, true);
}

async function testStalePeerRejectsInflightAndQueuedRequests() {
  const { peer, queue, sentOffers } = createHarness();
  const first = queue.request();
  await tick();
  const second = queue.request();
  peer.current = false;
  await assert.rejects(queue.request(), /stale WebRTC connection/);
  await assert.rejects(first, /stale WebRTC connection/);
  await assert.rejects(second, /stale WebRTC connection/);
  assert.deepEqual(sentOffers, ["offer-1"]);
}

async function run() {
  await testRequestResolvesOnlyAfterItsAnswer();
  await testBusyPeerCoalescesAndResumesAfterRemoteOffer();
  await testGlareRollsBackAndRetriesWithoutSettling();
  await testTimeoutRejectsAllRequestsAndSignalsReconnect();
  await testDeadlineStartsBeforeOfferCreationCompletes();
  await testBlockedRequestsAlsoHaveAWatchdog();
  await testOfferFailureAndPeerResetRejectRequests();
  await testStartAndStopChangesRemainOrdered();
  await testStalePeerRejectsInflightAndQueuedRequests();

  const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
  assert.match(appSource, /renegotiationQueue = createRenegotiationQueue\(/);
  assert.match(appSource, /renegotiationQueue\?\.answer\(\)/);
  assert.match(appSource, /renegotiationQueue\?\.rollback\(\)/);
  assert.match(appSource, /renegotiationQueue\?\.resume\(\)/);
  assert.match(appSource, /return renegotiationQueue\.request\(\)/);
  assert.match(appSource, /offerTimeoutMs: 15000/);
  assert.match(appSource, /status\.textContent = "Media negotiation timed out\. Reconnecting\.\.\.";\s*currentSocket\.close\(\);/);
  assert.match(appSource, /statsTimer = setInterval\(updateDiagnostics, 1000\);\s*await renegotiateLocalMedia\(\);/);
  assert.equal([...appSource.matchAll(/currentPeer\.createOffer\(\)/g)].length, 1,
    "startup and media renegotiation should share the queued offer path");
  console.log("renegotiation queue tests passed");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
