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

// --- Simulcast ---------------------------------------------------------------

// A server of its own with simulcast on and an admin password. Medium default
// quality gives a capture large enough for at least two layers.
const simulcastServer = {
  when: "localCapacity",
  localCapacityLimit: 2,
  connectionMethodTest: true,
  serverEnv: { SIMULCAST_ENABLED: "true", DEFAULT_VIDEO_QUALITY: "medium" }
};

const codecMimes = { av1: "video/AV1", vp9: "video/VP9", vp8: "video/VP8", h264: "video/H264" };
const browserName = process.env.MEDIA_E2E_BROWSER || "chromium";

// The codec a simulcast camera in this browser ends up with when `codec` is
// wanted: the codec itself where the page found that the browser can send it
// as separate layers, VP8 otherwise.
async function simulcastMime(page, codec) {
  if (codec === "vp8" || codec === "h264") return codecMimes[codec];
  const layered = await page.evaluate((name) => videoCodecsLayerable.has(name), codec);
  // Chromium is known to send both newer codecs as layers; if the page stops
  // finding that out, the scenarios must fail rather than quietly test VP8.
  if (browserName === "chromium") {
    assert.equal(layered, true, `Chromium did not report ${codec} as sendable in simulcast layers`);
  }
  return layered ? codecMimes[codec] : codecMimes.vp8;
}

// The camera's simulcast layers that are encoding frames right now, and how
// many the sender plans to send.
async function cameraLayers(page) {
  return page.evaluate(async () => {
    const peer = window.__slowMeetTest.peerConnections.at(-1);
    const sender = peer.getSenders().find((candidate) => candidate.track?.kind === "video");
    const planned = sender
      ? sender.getParameters().encodings.filter((encoding) => encoding.active !== false).length : 0;
    const sample = async () => {
      const report = await peer.getStats();
      const codecs = new Map();
      const layers = new Map();
      report.forEach((stat) => {
        if (stat.type === "codec") codecs.set(stat.id, stat.mimeType);
      });
      report.forEach((stat) => {
        if (stat.type === "outbound-rtp" && stat.kind === "video" && stat.rid) {
          layers.set(stat.rid, { frames: stat.framesEncoded || 0, mime: codecs.get(stat.codecId) || null,
            mode: stat.scalabilityMode || null });
        }
      });
      return layers;
    };
    const before = await sample();
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const after = await sample();
    const encoding = [];
    for (const [rid, layer] of after) {
      if (layer.frames > (before.get(rid)?.frames ?? 0)) encoding.push({ rid, mime: layer.mime, mode: layer.mode });
    }
    return { planned, encoding };
  });
}

// Every planned layer is encoding, and all of them in the wanted codec.
async function waitForCameraLayers(page, mime, timeout = 45000) {
  const deadline = Date.now() + timeout;
  let state = null;
  while (Date.now() < deadline) {
    state = await cameraLayers(page);
    if (state.planned >= 2 && state.encoding.length === state.planned &&
        state.encoding.every((layer) => layer.mime === mime)) {
      return state;
    }
  }
  assert.fail(`camera layers are ${JSON.stringify(state)}, expected every planned layer (at least two) in ${mime}`);
}

async function joinSimulcastPair(fixture) {
  const pageA = pageFor(fixture, "A");
  const pageB = pageFor(fixture, "B");
  await fixture.join("A", "Alice");
  await fixture.waitForConnected("A");
  await fixture.join("B", "Bob");
  await fixture.waitForConnected();
  assert.equal(await pageA.evaluate(() => simulcastEnabled), true, "the server did not turn simulcast on");
  await setCamera(pageA, true);
  return { pageA, pageB };
}

