const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  codecNameFromMime, deviceCodecs, fallbackOrder, chooseSendCodec, preferVideoCodec,
  cpuFallbackDue, isNewerCodec, codecLabel, planCodecChange, codecNote, cpuFallbackWatched, addCpuSample,
  simulcastCapableCodecs, needsLayerMode, simulcastEncodings, simulcastCollapsed
} = require("../web/js/video-codec.js");

// --- SDP rewrite -----------------------------------------------------------

const videoLine = "m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 45 46 102 103 127 125";
const sdp = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  videoLine,
  "a=mid:1",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  "a=rtpmap:98 VP9/90000",
  "a=fmtp:98 profile-id=0",
  "a=rtpmap:99 rtx/90000",
  "a=fmtp:99 apt=98",
  "a=rtpmap:100 VP9/90000",
  "a=fmtp:100 profile-id=2",
  "a=rtpmap:101 rtx/90000",
  "a=fmtp:101 apt=100",
  "a=rtpmap:45 AV1/90000",
  "a=rtpmap:46 rtx/90000",
  "a=fmtp:46 apt=45",
  "a=rtpmap:102 H264/90000",
  "a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f",
  "a=rtpmap:103 rtx/90000",
  "a=fmtp:103 apt=102",
  "a=rtpmap:127 H264/90000",
  "a=fmtp:127 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
  "a=rtpmap:125 rtx/90000",
  "a=fmtp:125 apt=127",
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "a=mid:2",
  "a=rtpmap:96 VP8/90000",
  "a=rtpmap:97 rtx/90000",
  "a=fmtp:97 apt=96",
  ""
].join("\r\n");

function videoLines(text) {
  return text.split(/\r?\n/).filter((line) => line.startsWith("m=video "));
}

function onlyVideoLinesChanged(before, after) {
  const strip = (text) => text.split("\r\n").filter((line) => !line.startsWith("m=video ")).join("\r\n");
  assert.equal(strip(after), strip(before), "only the video m-lines may change");
}

const av1 = preferVideoCodec(sdp, "av1");
assert.equal(videoLines(av1)[0], "m=video 9 UDP/TLS/RTP/SAVPF 45 46 96 97 98 99 100 101 102 103 127 125",
  "AV1 and its RTX move to the front, the rest keeps its order");
assert.equal(videoLines(av1)[1], "m=video 9 UDP/TLS/RTP/SAVPF 96 97",
  "a section that does not offer the codec is left alone");
onlyVideoLinesChanged(sdp, av1);
assert.equal(preferVideoCodec(av1, "av1"), av1, "the rewrite is idempotent");

assert.equal(videoLines(preferVideoCodec(sdp, "vp9"))[0],
  "m=video 9 UDP/TLS/RTP/SAVPF 98 99 96 97 100 101 45 46 102 103 127 125",
  "only VP9 profile 0 is preferred; profile 2 stays where it was");
assert.equal(videoLines(preferVideoCodec(sdp, "h264"))[0],
  "m=video 9 UDP/TLS/RTP/SAVPF 102 103 127 125 96 97 98 99 100 101 45 46",
  "every H.264 payload type moves, in its original order");
assert.equal(preferVideoCodec(sdp, "vp8"), sdp, "a codec already in front changes nothing");
assert.equal(videoLines(preferVideoCodec(av1, "vp8"))[0], "m=video 9 UDP/TLS/RTP/SAVPF 96 97 45 46 98 99 100 101 102 103 127 125",
  "a later choice moves only its own payload types");

for (const codec of [null, undefined, "auto", "h265", ""]) {
  assert.equal(preferVideoCodec(sdp, codec), sdp, `codec ${String(codec)} leaves the SDP alone`);
}
assert.equal(preferVideoCodec(undefined, "av1"), undefined);
const unixSDP = sdp.replace(/\r\n/g, "\n");
assert.equal(preferVideoCodec(unixSDP, "av1"), av1.replace(/\r\n/g, "\n"), "bare newlines are preserved");
assert.ok(!preferVideoCodec(unixSDP, "av1").includes("\r"));

// --- Device capabilities ---------------------------------------------------

