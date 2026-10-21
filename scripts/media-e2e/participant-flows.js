const assert = require("node:assert/strict");

const profiles = ["auto", "very-slow", "slow", "normal", "high", "very-good", "ultra"];
const cameraQualities = ["1080p", "720p", "480p", "360p", "240p", "off"];

function pageFor(fixture, role) {
  const page = role === "A" ? fixture.pageA : fixture.pageB;
  assert.ok(page, `fixture is missing page ${role}`);
  return page;
}

async function openPrejoin(fixture, role = "A") {
  const page = pageFor(fixture, role);
  await page.goto(fixture.baseURL);
  await page.locator("#join-form").waitFor({ state: "visible" });
  return page;
}

async function submitPrejoin(page, name, password = "") {
  await page.locator("#name").fill(name);
  if (password) await page.locator("#password").fill(password);
  await page.locator("#join").click();
}

async function waitForText(page, selector, text, timeout = 15000) {
  await page.waitForFunction(({ selector, text }) =>
    document.querySelector(selector)?.textContent.includes(text),
  { selector, text }, { timeout });
}

async function waitForReactionOverParticipant(page, senderName, emoji) {
  await page.waitForFunction(({ senderName, emoji }) => {
    const tile = [...document.querySelectorAll(".participant-tile")]
      .find((element) => element.querySelector(".participant-name")?.textContent.trim() === senderName);
    const reaction = tile?.querySelector(".participant-reaction");
    if (!reaction || reaction.textContent !== emoji || tile.querySelectorAll(".participant-reaction").length !== 1) return false;
    if (!reaction.isConnected || reaction.parentElement !== tile) return false;
    const reactionRect = reaction.getBoundingClientRect();
    const tileRect = tile.getBoundingClientRect();
    return reactionRect.left >= tileRect.left && reactionRect.left < tileRect.left + 40 &&
      reactionRect.top >= tileRect.top && reactionRect.top < tileRect.top + 40;
  }, { senderName, emoji }, { timeout: 10000 });
}

async function waitForReactionRising(page, senderName, emoji) {
  await page.waitForFunction(({ senderName, emoji }) => {
    const tile = [...document.querySelectorAll(".participant-tile")]
      .find((element) => element.querySelector(".participant-name")?.textContent.trim() === senderName);
    const bubble = tile?.querySelector(".participant-reaction-bubble");
    if (!bubble || bubble.textContent !== emoji) return false;
    const tileRect = tile.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    const animation = bubble.getAnimations().find((item) => item.playState === "running");
    const frames = animation?.effect?.getKeyframes();
    const startTransform = frames?.[0]?.transform || "";
    const endTransform = frames?.at(-1)?.transform || "";
    return bubbleRect.bottom <= tileRect.bottom && bubbleRect.bottom > tileRect.bottom - 100 &&
      /translate\(-50%, 0(?:px)?\)/.test(startTransform) &&
      /translate\(-50%, -[\d.]+px\)/.test(endTransform);
  }, { senderName, emoji }, { timeout: 10000 });
}

async function waitForStageReactionBubble(page, emoji) {
  await page.waitForFunction(({ emoji }) => {
    const bubble = [...document.querySelectorAll("#reaction-overlay .participant-reaction-bubble--stage")]
      .find((element) => element.textContent === emoji);
    const animation = bubble?.getAnimations().find((item) => item.playState === "running");
    const endTransform = animation?.effect?.getKeyframes().at(-1)?.transform || "";
    return Boolean(animation) && /translate\(0(?:px)?, -[\d.]+px\)/.test(endTransform);
  }, { emoji }, { timeout: 10000 });
}

async function waitForReactionBubblesSeparated(page, senderName) {
  await page.waitForFunction((senderName) => {
    const tile = [...document.querySelectorAll(".participant-tile")]
      .find((element) => element.querySelector(".participant-name")?.textContent.trim() === senderName);
    const bubbles = [...(tile?.querySelectorAll(".participant-reaction-bubble") || [])];
    if (bubbles.length < 2) return false;
    const first = bubbles.at(-2).getBoundingClientRect();
    const second = bubbles.at(-1).getBoundingClientRect();
    return Math.abs(first.left - second.left) >= 20;
  }, senderName, { timeout: 10000 });
}

