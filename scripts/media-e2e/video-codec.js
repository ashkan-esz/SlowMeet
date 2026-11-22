const assert = require("node:assert/strict");

const adminPassword = "slowmeet-e2e-admin-password";

function pageFor(fixture, role) {
  const page = role === "A" ? fixture.pageA : fixture.pageB;
  assert.ok(page, `fixture is missing page ${role}`);
  return page;
}

// The codec the sender's own stats report for its outgoing video, as shown in
// the connection details.
async function waitForSentCodec(page, label, timeout = 45000) {
  await page.waitForFunction((expected) =>
    document.querySelector("#metric-video-codec")?.textContent === expected,
  label, { timeout });
}

// The MIME type of the inbound video stream that is decoding frames right now.
// A codec switch replaces the receiver's track, so a finished stream of the
// previous codec can still be listed; only one that advances counts.
async function advancingInboundVideoMime(page) {
  return page.evaluate(async () => {
    const peer = window.__slowMeetTest.peerConnections.at(-1);
    const sample = async () => {
      const report = await peer.getStats();
      const codecs = new Map();
      const streams = new Map();
      report.forEach((stat) => {
        if (stat.type === "codec") codecs.set(stat.id, stat.mimeType);
      });
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && stat.kind === "video") {
          streams.set(stat.id, { frames: stat.framesDecoded || 0, mime: codecs.get(stat.codecId) || null });
        }
      });
      return streams;
    };
    const before = await sample();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await sample();
    for (const [id, stream] of after) {
      if (stream.frames > (before.get(id)?.frames ?? 0)) return stream.mime;
    }
    return null;
  });
}

async function waitForReceivedCodec(page, mime, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let seen = null;
  while (Date.now() < deadline) {
    seen = await advancingInboundVideoMime(page);
    if (seen === mime) return;
  }
  assert.fail(`receiver is decoding ${seen}, expected ${mime}`);
}

async function updateAdminConfig(fixture, body) {
  const response = await fetch(`${fixture.baseURL}/admin/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Password": adminPassword },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, `admin update failed: ${await response.text()}`);
}

const scenarios = [
  {
    name: "video codec follows the server default, an admin change, and the participant's choice",
    // Changes admin settings, so it needs its own local server started with an
    // admin password (the runner's connectionMethodTest server has one).
    when: "localCapacity",
    localCapacityLimit: 2,
    connectionMethodTest: true,
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();

      const camera = pageA.locator("#camera");
      if ((await camera.getAttribute("aria-pressed")) !== "true") await camera.click();

      // Both browsers support AV1, the default, so the room uses it.
      await waitForSentCodec(pageA, "AV1");
      await waitForReceivedCodec(pageB, "video/AV1");
      const senderBefore = await pageA.evaluate(() => {
        const peer = window.__slowMeetTest.peerConnections.at(-1);
        return peer.getSenders().filter((sender) => sender.track?.kind === "video").length;
      });

      // The administrator changes the default mid-call: the sender switches
      // encoder on the same connection and the receiver keeps getting video.
      await updateAdminConfig(fixture, { default_video_codec: "vp8" });
      await waitForSentCodec(pageA, "VP8");
      await waitForReceivedCodec(pageB, "video/VP8");

      // The participant picks another allowed codec in Settings.
      await pageA.evaluate(() => {
        const select = document.querySelector("#video-codec");
        if (![...select.options].some((option) => option.value === "vp9" && !option.disabled)) {
          throw new Error("VP9 is not offered in Settings");
        }
        select.value = "vp9";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await waitForSentCodec(pageA, "VP9");
      await waitForReceivedCodec(pageB, "video/VP9");

      // A codec the administrator removes is given up at once, even though the
      // participant chose it.
      await updateAdminConfig(fixture, { video_codecs: ["vp8", "h264"], default_video_codec: "vp8" });
      await waitForSentCodec(pageA, "VP8");
      await waitForReceivedCodec(pageB, "video/VP8");

      const senderAfter = await pageA.evaluate(() => {
        const peer = window.__slowMeetTest.peerConnections.at(-1);
        return peer.getSenders().filter((sender) => sender.track?.kind === "video").length;
      });
      assert.equal(senderAfter, senderBefore, "codec switches reuse the camera sender");
      await fixture.assertPeersConnected("after codec switches");
      await updateAdminConfig(fixture, { video_codecs: ["av1", "vp9", "vp8", "h264"], default_video_codec: "av1" });
    }
  }
];

module.exports = { scenarios };