assert.equal(codecNameFromMime("video/VP9", "profile-id=2"), null);
assert.equal(codecNameFromMime("video/VP9"), "vp9");
assert.equal(codecNameFromMime("video/AV1"), "av1");
assert.equal(codecNameFromMime("video/rtx"), null);
assert.equal(codecLabel("h264"), "H.264");
assert.equal(codecLabel("nope"), "");

const sender = {codecs: [
  {mimeType: "video/VP8"}, {mimeType: "video/rtx"},
  {mimeType: "video/VP9", sdpFmtpLine: "profile-id=0"},
  {mimeType: "video/VP9", sdpFmtpLine: "profile-id=2"},
  {mimeType: "video/H264", sdpFmtpLine: "packetization-mode=1;profile-level-id=42e01f"},
  {mimeType: "video/AV1"}
]};
const receiverWithoutAV1 = {codecs: sender.codecs.filter((codec) => codec.mimeType !== "video/AV1")};
assert.deepEqual(deviceCodecs(sender, sender), ["av1", "vp9", "vp8", "h264"]);
assert.deepEqual(deviceCodecs(sender, receiverWithoutAV1), ["vp9", "vp8", "h264"],
  "a codec counts only when the device both sends and receives it");
assert.deepEqual(deviceCodecs({codecs: [{mimeType: "video/VP9", sdpFmtpLine: "profile-id=2"}, {mimeType: "video/VP8"}]}, sender),
  ["vp8"], "VP9 without profile 0 is not VP9 support");
assert.equal(deviceCodecs(undefined, sender), null);
assert.equal(deviceCodecs({codecs: []}, sender), null);

// --- Choice ----------------------------------------------------------------

assert.deepEqual(fallbackOrder("av1"), ["av1", "vp9", "vp8", "h264"]);
assert.deepEqual(fallbackOrder("vp9"), ["vp9", "vp8", "h264", "av1"]);
assert.deepEqual(fallbackOrder("h264"), ["h264", "vp8", "vp9", "av1"]);
assert.ok(isNewerCodec("av1", "vp8"));
assert.ok(!isNewerCodec("vp8", "vp9"));
assert.ok(!isNewerCodec(null, "vp9"));

const all = ["av1", "vp9", "vp8", "h264"];
const choices = [
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: all}, "av1", "server default"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: ["vp9", "vp8"], device: all}, "vp9", "room without AV1 falls to VP9"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: ["vp8", "h264"]}, "vp8", "device without the new codecs falls to VP8"],
  [{stored: "vp8", serverDefault: "av1", roomCodecs: all, device: all}, "vp8", "the participant may pick an older codec"],
  [{stored: "av1", serverDefault: "vp8", roomCodecs: all, device: all}, "av1", "or a newer one than the default"],
  [{stored: "av1", serverDefault: "vp8", roomCodecs: ["vp8", "h264"], device: all}, "vp8", "a pick the room cannot play falls back"],
  [{stored: "h264", serverDefault: "av1", roomCodecs: ["av1", "vp9", "vp8"], device: all}, "vp8", "H.264 falls to VP8 before anything newer"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: all, avoid: new Set(["av1"])}, "vp9", "automatic skips a codec this device encodes poorly"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: all, avoid: ["av1", "vp9"]}, "vp8", "avoid may be an array"],
  [{stored: "av1", serverDefault: "av1", roomCodecs: all, device: all, avoid: new Set(["av1"])}, "av1", "an explicit pick is not overridden"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: ["av1"], device: ["av1"], avoid: new Set(["av1"])}, "av1", "the only usable codec is used even when avoided"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: all, simulcastCodecs: ["vp8", "h264"]}, "vp8",
    "a simulcast camera stays on the older codecs in a browser that cannot layer the newer ones"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: all, simulcastCodecs: all}, "av1",
    "a simulcast camera uses the default where the browser can send it as layers"],
  [{stored: "av1", serverDefault: "vp8", roomCodecs: all, device: all, simulcastCodecs: ["vp9", "vp8", "h264"]}, "vp9",
    "a pick the browser cannot send as layers falls to the next codec"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: all, simulcastCodecs: null}, "av1",
    "without simulcast nothing is restricted"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: ["av1"], device: all, simulcastCodecs: ["vp8", "h264"]}, null,
    "no codec is both playable by the room and sendable as layers"],
  [{stored: "auto", serverDefault: "nope", roomCodecs: ["vp9", "vp8"], device: all}, "vp9", "an unknown default means the newest usable codec"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: null, device: all}, null, "no room list yet"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: all, device: null}, null, "browser without capabilities is left alone"],
  [{stored: "auto", serverDefault: "av1", roomCodecs: ["av1"], device: ["vp8"]}, null, "nothing in common"]
];
for (const [options, expected, label] of choices) {
  assert.equal(chooseSendCodec(options), expected, label);
}
assert.equal(chooseSendCodec(), null);

