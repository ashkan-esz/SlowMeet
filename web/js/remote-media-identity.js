(function exposeRemoteMediaIdentity(root, factory) {
  const helpers = factory();
  if (typeof module === "object" && module.exports) module.exports = helpers;
  else Object.assign(root, helpers);
})(typeof globalThis === "object" ? globalThis : this, function createRemoteMediaIdentity() {
  function remoteMediaRole(streams, track) {
    const streamID = streams?.[0]?.id || track?.streamId || track?.StreamID?.() || "";
    if (/-screen$/.test(streamID) || /\|screen$/.test(track?.id || "")) return "screen";
    if (/-camera$/.test(streamID) || /\|camera(?:\|(low|medium|high))?$/.test(track?.id || "")) return "camera";
    return track?.kind === "audio" ? "audio" : "camera";
  }

  function remoteCameraLayer(track) {
    const match = /\|camera\|(low|medium|high)$/.exec(track?.id || "");
    return match?.[1] || "";
  }

  return { remoteMediaRole, remoteCameraLayer };
});
