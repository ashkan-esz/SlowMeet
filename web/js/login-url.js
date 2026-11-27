(function exposeLoginURL(root) {
  function read(search, connectionTypes) {
    const params = new URLSearchParams(search || "");
    const requestedConnectionType = params.get("connectionType");
    const knownConnectionTypes = new Set(connectionTypes || []);
    return Object.freeze({
      hasUser: params.has("user"),
      user: params.get("user") || "",
      connectionType: knownConnectionTypes.has(requestedConnectionType) ? requestedConnectionType : null,
      autoLogin: params.get("autologin") === "true"
    });
  }

  function update(currentURL, user, connectionType) {
    const url = new URL(currentURL);
    url.searchParams.set("user", String(user ?? ""));
    if (connectionType) url.searchParams.set("connectionType", connectionType);
    else url.searchParams.delete("connectionType");
    return `${url.pathname}${url.search}${url.hash}`;
  }

  const utilities = Object.freeze({read, update});
  root.SlowMeetLoginURL = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