async function waitForReactionAtStageBottomRight(page, emoji) {
  await page.waitForFunction(({ emoji }) => {
    const reaction = [...document.querySelectorAll("#reaction-overlay .participant-reaction--stage")]
      .find((element) => element.textContent === emoji);
    const overlay = document.querySelector("#reaction-overlay");
    if (!reaction || !overlay) return false;
    const reactionRect = reaction.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    return reactionRect.right <= overlayRect.right && reactionRect.right > overlayRect.right - 48 &&
      reactionRect.bottom <= overlayRect.bottom && reactionRect.bottom > overlayRect.bottom - 48;
  }, { emoji }, { timeout: 10000 });
}

async function waitForParticipantNames(page, expectedNames) {
  const expected = [...expectedNames].sort();
  await page.waitForFunction((expected) => {
    const actual = [...document.querySelectorAll("#participants li[data-participant-id] .participant-name")]
      .map((element) => element.textContent.trim())
      .filter(Boolean)
      .sort();
    return actual.length === expected.length && actual.every((name, index) => name === expected[index]);
  }, expected, { timeout: 30000 });
  const actual = (await page.locator("#participants li[data-participant-id] .participant-name").allTextContents())
    .map((name) => name.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(actual, expected);
}

async function joinPair(fixture, nameA = "Alice", nameB = "Bob") {
  await Promise.all([fixture.join("A", nameA), fixture.join("B", nameB)]);
  await fixture.waitForConnected();
  await fixture.waitForStability(1000, 30000);
}

async function assertNoHorizontalOverflow(page, width) {
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    document: document.documentElement.scrollWidth,
    body: document.body.scrollWidth
  }));
  assert.equal(dimensions.viewport, width);
  assert.ok(dimensions.document <= width, `document overflows at ${width}px: ${JSON.stringify(dimensions)}`);
  assert.ok(dimensions.body <= width, `body overflows at ${width}px: ${JSON.stringify(dimensions)}`);
}

