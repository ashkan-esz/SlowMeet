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

  // signaledTrackID returns the track ID the remote description signals for
  // one m-section (`a=msid:<stream> <track>`). A browser keeps a receiver's
  // track.id from the transceiver's first use, and its own recvonly video
  // transceiver never gets the signaled ID at all, so when the SFU reuses a
  // transceiver for another participant or another camera layer, track.id
  // names the wrong source (B12: a camera's low layer arriving on the page's
  // first video transceiver was never recognized as a layer).
  function signaledTrackID(sdp, mid) {
    if (!sdp || mid == null) return "";
    for (const section of String(sdp).split(/\r?\nm=/).slice(1)) {
      const lines = section.split(/\r?\n/);
      if (!lines.includes(`a=mid:${mid}`)) continue;
      const msid = lines.find((line) => line.startsWith("a=msid:"));
      return msid?.slice("a=msid:".length).trim().split(/\s+/)[1] || "";
    }
    return "";
  }

  // routeRemoteVideo decides which participant's tile, and which role, a
  // remote video track belongs to while someone else is sharing a screen.
  // Some browsers deliver screen tracks without stream metadata, so the
  // active owner is the signaling source of truth when the track's identity
  // is ambiguous. A screen track that names a known participant stays with
  // it even while someone else shares: a past sharer keeps its idle screen
  // sender, so a joiner also receives that silent track, and handing it to
  // the current owner let whichever ontrack fired last replace the live
  // share with it. The share-change handler binds a participant's own
  // screen track when that participant starts sharing.
  function routeRemoteVideo({ participantID, role, known, streamID = "", trackID = "", screenShareOwner, localParticipantID }) {
    if (!screenShareOwner || screenShareOwner === localParticipantID) return { participantID, role };
    const explicitCamera = /-camera$/.test(streamID) || /\|camera(?:\|(low|medium|high))?$/.test(trackID);
    const explicitScreen = /-screen$/.test(streamID) || /\|screen$/.test(trackID);
    if (explicitCamera) return { participantID, role };
    if (explicitScreen && known) return { participantID, role: "screen" };
    if (explicitScreen || !known || participantID === screenShareOwner) {
      return { participantID: screenShareOwner, role: "screen" };
    }
    return { participantID, role };
  }

  return { remoteMediaRole, remoteCameraLayer, signaledTrackID, routeRemoteVideo };
});