// --- CPU fallback ----------------------------------------------------------

assert.equal(cpuFallbackDue(Array(10).fill("cpu")), true);
assert.equal(cpuFallbackDue(Array(9).fill("cpu")), false);
assert.equal(cpuFallbackDue([...Array(9).fill("cpu"), "none"]), false);
assert.equal(cpuFallbackDue(["none", ...Array(10).fill("cpu")]), true);
assert.equal(cpuFallbackDue(["cpu", "cpu"], 2), true);
assert.equal(cpuFallbackDue(null), false);

// --- Applying a change now or holding it -----------------------------------

const plans = [
  [{target: "av1", applied: "av1", roomCodecs: all}, "none", "nothing changed"],
  [{target: null, applied: null, roomCodecs: null}, "none", "still nothing to apply"],
  [{target: "av1", applied: null, roomCodecs: all}, "apply", "the first choice is applied at once"],
  [{target: "vp9", applied: "av1", roomCodecs: ["vp9", "vp8"]}, "apply", "the codec in use stopped being usable"],
  [{target: "vp8", applied: "vp9", roomCodecs: all}, "apply", "a move to an older codec is not held"],
  [{target: "av1", applied: "vp9", roomCodecs: all}, "hold", "a move to a newer codec waits for the room to hold still"],
  [{target: "av1", applied: "vp9", roomCodecs: all, immediate: true}, "apply", "a choice by the participant or administrator is not held"],
  [{target: "av1", applied: "vp9", roomCodecs: ["av1"]}, "apply", "an upgrade is not held when the current codec is gone"],
  [{target: null, applied: "vp9", roomCodecs: []}, "apply", "losing every usable codec clears the choice"]
];
for (const [options, expected, label] of plans) {
  assert.equal(planCodecChange(options), expected, label);
}
assert.equal(planCodecChange(), "none");

// --- Settings note ---------------------------------------------------------

const notes = [
  [{applied: null}, "Uses the newest codec everyone in the room can play."],
  [{applied: "av1", stored: "auto", serverDefault: "av1", roomCodecs: all, device: all}, "Sending AV1."],
  [{applied: "vp9", stored: "auto", serverDefault: "av1", roomCodecs: ["vp9", "vp8"], device: all},
    "Sending VP9. Not everyone here can play AV1."],
  [{applied: "vp8", stored: "auto", serverDefault: "av1", roomCodecs: all, device: ["vp8", "h264"]},
    "Sending VP8. This device cannot send AV1."],
  [{applied: "vp8", stored: "av1", serverDefault: "vp8", roomCodecs: all, device: all, simulcastCodecs: ["vp8", "h264"]},
    "Sending VP8. This browser cannot send AV1 as simulcast layers."],
  [{applied: "av1", stored: "auto", serverDefault: "av1", roomCodecs: all, device: all, simulcastCodecs: all},
    "Sending AV1."],
  [{applied: "vp8", stored: "auto", serverDefault: "av1", roomCodecs: ["vp8"], device: all, simulcastCodecs: ["vp8", "h264"]},
    "Sending VP8. Not everyone here can play AV1."],
  [{applied: "vp9", stored: "auto", serverDefault: "av1", roomCodecs: all, device: all, avoided: new Set(["av1"])},
    "Sending VP9. AV1 is too heavy for this device."],
  [{applied: "vp8", stored: "h264", serverDefault: "av1", roomCodecs: ["av1", "vp9", "vp8"], device: all},
    "Sending VP8. Not everyone here can play H.264."],
  [{applied: "vp8", stored: "vp8", serverDefault: "av1", roomCodecs: all, device: all}, "Sending VP8."],
  [{applied: "vp9", stored: "auto", serverDefault: null, roomCodecs: all, device: all}, "Sending VP9."],
  // The device reason comes first: it is the one the participant can do nothing about.
  [{applied: "vp8", stored: "auto", serverDefault: "av1", roomCodecs: ["vp8"], device: ["vp8"]},
    "Sending VP8. This device cannot send AV1."]
];
for (const [options, expected] of notes) {
  assert.equal(codecNote(options), expected);
}
assert.equal(codecNote(), "Uses the newest codec everyone in the room can play.");

