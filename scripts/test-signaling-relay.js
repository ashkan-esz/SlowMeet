// Checks scripts/signaling-relay.js over loopback against a small echo
// server: forwarding, blackhole hold-and-release, refuse, reset and delay.
"use strict";

const assert = require("node:assert/strict");
const net = require("node:net");
const { startSignalingRelay } = require("./signaling-relay");

const BOUND_MS = 3000;

function startEcho() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.on("error", () => {});
      socket.on("data", (chunk) => {
        socket.write(chunk);
        // "close-later" makes the server close this connection 200 ms later.
        if (String(chunk).includes("close-later")) setTimeout(() => socket.end(), 200);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function dial(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      // Resets are expected here; the test observes them through "close".
      socket.on("error", () => {});
      resolve(socket);
    });
    socket.once("error", reject);
  });
}

// Resolves with the text received within ms, or "" if nothing arrived.
function receive(socket, ms) {
  return new Promise((resolve) => {
    let text = "";
    const onData = (chunk) => { text += chunk; };
    socket.on("data", onData);
    setTimeout(() => {
      socket.off("data", onData);
      resolve(text);
    }, ms);
  });
}

function waitForClose(socket, ms) {
  return new Promise((resolve) => {
    if (socket.destroyed) return resolve(true);
    const timer = setTimeout(() => resolve(false), ms);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(true);
    });
    socket.once("error", () => {});
  });
}

(async () => {
  const echo = await startEcho();
  const relay = await startSignalingRelay({ target: echo.address().port });
  assert.match(relay.url, /^http:\/\/127\.0\.0\.1:\d+$/);

  // Forward: an echo round trip through the relay.
  const first = await dial(relay.port);
  first.write("hello");
  assert.equal(await receive(first, 300), "hello");
  assert.equal(relay.stats().forwardedUpBytes, 5);
  assert.equal(relay.stats().forwardedDownBytes, 5);

  // Blackhole: nothing passes, nothing closes; resume delivers in order.
  relay.blackhole();
  first.write("held-1");
  first.write("held-2");
  assert.equal(await receive(first, 400), "", "a blackholed link must pass nothing");
  assert.equal(first.destroyed, false, "a blackholed link must not close the socket");
  assert.equal(relay.stats().heldUpBytes, 12);
  // A connection opened during the blackhole is accepted but goes nowhere.
  const during = await dial(relay.port);
  during.write("late");
  assert.equal(await receive(during, 300), "");
  const resumedAt = Date.now();
  relay.resume();
  const [afterFirst, afterDuring] = await Promise.all([receive(first, 500), receive(during, 500)]);
  assert.equal(afterFirst, "held-1held-2", "held bytes are delivered in order after resume");
  assert.equal(afterDuring, "late", "a connection opened in the blackhole is connected on resume");
  assert.ok(Date.now() - resumedAt <= BOUND_MS);

  // Delay: a round trip crosses the relay twice.
  relay.setDelay(150);
  const sentAt = Date.now();
  first.write("slow");
  assert.equal(await receive(first, 800), "slow");
  relay.setDelay(0);
  const delayedReply = await (async () => {
    const started = Date.now();
    first.write("x");
    await receive(first, 100);
    return Date.now() - started;
  })();
  assert.ok(delayedReply < 400, `delay removed: round trip ${delayedReply} ms`);
  assert.ok(Date.now() - sentAt >= 300);

  // A close from the server during a blackhole reaches the participant only
  // after resume, after any bytes held before it.
  const closing = await dial(relay.port);
  let ended = false;
  closing.on("end", () => { ended = true; });
  closing.write("close-later");
  assert.equal(await receive(closing, 100), "close-later");
  relay.blackhole();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(ended, false, "the server's close must not reach the participant during a blackhole");
  relay.resume();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(ended, true, "the server's close reaches the participant after resume");
  closing.destroy();

  // Reset: every live connection dies with a reset.
  relay.reset();
  assert.equal(await waitForClose(first, BOUND_MS), true, "reset must close the participant's socket");
  assert.equal(await waitForClose(during, BOUND_MS), true);
  assert.equal(relay.stats().live, 0);

  // Refuse: new connections are reset at once.
  relay.refuse();
  const refused = await dial(relay.port).catch((error) => error);
  if (!(refused instanceof Error)) {
    assert.equal(await waitForClose(refused, BOUND_MS), true, "a refused connection must close");
  }
  assert.ok(relay.stats().refused >= 1);

  // Back to forward: new connections work again.
  relay.resume();
  const again = await dial(relay.port);
  again.write("back");
  assert.equal(await receive(again, 300), "back");
  assert.deepEqual(relay.stats().transitions.map((step) => step.mode), ["blackhole", "forward", "blackhole", "forward", "refuse", "forward"]);

  again.destroy();
  await relay.close();
  await new Promise((resolve) => echo.close(resolve));
  console.log("signaling relay checks passed");
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
