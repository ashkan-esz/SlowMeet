// A per-participant TCP relay in front of the SlowMeet HTTP/WebSocket port,
// so a browser e2e scenario can fail ONE participant's signaling without
// touching the others: the participant loads the app (and opens its
// WebSocket) through http://127.0.0.1:<relay port>, everyone else talks to
// the server directly. tc cannot do this cleanly — every browser's signaling
// shares the server's one TCP port on loopback.
//
// Modes:
//   forward   — bytes pass through (optionally delayed by setDelay).
//   blackhole — nothing passes and nothing is closed: bytes in either
//               direction are held, and new connections are accepted but not
//               connected upstream, the way a dead radio looks from both ends
//               (no FIN, no RST). resume() delivers everything held, in
//               order, like TCP retransmission after the link returns.
//   refuse    — new connections are reset at once (server unreachable);
//               existing ones keep forwarding.
// reset() kills every live connection with a TCP reset.
//
// The relay terminates TCP, so the browser's kernel sees its segments
// acknowledged even while blackholed; only application-level timeouts (the
// hub's pong deadline, the client's own timers) notice the outage. That is
// the behaviour the scenarios exercise.

"use strict";

const net = require("node:net");

function targetOf(target) {
  if (typeof target === "number") return { host: "127.0.0.1", port: target };
  if (typeof target === "string") {
    const url = new URL(target);
    return { host: url.hostname, port: Number(url.port) };
  }
  return { host: target.host || "127.0.0.1", port: Number(target.port) };
}

function startSignalingRelay({ target, host = "127.0.0.1", port = 0 } = {}) {
  const upstreamAddress = targetOf(target);
  const connections = new Set();
  const state = {
    mode: "forward", delayMs: 0, accepted: 0, refused: 0,
    forwardedUpBytes: 0, forwardedDownBytes: 0, heldUpBytes: 0, heldDownBytes: 0,
    transitions: []
  };

  const send = (connection, direction, chunk) => {
    const destination = direction === "up" ? connection.upstream : connection.client;
    const write = () => {
      if (destination.destroyed) return;
      destination.write(chunk);
      state[direction === "up" ? "forwardedUpBytes" : "forwardedDownBytes"] += chunk.length;
    };
    if (state.delayMs > 0) setTimeout(write, state.delayMs);
    else write();
  };

  const relay = (connection, direction, chunk) => {
    if (state.mode === "blackhole" || (direction === "up" && !connection.upstreamReady)) {
      connection[direction === "up" ? "heldUp" : "heldDown"].push(chunk);
      // Only blackholed bytes count as held: bytes queued while the upstream
      // connection is still opening are ordinary connection setup.
      if (state.mode === "blackhole") state[direction === "up" ? "heldUpBytes" : "heldDownBytes"] += chunk.length;
      return;
    }
    send(connection, direction, chunk);
  };

  const flush = (connection) => {
    if (connection.upstreamReady) {
      for (const chunk of connection.heldUp.splice(0)) send(connection, "up", chunk);
    }
    for (const chunk of connection.heldDown.splice(0)) send(connection, "down", chunk);
  };

  const destroy = (connection, hard) => {
    for (const socket of [connection.client, connection.upstream]) {
      if (!socket || socket.destroyed) continue;
      if (hard && typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
    }
    connections.delete(connection);
  };

  const connectUpstream = (connection) => {
    if (connection.upstream) return;
    const upstream = net.connect(upstreamAddress);
    connection.upstream = upstream;
    upstream.on("connect", () => {
      connection.upstreamReady = true;
      if (state.mode !== "blackhole") flush(connection);
    });
    upstream.on("data", (chunk) => relay(connection, "down", chunk));
    upstream.on("error", () => destroy(connection, false));
    upstream.on("close", () => {
      if (!connection.client.destroyed) connection.client.end();
      connections.delete(connection);
    });
  };

  const server = net.createServer((client) => {
    state.accepted++;
    if (state.mode === "refuse") {
      state.refused++;
      if (typeof client.resetAndDestroy === "function") client.resetAndDestroy();
      else client.destroy();
      return;
    }
    const connection = { client, upstream: null, upstreamReady: false, heldUp: [], heldDown: [] };
    connections.add(connection);
    client.on("data", (chunk) => relay(connection, "up", chunk));
    client.on("error", () => destroy(connection, false));
    client.on("close", () => {
      if (connection.upstream && !connection.upstream.destroyed) connection.upstream.end();
      connections.delete(connection);
    });
    if (state.mode !== "blackhole") connectUpstream(connection);
  });

  const transition = (mode) => {
    state.mode = mode;
    state.transitions.push({ at: Date.now(), mode });
  };

  const ready = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve());
  });

  return ready.then(() => {
    const address = server.address();
    return {
      port: address.port,
      url: `http://${host}:${address.port}`,
      blackhole() {
        transition("blackhole");
      },
      // Alias kept for scenario readability.
      pause() {
        transition("blackhole");
      },
      resume() {
        transition("forward");
        for (const connection of connections) {
          connectUpstream(connection);
          flush(connection);
        }
      },
      refuse() {
        transition("refuse");
      },
      reset() {
        for (const connection of [...connections]) destroy(connection, true);
      },
      setDelay(ms) {
        state.delayMs = Math.max(0, ms);
      },
      stats() {
        return {
          mode: state.mode, delayMs: state.delayMs, accepted: state.accepted, refused: state.refused,
          live: connections.size, forwardedUpBytes: state.forwardedUpBytes,
          forwardedDownBytes: state.forwardedDownBytes, heldUpBytes: state.heldUpBytes,
          heldDownBytes: state.heldDownBytes, transitions: [...state.transitions]
        };
      },
      close() {
        for (const connection of [...connections]) destroy(connection, false);
        return new Promise((resolve) => server.close(() => resolve()));
      }
    };
  });
}

module.exports = { startSignalingRelay };