// --- CPU fallback bookkeeping ----------------------------------------------

assert.equal(cpuFallbackWatched({sending: "av1", applied: "av1", stored: "auto"}), true);
assert.equal(cpuFallbackWatched({sending: "vp9", applied: "vp9", stored: "auto"}), true);
assert.equal(cpuFallbackWatched({sending: "av1", applied: "av1", stored: "av1"}), false, "an explicit pick is not watched");
assert.equal(cpuFallbackWatched({sending: "vp8", applied: "vp8", stored: "auto"}), false, "the older codecs are not watched");
assert.equal(cpuFallbackWatched({sending: "av1", applied: "vp9", stored: "auto"}), false, "a codec on its way out is not watched");
assert.equal(cpuFallbackWatched(), false);

let cpuState = {samples: [], lastAt: 0};
cpuState = addCpuSample(cpuState, {now: 1000, cpuLimited: false});
assert.deepEqual(cpuState, {samples: ["none"], lastAt: 1000});
cpuState = addCpuSample(cpuState, {now: 1010, cpuLimited: true});
assert.deepEqual(cpuState, {samples: ["cpu"], lastAt: 1000}, "a second stream of the same sample upgrades it");
cpuState = addCpuSample(cpuState, {now: 1020, cpuLimited: false});
assert.deepEqual(cpuState, {samples: ["cpu"], lastAt: 1000}, "and a later unlimited stream does not downgrade it");
cpuState = addCpuSample(cpuState, {now: 2000, cpuLimited: true});
assert.deepEqual(cpuState, {samples: ["cpu", "cpu"], lastAt: 2000});
assert.deepEqual(addCpuSample(undefined, {now: 5, cpuLimited: true}), {samples: ["cpu"], lastAt: 5});
let longState = {samples: [], lastAt: 0};
for (let second = 1; second <= 40; second += 1) {
  longState = addCpuSample(longState, {now: second * 1000, cpuLimited: second > 30});
}
assert.equal(longState.samples.length, 30, "only recent samples are kept");
assert.equal(cpuFallbackDue(longState.samples), true, "ten limited seconds in a row trigger the fallback");
const frozen = {samples: ["none"], lastAt: 0};
addCpuSample(frozen, {now: 1000, cpuLimited: true});
assert.deepEqual(frozen, {samples: ["none"], lastAt: 0}, "the given state is not modified");

// --- Simulcast -------------------------------------------------------------

assert.deepEqual(simulcastCapableCodecs(new Set(["vp9", "av1"])), ["av1", "vp9", "vp8", "h264"]);
assert.deepEqual(simulcastCapableCodecs(["vp9"]), ["vp9", "vp8", "h264"]);
assert.deepEqual(simulcastCapableCodecs(new Set()), ["vp8", "h264"],
  "a browser that accepts no layer mode sends only the older codecs as layers");
assert.deepEqual(simulcastCapableCodecs(new Set(["h265"])), ["vp8", "h264"]);
assert.deepEqual(simulcastCapableCodecs(undefined), ["vp8", "h264"]);

assert.equal(needsLayerMode("av1"), true);
assert.equal(needsLayerMode("vp9"), true);
assert.equal(needsLayerMode("vp8"), false);
assert.equal(needsLayerMode("h264"), false);
assert.equal(needsLayerMode(null), false);

const plainLayers = [{rid: "low", active: true, maxBitrate: 60000}, {rid: "high", active: true, maxBitrate: 340000}];
assert.deepEqual(simulcastEncodings(plainLayers, "av1"), [
  {rid: "low", active: true, maxBitrate: 60000, scalabilityMode: "L1T1"},
  {rid: "high", active: true, maxBitrate: 340000, scalabilityMode: "L1T1"}
]);
assert.deepEqual(simulcastEncodings(plainLayers, "vp8"), plainLayers, "the older codecs are sent as they always were");
assert.deepEqual(simulcastEncodings(plainLayers, null), plainLayers);
assert.notEqual(simulcastEncodings(plainLayers, "vp8")[0], plainLayers[0], "the given encodings are copied, not shared");
assert.deepEqual(simulcastEncodings([{rid: "low", scalabilityMode: "L1T1"}], "vp8"), [{rid: "low", scalabilityMode: "L1T1"}],
  "a mode that is already set stays when the camera returns to an older codec");
