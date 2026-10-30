(function exposeConnectionMethodUtilities(root) {
  function filterICEServers(iceServers, methodID) {
    if (methodID === "auto") return iceServers;
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

  const utilities = Object.freeze({filterICEServers, requiresConfiguredICEServers});
  root.SlowMeetConnectionMethods = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
