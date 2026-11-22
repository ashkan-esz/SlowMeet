// Choice of the video codec for this participant's outgoing camera and screen
// video.
//
// The server forwards video without transcoding, so a publisher can only use a
// codec every participant's browser decodes. The server says which codecs are
// allowed and which the room can use right now; this module picks one of them
// for this device and makes the browser use it.
//
// A browser encodes with the first codec it supports in the *remote*
// description's video m-line, so the choice is applied by moving that codec's
// payload types to the front of the SDP received from the server just before
// it is set (the same mechanism as opus-dtx.js). The local description is
// never touched, so this browser keeps receiving every codec it offered.
(function exposeVideoCodec(root) {
  // Newest first. This is also the order a fallback walks: from the preferred
  // codec towards older ones, and only then towards newer ones.
  const codecs = Object.freeze(["av1", "vp9", "vp8", "h264"]);
  const labels = Object.freeze({av1: "AV1", vp9: "VP9", vp8: "VP8", h264: "H.264"});
  // Simulcast layers are separate streams the server switches between; only
  // the two older codecs are sent that way by every browser.
  const simulcastCodecs = Object.freeze(["vp8", "h264"]);

  function isCodec(name) {
    return codecs.includes(name);
  }

  function codecLabel(name) {
    return labels[name] || "";
  }

  function isNewerCodec(candidate, current) {
    return isCodec(candidate) && isCodec(current) && codecs.indexOf(candidate) < codecs.indexOf(current);
  }

  // The codec name for a MIME type such as "video/VP9", or null when it is not
  // one of the four. VP9 counts only in profile 0, the one every VP9 decoder
  // has; a missing profile-id means profile 0.
  function codecNameFromMime(mimeType, fmtp) {
    const mime = String(mimeType || "").toLowerCase();
    if (mime === "video/vp8") return "vp8";
    if (mime === "video/h264") return "h264";
    if (mime === "video/av1") return "av1";
    if (mime === "video/vp9") {
      const profile = /(?:^|;)\s*profile-id=(\d+)/.exec(String(fmtp || ""));
      return !profile || profile[1] === "0" ? "vp9" : null;
    }
    return null;
  }

  function capabilityNames(capabilities) {
    const names = new Set();
    const list = capabilities && Array.isArray(capabilities.codecs) ? capabilities.codecs : [];
    list.forEach((codec) => {
      const name = codec ? codecNameFromMime(codec.mimeType, codec.sdpFmtpLine) : null;
      if (name) names.add(name);
    });
    return names;
  }

  // The codecs this device both sends and receives, newest first: what it
  // tells the server at join and what it may be asked to encode. null when the
  // browser does not report capabilities; the server then assumes an older
  // client and this module leaves the browser's own codec order alone.
  function deviceCodecs(senderCapabilities, receiverCapabilities) {
    const send = capabilityNames(senderCapabilities);
    const receive = capabilityNames(receiverCapabilities);
    if (send.size === 0 || receive.size === 0) return null;
    return codecs.filter((name) => send.has(name) && receive.has(name));
  }

  function fallbackOrder(preferred) {
    const index = codecs.indexOf(preferred);
    if (index < 0) return codecs.slice();
    return codecs.slice(index).concat(codecs.slice(0, index).reverse());
  }

  function contains(collection, name) {
    if (!collection) return false;
    if (typeof collection.has === "function") return collection.has(name);
    return Array.isArray(collection) && collection.includes(name);
  }

  // The codec to send with, or null to leave the browser's own order alone.
  //   stored        the participant's choice: a codec name, or anything else
  //                 ("auto") to follow the server default
  //   serverDefault the server's default codec
  //   roomCodecs    codecs usable in the room now
  //   device        deviceCodecs() of this browser
  //   avoid         codecs to skip on this device (too slow to encode); the
  //                 participant's explicit choice is never skipped
  //   simulcast     true when the camera is sent as simulcast layers
  function chooseSendCodec(options) {
    const {stored, serverDefault, roomCodecs, device, avoid, simulcast} = options || {};
    if (!Array.isArray(roomCodecs) || !Array.isArray(device)) return null;
    const usable = codecs.filter((name) => roomCodecs.includes(name) && device.includes(name) &&
      (!simulcast || simulcastCodecs.includes(name)));
    if (usable.length === 0) return null;
    const explicit = isCodec(stored) ? stored : null;
    const preferred = explicit || (isCodec(serverDefault) ? serverDefault : usable[0]);
    const order = fallbackOrder(preferred).filter((name) => usable.includes(name));
    return order.find((name) => name === explicit || !contains(avoid, name)) || order[0];
  }

  // Moves codec's payload types, and the RTX payload types that repair them,
  // to the front of every video m-line. Everything else, including the order
  // of the remaining payload types and the line endings, is left as it was. A
  // section that does not offer the codec is not changed.
  function preferVideoCodec(sdp, codec) {
    if (typeof sdp !== "string" || !isCodec(codec)) return sdp;
    const newline = sdp.includes("\r\n") ? "\r\n" : "\n";
    const lines = sdp.split(newline);
    for (let start = 0; start < lines.length; start += 1) {
      if (!lines[start].startsWith("m=video ")) continue;
      let end = start + 1;
      while (end < lines.length && !lines[end].startsWith("m=")) end += 1;
      const names = new Map();
      const parameters = new Map();
      for (let index = start + 1; index < end; index += 1) {
        const rtpmap = /^a=rtpmap:(\d+) ([^/\s]+)/.exec(lines[index]);
        if (rtpmap) names.set(rtpmap[1], rtpmap[2]);
        const fmtp = /^a=fmtp:(\d+) (.*)$/.exec(lines[index]);
        if (fmtp) parameters.set(fmtp[1], fmtp[2]);
      }
      const preferred = new Set();
      names.forEach((name, payloadType) => {
        if (codecNameFromMime(`video/${name}`, parameters.get(payloadType)) === codec) preferred.add(payloadType);
      });
      if (preferred.size === 0) continue;
      names.forEach((name, payloadType) => {
        if (name.toLowerCase() !== "rtx") return;
        const repaired = /(?:^|;)\s*apt=(\d+)/.exec(parameters.get(payloadType) || "");
        if (repaired && preferred.has(repaired[1])) preferred.add(payloadType);
      });
      const fields = lines[start].split(" ");
      const payloadTypes = fields.slice(3);
      lines[start] = fields.slice(0, 3)
        .concat(payloadTypes.filter((payloadType) => preferred.has(payloadType)))
        .concat(payloadTypes.filter((payloadType) => !preferred.has(payloadType)))
        .join(" ");
    }
    return lines.join(newline);
  }

  // reasons: one qualityLimitationReason per stats sample, oldest first. True
  // once the encoder has been CPU-limited for `needed` samples in a row.
  function cpuFallbackDue(reasons, needed = 10) {
    if (!Array.isArray(reasons) || reasons.length < needed) return false;
    return reasons.slice(-needed).every((reason) => reason === "cpu");
  }

  const utilities = Object.freeze({
    codecs, isCodec, codecLabel, isNewerCodec, codecNameFromMime, deviceCodecs,
    fallbackOrder, chooseSendCodec, preferVideoCodec, cpuFallbackDue
  });
  root.SlowMeetVideoCodec = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