assert.deepEqual(simulcastEncodings(undefined, "av1"), []);

assert.equal(simulcastCollapsed([["L3T3_KEY"], ["L3T3_KEY"], ["L3T3_KEY"]]), true, "one stream carries every layer");
assert.equal(simulcastCollapsed([["L1T1", "L1T1"], ["L1T1", "L1T1"], ["L1T1", "L1T1"]]), false, "separate layers");
assert.equal(simulcastCollapsed([["L3T3"], ["L3T3"]]), false, "not yet long enough to be sure");
assert.equal(simulcastCollapsed([["L3T3"], ["L1T1"], ["L3T3"], ["L3T3"]]), false, "an interrupted run starts over");
assert.equal(simulcastCollapsed([["S2T1", "L1T1"], ["S2T1"], ["L2T1"]]), true);
assert.equal(simulcastCollapsed([[""], [""], [""]]), false, "a browser that reports no mode is not judged");
assert.equal(simulcastCollapsed([["L3T3"], ["L3T3"]], 2), true);
assert.equal(simulcastCollapsed(null), false);

// --- A codec the browser lists but cannot encode ----------------------------

const { stalledFallbackDue } = require("../web/js/video-codec.js");
assert.equal(stalledFallbackDue(8000, "h264"), true, "eight seconds without a frame gives the codec up");
assert.equal(stalledFallbackDue(7999, "h264"), false);
assert.equal(stalledFallbackDue(60000, "vp8"), false, "VP8 is the floor and is never given up");
assert.equal(stalledFallbackDue(60000, null), false);
assert.equal(stalledFallbackDue(3000, "av1", 2000), true);
assert.equal(chooseSendCodec({stored: "h264", serverDefault: "av1", roomCodecs: all, device: ["av1", "vp9", "vp8"]}), "vp8",
  "a pick the device turned out unable to send falls back like an unsupported one");

// --- Wiring in the page ----------------------------------------------------

const root = path.join(__dirname, "..");
const appSource = fs.readFileSync(path.join(root, "web/js/app.js"), "utf8");
const indexMarkup = fs.readFileSync(path.join(root, "web/index.html"), "utf8");

