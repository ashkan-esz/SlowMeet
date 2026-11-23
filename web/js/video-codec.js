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
  // A simulcast camera is sent as separate streams, one per layer, and the
  // server forwards one of them to each viewer. Every browser sends the two
  // older codecs that way. For VP9 and AV1 a browser keeps the layers apart
  // only when each one names a scalability mode with a single spatial layer;
  // without it Chromium packs all layers into one stream, which the server
  // cannot split. Whether a browser accepts such a mode is asked through the
  // Media Capabilities API (see app.js).
  const alwaysSimulcastCodecs = Object.freeze(["vp8", "h264"]);
  const simulcastLayerMode = "L1T1";

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
  //   simulcastCodecs  when the camera is sent as simulcast layers, the codecs
  //                 this browser can send that way (simulcastCapableCodecs);
  //                 anything else when it is not
  function chooseSendCodec(options) {
    const {stored, serverDefault, roomCodecs, device, avoid, simulcastCodecs} = options || {};
    if (!Array.isArray(roomCodecs) || !Array.isArray(device)) return null;
    const usable = codecs.filter((name) => roomCodecs.includes(name) && device.includes(name) &&
      (!Array.isArray(simulcastCodecs) || simulcastCodecs.includes(name)));
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

  // What to do when the codec to send with (target) differs from the one in
  // use (applied): "none", "apply" now, or "hold" it back for a while. Only a
  // move to a newer codec while the current one still works is held, so that a
  // participant who drops and comes back does not switch every encoder twice.
  // immediate (the participant or the administrator chose) never holds.
  function planCodecChange(options) {
    const {target, applied, roomCodecs, immediate} = options || {};
    if (target === applied) return "none";
    const appliedStillUsable = Array.isArray(roomCodecs) && roomCodecs.includes(applied);
    return !immediate && appliedStillUsable && isNewerCodec(target, applied) ? "hold" : "apply";
  }

  // The line under the codec picker: what is being sent and, when that is not
  // the wanted codec, the first reason that applies.
  function codecNote(options) {
    const {applied, stored, serverDefault, roomCodecs, device, avoided, simulcastCodecs} = options || {};
    if (!isCodec(applied)) return "Uses the newest codec everyone in the room can play.";
    const wanted = isCodec(stored) ? stored : (isCodec(serverDefault) ? serverDefault : null);
    let reason = "";
    if (wanted && wanted !== applied) {
      if (Array.isArray(device) && !device.includes(wanted)) {
        reason = ` This device cannot send ${codecLabel(wanted)}.`;
      } else if (!Array.isArray(roomCodecs) || !roomCodecs.includes(wanted)) {
        reason = ` Not everyone here can play ${codecLabel(wanted)}.`;
      } else if (Array.isArray(simulcastCodecs) && !simulcastCodecs.includes(wanted)) {
        reason = ` This browser cannot send ${codecLabel(wanted)} as simulcast layers.`;
      } else if (contains(avoided, wanted)) {
        reason = ` ${codecLabel(wanted)} is too heavy for this device.`;
      }
    }
    return `Sending ${codecLabel(applied)}.${reason}`;
  }

  // Whether the encoder is watched for CPU overload: only a newer codec that
  // Automatic chose. A codec the participant picked is theirs to keep.
  function cpuFallbackWatched(options) {
    const {sending, applied, stored} = options || {};
    return (sending === "av1" || sending === "vp9") && sending === applied && stored !== sending;
  }

  // Adds one stats sample to state ({samples, lastAt}) and returns the new
  // state. Several outbound streams report in the same stats sample; they
  // count once, as CPU-limited if any of them is.
  function addCpuSample(state, sample, limits) {
    const {now, cpuLimited} = sample || {};
    const {minGapMs = 900, keep = 30} = limits || {};
    const samples = state && Array.isArray(state.samples) ? state.samples.slice() : [];
    const lastAt = state && Number.isFinite(state.lastAt) ? state.lastAt : -Infinity;
    if (now - lastAt < minGapMs) {
      if (cpuLimited && samples.length) samples[samples.length - 1] = "cpu";
      return {samples, lastAt};
    }
    samples.push(cpuLimited ? "cpu" : "none");
    return {samples: samples.slice(-keep), lastAt: now};
  }

  // The codecs this browser can send as separate simulcast layers, newest
  // first: the two older ones, and each newer one in `layerable`, the codecs
  // for which the browser was found to accept the single-spatial-layer
  // scalability mode.
  function simulcastCapableCodecs(layerable) {
    return codecs.filter((name) => alwaysSimulcastCodecs.includes(name) || contains(layerable, name));
  }

  // Whether a simulcast camera in this codec needs the scalability mode on
  // its layers.
  function needsLayerMode(codec) {
    return isCodec(codec) && !alwaysSimulcastCodecs.includes(codec);
  }

  // The simulcast encodings to use for codec: copies of the given ones, with
  // the scalability mode added when the codec needs it. A mode that is
  // already there is kept, also for a codec that does not need one: taking it
  // away again would only be a second change for the encoder.
  function simulcastEncodings(encodings, codec) {
    if (!Array.isArray(encodings)) return [];
    return encodings.map((encoding) => (needsLayerMode(codec)
      ? {...encoding, scalabilityMode: simulcastLayerMode}
      : {...encoding}));
  }

  // samples: for each recent stats sample, the scalability modes the camera's
  // outbound streams report. True once every one of the last `needed` samples
  // has a stream carrying more than one spatial layer: the browser packed the
  // simulcast layers into one stream, so viewers of the other layers get
  // nothing and the codec cannot be used for simulcast here.
  function simulcastCollapsed(samples, needed = 3) {
    if (!Array.isArray(samples) || samples.length < needed) return false;
    return samples.slice(-needed).every((modes) => Array.isArray(modes) &&
      modes.some((mode) => /^[LS][2-9]/.test(String(mode || ""))));
  }

  const utilities = Object.freeze({
    codecs, isCodec, codecLabel, isNewerCodec, codecNameFromMime, deviceCodecs,
    fallbackOrder, chooseSendCodec, preferVideoCodec, cpuFallbackDue,
    planCodecChange, codecNote, cpuFallbackWatched, addCpuSample,
    simulcastCapableCodecs, needsLayerMode, simulcastEncodings, simulcastCollapsed
  });
  root.SlowMeetVideoCodec = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
