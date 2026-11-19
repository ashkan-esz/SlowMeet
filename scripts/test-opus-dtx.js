const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { applyOpusDTX, effectivePreference } = require("../web/js/opus-dtx.js");

const plain = "v=0\r\n" +
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63\r\n" +
  "a=rtpmap:111 opus/48000/2\r\n" +
  "a=fmtp:111 minptime=10;useinbandfec=1\r\n" +
  "a=rtpmap:63 red/48000/2\r\n" +
  "a=fmtp:63 111/111\r\n" +
  "m=video 9 UDP/TLS/RTP/SAVPF 96 97\r\n" +
  "a=rtpmap:96 VP8/90000\r\n" +
  "a=fmtp:97 apt=96\r\n";
const marked = plain.replace("useinbandfec=1\r\n", "useinbandfec=1;usedtx=1\r\n");

// On: the marker lands on the Opus line only, once, and stays put.
assert.equal(applyOpusDTX(plain, true), marked, "DTX on must mark the Opus fmtp line");
assert.equal(applyOpusDTX(marked, true), marked, "DTX on must be idempotent");
// Off: the server's marker is removed and nothing else changes.
assert.equal(applyOpusDTX(marked, false), plain, "DTX off must strip the server's marker");
assert.equal(applyOpusDTX(plain, false), plain, "DTX off must leave an unmarked SDP alone");
// No choice and no known default: exactly what the server sent.
for (const undecided of [null, undefined, "true", 1, 0, ""]) {
  assert.equal(applyOpusDTX(marked, undecided), marked, `${JSON.stringify(undecided)} must pass the SDP through`);
  assert.equal(applyOpusDTX(plain, undecided), plain, `${JSON.stringify(undecided)} must pass the SDP through`);
}
// Parameter order and an explicit usedtx=0 are handled; line endings survive.
assert.equal(applyOpusDTX("a=fmtp:111 usedtx=0;minptime=10;useinbandfec=1\n", true),
  "a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1\n");
assert.equal(applyOpusDTX("a=fmtp:111 minptime=10;usedtx=1;useinbandfec=1\n", false),
  "a=fmtp:111 minptime=10;useinbandfec=1\n");
assert.equal(applyOpusDTX("a=fmtp:111 useinbandfec=1", true), "a=fmtp:111 useinbandfec=1;usedtx=1",
  "a final line without a terminator is still handled");
// Several audio sections are all rewritten.
const twoSections = plain + plain;
assert.equal(applyOpusDTX(twoSections, true).split("usedtx=1").length - 1, 2);
assert.equal(applyOpusDTX(applyOpusDTX(twoSections, true), false), twoSections);
// Non-string input and SDP without Opus are returned untouched.
assert.equal(applyOpusDTX(undefined, true), undefined);
const videoOnly = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=fmtp:97 apt=96\r\n";
assert.equal(applyOpusDTX(videoOnly, true), videoOnly);
assert.equal(applyOpusDTX(videoOnly, false), videoOnly);

// The stored choice wins over the server default; without either the SDP is
// left as the server sent it.
assert.equal(effectivePreference("true", false), true);
assert.equal(effectivePreference("false", true), false);
assert.equal(effectivePreference(null, true), true);
assert.equal(effectivePreference(null, false), false);
assert.equal(effectivePreference(undefined, null), null);
assert.equal(effectivePreference("yes", undefined), null, "an unrecognised stored value counts as no choice");
assert.equal(effectivePreference(null, "true"), null, "only a boolean server default is trusted");

const appSource = fs.readFileSync(path.join(__dirname, "..", "web/js/app.js"), "utf8");
const indexSource = fs.readFileSync(path.join(__dirname, "..", "web/index.html"), "utf8");

// Every remote description goes through the participant's choice.
const remoteDescriptions = appSource.match(/currentPeer\.setRemoteDescription\(\{[^}]*\}\)/g) || [];
assert.equal(remoteDescriptions.length, 2, "the offer and the answer handler each apply one remote description");
for (const call of remoteDescriptions) {
  assert.match(call, /sdp: applyOpusDTXChoice\(message\.sdp\)/,
    `a remote description must be rewritten with the DTX choice before it is applied: ${call}`);
}
assert.match(appSource, /function applyOpusDTXChoice\(sdp\) \{[\s\S]{0,200}applyOpusDTX\(sdp, opusDTXEffective\(\)\)/,
  "the rewrite must use the effective preference");
assert.match(appSource, /function opusDTXEffective\(\) \{[\s\S]{0,200}effectivePreference\(opusDTXStored, opusDTXServerDefault\)/,
  "the effective preference combines the stored choice and the server default");
assert.match(appSource, /opusDTXServerDefault = typeof config\.opus_dtx_enabled === "boolean" \? config\.opus_dtx_enabled : null;/,
  "the server default comes from the ICE configuration");
// The switch stores the choice and applies it to the live call.
assert.match(appSource, /opusDTXSwitch\?\.addEventListener\("change", \(\) => \{[\s\S]*?writeStoredValue\("meeting\.opusDtx", opusDTXStored\);[\s\S]*?renegotiateLocalMedia\(\)\.catch\(/,
  "changing the switch must persist the choice and renegotiate so it takes effect mid-call");
assert.match(appSource, /let opusDTXStored = readStoredValue\("meeting\.opusDtx"\);/,
  "the choice is restored from storage on load");

assert.match(indexSource, /<input id="opus-dtx" type="checkbox"[^>]*>/, "Settings must contain the DTX switch");
const moduleAt = indexSource.indexOf('<script defer src="/js/opus-dtx.js"></script>');
const appAt = indexSource.indexOf('<script defer src="/js/app.js"></script>');
assert.ok(moduleAt > 0 && appAt > moduleAt, "opus-dtx.js must load before app.js");

console.log("Opus DTX tests passed");
