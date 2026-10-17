"use strict";

const assert = require("node:assert/strict");
const { setTimeout: delay } = require("node:timers/promises");

const participants = { A: "Media A", B: "Media B" };
const roles = ["A", "B"];

function otherRole(role) {
  return role === "A" ? "B" : "A";
}

function pageFor(fixture, role) {
  return role === "A" ? fixture.pageA : fixture.pageB;
}

async function joinPair(fixture, label) {
  await fixture.join("A", participants.A);
  await fixture.join("B", participants.B);
  await Promise.all(roles.map((role) => fixture.waitForConnected(role)));
  await fixture.waitForStability(1000, 20000);
  await fixture.assertPeersConnected(label);
  await fixture.assertNoDuplicateParticipants();
}

async function enableCamera(fixture, role, label) {
  const receiverRole = otherRole(role);
  await fixture.setPressed(role, "#camera", true);
  await fixture.waitForRemoteState(receiverRole, participants[role], "camera", "on");
  await fixture.assertRemoteVideoMoves(role, receiverRole, label);
}

async function transitionCamera(fixture, role, enabled, label) {
  await fixture.setPressed(role, "#camera", enabled);
  await fixture.waitForRemoteState(otherRole(role), participants[role], "camera", enabled ? "on" : "off");
  await fixture.assertPeersConnected(label);
}

async function transitionCamerasTogether(fixture, enabled, label) {
  await Promise.all(roles.map((role) => fixture.setPressed(role, "#camera", enabled)));
  await Promise.all(roles.map((role) =>
    fixture.waitForRemoteState(otherRole(role), participants[role], "camera", enabled ? "on" : "off")));
  await fixture.assertPeersConnected(label);
}

async function assertCameraScenarioHealthy(fixture, label) {
  await fixture.assertPeersConnected(label);
  await fixture.assertNoDuplicateParticipants();
}

async function enableMicrophone(fixture, role, label) {
  const receiverRole = otherRole(role);
  await fixture.setPressed(role, "#mic", true);
  await fixture.waitForRemoteState(receiverRole, participants[role], "mic", "on");
  await fixture.assertAudioProgress(role, receiverRole, label);
}

async function senderVideoBytes(fixture, role) {
  const state = await fixture.diagnostics(role);
  assert.ok(Number.isFinite(state.videoBytesSent), `${role}: diagnostics did not include videoBytesSent`);
  return state.videoBytesSent;
}

async function assertSenderVideoProgress(fixture, role, label) {
  const before = await senderVideoBytes(fixture, role);
  await delay(1200);
  const after = await senderVideoBytes(fixture, role);
  assert.ok(after > before, `${label}: sender camera RTP did not advance (${before} -> ${after} bytes)`);
}

async function assertRemoteCameraMovesFromDiagnostics(fixture, senderRole, receiverRole, label) {
  const before = await fixture.diagnostics(receiverRole);
  await delay(1200);
  const after = await fixture.diagnostics(receiverRole);
  const senderName = participants[senderRole];
  const beforeVideo = before.remoteVideos?.find((video) => video.role === "camera" &&
    video.participant.includes(senderName));
  const afterVideo = after.remoteVideos?.find((video) => video.role === "camera" &&
    video.participant.includes(senderName));

  assert.ok(after.framesDecoded > before.framesDecoded,
    `${label}: decoded video frames did not advance (${before.framesDecoded} -> ${after.framesDecoded})`);
  assert.ok(afterVideo && afterVideo.width > 0 && afterVideo.height > 0 && !afterVideo.paused &&
    afterVideo.currentTime > beforeVideo?.currentTime,
  `${label}: remote camera playback did not advance`);
}

async function activeTracks(page) {
  return page.evaluate(() => {
    const peer = window.__slowMeetTest?.peerConnections.at(-1);
    if (!peer) throw new Error("media peer connection is missing");
    return Object.fromEntries(peer.getSenders()
      .filter((sender) => sender.track)
      .map((sender) => [sender.track.kind, sender.track.id]));
  });
}

async function activeVideoSenderID(fixture, role) {
  const state = await fixture.diagnostics(role);
  const sender = state.videoSenderStats?.find((entry) => entry.trackID) || state.videoSenderStats?.[0];
  assert.ok(sender?.senderID, `${role}: active video sender identity was not recorded`);
  return sender.senderID;
}

async function videoSenderIDs(fixture) {
  return Object.fromEntries(await Promise.all(roles.map(async (role) =>
    [role, await activeVideoSenderID(fixture, role)])));
}

