(function exposeConnectionMethodUtilities(root) {
  // A rotating method uses its base TURN method's servers and adds periodic
  // relay rotation (relay-rotation.js) on top.
  const rotatingBases = Object.freeze({"turn-tcp-rotate": "turn-tcp", "turn-tls-rotate": "turn-tls"});
  // Relay methods "Automatic" falls back to when direct UDP dies, best first:
  // rotating survives networks that degrade long-lived TCP flows, and plain
  // TURN/TCP has held up better in real calls than TURN/TLS (one less
  // handshake per rotation), so TCP comes before TLS in each group.
  const autoRelayFallbackOrder = Object.freeze(["turn-tcp-rotate", "turn-tls-rotate", "turn-tcp", "turn-tls"]);

  function isRotatingMethod(methodID) {
    return Object.hasOwn(rotatingBases, methodID);
  }

  function baseMethod(methodID) {
    return rotatingBases[methodID] || methodID;
  }

  // The rotating method that shares a plain TURN method's servers
  // ("turn-tcp" -> "turn-tcp-rotate"), or null for any other method.
  function rotatingVariant(methodID) {
    return Object.keys(rotatingBases).find((rotatingID) => rotatingBases[rotatingID] === methodID) || null;
  }

  // The rotating method for a relay protocol reported by the browser
  // ("tcp"/"tls"), or null.
  function rotatingMethodForProtocol(protocol) {
    const methodID = `turn-${String(protocol || "").toLowerCase()}-rotate`;
    return isRotatingMethod(methodID) ? methodID : null;
  }

  // First fallback method the server enables; isEnabled(methodID) -> boolean.
  function autoRelayFallback(isEnabled) {
    return autoRelayFallbackOrder.find((methodID) => isEnabled(methodID) === true) || null;
  }

  // Two methods share a peer configuration when switching between them needs
  // no new ICE servers or policy (plain <-> rotating of one transport).
  function sharesPeerConfiguration(firstMethodID, secondMethodID) {
    return firstMethodID !== "auto" && secondMethodID !== "auto" &&
      baseMethod(firstMethodID) === baseMethod(secondMethodID);
  }

  function filterICEServers(iceServers, requestedMethodID) {
    if (requestedMethodID === "auto") return iceServers;
    const methodID = baseMethod(requestedMethodID);
    const selectURL = (url) => {
      const value = url.toLowerCase();
      if (methodID === "direct") return !value.startsWith("turn:") && !value.startsWith("turns:");
      if (methodID === "turn-tls") return value.startsWith("turns:");
      if (!value.startsWith("turn:")) return false;
      const query = value.split("?", 2)[1] || "";
      const transport = query.split("&").map((part) => part.split("=", 2))
        .find(([key]) => key === "transport")?.[1] || "udp";
      return methodID === "turn-udp" ? transport === "udp" : methodID === "turn-tcp" && transport === "tcp";
    };
    return iceServers.map((server) => ({...server, urls: server.urls.filter(selectURL)}))
      .filter((server) => server.urls.length > 0);
  }

  function requiresConfiguredICEServers(methodID) {
    return methodID.startsWith("turn-");
  }

  const utilities = Object.freeze({
    filterICEServers, requiresConfiguredICEServers, isRotatingMethod, baseMethod, rotatingVariant,
    rotatingMethodForProtocol, autoRelayFallback, autoRelayFallbackOrder, sharesPeerConfiguration
  });
  root.SlowMeetConnectionMethods = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