const scenarios = [
  {
    name: "prejoin name validation and device preview",
    async run(fixture) {
      const page = await openPrejoin(fixture);
      const name = page.locator("#name");
      assert.equal(await name.getAttribute("required"), "");
      assert.equal(await name.getAttribute("maxlength"), "32");
      assert.equal(await name.evaluate((input) => input.checkValidity()), false);

      await page.locator("#join").click();
      assert.equal(await page.locator("#meeting").isVisible(), false, "an empty name must not join");

      await name.fill("   ");
      if (fixture.password) await page.locator("#password").fill(fixture.password);
      await page.locator("#join").click();
      await page.waitForFunction(() => {
        const status = document.querySelector("#status")?.textContent.trim() || "";
        return Boolean(status && !status.includes("Joining meeting"));
      }, null, { timeout: 15000 });
      assert.equal(await page.locator("#meeting").isVisible(), false, "whitespace-only names must be rejected");
      assert.match(await page.locator("#status").textContent(), /name|required|valid|empty/i);

      await page.locator("#test-media").click();
      await page.locator("#stop-media-test").waitFor({ state: "visible", timeout: 15000 });
      await page.waitForFunction(() => {
        const camera = document.querySelector("#test-camera")?.textContent || "";
        const microphone = document.querySelector("#test-microphone")?.textContent || "";
        return !camera.includes("Checking") && !microphone.includes("Checking");
      }, null, { timeout: 30000 });

      const cameraReady = (await page.locator("#test-camera").textContent()).includes("ready");
      assert.equal(await page.locator("#device-preview").isVisible(), cameraReady);
      await page.locator("#stop-media-test").click();
      assert.equal(await page.locator("#device-preview").isVisible(), false);
      assert.equal(await page.locator("#stop-media-test").isVisible(), false);
    }
  },
  {
    name: "wrong meeting password is rejected before a correct retry",
    when: "passwordValidation",
    async run(fixture) {
      const page = pageFor(fixture, "A");
      const wrongPassword = `${fixture.password}-wrong`;
      await page.locator("#name").fill("Alice");
      await page.locator("#password").fill(wrongPassword);
      await page.locator("#join").click();
      await page.waitForFunction(() => /invalid meeting password/i.test(
        document.querySelector("#status")?.textContent || ""
      ), null, { timeout: 15000 });
      assert.equal(await page.locator("#meeting").isVisible(), false);
      assert.equal(await page.locator("#join-form").isVisible(), true);

      await fixture.join("A", "Alice", fixture.password);
      assert.equal(await page.locator("#meeting").isVisible(), true,
        "the configured password should allow a retry after the rejected password");
      await fixture.waitForConnected("A");
      await fixture.assertPeersConnected("correct password retry");
    }
  },
  {
    name: "join A then B and keep the roster unique",
    async run(fixture) {
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.join("B", "Bob");
      await fixture.waitForConnected();
      await fixture.waitForStability(1000, 30000);
      await waitForParticipantNames(pageFor(fixture, "A"), ["Alice", "Bob"]);
      await waitForParticipantNames(pageFor(fixture, "B"), ["Alice", "Bob"]);
      await fixture.assertPeersConnected("A joined before B");
      await fixture.assertNoDuplicateParticipants();

      await fixture.openSidebar("A", "#participants-button");
      const people = pageFor(fixture, "A").locator("#people-list");
      await people.waitFor({ state: "visible" });
      await waitForText(pageFor(fixture, "A"), "#people-list", "Alice");
      await waitForText(pageFor(fixture, "A"), "#people-list", "Bob");
      assert.equal(await people.locator("li").count(), 2);
    }
  },
  {
    name: "B joins first and appears in A prejoin roster",
    async run(fixture) {
      await fixture.join("B", "Bob");
      await fixture.waitForConnected("B");
      const pageA = await openPrejoin(fixture, "A");
      if (fixture.password) await pageA.locator("#password").fill(fixture.password);
      await waitForText(pageA, "#room-roster-list", "Bob", 20000);
      await fixture.join("A", "Alice");
      await fixture.waitForConnected();
      await fixture.waitForStability(1000, 30000);
      await waitForParticipantNames(pageFor(fixture, "A"), ["Alice", "Bob"]);
      await waitForParticipantNames(pageFor(fixture, "B"), ["Alice", "Bob"]);
      await fixture.assertPeersConnected("B joined before A");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "simultaneous joins settle with one roster entry per participant",
    async run(fixture) {
      await joinPair(fixture, "Alice", "Bob");
      await waitForParticipantNames(pageFor(fixture, "A"), ["Alice", "Bob"]);
      await waitForParticipantNames(pageFor(fixture, "B"), ["Alice", "Bob"]);
      await fixture.assertPeersConnected("simultaneous joins");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "two-person capacity shows exactly A and B at the configured limit",
    when: "localCapacity",
    async run(fixture) {
      // The local media E2E server sets MAX_PARTICIPANTS=2; this verifies the full room
      // using only the existing A and B pages, without attempting a third join.
      await joinPair(fixture, "Alice", "Bob");
      for (const role of ["A", "B"]) {
        const page = pageFor(fixture, role);
        await waitForParticipantNames(page, ["Alice", "Bob"]);
        assert.equal(await page.locator("#participants li[data-participant-id]").count(), 2);
        assert.match((await page.locator("#participant-count").textContent()).trim(), /^2 participants$/);
        assert.equal((await page.locator("#participant-count-badge").textContent()).trim(), "2");
      }
      await fixture.openSidebar("A", "#participants-button");
      const people = pageFor(fixture, "A").locator("#people-list");
      await people.waitFor({ state: "visible" });
      assert.equal(await people.locator("li").count(), 2);
      await waitForText(pageFor(fixture, "A"), "#people-list", "Alice");
      await waitForText(pageFor(fixture, "A"), "#people-list", "Bob");
      await fixture.assertPeersConnected("two-person room at capacity");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "capacity rejects B at a one-participant local room limit",
    when: "localCapacity",
    localCapacityLimit: 1,
    async run(fixture) {
      await fixture.join("A", "Alice");
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await waitForParticipantNames(pageA, ["Alice"]);
      await pageB.locator("#name").fill("Bob");
      if (fixture.password) await pageB.locator("#password").fill(fixture.password);
      await pageB.locator("#join").click();
      await pageB.waitForFunction(() => document.querySelector("#meeting")?.hidden === true &&
        /room is full/i.test(document.querySelector("#status")?.textContent || ""),
      null, { timeout: 15000 });

      assert.match(await pageB.locator("#status").textContent(), /This room is full/);
      assert.equal(await pageA.locator("#participants li[data-participant-id]").count(), 1,
        "the room owner should remain the only participant after B is rejected");
      await fixture.assertPeersConnected("capacity rejection preserves A's connection");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "bidirectional chat delivery",
    async run(fixture) {
      await joinPair(fixture);
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      const fromA = "participant-flow-A-to-B";
      const fromB = "participant-flow-B-to-A";

      await pageA.locator("#chat").click();
      await pageA.locator("#chat-input").fill(fromA);
      await pageA.locator("#chat-input").press("Enter");
      await waitForText(pageA, "#chat-messages", fromA);
      await pageB.locator("#chat").click();
      await waitForText(pageB, "#chat-messages", fromA);

      await pageB.locator("#chat-input").fill(fromB);
      await pageB.locator("#chat-input").press("Enter");
      await waitForText(pageB, "#chat-messages", fromB);
      await waitForText(pageA, "#chat-messages", fromB);
      await fixture.assertPeersConnected("bidirectional chat");
    }
  },
  {
    name: "reactions and raised hand order synchronize between peers",
    async run(fixture) {
      await joinPair(fixture);
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");

      await pageA.locator("#reactions").click();
      await pageA.waitForFunction(() => !document.querySelector("#reaction-picker")?.hidden);
      await pageA.locator('[data-reaction="👏"]').click();
      await pageA.waitForFunction(() => !document.querySelector("#reaction-picker")?.hidden);
      await waitForText(pageA, "#reaction-announcements", "Alice sent 👏");
      await waitForText(pageB, "#reaction-announcements", "Alice sent 👏");
      await Promise.all([pageA, pageB].map((page) => waitForReactionRising(page, "Alice", "👏")));
      await waitForReactionOverParticipant(pageA, "Alice", "👏");
      await waitForReactionOverParticipant(pageB, "Alice", "👏");
      await pageA.locator('[data-reaction="❤️"]').click();
      await pageA.waitForFunction(() => !document.querySelector("#reaction-picker")?.hidden);
      await waitForText(pageA, "#reaction-announcements", "Alice sent ❤️");
      await waitForText(pageB, "#reaction-announcements", "Alice sent ❤️");
      await waitForReactionOverParticipant(pageA, "Alice", "❤️");
      await waitForReactionOverParticipant(pageB, "Alice", "❤️");
      await waitForReactionOverParticipant(pageA, "Alice", "❤️");
      await waitForReactionOverParticipant(pageB, "Alice", "❤️");
      await Promise.all([pageA, pageB].map((page) => waitForReactionBubblesSeparated(page, "Alice")));
      await pageA.waitForTimeout(2000);
      await waitForReactionOverParticipant(pageA, "Alice", "❤️");
      await waitForReactionOverParticipant(pageB, "Alice", "❤️");
      await Promise.all([pageA, pageB].map((page) => page.waitForFunction(() =>
        document.querySelectorAll(".participant-reaction").length === 0,
      null, { timeout: 5000 })));

      await pageB.locator(".participant-tile").evaluateAll((tiles) => {
        const senderTile = tiles.find((tile) =>
          tile.querySelector(".participant-name")?.textContent.trim() === "Bob");
        if (senderTile) senderTile.style.transform = "translateX(200vw)";
      });
      await pageB.locator("#reactions").click();
      await pageB.waitForFunction(() => !document.querySelector("#reaction-picker")?.hidden);
      await pageB.locator('[data-reaction="👍"]').click();
      await pageB.waitForFunction(() => !document.querySelector("#reaction-picker")?.hidden);
      await waitForText(pageB, "#reaction-announcements", "Bob sent 👍");
      await waitForReactionAtStageBottomRight(pageB, "👍");
      await waitForStageReactionBubble(pageB, "👍");
      await pageB.locator(".participant-tile").evaluateAll((tiles) => {
        const senderTile = tiles.find((tile) =>
          tile.querySelector(".participant-name")?.textContent.trim() === "Bob");
        if (senderTile) senderTile.style.removeProperty("transform");
      });
      await pageB.waitForFunction(() =>
        document.querySelectorAll(".participant-reaction").length === 0,
      null, { timeout: 5000 });

      await pageB.locator('[data-reaction="👏"]').click();
      await pageB.waitForFunction(() => !document.querySelector("#reaction-picker")?.hidden);
      await waitForText(pageB, "#reaction-announcements", "Bob sent 👏");
      await waitForText(pageA, "#reaction-announcements", "Bob sent 👏");
      await waitForReactionOverParticipant(pageB, "Bob", "👏");
      await waitForReactionOverParticipant(pageA, "Bob", "👏");

      await fixture.setPressed("A", "#raise-hand", true);
      await fixture.waitForRemoteState("B", "Alice", "handRaised", "true");
      await fixture.setPressed("B", "#raise-hand", true);
      await fixture.waitForRemoteState("A", "Bob", "handRaised", "true");
      await fixture.waitForRemoteState("B", "Alice", "handOrder", "1");
      await fixture.waitForRemoteState("A", "Bob", "handOrder", "2");

      await fixture.setPressed("A", "#raise-hand", false);
      await fixture.waitForRemoteState("B", "Alice", "handRaised", "false");
      await fixture.waitForRemoteState("A", "Bob", "handOrder", "1");
      await fixture.assertPeersConnected("reaction and raised-hand state");
    }
  },
  {
    name: "profile and camera quality choices stay local to each participant",
    async run(fixture) {
      await joinPair(fixture);
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");
      await fixture.openSidebar("A", "#more");

      const remoteProfileBefore = await pageB.locator("#profile").inputValue();
      const remoteQualityBefore = await pageB.locator("#camera-quality").inputValue();
      await pageA.locator("#audio-only").check();
      await pageA.locator("#self-view").uncheck();
      assert.equal(await pageB.locator("#audio-only").isChecked(), false);
      assert.equal(await pageB.locator("#self-view").isChecked(), true);
      await fixture.setPressed("A", "#receive-video", false);
      assert.equal(await pageB.locator("#receive-video").getAttribute("aria-pressed"), "true");

      for (const value of profiles) {
        await pageA.locator("#profile").selectOption(value);
        assert.equal(await pageA.locator("#profile").inputValue(), value);
        assert.equal(await pageB.locator("#profile").inputValue(), remoteProfileBefore);
      }
      for (const value of cameraQualities) {
        await pageA.locator("#camera-quality").selectOption(value);
        assert.equal(await pageA.locator("#camera-quality").inputValue(), value);
        assert.equal(await pageB.locator("#camera-quality").inputValue(), remoteQualityBefore);
      }
      await fixture.assertPeersConnected("local profile and camera quality settings");
    }
  },
  {
    name: "keyboard shortcuts, focus restoration, and sidebar focus trap",
    async run(fixture) {
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      const page = pageFor(fixture, "A");

      await fixture.openSidebar("A", "#more");
      const sidebar = page.locator("#meeting-sidebar");
      await sidebar.waitFor({ state: "visible" });
      const focusOrder = await sidebar.evaluate((element) => [...element.querySelectorAll(
        "button, select, input, summary, textarea, [tabindex]"
      )].filter((item) => !item.disabled && item.offsetParent !== null).length);
      assert.ok(focusOrder > 1, "settings sidebar should expose multiple focus targets");
      await sidebar.evaluate((element) => {
        const focusable = [...element.querySelectorAll("button, select, input, summary, textarea, [tabindex]")]
          .filter((item) => !item.disabled && item.offsetParent !== null);
        focusable.at(-1).focus();
      });
      await page.keyboard.press("Tab");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "close-sidebar");
      await page.keyboard.press("Shift+Tab");
      assert.equal(await sidebar.evaluate((element) => {
        const focusable = [...element.querySelectorAll("button, select, input, summary, textarea, [tabindex]")]
          .filter((item) => !item.disabled && item.offsetParent !== null);
        return document.activeElement === focusable.at(-1);
      }), true);
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector("#meeting-sidebar")?.getAttribute("aria-hidden") === "true");
      assert.equal(await page.evaluate(() => document.activeElement?.id), "more");

      await page.keyboard.press("c");
      await page.locator("#chat-rail").waitFor({ state: "visible" });
      await page.waitForFunction(() => document.activeElement?.id === "chat-input", null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "chat-input");
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => document.querySelector("#chat-rail")?.hidden === true);
      await page.waitForFunction(() => document.activeElement?.id === "chat", null, { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.activeElement?.id), "chat");
    }
  },
  {
    name: "axe checks on prejoin and meeting surfaces",
    async run(fixture) {
      await openPrejoin(fixture, "A");
      await fixture.checkAxe("A", "prejoin");
      await fixture.join("A", "Alice");
      await fixture.waitForConnected("A");
      await fixture.checkAxe("A", "meeting");
    }
  },
  {
    name: "meeting layout remains within 375, 768, and 1440 pixel viewports",
    async run(fixture) {
      await joinPair(fixture);
      for (const width of [375, 768, 1440]) {
        const height = width === 375 ? 812 : width === 768 ? 900 : 1000;
        await Promise.all([
          fixture.setViewport("A", width, height),
          fixture.setViewport("B", width, height)
        ]);
        await assertNoHorizontalOverflow(pageFor(fixture, "A"), width);
        await assertNoHorizontalOverflow(pageFor(fixture, "B"), width);
        await pageFor(fixture, "A").locator("#participants").waitFor({ state: "visible" });
      }
      await fixture.assertPeersConnected("responsive layout widths");
    }
  },
  {
    name: "reload, signaling reconnect, leave, and rejoin lifecycle",
    async run(fixture) {
      await joinPair(fixture);
      const pageA = pageFor(fixture, "A");
      const pageB = pageFor(fixture, "B");

      await pageA.reload();
      await pageA.locator("#join-form").waitFor({ state: "visible" });
      // Let the local server's one-second reconnect reservation expire before rejoining.
      await pageA.waitForTimeout(1100);
      await submitPrejoin(pageA, "Alice", fixture.password);
      await fixture.waitForConnected("A");
      await fixture.waitForStability(1000, 30000);
      await waitForParticipantNames(pageFor(fixture, "A"), ["Alice", "Bob"]);
      await waitForParticipantNames(pageFor(fixture, "B"), ["Alice", "Bob"]);
      await fixture.refreshPeerBaseline();
      await fixture.assertPeersConnected("after page reload and rejoin");
      await fixture.assertNoDuplicateParticipants();

      await pageA.evaluate(() => {
        const socket = window.__slowMeetTest?.sockets?.at(-1);
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error("expected an open signaling socket before reconnect check");
        }
        socket.close(4001, "participant flow reconnect check");
      });
      await pageA.waitForFunction(() => /Reconnecting/.test(document.querySelector("#status")?.textContent || ""),
        null, { timeout: 10000 });
      await pageA.waitForFunction(() => window.__slowMeetTest?.sockets?.at(-1)?.readyState === WebSocket.OPEN,
        null, { timeout: 30000 });
      await fixture.waitForConnected("A");
      await fixture.waitForStability(1000, 30000);
      await fixture.refreshPeerBaseline();
      await fixture.assertPeersConnected("after signaling reconnect");

      await pageA.locator("#leave").click();
      await pageA.locator("#meeting-ended").waitFor({ state: "visible" });
      await pageB.waitForFunction(() =>
        document.querySelectorAll("#participants li[data-participant-id]").length === 1,
      null, { timeout: 10000 });
      await pageA.locator("#rejoin").click();
      await pageA.locator("#join-form").waitFor({ state: "visible" });
      await submitPrejoin(pageA, "Alice", fixture.password);
      await fixture.waitForConnected("A");
      await fixture.waitForStability(1000, 30000);
      await fixture.refreshPeerBaseline();
      await fixture.assertPeersConnected("after leave and rejoin");
      await fixture.assertNoDuplicateParticipants();
      await waitForParticipantNames(pageFor(fixture, "A"), ["Alice", "Bob"]);
      await waitForParticipantNames(pageFor(fixture, "B"), ["Alice", "Bob"]);
    }
  }
];

module.exports = { scenarios };
