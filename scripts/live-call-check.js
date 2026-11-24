// Checks a deployed SlowMeet with a real call: two headless Chrome
// participants join the room at the given address, send their cameras to each
// other, and one shares a generated 1920x1080 screen, first in AV1 and then
// in VP9 after a codec change in the middle of the share. It prints how many
// of the encoded frames the other side decoded.
//
//   node scripts/live-call-check.js https://meet.example.com
//
// It joins the real room as "deploy-check-A" and "deploy-check-B": run it
// when the room is empty. LIVE_CALL_CHROME names the Chrome to use (default
// /usr/bin/google-chrome when it exists). A room with a meeting password is
// not supported.
const fs = require("node:fs");
const { chromium } = require("playwright-core");

const base = process.argv[2];
if (!/^https?:\/\//.test(base || "")) {
  console.error("usage: node scripts/live-call-check.js https://host");
  process.exit(2);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function join(browser, name) {
  const context = await browser.newContext({ permissions: ["camera", "microphone"] });
  const page = await context.newPage();
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.fill("#name", name);
  await page.click("#join");
  await page.waitForSelector("#meeting", { state: "visible", timeout: 30000 });
  await page.waitForFunction(() => typeof peer !== "undefined" && peer && peer.connectionState === "connected",
    null, { timeout: 60000 });
  return page;
}

const videoStats = (page) => page.evaluate(async () => {
  const report = await peer.getStats();
  const codecs = new Map();
  report.forEach((stat) => { if (stat.type === "codec") codecs.set(stat.id, stat.mimeType); });
  const result = { encoded: 0, decoded: 0, lost: 0, sent: [], received: [] };
  report.forEach((stat) => {
    if (stat.kind !== "video") return;
    if (stat.type === "outbound-rtp" && stat.framesEncoded) {
      result.encoded += stat.framesEncoded;
      result.sent.push(`${codecs.get(stat.codecId)} ${stat.frameWidth}x${stat.frameHeight}`);
    }
    if (stat.type === "inbound-rtp" && stat.framesDecoded) {
      result.decoded += stat.framesDecoded;
      result.lost += stat.packetsLost || 0;
      result.received.push(`${codecs.get(stat.codecId)} ${stat.frameWidth}x${stat.frameHeight}`);
    }
  });
  return result;
});

async function measure(label, sender, viewer, seconds) {
  const sentBefore = await videoStats(sender);
  const gotBefore = await videoStats(viewer);
  await sleep(seconds * 1000);
  const sentAfter = await videoStats(sender);
  const gotAfter = await videoStats(viewer);
  // A stream that ended during the window (a codec change replaces it) takes
  // its count with it, so the difference can fall below zero.
  const decoded = Math.max(0, gotAfter.decoded - gotBefore.decoded);
  const encoded = Math.max(0, sentAfter.encoded - sentBefore.encoded);
  console.log(`${label}: decoded ${decoded} of ${encoded} encoded frames in ${seconds} s, ` +
    `${gotAfter.lost - gotBefore.lost} packets lost | sends ${JSON.stringify(sentAfter.sent)} | receives ${JSON.stringify(gotAfter.received)}`);
  return { decoded, encoded };
}

async function setToggle(page, selector, on) {
  if ((await page.getAttribute(selector, "aria-pressed")) !== String(on)) await page.click(selector);
  await page.waitForFunction(([target, pressed]) =>
    document.querySelector(target)?.getAttribute("aria-pressed") === pressed, [selector, String(on)], { timeout: 45000 });
}

// A document in which only a small counter changes, ten times a second, in
// place of a captured screen: the screen picker cannot run headless.
const offerGeneratedScreen = (page) => page.evaluate(() => {
  const canvas = document.createElement("canvas");
  canvas.width = 1920;
  canvas.height = 1080;
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#111";
  context.font = "20px monospace";
  for (let row = 0; row < 40; row += 1) {
    context.fillText(`${"shared screen text ".repeat(7)}${row}`, 10, 22 * (row + 1));
  }
  for (let block = 0; block < 320; block += 1) {
    context.fillStyle = `hsl(${(block * 37) % 360} 80% 50%)`;
    context.fillRect((block % 40) * 48, 900 + Math.floor(block / 40) * 22, 48, 22);
  }
  let frame = 0;
  setInterval(() => {
    frame += 1;
    context.fillStyle = "#fff";
    context.fillRect(canvas.width - 420, canvas.height - 80, 400, 60);
    context.fillStyle = "#111";
    context.fillText(`frame ${frame}`, canvas.width - 410, canvas.height - 40);
  }, 100);
  const stream = canvas.captureStream(10);
  Object.defineProperty(navigator.mediaDevices, "getDisplayMedia", { configurable: true, value: async () => stream });
});

const pickCodec = (page, codec) => page.evaluate((value) => {
  const select = document.querySelector("#video-codec");
  select.value = value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}, codec);

(async () => {
  const chrome = process.env.LIVE_CALL_CHROME || (fs.existsSync("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined);
  const browser = await chromium.launch({
    executablePath: chrome, headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"]
  });
  let failed = false;
  try {
    const pageA = await join(browser, "deploy-check-A");
    const pageB = await join(browser, "deploy-check-B");
    console.log(`joined ${base}: room codecs ${JSON.stringify(await pageA.evaluate(() => videoCodecsRoom))}, ` +
      `default ${await pageA.evaluate(() => videoCodecServerDefault)}, simulcast ${await pageA.evaluate(() => simulcastEnabled)}, ` +
      `profile ${await pageA.evaluate(() => document.querySelector("#profile")?.value)}`);

    await setToggle(pageA, "#camera", true);
    await setToggle(pageB, "#camera", true);
    await sleep(8000);
    for (const [label, sender, viewer] of [["camera A to B", pageA, pageB], ["camera B to A", pageB, pageA]]) {
      const camera = await measure(label, sender, viewer, 10);
      if (camera.decoded < camera.encoded * 0.9) failed = true;
    }
    await setToggle(pageB, "#camera", false);
    await setToggle(pageA, "#camera", false);
    await sleep(3000);

    await offerGeneratedScreen(pageA);
    await pickCodec(pageA, "av1");
    await setToggle(pageA, "#screen", true);
    await sleep(10000);
    const av1 = await measure("1920x1080 screen in AV1", pageA, pageB, 12);
    if (av1.decoded < av1.encoded * 0.9 || av1.decoded < 30) failed = true;

    // A codec change in the middle of a share is what used to leave an older
    // codec at a frame every few seconds; the sender must shrink the picture.
    await pickCodec(pageA, "vp9");
    let moving = false;
    for (let round = 1; round <= 5 && !moving; round += 1) {
      const scale = await pageA.evaluate(() => screenSender?.getParameters().encodings[0]?.scaleResolutionDownBy ?? 1);
      const vp9 = await measure(`screen in VP9 after the change, round ${round} (scale ${scale})`, pageA, pageB, 12);
      moving = vp9.decoded >= 30;
    }
    if (!moving) failed = true;

    await pickCodec(pageA, "auto");
    await setToggle(pageA, "#screen", false);
    for (const page of [pageA, pageB]) await page.click("#leave").catch(() => {});
    await sleep(1500);
  } finally {
    await browser.close();
  }
  console.log(failed ? "RESULT: FAILED" : "RESULT: OK");
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(`RESULT: FAILED: ${error.message.split("\n")[0]}`);
  process.exit(1);
});
