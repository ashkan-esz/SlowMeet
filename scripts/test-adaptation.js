const {
  chooseAdaptationLevel,
  shouldRecoverVideo,
  applyServerDefaults,
  resolveCodecName,
  profileNameForQuality,
  isBelowBitrate
} = require("../web/js/adaptation-policy.js");

const transition = (level, poor, good) =>
  chooseAdaptationLevel(level, poor, good, 4);

if (transition(2, 2, 0).level !== 1) throw new Error("poor network should downgrade normal to slow");
if (transition(1, 2, 0).level !== 0) throw new Error("poor network should downgrade slow to very-slow");
if (transition(0, 2, 0).level !== 0) throw new Error("downgrade should stop at very-slow");
if (transition(0, 0, 5).level !== 1) throw new Error("good network should upgrade very-slow to slow");
if (transition(1, 0, 5).level !== 2) throw new Error("good network should upgrade slow to normal");
if (transition(2, 0, 5).level !== 3) throw new Error("good network should upgrade normal to high");
if (transition(3, 0, 5).level !== 3) throw new Error("upgrade should stop at high");
if (transition(2, 1, 0).level !== 2) throw new Error("downgrade requires two samples");
if (transition(0, 0, 4).level !== 0) throw new Error("upgrade requires five samples");
if (!shouldRecoverVideo(5, true) || shouldRecoverVideo(4, true) || shouldRecoverVideo(5, false)) {
  throw new Error("video recovery requires five consecutive good samples");
}
const profile = { name: "slow", fps: 10, audioBitrate: 32000 };
const configured = applyServerDefaults(profile, { videoFPS: 15, audioBitrate: 48000 }, true);
if (configured.fps !== 15 || configured.audioBitrate !== 48000 || profile.fps !== 10) {
  throw new Error("server defaults should override only the selected profile copy");
}
if (applyServerDefaults(profile, { videoFPS: 5, audioBitrate: 24000 }, false) !== profile) {
  throw new Error("disabled server defaults should preserve the selected profile");
}
const codecById = new Map([["C1", "video/VP8"], ["C2", "audio/opus"]]);
if (resolveCodecName(codecById, "C1") !== "video/VP8" ||
    resolveCodecName(codecById, "C2") !== "audio/opus" ||
    resolveCodecName(codecById, "unknown") !== "unknown") {
  throw new Error("codec stats should resolve opaque codec IDs to MIME names");
}
if (profileNameForQuality("low") !== "slow" ||
    profileNameForQuality("medium") !== "normal" ||
    profileNameForQuality("high") !== "high") {
  throw new Error("host quality names should map to client profile names");
}
if (isBelowBitrate(20, 40) !== true ||
    isBelowBitrate(40, 40) !== false ||
    isBelowBitrate(null, 40) !== false ||
    isBelowBitrate(undefined, 40) !== false) {
  throw new Error("missing inbound video bitrate must not be treated as critical");
}

const appSource = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "web/js/app.js"), "utf8");
if (!appSource.includes("const currentPeer = new RTCPeerConnection();\n  restartRequested = false;")) {
  throw new Error("new WebRTC generations must reset ICE restart state");
}
if (!appSource.includes('setConnection("fair", "Reconnecting");') ||
    !appSource.includes('setConnection("poor", "Connection lost");')) {
  throw new Error("signaling disconnects must be visible in the connection indicator");
}

console.log("Adaptation tests passed");