const remoteDescriptions = appSource.match(/currentPeer\.setRemoteDescription\(\{[^}]*\}\)/g) || [];
assert.equal(remoteDescriptions.length, 2, "the offer and the answer are the two remote descriptions");
for (const call of remoteDescriptions) {
  assert.match(call, /sdp: applyRemoteSDPChoices\(message\.sdp\)/,
    "every remote description goes through the codec and DTX choices");
}
assert.match(appSource, /function applyRemoteSDPChoices\(sdp\) \{\s*return applyVideoCodecChoice\(applyOpusDTXChoice\(sdp\)\);/);
assert.match(appSource, /function applyVideoCodecChoice\(sdp\) \{\s*videoCodecDescribed = videoCodecApplied;\s*return window\.SlowMeetVideoCodec\.preferVideoCodec\(sdp, videoCodecApplied\);/);
assert.match(appSource, /if \(peer && renegotiationQueue && sendingVideo\(\)\) renegotiateLocalMedia\(\)/,
  "a codec change renegotiates only for a participant who is sending video");
assert.match(appSource, /function sendingVideo\(\) \{\s*return \[cameraSender, screenSender\]\.some\(\(sender\) => sender\?\.track\?\.readyState === "live"\);/);
assert.match(appSource, /if \(videoCodecDescribed !== videoCodecApplied && peer && renegotiationQueue\) \{\s*videoCodecDescribed = videoCodecApplied;\s*renegotiateLocalMedia\(\)/,
  "video that starts after a codec change brings the description up to date");
assert.match(appSource, /planCodecChange\(\{\s*target, applied: videoCodecApplied, roomCodecs: videoCodecRoomList\(\), immediate\s*\}\)/);
assert.match(appSource, /return window\.SlowMeetVideoCodec\.codecNote\(\{/);
assert.match(appSource, /codecs\.addCpuSample\(videoCodecCpu, \{ now: Date\.now\(\), cpuLimited: limitationReason === "cpu" \}\)/);
assert.match(appSource, /noteOutboundVideoStat\(codecById\.get\(stat\.codecId\), stat\.qualityLimitationReason, stat\.id, stat\.framesEncoded,/);
assert.match(appSource, /acceptsLayerMode\(contentType, "L1T1"\), acceptsLayerMode\(contentType, "L9T9"\)\]\)\s*\.then\(\(\[layered, anything\]\) => \{\s*if \(!layered \|\| anything\) return;\s*videoCodecsLayerable\.add\(codec\);/,
  "a codec counts as sendable in layers only if the browser tells real scalability modes from made-up ones");
assert.match(appSource, /simulcastCapableCodecs\(videoCodecsLayerable\)/);
assert.match(appSource, /if \(optionsKey !== videoCodecOptionsKey\) \{/, "the picker is rebuilt only when its entries change");
assert.equal((appSource.match(/device: videoCodecsUsableDevice\(\),/g) || []).length, 2,
  "the choice and the note both leave out codecs the device could not encode");
assert.match(appSource, /if \(sending\) videoCodecsProven\.add\(sending\);/, "a codec that encoded a frame is never judged broken");
assert.match(appSource, /const expecting = onTime && [^;]*!videoCodecsProven\.has\(videoCodecApplied\)[^;]*currentDirection/,
  "the no-encoder verdict needs an on-time timer, an unproven codec and a negotiated sending line");
assert.match(appSource, /new RTCPeerConnection\(\{ iceServers: selectedICEServers[^\n]*\n(\s*\/\/[^\n]*\n)*\s*videoCodecFramesEncoded\.clear\(\);/,
  "frame counts start over with each connection");
assert.match(appSource, /stalledFallbackDue\(now - videoCodecStalledSince, codec\)\) return;\s*videoCodecStalledSince = 0;\s*videoCodecsBroken\.add\(codec\);/);
assert.equal((appSource.match(/simulcastCodecs: videoSimulcastCodecs\(\)/g) || []).length, 2,
  "the choice and the Settings note both know which codecs the browser can send as layers");
assert.match(appSource, /function videoSimulcastCodecs\(\) \{\s*if \(!simulcastEnabled\) return null;/);
assert.match(appSource, /ensureSimulcastLayerMode\(target\)\.then\(renegotiate, renegotiate\)/,
  "a simulcast camera's layers are prepared before the negotiation that switches codec");
assert.match(appSource, /transceiverOptions\.sendEncodings = window\.SlowMeetVideoCodec\.simulcastEncodings\(/);
assert.match(appSource, /stat\.rid, stat\.scalabilityMode\);/);
assert.match(appSource, /if \(window\.SlowMeetVideoCodec\.simulcastCollapsed\(videoSimulcastModeSamples\)\) \{[\s\S]{0,200}videoCodecsNotSimulcast\.add\(codec\);/);
assert.match(appSource, /let videoCodecStored = readStoredValue\("meeting\.videoCodec"\)/);
assert.match(appSource, /writeStoredValue\("meeting\.videoCodec", videoCodecStored\)/);
assert.match(appSource, /type: "join", name, password, reconnect_token: reconnectToken,\s*video_codecs: videoCodecsDevice \|\| undefined/,
  "join tells the server which codecs this device supports");
assert.match(appSource, /message\.type === "video_codec_state"[\s\S]{0,120}noteRoomVideoCodecs\(message\.room_video_codecs, false\)/);
assert.match(appSource, /noteServerVideoCodecs\(config\.video_codecs, config\.default_video_codec\)/);
assert.match(appSource, /noteServerVideoCodecs\(message\.video_codecs, message\.default_video_codec\)/);
assert.match(indexMarkup, /<select id="video-codec"/);
assert.match(indexMarkup, /id="video-codec-note"/);
assert.match(indexMarkup, /id="metric-video-codec"/);
assert.ok(indexMarkup.indexOf('src="/js/video-codec.js"') > 0 &&
  indexMarkup.indexOf('src="/js/video-codec.js"') < indexMarkup.indexOf('src="/js/app.js"'),
  "video-codec.js loads before app.js");

console.log("video codec tests passed");