async function assertVideoSenderIDs(fixture, expected, label) {
  for (const role of roles) {
    assert.equal(await activeVideoSenderID(fixture, role), expected[role],
      `${label}: ${role} camera replaced its established video sender`);
  }
}

async function assertRemoteScreenPixelsChange(page, senderName, label) {
  const fingerprints = await page.evaluate(async ({ senderName }) => {
    const participant = [...document.querySelectorAll("#participants li[data-participant-id]")]
      .find((item) => !item.classList.contains("is-local") && item.textContent.includes(senderName));
    const video = participant?.querySelector("video[data-media-role='screen']");
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA ||
        video.videoWidth === 0 || video.videoHeight === 0 || video.paused) {
      throw new Error(`${senderName} screen video is not ready for a pixel fingerprint`);
    }

    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("could not create screen fingerprint canvas context");
    const fingerprint = () => {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let hash = 2166136261;
      for (const pixel of pixels) hash = Math.imul(hash ^ pixel, 16777619);
      return hash >>> 0;
    };

    const first = fingerprint();
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = fingerprint();
    return { first, second, currentTime: video.currentTime };
  }, { senderName });

  assert.notEqual(fingerprints.second, fingerprints.first,
    `${label}: receiver screen pixels did not change over the observation interval`);
}

const scenarios = [
  {
    name: "camera toggles and rapid repeated recovery in both directions",
    async run(fixture) {
      await joinPair(fixture, "camera lifecycle startup");

      for (const role of roles) {
        const receiverRole = otherRole(role);
        await fixture.setPressed(role, "#camera", true);
        await fixture.waitForRemoteState(receiverRole, participants[role], "camera", "on");
        const senderID = await activeVideoSenderID(fixture, role);
        await fixture.assertRemoteVideoMoves(role, receiverRole, `${role} initial camera enable`);

        await fixture.setPressed(role, "#camera", false);
        await fixture.waitForRemoteState(receiverRole, participants[role], "camera", "off");
        await fixture.assertPeersConnected(`${role} camera paused`);
        await fixture.setPressed(role, "#camera", true);
        await fixture.waitForRemoteState(receiverRole, participants[role], "camera", "on");
        assert.equal(await activeVideoSenderID(fixture, role), senderID,
          `${role}: camera resume replaced the established video sender`);
        await fixture.assertRemoteVideoMoves(role, receiverRole, `${role} camera resume`);

        for (let cycle = 0; cycle < 3; cycle += 1) {
          await fixture.setPressed(role, "#camera", false);
          await fixture.setPressed(role, "#camera", true);
        }
        await fixture.waitForRemoteState(receiverRole, participants[role], "camera", "on");
        assert.equal(await activeVideoSenderID(fixture, role), senderID,
          `${role}: repeated camera toggles replaced the established video sender`);
        await fixture.assertRemoteVideoMoves(role, receiverRole, `${role} rapid camera toggles`);
        await fixture.waitForStability(1000, 15000);
        await fixture.assertPeersConnected(`${role} camera toggle recovery`);
        await fixture.assertNoDuplicateParticipants();
      }
    }
  },
  {
    name: "A starts first then stops and resumes while B camera stays live",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "A-first camera regression startup");
      await enableCamera(fixture, "A", "A starts before B");
      await enableCamera(fixture, "B", "B starts after A");
      const senderIDs = await videoSenderIDs(fixture);

      const capture = await fixture.beginCameraQualityCapture("A stop/resume while B stays live");
      await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
      await transitionCamera(fixture, "A", false, "A camera paused while B stays live");
      await transitionCamera(fixture, "A", true, "A camera resumed while B stays live");
      await fixture.endCameraQualityCapture(capture, { toggledRoles: ["A"], liveRoles: ["B"] });
      await assertVideoSenderIDs(fixture, senderIDs, "A stop/resume while B stays live");
      await assertCameraScenarioHealthy(fixture, "A-first stop/resume while B stays live");
    }
  },
  {
    name: "marker-free frame quality accepts A-first camera stop/resume",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "marker-free A-first camera startup");
      await enableCamera(fixture, "A", "A starts before B for marker-free capture");
      await enableCamera(fixture, "B", "B starts after A for marker-free capture");
      const senderIDs = await videoSenderIDs(fixture);

      const capture = await fixture.beginCameraQualityCapture("marker-free A stop/resume while B stays live", {
        requireMarkers: false,
        includeFrameObservations: true
      });
      await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
      await transitionCamera(fixture, "A", false, "A camera paused for marker-free capture");
      await transitionCamera(fixture, "A", true, "A camera resumed for marker-free capture");
      await fixture.endCameraQualityCapture(capture, { toggledRoles: ["A"], liveRoles: ["B"] });
      await assertVideoSenderIDs(fixture, senderIDs, "marker-free A stop/resume while B stays live");
      await assertCameraScenarioHealthy(fixture, "marker-free A-first stop/resume while B stays live");
    }
  },
  {
    name: "B starts first then A stops and resumes while B camera stays live",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "B-first camera regression startup");
      await enableCamera(fixture, "B", "B starts before A");
      await enableCamera(fixture, "A", "A starts after B");
      const senderIDs = await videoSenderIDs(fixture);

      const capture = await fixture.beginCameraQualityCapture("A stop/resume after B starts first");
      await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
      await transitionCamera(fixture, "A", false, "A camera paused after B started first");
      await transitionCamera(fixture, "A", true, "A camera resumed after B started first");
      await fixture.endCameraQualityCapture(capture, { toggledRoles: ["A"], liveRoles: ["B"] });
      await assertVideoSenderIDs(fixture, senderIDs, "B-first A stop/resume while B stays live");
      await assertCameraScenarioHealthy(fixture, "B-first A stop/resume while B stays live");
    }
  },
  {
    name: "B starts first then B stops and resumes while A camera stays live",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "B-first B-camera regression startup");
      await enableCamera(fixture, "B", "B starts before A for B toggle");
      await enableCamera(fixture, "A", "A starts after B for B toggle");
      const senderIDs = await videoSenderIDs(fixture);

      const capture = await fixture.beginCameraQualityCapture("B stop/resume after B starts first");
      await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
      await transitionCamera(fixture, "B", false, "B camera paused after B started first");
      await transitionCamera(fixture, "B", true, "B camera resumed after B started first");
      await fixture.endCameraQualityCapture(capture, { toggledRoles: ["B"], liveRoles: ["A"] });
      await assertVideoSenderIDs(fixture, senderIDs, "B-first B stop/resume while A stays live");
      await assertCameraScenarioHealthy(fixture, "B-first B stop/resume while A stays live");
    }
  },
  {
    name: "B stop/resume keeps A camera live as the comparison",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "B camera comparison startup");
      await enableCamera(fixture, "A", "A starts before B comparison");
      await enableCamera(fixture, "B", "B starts before comparison toggle");
      const senderIDs = await videoSenderIDs(fixture);

      const capture = await fixture.beginCameraQualityCapture("B stop/resume while A stays live");
      await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
      await transitionCamera(fixture, "B", false, "B camera paused while A stays live");
      await transitionCamera(fixture, "B", true, "B camera resumed while A stays live");
      await fixture.endCameraQualityCapture(capture, { toggledRoles: ["B"], liveRoles: ["A"] });
      await assertVideoSenderIDs(fixture, senderIDs, "B stop/resume while A stays live");
      await assertCameraScenarioHealthy(fixture, "B stop/resume while A stays live");
    }
  },
  {
    name: "repeated camera stop/resume cycles preserve the other participant video",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "rapid camera toggle startup");
      for (const role of roles) await enableCamera(fixture, role, `${role} camera before rapid toggles`);
      const senderIDs = await videoSenderIDs(fixture);

      for (const role of roles) {
        const capture = await fixture.beginCameraQualityCapture(
          `${role} rapid camera toggles while ${otherRole(role)} stays live`);
        await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
        for (let cycle = 0; cycle < 3; cycle += 1) {
          await transitionCamera(fixture, role, false, `${role} rapid camera pause ${cycle + 1}`);
          await transitionCamera(fixture, role, true, `${role} rapid camera resume ${cycle + 1}`);
          await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
        }
        await fixture.endCameraQualityCapture(capture, {
          toggledRoles: [role],
          liveRoles: [otherRole(role)],
          expectedResumeCycles: 3
        });
        await assertVideoSenderIDs(fixture, senderIDs, `${role} repeated camera stop/resume`);
        await assertCameraScenarioHealthy(fixture, `${role} rapid camera toggle recovery`);
      }
    }
  },
  {
    name: "back-to-back camera pause and resume bursts from both participants",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "back-to-back camera transition startup");
      for (const role of roles) await enableCamera(fixture, role, `${role} camera before back-to-back requests`);
      const senderIDs = await videoSenderIDs(fixture);
      for (const role of roles) {
        const other = otherRole(role);
        const capture = await fixture.beginCameraQualityCapture(`${role} back-to-back pause/resume requests`);
        await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);

        await transitionCamera(fixture, role, false, `${role} acknowledged camera pause before request burst`);
        await transitionCamera(fixture, role, true, `${role} acknowledged camera resume before request burst`);
        await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
        for (let cycle = 0; cycle < 3; cycle += 1) {
          await fixture.setPressed(role, "#camera", false);
          await fixture.setPressed(role, "#camera", true);
        }
        await fixture.waitForRemoteState(other, participants[role], "camera", "on");
        await fixture.assertPeersConnected(`${role} back-to-back camera requests settle`);
        await fixture.endCameraQualityCapture(capture, {
          toggledRoles: [role],
          liveRoles: [other],
          expectedResumeCycles: 2,
          allowAdditionalResumeCycles: true
        });
        await assertVideoSenderIDs(fixture, senderIDs, `${role} back-to-back camera requests`);
        await assertCameraScenarioHealthy(fixture, `${role} back-to-back camera pause/resume`);
      }
    }
  },
  {
    name: "near-simultaneous camera starts and stop/resumes in both directions",
    timecodedCamera: true,
    async run(fixture) {
      await joinPair(fixture, "near-simultaneous camera transition startup");
      const capture = await fixture.beginCameraQualityCapture("near-simultaneous camera starts and resumes");

      await transitionCamerasTogether(fixture, true, "both cameras started near-simultaneously");
      await fixture.waitForCameraQualityBaseline(capture, ["A", "B"]);
      const senderIDs = await videoSenderIDs(fixture);
      await transitionCamerasTogether(fixture, false, "both cameras stopped near-simultaneously");
      await transitionCamerasTogether(fixture, true, "both cameras resumed near-simultaneously");
      await fixture.endCameraQualityCapture(capture, {
        toggledRoles: ["A", "B"],
        liveRoles: [],
        expectedResumeCycles: 1
      });
      await assertVideoSenderIDs(fixture, senderIDs, "near-simultaneous camera stop/resume");
      await assertCameraScenarioHealthy(fixture, "near-simultaneous camera start and stop/resume");
    }
  },
  {
    name: "microphone mute and unmute with repeated toggles in both directions",
    async run(fixture) {
      await joinPair(fixture, "microphone lifecycle startup");

      for (const role of roles) {
        const receiverRole = otherRole(role);
        await enableMicrophone(fixture, role, `${role} initial microphone enable`);

        await fixture.setPressed(role, "#mic", false);
        await fixture.waitForRemoteState(receiverRole, participants[role], "mic", "off");
        await fixture.setPressed(role, "#mic", true);
        await fixture.waitForRemoteState(receiverRole, participants[role], "mic", "on");
        await fixture.assertAudioProgress(role, receiverRole, `${role} microphone resume`);

        for (let cycle = 0; cycle < 3; cycle += 1) {
          await fixture.setPressed(role, "#mic", false);
          await fixture.setPressed(role, "#mic", true);
        }
        await fixture.waitForRemoteState(receiverRole, participants[role], "mic", "on");
        await fixture.assertAudioProgress(role, receiverRole, `${role} rapid microphone toggles`);
        await fixture.assertPeersConnected(`${role} microphone toggle recovery`);
        await fixture.assertNoDuplicateParticipants();
      }
    }
  },
  {
    name: "leaving during a delayed camera change releases every capture track",
    async run(fixture) {
      await joinPair(fixture, "leave during media change startup");
      await enableCamera(fixture, "A", "A camera before leave overlap");
      await enableMicrophone(fixture, "A", "A microphone before leave overlap");
      await fixture.setPressed("A", "#camera", false);
      await fixture.waitForRemoteState("B", participants.A, "camera", "off");

      await fixture.pageA.evaluate(() => {
        const mediaDevices = navigator.mediaDevices;
        const originalGetUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
        window.__slowMeetTest.pendingDelayedCameraCapture = 0;
        Object.defineProperty(mediaDevices, "getUserMedia", {
          configurable: true,
          value: async (constraints = {}) => {
            if (constraints.video) {
              window.__slowMeetTest.pendingDelayedCameraCapture += 1;
              await new Promise((resolve) => setTimeout(resolve, 750));
            }
            try {
              return await originalGetUserMedia(constraints);
            } finally {
              if (constraints.video) window.__slowMeetTest.pendingDelayedCameraCapture -= 1;
            }
          }
        });
      });
      await fixture.pageA.locator("#camera").click();
      await fixture.pageA.waitForFunction(() => window.__slowMeetTest?.pendingDelayedCameraCapture === 1,
        null, { timeout: 5000 });
      await fixture.pageA.locator("#leave").click();
      await fixture.pageA.locator("#meeting-ended").waitFor({ state: "visible", timeout: 10000 });
      await fixture.pageA.waitForFunction(() => window.__slowMeetTest?.pendingDelayedCameraCapture === 0,
        null, { timeout: 5000 });
      await fixture.assertNoLiveCapturedTracks("A", "leave during delayed camera capture");

      await fixture.pageB.waitForFunction(() =>
        document.querySelectorAll("#participants li[data-participant-id]").length === 1,
      null, { timeout: 10000 });
      await fixture.waitForConnected("B");
      assert.equal(await fixture.pageB.locator("#participants li[data-participant-id]").count(), 1,
        "B should have exactly one local participant after A leaves during capture");
    }
  },
  {
    name: "camera and microphone device replacement for both participants",
    async run(fixture) {
      await joinPair(fixture, "device replacement startup");
      for (const role of roles) {
        await enableCamera(fixture, role, `${role} camera before device replacement`);
        await enableMicrophone(fixture, role, `${role} microphone before device replacement`);
      }

      for (const role of roles) {
        const receiverRole = otherRole(role);
        const page = pageFor(fixture, role);
        await fixture.openSidebar(role, "#more");

        for (const { kind, selector, deviceID } of [
          { kind: "video", selector: "#settings-camera", deviceID: "slowmeet-e2e-camera" },
          { kind: "audio", selector: "#settings-mic", deviceID: "slowmeet-e2e-microphone" }
        ]) {
          await page.waitForFunction(({ selector, deviceID }) =>
            [...document.querySelectorAll(`${selector} option`)].some((item) => item.value === deviceID),
          { selector, deviceID }, { timeout: 10000 });
          const options = await page.locator(`${selector} option`).evaluateAll((items) => items.map((item) => item.value));
          assert.ok(options.includes(deviceID),
            `${role}: fixture device ${deviceID} is missing from ${selector}`);
          const previousTracks = await activeTracks(page);
          const previousVideoSender = kind === "video" ? await activeVideoSenderID(fixture, role) : undefined;
          const mediaKind = kind === "video" ? "video" : "audio";

          await page.locator(selector).selectOption(deviceID);
          await page.waitForFunction(({ kind, deviceID }) =>
            window.__slowMeetTest?.deviceSelectionRequests?.some((request) =>
              request.kind === kind && request.deviceId === deviceID),
          { kind, deviceID }, { timeout: 15000 });
          await page.waitForFunction(({ mediaKind, previousTrackID }) => {
            const peer = window.__slowMeetTest?.peerConnections.at(-1);
            const trackID = peer?.getSenders().find((sender) => sender.track?.kind === mediaKind)?.track?.id;
            return trackID && trackID !== previousTrackID;
          }, { mediaKind, previousTrackID: previousTracks[mediaKind] }, { timeout: 15000 });

          const nextTracks = await activeTracks(page);
          assert.notEqual(nextTracks[mediaKind], previousTracks[mediaKind],
            `${role}: selecting ${deviceID} did not replace the ${mediaKind} track`);
          if (kind === "video") {
            assert.equal(await activeVideoSenderID(fixture, role), previousVideoSender,
              `${role}: camera replacement changed the established video sender`);
            await fixture.assertRemoteVideoMoves(role, receiverRole, `${role} camera device replacement`);
          } else {
            await fixture.assertAudioProgress(role, receiverRole, `${role} microphone device replacement`);
          }
        }

        for (const { kind, selector } of [
          { kind: "video", selector: "#settings-camera" },
          { kind: "audio", selector: "#settings-mic" }
        ]) {
          const previousTracks = await activeTracks(page);
          await page.locator(selector).selectOption("");
          await page.waitForFunction(({ kind, previousTrackID }) => {
            const peer = window.__slowMeetTest?.peerConnections.at(-1);
            const trackID = peer?.getSenders().find((sender) => sender.track?.kind === kind)?.track?.id;
            return trackID && trackID !== previousTrackID;
          }, { kind, previousTrackID: previousTracks[kind] }, { timeout: 15000 });
          if (kind === "video") {
            await fixture.assertRemoteVideoMoves(role, receiverRole, `${role} default camera restored`);
          } else {
            await fixture.assertAudioProgress(role, receiverRole, `${role} default microphone restored`);
          }
        }
        await fixture.closeSidebar(role);
        await fixture.assertPeersConnected(`${role} device replacement`);
      }
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "incoming video can pause and resume without stopping the sender camera",
    async run(fixture) {
      await joinPair(fixture, "incoming video startup");
      for (const role of roles) await enableCamera(fixture, role, `${role} camera before receive toggle`);

      for (const receiverRole of roles) {
        const senderRole = otherRole(receiverRole);
        await fixture.setPressed(receiverRole, "#receive-video", false);
        await fixture.waitForRemoteState(receiverRole, participants[senderRole], "receiveVideo", "false");
        await fixture.assertPeersConnected(`${receiverRole} incoming video off`);
        await assertSenderVideoProgress(fixture, senderRole,
          `${senderRole} camera while ${receiverRole} has incoming video off`);

        await fixture.setPressed(receiverRole, "#receive-video", true);
        await fixture.waitForRemoteState(receiverRole, participants[senderRole], "receiveVideo", "true");
        await fixture.waitForRemoteState(receiverRole, participants[senderRole], "camera", "on");
        await fixture.assertRemoteVideoMoves(senderRole, receiverRole,
          `${receiverRole} incoming video resumed`);
        await fixture.assertPeersConnected(`${receiverRole} incoming video resumed`);
      }
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "protect audio pauses and restores camera while audio continues",
    async run(fixture) {
      await joinPair(fixture, "protect audio startup");
      for (const role of roles) {
        await enableCamera(fixture, role, `${role} camera before protect audio`);
        await enableMicrophone(fixture, role, `${role} microphone before protect audio`);
      }

      for (const role of roles) {
        const receiverRole = otherRole(role);
        await fixture.openSidebar(role, "#more");
        const protectAudio = pageFor(fixture, role).locator("#audio-only");
        await protectAudio.check();
        await fixture.waitForRemoteState(receiverRole, participants[role], "camera", "off");
        await fixture.assertAudioProgress(role, receiverRole, `${role} audio while protect audio is active`);
        await fixture.assertPeersConnected(`${role} protect audio active`);

        await protectAudio.uncheck();
        await fixture.waitForRemoteState(receiverRole, participants[role], "camera", "on");
        await fixture.assertRemoteVideoMoves(role, receiverRole, `${role} camera restored after protect audio`);
        await fixture.closeSidebar(role);
      }
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "hiding self-view keeps camera sending and remote video live",
    async run(fixture) {
      await joinPair(fixture, "self-view startup");
      await enableCamera(fixture, "A", "A camera before hiding self-view");
      const localTile = fixture.pageA.locator("li.is-local");
      await fixture.openSidebar("A", "#more");
      await fixture.pageA.locator("#self-view").uncheck();
      await fixture.pageA.waitForFunction(() => {
        const tile = document.querySelector("li.is-local");
        return tile?.hidden === true;
      }, null, { timeout: 10000 });
      assert.equal(await fixture.pageA.locator("#self-view").isChecked(), false,
        "self-view control should be unchecked when hiding the local tile");
      assert.ok(await localTile.count(), "the local participant tile should remain mounted while hidden");
      await fixture.assertCameraRTPContinues("A", "B", "self-view hidden");
      await fixture.assertPeersConnected("self-view hidden");

      await fixture.pageA.locator("#self-view").check();
      await fixture.pageA.waitForFunction(() => document.querySelector("li.is-local")?.hidden === false,
        null, { timeout: 10000 });
      await fixture.assertCameraRTPContinues("A", "B", "self-view shown again");
      await fixture.closeSidebar("A");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "bidirectional ICE restart restores both media directions without reconnect",
    async run(fixture) {
      await joinPair(fixture, "ICE restart startup");
      for (const role of roles) await enableCamera(fixture, role, `${role} camera before ICE restart`);
      const before = await Promise.all(roles.map((role) => fixture.diagnostics(role)));

      await fixture.requestIceRestart("A");
      await Promise.all(roles.map((role) => fixture.waitForConnected(role)));
      await fixture.waitForStability(1000, 30000);
      await Promise.all([
        fixture.assertRemoteVideoMoves("A", "B", "A ICE restart to B"),
        fixture.assertRemoteVideoMoves("B", "A", "B video after A ICE restart")
      ]);
      await fixture.requestIceRestart("B");
      await Promise.all(roles.map((role) => fixture.waitForConnected(role)));
      await fixture.waitForStability(1000, 30000);
      await Promise.all([
        fixture.assertRemoteVideoMoves("A", "B", "A video after B ICE restart"),
        fixture.assertRemoteVideoMoves("B", "A", "B ICE restart to A")
      ]);

      const after = await Promise.all(roles.map((role) => fixture.diagnostics(role)));
      for (let index = 0; index < roles.length; index += 1) {
        assert.equal(after[index].peerConnectionCount, before[index].peerConnectionCount,
          `${roles[index]} ICE restart replaced the media peer connection`);
        assert.equal(after[index].socketCount, before[index].socketCount,
          `${roles[index]} ICE restart replaced the signaling socket`);
      }
      await fixture.assertPeersConnected("bidirectional ICE restart recovery");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "camera disable requested during ICE restart negotiation recovers moving video",
    async run(fixture) {
      await joinPair(fixture, "ICE and camera overlap startup");
      await enableCamera(fixture, "A", "A camera before overlapping ICE restart");
      await fixture.pageB.evaluate((senderName) => {
        const participant = [...document.querySelectorAll("#participants li[data-participant-id]")]
          .find((item) => !item.classList.contains("is-local") && item.textContent.includes(senderName));
        if (!participant) throw new Error(`remote participant ${senderName} was not found`);
        window.__iceCameraStatesDuringRestart = [];
        new MutationObserver(() => window.__iceCameraStatesDuringRestart.push(participant.dataset.camera))
          .observe(participant, { attributes: true, attributeFilter: ["data-camera"] });
      }, participants.A);
      await fixture.pageA.evaluate(() => {
        const peer = window.__slowMeetTest?.peerConnections.at(-1);
        const camera = document.querySelector("#camera");
        if (!peer || !camera) throw new Error("camera or media peer is missing before ICE overlap");
        window.__iceCameraToggleDuringRestart = { requested: false, signalingState: "" };
        peer.addEventListener("signalingstatechange", () => {
          const overlap = window.__iceCameraToggleDuringRestart;
          if (overlap.requested || peer.signalingState === "stable") return;
          overlap.requested = true;
          overlap.signalingState = peer.signalingState;
          camera.click();
        });
      });

      let restartError;
      const restartPromise = fixture.requestIceRestart("A").catch((error) => {
        restartError = error;
      });
      await fixture.pageA.waitForFunction(() => window.__iceCameraToggleDuringRestart?.requested === true,
        null, { timeout: 15000 });
      const overlap = await fixture.pageA.evaluate(() => window.__iceCameraToggleDuringRestart);
      assert.ok(overlap.signalingState && overlap.signalingState !== "stable",
        "camera disable must be requested while A has an ICE restart negotiation in progress");

      await restartPromise;
      if (restartError) throw restartError;
      await fixture.waitForRemoteState("B", participants.A, "camera", "off");
      await fixture.setPressed("A", "#camera", true);
      await fixture.waitForRemoteState("B", participants.A, "camera", "on");
      const receivedCameraStates = await fixture.pageB.evaluate(() => window.__iceCameraStatesDuringRestart);
      assert.ok(receivedCameraStates.includes("off") && receivedCameraStates.includes("on"),
        `B should receive A's camera off/on states after the ICE overlap; observed ${receivedCameraStates.join(", ")}`);

      await Promise.all(roles.map((role) => fixture.waitForConnected(role)));
      await fixture.waitForStability(1000, 30000);
      await fixture.assertRemoteVideoMoves("A", "B", "A camera after overlapping ICE and camera toggles");
      await fixture.assertPeersConnected("overlapping ICE and camera recovery");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "signaling socket reconnect restores both cameras for the two participants",
    async run(fixture) {
      await joinPair(fixture, "signaling reconnect startup");
      for (const role of roles) await enableCamera(fixture, role, `${role} camera before signaling reconnect`);
      const before = await Promise.all(roles.map((role) => fixture.diagnostics(role)));

      await fixture.pageA.evaluate(() => {
        const socket = window.__slowMeetTest?.sockets.at(-1);
        if (!socket || socket.readyState !== WebSocket.OPEN) {
          throw new Error("cannot exercise signaling reconnect without an open WebSocket");
        }
        socket.close(4001, "media lifecycle reconnect scenario");
      });
      await fixture.pageA.waitForFunction((oldSocketCount) =>
        window.__slowMeetTest?.sockets.length > oldSocketCount,
      before[0].socketCount, { timeout: 25000 });
      await Promise.all(roles.map((role) => fixture.waitForConnected(role)));
      await fixture.waitForStability(1000, 30000);

      const after = await Promise.all(roles.map((role) => fixture.diagnostics(role)));
      assert.equal(after[0].socketCount, before[0].socketCount + 1,
        "A signaling reconnect should open exactly one replacement WebSocket");
      assert.ok(after[0].peerConnectionCount > before[0].peerConnectionCount,
        "A signaling reconnect should establish a replacement media peer connection");
      assert.equal(after[1].socketCount, before[1].socketCount,
        "B signaling socket changed while A reconnected");
      assert.equal(after[1].peerConnectionCount, before[1].peerConnectionCount,
        "B media peer connection changed while A reconnected");

      for (let index = 0; index < roles.length; index += 1) {
        assert.equal(after[index].connectionState, "connected",
          `${roles[index]} must be connected after signaling recovery`);
        assert.ok(["connected", "completed"].includes(after[index].iceConnectionState),
          `${roles[index]} ICE must be connected after signaling recovery`);
      }
      await Promise.all([
        assertRemoteCameraMovesFromDiagnostics(fixture, "A", "B", "A camera after signaling reconnect"),
        assertRemoteCameraMovesFromDiagnostics(fixture, "B", "A", "B camera after signaling reconnect")
      ]);
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "generated screen share starts, stops, restarts, and rejects competing ownership",
    when: "screenShare",
    required: false,
    async run(fixture) {
      await joinPair(fixture, "screen share startup");
      await enableCamera(fixture, "A", "A camera before screen share");
      const sourcePage = await fixture.createChangingContentPage("A");
      await sourcePage.bringToFront();

      const startShare = async (label) => {
        await sourcePage.bringToFront();
        await fixture.pageA.bringToFront();
        await fixture.pageA.locator("#screen").click();
        await fixture.pageA.waitForFunction(() =>
          document.querySelector("#screen")?.getAttribute("aria-pressed") === "true",
        null, { timeout: 60000 });
        await fixture.waitForRemoteState("B", participants.A, "sharing", "true");
        const sourceFrameBefore = await sourcePage.evaluate(() => window.__shareSourceFrame);
        await fixture.assertRemoteVideoMoves("A", "B", label, "screen");
        await assertRemoteScreenPixelsChange(fixture.pageB, participants.A, label);
        const sourceFrameAfter = await sourcePage.evaluate(() => window.__shareSourceFrame);
        assert.ok(sourceFrameAfter > sourceFrameBefore,
          `${label}: generated source frame counter did not advance during the active share`);
        await fixture.assertCameraRTPContinues("A", "B", `${label}; camera continues`);
      };

      const stopShare = async (label) => {
        await fixture.pageA.locator("#screen").click();
        await fixture.pageA.waitForFunction(() =>
          document.querySelector("#screen")?.getAttribute("aria-pressed") === "false",
        null, { timeout: 15000 });
        await fixture.waitForRemoteState("B", participants.A, "sharing", "false");
        await fixture.assertDisplayCaptureEnded("A", label);
        await fixture.waitForStability(750, 15000);
        await fixture.assertPeersConnected(label);
      };

      await startShare("A generated screen share");
      assert.equal(await fixture.pageB.locator("#screen").isDisabled(), true,
        "B must not own a competing share while A is sharing");
      const outgoingStartsBefore = await fixture.pageB.evaluate(() =>
        window.__slowMeetTest.signalingMessages.filter((message) =>
          message.direction === "out" && message.type === "screen_share" && message.screenShareActive === true).length);
      await fixture.pageB.locator("#screen").evaluate((button) =>
        button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      await delay(500);
      const outgoingStartsAfter = await fixture.pageB.evaluate(() =>
        window.__slowMeetTest.signalingMessages.filter((message) =>
          message.direction === "out" && message.type === "screen_share" && message.screenShareActive === true).length);
      assert.equal(outgoingStartsAfter, outgoingStartsBefore,
        "B competing share click must not send another active screen-share request");
      await fixture.waitForRemoteState("B", participants.A, "sharing", "true");

      await stopShare("A generated screen share stopped");
      await startShare("A generated screen share restart");
      await stopShare("A restarted generated screen share stopped");
      await fixture.assertNoDuplicateParticipants();
    }
  },
  {
    name: "camera and microphone tracks stop after both participants leave",
    async run(fixture) {
      await joinPair(fixture, "leave media cleanup startup");
      for (const role of roles) {
        await enableCamera(fixture, role, `${role} camera before leaving`);
        await enableMicrophone(fixture, role, `${role} microphone before leaving`);
      }

      for (const role of roles) {
        const page = pageFor(fixture, role);
        await page.locator("#leave").click();
        await page.locator("#meeting").waitFor({ state: "hidden", timeout: 15000 });
        await fixture.assertNoLiveCapturedTracks(role);
      }
    }
  }
];

module.exports = { scenarios };
