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
  assert.fail(`receiver is decoding ${seen}, expected ${mime}; receiver state: ${JSON.stringify(await receiverVideoState(page))}`);
}

// What the receiving browser negotiated and is getting for video, for a
// failure message that says where the stream stopped.
async function receiverVideoState(page) {
  return page.evaluate(async () => {
    const peer = window.__slowMeetTest.peerConnections.at(-1);
    const sections = (description) => (description?.sdp || "").split(/\r\nm=/).slice(1)
      .map((section) => `m=${section}`.split("\r\n"))
      .filter((lines) => lines[0].startsWith("m=video"))
      .map((lines) => ({
        mid: (lines.find((line) => line.startsWith("a=mid:")) || "").slice(6),
        direction: (lines.find((line) => /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) || "").slice(2),
        payloadTypes: lines[0].split(" ").slice(3, 8).join(" "),
        msid: lines.filter((line) => line.startsWith("a=msid:")).map((line) => line.slice(7, 40)),
        ssrc: [...new Set(lines.filter((line) => line.startsWith("a=ssrc:")).map((line) => line.slice(7).split(" ")[0]))]
      }));
    const sample = async () => {
      const report = await peer.getStats();
      const codecs = new Map();
      const result = { inbound: [], transportBytesReceived: 0 };
      report.forEach((stat) => {
        if (stat.type === "codec") codecs.set(stat.id, `${stat.mimeType}/${stat.payloadType}`);
      });
      report.forEach((stat) => {
        if (stat.type === "inbound-rtp" && stat.kind === "video") {
          result.inbound.push({ mid: stat.mid, ssrc: stat.ssrc, packets: stat.packetsReceived,
            frames: stat.framesDecoded, codec: codecs.get(stat.codecId) || null });
        }
        if (stat.type === "candidate-pair" && (stat.nominated || stat.selected)) {
          result.transportBytesReceived = Math.max(result.transportBytesReceived, stat.bytesReceived || 0);
        }
      });
      return result;
    };
    const first = await sample();
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const second = await sample();
    return {
      remote: sections(peer.remoteDescription),
      local: sections(peer.localDescription),
      transceivers: peer.getTransceivers().filter((transceiver) => transceiver.receiver.track.kind === "video")
        .map((transceiver) => ({ mid: transceiver.mid, direction: transceiver.direction,
          currentDirection: transceiver.currentDirection, receiverTrack: transceiver.receiver.track.id.slice(0, 9),
          muted: transceiver.receiver.track.muted, readyState: transceiver.receiver.track.readyState })),
      inbound: second.inbound,
      receivedKbps: Math.round((second.transportBytesReceived - first.transportBytesReceived) * 8 / 2000)
    };
  });
}

async function setCamera(page, on) {
  const camera = page.locator("#camera");
  await camera.waitFor({ state: "visible" });
  if ((await camera.getAttribute("aria-pressed")) !== String(on)) await camera.click();
  await page.waitForFunction((pressed) =>
    document.querySelector("#camera")?.getAttribute("aria-pressed") === pressed,
  String(on), { timeout: 15000 });
}

// Any inbound video stream that is decoding frames right now, whatever its
// codec.
async function waitForReceivedVideo(page, step, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await advancingInboundVideoMime(page)) return;
  }
  assert.fail(`receiver got no video after ${step}; receiver state: ${JSON.stringify(await receiverVideoState(page))}`);
}

async function waitForNoReceivedVideo(page, step, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (!(await advancingInboundVideoMime(page))) return;
  }
  assert.fail(`receiver still gets video after ${step}`);
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
  },
  {
    // The server puts a new outgoing track on the first free media line of
    // the viewer's connection, so every round here lands on a line that
    // carried another stream before. Firefox has failed to bind such streams.
    name: "a viewer keeps getting video after the sender leaves and rejoins, and after a camera restart",
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      await setCamera(pageA, true);
      await waitForReceivedVideo(pageB, "first join");

      for (const round of ["first", "second"]) {
        await pageA.locator("#leave").click();
        await waitForNoReceivedVideo(pageB, `${round} leave`);
        // Leaving ends on the "meeting ended" screen; a fresh page load
        // brings the join form back for a new participant.
        await pageA.goto(fixture.baseURL);
        await fixture.join("A", `Alice ${round} rejoin`);
        await fixture.waitForConnected("A");
        await setCamera(pageA, true);
        await waitForReceivedVideo(pageB, `${round} rejoin`);
      }

      for (const round of ["first", "second"]) {
        await setCamera(pageA, false);
        await waitForNoReceivedVideo(pageB, `${round} camera stop`);
        await setCamera(pageA, true);
        await waitForReceivedVideo(pageB, `${round} camera restart`);
      }
      await fixture.assertPeersConnected("after rejoins and camera restarts");
    }
  },
  {
    // The server does not transcode, so one device without a codec takes it
    // away from the whole room while it is there.
    name: "a device without AV1 brings the room down to VP9 and the room recovers",
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      // B reports no AV1 support, as a phone without an AV1 codec does. The
      // script must be in place before the page's own scripts read the
      // capabilities, so the page is loaded again after installing it.
      await pageB.addInitScript(() => {
        for (const endpoint of [RTCRtpSender, RTCRtpReceiver]) {
          const original = endpoint.getCapabilities.bind(endpoint);
          endpoint.getCapabilities = (kind) => {
            const capabilities = original(kind);
            if (!capabilities || kind !== "video") return capabilities;
            return { ...capabilities, codecs: capabilities.codecs.filter((codec) => !/av1/i.test(codec.mimeType)) };
          };
        }
      });
      await pageB.goto(fixture.baseURL);

      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await setCamera(pageA, true);
      await waitForSentCodec(pageA, "AV1");

      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      await waitForSentCodec(pageA, "VP9");
      await waitForReceivedCodec(pageB, "video/VP9");
      const note = await pageA.locator("#video-codec-note").textContent();
      assert.match(note, /Sending VP9\. Not everyone here can play AV1\./, "the sender is told why it is not on the default codec");
      const av1Option = await pageB.evaluate(() => {
        const option = document.querySelector('#video-codec option[value="av1"]');
        return option ? { disabled: option.disabled, text: option.textContent } : null;
      });
      assert.deepEqual(av1Option, { disabled: true, text: "AV1 (not supported on this device)" });

      // After the limiting device leaves, the room returns to the default,
      // but only once it has held still: a device that drops and comes back
      // must not switch every encoder twice.
      await pageB.locator("#leave").click();
      await pageA.waitForTimeout(8000);
      assert.equal(await pageA.locator("#metric-video-codec").textContent(), "VP9",
        "the sender moved back to AV1 before the hold time passed");
      await waitForSentCodec(pageA, "AV1", 30000);
    }
  }
];

module.exports = { scenarios };