async function pickCodec(page, codec) {
  await page.evaluate((value) => {
    const select = document.querySelector("#video-codec");
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, codec);
}

// Makes the page report no AV1 support, as a device without an AV1 codec
// does. Takes effect on the next page load.
async function reportNoAV1(page) {
  await page.addInitScript(() => {
    for (const endpoint of [RTCRtpSender, RTCRtpReceiver]) {
      const original = endpoint.getCapabilities.bind(endpoint);
      endpoint.getCapabilities = (kind) => {
        const capabilities = original(kind);
        if (!capabilities || kind !== "video") return capabilities;
        return { ...capabilities, codecs: capabilities.codecs.filter((codec) => !/av1/i.test(codec.mimeType)) };
      };
    }
  });
}

async function updateAdminConfig(fixture, body) {
  const response = await fetch(`${fixture.baseURL}/admin/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Password": adminPassword },
    body: JSON.stringify(body)
  });
  assert.equal(response.status, 200, `admin update failed: ${await response.text()}`);
}

// Hands the page a generated screen in place of a captured one: the screen
// picker cannot run headless. From there the app takes its whole
// screen-share path. Without motion it is a document in which only a small
// counter changes, ten times a second.
async function offerGeneratedScreen(page, width, height, motion = false) {
  await page.evaluate(([width, height, motion]) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    let frame = 0;
    const draw = () => {
      frame += 1;
      if (!motion && frame > 1) {
        // A document on screen: only a small counter changes.
        context.fillStyle = "#fff";
        context.fillRect(canvas.width - 420, canvas.height - 80, 400, 60);
        context.fillStyle = "#111";
        context.fillText(`frame ${frame}`, canvas.width - 410, canvas.height - 40);
        return;
      }
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.fillStyle = "#111";
      context.font = "20px monospace";
      for (let row = 0; row < 40; row += 1) {
        context.fillText(`${frame} ${"shared screen text ".repeat(7)}${row * frame}`, 10, 22 * (row + 1));
      }
      for (let block = 0; block < 320; block += 1) {
        context.fillStyle = `hsl(${(block * 37 + frame * 11) % 360} 80% 50%)`;
        context.fillRect((block % 40) * 48, 900 + Math.floor(block / 40) * 22, 48, 22);
      }
    };
    draw();
    window.__screenDrawTimer = setInterval(draw, 100);
    const stream = canvas.captureStream(10);
    Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => stream });
  }, [width, height, motion]);
}

// How many video streams the server republished because a publisher changed
// codec, from /metrics.
async function codecSwitches(fixture) {
  const text = await (await fetch(`${fixture.baseURL}/metrics`)).text();
  const match = text.match(/^slowmeet_video_codec_switches_total (\d+)$/m);
  assert.ok(match, "the server reports no codec switch count");
  return Number(match[1]);
}

// What the busiest outgoing video stream did over four seconds. The bytes sent
// in the quarter second after a keyframe show how large its keyframes are.
async function outboundVideoEvidence(page) {
  return page.evaluate(async () => {
    const peer = window.__slowMeetTest.peerConnections.at(-1);
    const read = async () => {
      let best = null;
      (await peer.getStats()).forEach((stat) => {
        if (stat.type === "outbound-rtp" && stat.kind === "video" && (stat.bytesSent || 0) >= (best?.bytesSent || 0)) best = stat;
      });
      return best;
    };
    const samples = [];
    const until = Date.now() + 4000;
    while (Date.now() < until) {
      const sample = await read();
      if (sample) samples.push(sample);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (samples.length < 2) return null;
    let largestKeyFrameBytes = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (samples[index].keyFramesEncoded > samples[index - 1].keyFramesEncoded) {
        const after = samples[Math.min(index + 5, samples.length - 1)];
        largestKeyFrameBytes = Math.max(largestKeyFrameBytes, after.bytesSent - samples[index - 1].bytesSent);
      }
    }
    const first = samples[0];
    const last = samples.at(-1);
    return {
      width: last.frameWidth, height: last.frameHeight, fps: last.framesPerSecond,
      kbps: Math.round((last.bytesSent - first.bytesSent) * 8 / 4000),
      keyFrames: last.keyFramesEncoded, keyFramesInWindow: last.keyFramesEncoded - first.keyFramesEncoded,
      largestKeyFrameBytes, pli: last.pliCount, nack: last.nackCount, hugeFrames: last.hugeFramesSent,
      limited: last.qualityLimitationReason,
      caps: peer.getSenders().filter((sender) => sender.track?.kind === "video")
        .map((sender) => sender.getParameters().encodings.map((encoding) =>
          `${encoding.active === false ? "off" : "on"}/${encoding.maxBitrate ?? "-"}bps/${encoding.maxFramerate ?? "-"}fps`).join(","))
    };
  });
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
      assert.equal(await codecSwitches(fixture), 0, "the camera must start in its final codec, with no switch");
      const senderBefore = await pageA.evaluate(() => {
        const peer = window.__slowMeetTest.peerConnections.at(-1);
        return peer.getSenders().filter((sender) => sender.track?.kind === "video").length;
      });

      // The administrator changes the default mid-call: the sender switches
      // encoder on the same connection and the receiver keeps getting video.
      const viewerOffers = () => pageB.evaluate(() => window.__slowMeetTest.signalingMessages
        .filter((message) => message.direction === "out" && message.type === "offer").length);
      const offersBefore = await viewerOffers();
      await updateAdminConfig(fixture, { default_video_codec: "vp8" });
      await waitForSentCodec(pageA, "VP8");
      await waitForReceivedCodec(pageB, "video/VP8");
      // The viewer sends no video, so the change is nothing it has to
      // negotiate; an offer of its own would only cost a round trip.
      assert.equal(await viewerOffers(), offersBefore, "a viewer without video renegotiated for a codec change");

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
        await waitForSentCodec(pageA, "Not active");
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
  },
  {
    name: "simulcast camera layers use the default codec where the browser can send it as layers",
    ...simulcastServer,
    async run(fixture) {
      const { pageA, pageB } = await joinSimulcastPair(fixture);
      const mime = await simulcastMime(pageA, "av1");
      let state = await waitForCameraLayers(pageA, mime);
      assert.equal(new Set(state.encoding.map((layer) => layer.rid)).size, state.planned, "every layer has its own rid");
      if (mime === codecMimes.av1) {
        // A layer's scalability mode can lag its first frames in the stats.
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline && !state.encoding.every((layer) => /^L1T/.test(String(layer.mode)))) {
          state = await waitForCameraLayers(pageA, mime);
        }
        console.log(`[simulcast codec evidence] ${JSON.stringify(state)}`);
        for (const layer of state.encoding) {
          assert.match(String(layer.mode), /^L1T/, `layer ${layer.rid} must be a stream of its own, not carry other layers`);
        }
        assert.equal(await pageA.locator("#video-codec-note").textContent(), "Sending AV1.");
      } else {
        assert.equal(await pageA.locator("#video-codec-note").textContent(),
          "Sending VP8. This browser cannot send AV1 as simulcast layers.");
      }
      await waitForReceivedCodec(pageB, mime);
      assert.equal(await codecSwitches(fixture), 0, "the layers must start in their final codec, with no switch");
      await fixture.assertPeersConnected("simulcast with the default codec");
    }
  },
  {
    name: "simulcast camera layers follow codec changes and layer requests without going dark",
    ...simulcastServer,
    async run(fixture) {
      const { pageA, pageB } = await joinSimulcastPair(fixture);
      await waitForCameraLayers(pageA, await simulcastMime(pageA, "av1"));
      await waitForReceivedVideo(pageB, "simulcast start");
      for (const codec of ["vp9", "vp8", "av1"]) {
        await updateAdminConfig(fixture, { default_video_codec: codec });
        const mime = await simulcastMime(pageA, codec);
        await waitForCameraLayers(pageA, mime);
        await waitForReceivedCodec(pageB, mime);
        // The viewer asks for the small layer and then the large one; each
        // is a different stream of the new codec on the server.
        for (const layer of ["low", "high"]) {
          await pageB.evaluate((wanted) => setCameraLayer(wanted), layer);
          await waitForReceivedCodec(pageB, mime);
        }
      }
      await fixture.assertPeersConnected("simulcast codec changes");
    }
  },
  {
    name: "a device without AV1 brings a simulcast room down and the room recovers",
    ...simulcastServer,
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await reportNoAV1(pageB);
      await pageB.goto(fixture.baseURL);
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await setCamera(pageA, true);
      const withEveryone = await simulcastMime(pageA, "av1");
      await waitForCameraLayers(pageA, withEveryone);

      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      const withoutAV1 = await simulcastMime(pageA, "vp9");
      await waitForCameraLayers(pageA, withoutAV1);
      await waitForReceivedCodec(pageB, withoutAV1);

      await pageB.locator("#leave").click();
      await waitForCameraLayers(pageA, withEveryone, 60000);
    }
  },
  {
    name: "a participant's codec pick applies to every simulcast layer",
    ...simulcastServer,
    async run(fixture) {
      const { pageA, pageB } = await joinSimulcastPair(fixture);
      await waitForCameraLayers(pageA, await simulcastMime(pageA, "av1"));
      await pickCodec(pageA, "vp9");
      const picked = await simulcastMime(pageA, "vp9");
      await waitForCameraLayers(pageA, picked);
      await waitForReceivedCodec(pageB, picked);
      if (picked !== codecMimes.vp9) {
        assert.equal(await pageA.locator("#video-codec-note").textContent(),
          "Sending VP8. This browser cannot send VP9 as simulcast layers.");
      }
      await pickCodec(pageA, "vp8");
      await waitForCameraLayers(pageA, codecMimes.vp8);
      await waitForReceivedCodec(pageB, codecMimes.vp8);
      await pickCodec(pageA, "auto");
      const automatic = await simulcastMime(pageA, "av1");
      await waitForCameraLayers(pageA, automatic);
      await waitForReceivedCodec(pageB, automatic);
      await fixture.assertPeersConnected("simulcast codec picks");
    }
  },
  {
    // Every switch replaces the viewer's track. The viewer must keep
    // decoding after each one, and the tracks must go back onto media lines
    // that became free, or the session description would grow by a line per
    // switch for the rest of the call.
    name: "many codec switches in a row keep the viewer's video and reuse its media lines",
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
      await setCamera(pageA, true);
      await waitForSentCodec(pageA, "AV1");
      await waitForReceivedCodec(pageB, codecMimes.av1);
      const videoLines = () => pageB.evaluate(() =>
        (window.__slowMeetTest.peerConnections.at(-1).remoteDescription.sdp.match(/^m=video /gm) || []).length);
      const before = await videoLines();
      const labels = { av1: "AV1", vp9: "VP9", vp8: "VP8" };
      const switches = ["vp8", "av1", "vp9", "vp8", "av1", "vp9", "av1", "vp8"];
      for (const [index, codec] of switches.entries()) {
        await updateAdminConfig(fixture, { default_video_codec: codec });
        await waitForSentCodec(pageA, labels[codec]);
        try {
          await waitForReceivedCodec(pageB, codecMimes[codec]);
        } catch (error) {
          assert.fail(`switch ${index + 1} of ${switches.length} (to ${codec}): ${error.message}`);
        }
      }
      const after = await videoLines();
      console.log(`[codec switch evidence] viewer video lines ${before} -> ${after} after ${switches.length} switches`);
      assert.ok(after <= before + 1,
        `the viewer's session description grew from ${before} to ${after} video lines over ${switches.length} switches`);
      await updateAdminConfig(fixture, { default_video_codec: "av1" });
      await fixture.assertPeersConnected("after many codec switches");
    }
  },
  {
    // With MEDIA_E2E_BROWSER_B set to the other engine this is the interop
    // check: the engines number payload types differently and offer different
    // H.264 profiles. With one engine it covers H.264 where that engine has it.
    name: "two browsers exchange every codec they share in both directions",
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      const labels = { av1: "AV1", vp9: "VP9", vp8: "VP8", h264: "H.264" };
      const engines = { A: browserName, B: process.env.MEDIA_E2E_BROWSER_B || browserName };
      for (const [role, sender, viewer] of [["A", pageA, pageB], ["B", pageB, pageA]]) {
        await setCamera(sender, true);
        const shared = await sender.evaluate(() =>
          (videoCodecsRoom || []).filter((codec) => (videoCodecsDevice || []).includes(codec)));
        assert.ok(shared.includes("vp8"), `the room of ${role} has no VP8: ${shared}`);
        const done = [];
        for (const codec of shared) {
          await pickCodec(sender, codec);
          try {
            // Either the codec is sent, or the browser turns out to have no
            // encoder for it and the camera falls back with a note.
            const outcome = await sender.waitForFunction(({ label }) => {
              const sending = document.querySelector("#metric-video-codec")?.textContent;
              const note = document.querySelector("#video-codec-note")?.textContent || "";
              if (sending === label) return "sent";
              if (note.includes(`This device cannot send ${label}.`) && sending && sending !== "Not active") return "fell back";
              return false;
            }, { label: labels[codec] }, { timeout: 40000 }).then((handle) => handle.jsonValue());
            if (outcome === "fell back") {
              assert.notEqual(engines[role], "chromium", `Chromium could not encode ${codec}`);
              await waitForReceivedVideo(viewer, `${engines[role]} falling back from ${codec}`);
              done.push(`${codec} (no encoder, fell back)`);
              continue;
            }
            await waitForReceivedCodec(viewer, codecMimes[codec]);
          } catch (error) {
            const state = await sender.evaluate(() => ({
              sending: document.querySelector("#metric-video-codec")?.textContent,
              note: document.querySelector("#video-codec-note")?.textContent
            }));
            assert.fail(`${engines[role]} sending ${codec} (done so far: ${done.join(", ") || "none"}; ` +
              `sender shows ${JSON.stringify(state)}): ${String(error.message).slice(0, 300)}`);
          }
          done.push(codec);
        }
        console.log(`[codec matrix evidence] ${engines[role]} (${role}) sent and the other side decoded: ${done.join(", ")}`);
        await pickCodec(sender, "auto");
        await setCamera(sender, false);
        await waitForNoReceivedVideo(viewer, `${role} camera off`);
      }
      await fixture.assertPeersConnected("after the codec matrix");
    }
  },
  {
    name: "a screen share uses the room's codec, follows a codec pick, and keeps arriving",
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      // The screen picker cannot run headless, so the page is handed a
      // 1920x1080 stream of changing text and colour in place of a captured
      // screen. From there it takes the app's whole screen-share path.
      const screenSize = (process.env.MEDIA_E2E_SCREEN_SIZE || "1920x1080").split("x").map(Number);
      const order = (process.env.MEDIA_E2E_SCREEN_ORDER || "av1,vp9,vp8").split(",");
      const labels = { av1: "AV1", vp9: "VP9", vp8: "VP8", h264: "H.264" };
      await offerGeneratedScreen(pageA, ...screenSize, process.env.MEDIA_E2E_SCREEN_CONTENT === "motion");
      const setScreen = async (on) => {
        await pageA.locator("#screen").click();
        await pageA.waitForFunction((pressed) =>
          document.querySelector("#screen")?.getAttribute("aria-pressed") === pressed,
        String(on), { timeout: 30000 });
      };
      // MEDIA_E2E_SCREEN_PROFILE picks the sender's network profile, which
      // sets the bitrate a shared screen may use (the default profile is slow).
      if (process.env.MEDIA_E2E_SCREEN_PROFILE) {
        await pageA.evaluate((profileName) => {
          const select = document.querySelector("#profile");
          select.value = profileName;
          select.dispatchEvent(new Event("change", { bubbles: true }));
        }, process.env.MEDIA_E2E_SCREEN_PROFILE);
      }
      await pickCodec(pageA, order[0]);
      await setScreen(true);
      for (const pick of order) {
        const label = labels[pick];
        await pickCodec(pageA, pick);
        await waitForSentCodec(pageA, label);
        try {
          await waitForReceivedCodec(pageB, codecMimes[pick]);
        } catch (error) {
          const viewer = await pageB.evaluate(async () => {
            const found = [];
            (await window.__slowMeetTest.peerConnections.at(-1).getStats()).forEach((stat) => {
              if (stat.type !== "inbound-rtp" || stat.kind !== "video") return;
              found.push({
                packets: stat.packetsReceived, lost: stat.packetsLost, retransmitted: stat.retransmittedPacketsReceived,
                nack: stat.nackCount, pli: stat.pliCount, framesReceived: stat.framesReceived,
                framesDecoded: stat.framesDecoded, framesDropped: stat.framesDropped, keyFrames: stat.keyFramesDecoded,
                decoder: stat.decoderImplementation, discarded: stat.packetsDiscarded
              });
            });
            return found;
          });
          error.message = `${label} screen, sender ${JSON.stringify(await outboundVideoEvidence(pageA))}, ` +
            `viewer ${JSON.stringify(viewer)}: ${error.message}`;
          throw error;
        }
        // Large frames must keep arriving, not only the first ones.
        const decodedFrames = () => pageB.evaluate(async () => {
          let frames = 0;
          (await window.__slowMeetTest.peerConnections.at(-1).getStats()).forEach((stat) => {
            if (stat.type === "inbound-rtp" && stat.kind === "video") frames += stat.framesDecoded || 0;
          });
          return frames;
        });
        const framesBefore = await decodedFrames();
        // The app keeps a shared screen sharp and lets its frame rate fall, so
        // a full-size screen at the default bitrate runs at about a frame a
        // second.
        const encodedFrames = () => pageA.evaluate(async () => {
          let frames = 0;
          (await window.__slowMeetTest.peerConnections.at(-1).getStats()).forEach((stat) => {
            if (stat.type === "outbound-rtp" && stat.kind === "video") frames += stat.framesEncoded || 0;
          });
          return frames;
        });
        const encodedBefore = await encodedFrames();
        await pageB.waitForTimeout(12000);
        const arrived = (await decodedFrames()) - framesBefore;
        const encoded = (await encodedFrames()) - encodedBefore;
        // Nearly every encoded frame must be shown: a frame lost on the way
        // leaves the viewer waiting for a keyframe (B18 to B20).
        if (arrived < 2 || arrived < Math.floor(encoded * 0.9) - 1) {
          assert.fail(`the shared screen stalled in ${label}: ${arrived} of ${encoded} encoded frames in 12 s, sender ` +
            JSON.stringify(await outboundVideoEvidence(pageA)));
        }
        const size = await pageB.evaluate(async () => {
          const stats = await window.__slowMeetTest.peerConnections.at(-1).getStats();
          let best = null;
          stats.forEach((report) => {
            if (report.type === "inbound-rtp" && report.kind === "video" && (report.frameWidth || 0) > (best?.width || 0)) {
              best = { width: report.frameWidth, height: report.frameHeight, keyFrames: report.keyFramesDecoded, frames: report.framesDecoded };
            }
          });
          return best;
        });
        console.log(`[screen share codec evidence] ${label}: ${arrived} of ${encoded} encoded frames in 12 s, viewer decodes ${JSON.stringify(size)}, ` +
          `sender ${JSON.stringify(await outboundVideoEvidence(pageA))}`);
      }
      await pickCodec(pageA, "auto");
      await setScreen(false);
      await waitForNoReceivedVideo(pageB, "screen share stopped");
      await fixture.assertPeersConnected("after the screen share");
    }
  },
  {
    name: "a working encoder is never judged unable to send",
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      const labels = { av1: "AV1", vp9: "VP9", vp8: "VP8" };
      // Every moment in which a camera sends nothing for a reason other than
      // a missing encoder: codec switches, a camera turned off and on, a new
      // connection after the signaling socket dropped, and a long quiet call.
      const assertNoVerdict = async (step) => {
        const state = await pageA.evaluate(() => ({
          broken: [...videoCodecsBroken],
          note: document.querySelector("#video-codec-note")?.textContent || ""
        }));
        assert.deepEqual(state.broken, [], `${step}: a codec was judged unable to send (${state.note})`);
        assert.ok(!state.note.includes("cannot send"), `${step}: the note says "${state.note}"`);
      };
      await setCamera(pageA, true);
      for (const codec of ["av1", "vp9", "vp8", "av1", "vp9"]) {
        await pickCodec(pageA, codec);
        await waitForSentCodec(pageA, labels[codec]);
        await waitForReceivedCodec(pageB, codecMimes[codec]);
        await assertNoVerdict(`after switching to ${codec}`);
      }
      await setCamera(pageA, false);
      await pageA.waitForTimeout(10000);
      await assertNoVerdict("with the camera off for ten seconds");
      await setCamera(pageA, true);
      await waitForSentCodec(pageA, "VP9");
      await assertNoVerdict("after the camera came back");

      await pageA.evaluate(() => socket.close());
      await pageA.waitForFunction(() => {
        const peers = window.__slowMeetTest.peerConnections;
        return peers.length > 1 && peers.at(-1).connectionState === "connected";
      }, null, { timeout: 45000 });
      await waitForSentCodec(pageA, "VP9");
      await waitForReceivedCodec(pageB, codecMimes.vp9);
      await assertNoVerdict("after a reconnect");

      await pageA.waitForTimeout(20000);
      await assertNoVerdict("after twenty quiet seconds");
      await waitForReceivedCodec(pageB, codecMimes.vp9);
    }
  },
  {
    name: "a shared screen too large for its bitrate shrinks until it moves again",
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      // On the default slow profile (180 kbps) one full-size VP9 keyframe
      // costs seconds of bitrate. A codec change in the middle of a share
      // asks for several, the viewer sees nothing for longer than it waits
      // before asking again, and every frame becomes a keyframe: a frame
      // every few seconds, for as long as the picture stays this large. The
      // sender must notice and send a smaller one.
      await offerGeneratedScreen(pageA, 1920, 1080);
      await pickCodec(pageA, "av1");
      await pageA.locator("#screen").click();
      await pageA.waitForFunction(() => document.querySelector("#screen")?.getAttribute("aria-pressed") === "true",
        null, { timeout: 30000 });
      await waitForSentCodec(pageA, "AV1");
      await waitForReceivedCodec(pageB, codecMimes.av1);
      await pickCodec(pageA, "vp9");
      await waitForSentCodec(pageA, "VP9");
      const screenScale = () => pageA.evaluate(() => screenSender?.getParameters().encodings[0]?.scaleResolutionDownBy ?? 1);
      const frames = () => pageB.evaluate(async () => {
        let decoded = 0;
        (await window.__slowMeetTest.peerConnections.at(-1).getStats()).forEach((stat) => {
          if (stat.type === "inbound-rtp" && stat.kind === "video") decoded += stat.framesDecoded || 0;
        });
        return decoded;
      });
      const rounds = [];
      for (let round = 0; round < 8 && (rounds.at(-1)?.frames ?? 0) < 30; round += 1) {
        const before = await frames();
        await pageB.waitForTimeout(12000);
        rounds.push({ frames: (await frames()) - before, scale: await screenScale() });
      }
      console.log(`[screen share codec evidence] VP9 screen after a codec change, per 12 s: ${JSON.stringify(rounds)}`);
      if (rounds.at(-1).frames < 30) {
        assert.fail(`the screen still crawls: ${JSON.stringify(rounds)}, sender ${JSON.stringify(await outboundVideoEvidence(pageA))}, ` +
          `adaptation ${JSON.stringify(await pageA.evaluate(() => screenShareAdaptation?.state()))}`);
      }
      // What starved VP9 does not starve AV1: back in AV1 the share is full
      // size again within a few samples, not after the three minutes the
      // starved size stays ruled out for VP9.
      await pickCodec(pageA, "av1");
      await waitForSentCodec(pageA, "AV1");
      await pageA.waitForFunction(() => (screenSender?.getParameters().encodings[0]?.scaleResolutionDownBy ?? 1) === 1,
        null, { timeout: 30000 });
      const before = await frames();
      await pageB.waitForTimeout(12000);
      const backInAV1 = (await frames()) - before;
      console.log(`[screen share codec evidence] back in AV1 at full size, per 12 s: ${backInAV1} frames, ` +
        `sender ${JSON.stringify(await outboundVideoEvidence(pageA))}`);
      // Firefox encodes a 1920x1080 AV1 screen at about two frames a second
      // on this bitrate from the start of a share as well (25 in 12 s).
      assert.ok(backInAV1 >= 15, `the screen crawls after returning to AV1: ${backInAV1} frames in 12 s`);
    }
  },
  {
    // B22 and B23 in docs/network-testing.md. A profile above the server's
    // limit makes the browser encode at exactly the limit, a few percent over
    // it with packet headers; a moving screen keeps the encoder there. The
    // server's pacing queue used to fill (63 frames, every frame 12 s late,
    // nothing dropped), after a start in which three keyframe requests cost
    // three extra keyframes.
    name: "a sender at the server's bitrate limit does not fall seconds behind",
    localCapacityLimit: 2,
    connectionMethodTest: true,
    serverEnv: { MAX_VIDEO_BITRATE: "300000" },
    async run(fixture) {
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      await pageA.evaluate((profileName) => {
        const select = document.querySelector("#profile");
        select.value = profileName;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      }, "ultra");
      await pickCodec(pageA, "vp8");
      await offerGeneratedScreen(pageA, 1920, 1080, true);
      await pageA.locator("#screen").click();
      const sent = () => pageA.evaluate(async () => {
        const out = { bytes: 0, header: 0, frames: 0, keys: 0, pli: 0, target: 0, size: "" };
        (await peer.getStats()).forEach((stat) => {
          if (stat.type !== "outbound-rtp" || stat.kind !== "video") return;
          out.bytes += stat.bytesSent || 0;
          out.header += stat.headerBytesSent || 0;
          out.frames += stat.framesEncoded || 0;
          out.keys += stat.keyFramesEncoded || 0;
          out.pli += stat.pliCount || 0;
          out.target = stat.targetBitrate || out.target;
          if (stat.frameWidth) out.size = `${stat.frameWidth}x${stat.frameHeight}`;
        });
        return out;
      });
      const decoded = () => pageB.evaluate(async () => {
        let frames = 0;
        (await window.__slowMeetTest.peerConnections.at(-1).getStats()).forEach((stat) => {
          if (stat.type === "inbound-rtp" && stat.kind === "video") frames += stat.framesDecoded || 0;
        });
        return frames;
      });
      const serverNumber = async (name) => {
        const text = await (await fetch(`${fixture.baseURL}/metrics`)).text();
        return Number(text.match(new RegExp(`^slowmeet_video_${name} (\\d+)$`, "m"))?.[1] ?? NaN);
      };
      // The start: the first keyframe of the share must not be followed by
      // one for every request the server used to send.
      await pageB.waitForTimeout(20000);
      const start = await sent();
      const startDecoded = await decoded();
      // Then 40 s in which the sender stays at the limit.
      await pageB.waitForTimeout(40000);
      const end = await sent();
      const endDecoded = await decoded();
      const evidence = {
        startKeyFrames: start.keys, startRequests: start.pli,
        kbpsWithHeaders: Math.round((end.bytes + end.header - start.bytes - start.header) * 8 / 40000),
        encoded: end.frames - start.frames, decoded: endDecoded - startDecoded, size: end.size,
        queuePeak: await serverNumber("frame_queue_peak_frames"), waitMaxMs: await serverNumber("frame_wait_max_ms"),
        queueFull: await serverNumber('frames_dropped_total\\{reason="queue_full"\\}')
      };
      console.log(`[bitrate limit evidence] ${JSON.stringify(evidence)}`);
      assert.ok(evidence.kbpsWithHeaders >= 270, `the sender did not stay at the limit: ${JSON.stringify(evidence)}`);
      assert.ok(evidence.queuePeak <= 30 && evidence.waitMaxMs <= 6000 && evidence.queueFull === 0,
        `the server fell behind a sender at its limit: ${JSON.stringify(evidence)}`);
      assert.ok(evidence.decoded >= evidence.encoded * 0.9 - 2,
        `the viewer decoded ${evidence.decoded} of ${evidence.encoded} frames: ${JSON.stringify(evidence)}`);
      assert.ok(evidence.startKeyFrames <= 3, `the share started with ${evidence.startKeyFrames} keyframes: ${JSON.stringify(evidence)}`);
    }
  }
];

module.exports = { scenarios };
