// Per-participant control of Opus DTX (silence suppression).
//
// A browser applies the Opus parameters of the *remote* description to its own
// encoder, so whether this participant sends discontinuous audio is decided by
// the `usedtx` parameter in the SDP it receives from the server. The server
// adds `usedtx=1` by default (OPUS_DTX_ENABLED); this module rewrites that SDP
// just before it is applied so each participant can choose for themselves.
(function exposeOpusDTX(root) {
  // One Opus fmtp line, without its line terminator ("." and "$" both stop at
  // "\r" and "\n"). Only Opus carries useinbandfec, which is how the line is
  // recognised without tracking payload types (the same rule as the server's
  // enableOpusDTX in internal/signaling/sdp.go).
  const opusFmtpLine = /^(a=fmtp:\d+ )(.*useinbandfec=1.*)$/gm;

  // enabled === true: every Opus fmtp line carries usedtx=1.
  // enabled === false: no Opus fmtp line carries usedtx.
  // anything else: the SDP is returned as the server sent it.
  function applyOpusDTX(sdp, enabled) {
    if (typeof sdp !== "string" || (enabled !== true && enabled !== false)) return sdp;
    return sdp.replace(opusFmtpLine, (_line, prefix, parameters) => {
      const kept = parameters.split(";").map((part) => part.trim())
        .filter((part) => part !== "" && !part.startsWith("usedtx="));
      if (enabled) kept.push("usedtx=1");
      return prefix + kept.join(";");
    });
  }

  // The participant's stored choice ("true"/"false") wins; otherwise the
  // server's default (a boolean); otherwise null, which leaves the SDP alone.
  function effectivePreference(stored, serverDefault) {
    if (stored === "true") return true;
    if (stored === "false") return false;
    return typeof serverDefault === "boolean" ? serverDefault : null;
  }

  const utilities = Object.freeze({applyOpusDTX, effectivePreference});
  root.SlowMeetOpusDTX = utilities;
  if (typeof module !== "undefined" && module.exports) module.exports = utilities;
})(globalThis);
