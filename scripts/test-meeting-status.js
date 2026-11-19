const assert = require("node:assert/strict");
const { createMeetingStatusRouter } = require("../web/js/meeting-status.js");

function createRouter(inMeeting) {
  const joinStatus = { textContent: "" };
  const meetingStatus = { textContent: "", hidden: true };
  const router = createMeetingStatusRouter({
    joinStatus,
    meetingStatus,
    isInMeeting: () => inMeeting()
  });
  return { router, joinStatus, meetingStatus };
}

// Before the meeting starts, messages go to the join form status line.
let inMeeting = false;
let { router, joinStatus, meetingStatus } = createRouter(() => inMeeting);
router.show("Joining meeting…");
assert.equal(joinStatus.textContent, "Joining meeting…", "pre-join messages should reach the join form");
assert.equal(meetingStatus.hidden, true, "the in-meeting banner should stay hidden before joining");

// Once the meeting starts, messages go to the visible banner instead. The
// router checks dynamically, so the same call sites work across the
// join transition.
inMeeting = true;
router.show("Screen share unavailable: denied");
assert.equal(meetingStatus.textContent, "Screen share unavailable: denied", "mid-meeting messages should reach the banner");
assert.equal(meetingStatus.hidden, false, "the banner should become visible");
assert.equal(router.message, "Screen share unavailable: denied");

// Clearing hides the banner and empties it.
router.clear();
assert.equal(meetingStatus.hidden, true, "clear should hide the banner");
assert.equal(meetingStatus.textContent, "", "clear should empty the banner");
assert.equal(router.message, "");

// Non-string input behaves like clearing.
router.show("something");
router.show(undefined);
assert.equal(meetingStatus.hidden, true, "non-string input should hide the banner");

// A message shown pre-join does not leak into the hidden form forever: after
// the meeting starts and the router is cleared, the join form keeps its own
// last message.
inMeeting = false;
router.show("pre-join note");
inMeeting = true;
router.clear();
assert.equal(joinStatus.textContent, "pre-join note", "clear should not rewrite the join form");
assert.equal(meetingStatus.hidden, true, "clear should hide the banner mid-meeting");

// A confirmation shown with a duration dismisses itself; the banner has no
// close control, so without this it would stay up for the rest of the call.
function createTimedRouter() {
  const timers = new Map();
  let nextTimer = 1;
  const banner = { textContent: "", hidden: true };
  const timed = createMeetingStatusRouter({
    meetingStatus: banner,
    isInMeeting: () => true,
    setTimeout: (callback, delay) => {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id)
  });
  const fire = () => {
    const pending = [...timers.entries()];
    timers.clear();
    pending.forEach(([, timer]) => timer.callback());
  };
  return { timed, banner, timers, fire };
}

let timedRouter = createTimedRouter();
timedRouter.timed.show("Switched to TURN over TLS (rotating).", { duration: 4000 });
assert.equal(timedRouter.banner.hidden, false, "a timed message should show first");
assert.equal(timedRouter.timers.size, 1, "a duration should schedule one dismissal");
assert.equal([...timedRouter.timers.values()][0].delay, 4000, "the dismissal should use the requested duration");
timedRouter.fire();
assert.equal(timedRouter.banner.hidden, true, "a timed message should hide when its duration elapses");
assert.equal(timedRouter.banner.textContent, "", "a timed message should empty the banner when it hides");
assert.equal(timedRouter.timed.message, "");

// A newer message cancels the pending dismissal, so it is not hidden early.
timedRouter = createTimedRouter();
timedRouter.timed.show("Remote audio enabled.", { duration: 4000 });
timedRouter.timed.show("Media connection failed. Retry to reconnect.");
assert.equal(timedRouter.timers.size, 0, "replacing a timed message should cancel its dismissal");
assert.equal(timedRouter.banner.textContent, "Media connection failed. Retry to reconnect.");
assert.equal(timedRouter.banner.hidden, false, "a message without a duration should stay visible");

// Clearing cancels the pending dismissal too.
timedRouter.timed.show("Remote audio enabled.", { duration: 4000 });
timedRouter.timed.clear();
assert.equal(timedRouter.timers.size, 0, "clear should cancel a pending dismissal");

// A duration is ignored before the meeting starts: the join form keeps its line.
inMeeting = false;
({ router, joinStatus, meetingStatus } = createRouter(() => inMeeting));
router.show("pre-join confirmation", { duration: 1 });
assert.equal(joinStatus.textContent, "pre-join confirmation");

// clear(kind) retires only a message shown with that kind.
timedRouter = createTimedRouter();
timedRouter.timed.show("Restarting media...", { kind: "recovery" });
timedRouter.timed.clear("recovery");
assert.equal(timedRouter.banner.hidden, true, "clear(kind) should hide a message of that kind");
timedRouter.timed.show("Screen share unavailable: denied");
timedRouter.timed.clear("recovery");
assert.equal(timedRouter.banner.hidden, false, "clear(kind) should leave messages of another kind");
assert.equal(timedRouter.banner.textContent, "Screen share unavailable: denied");
timedRouter.timed.show("Restarting media...", { kind: "recovery" });
timedRouter.timed.show("Camera unavailable");
timedRouter.timed.clear("recovery");
assert.equal(timedRouter.banner.textContent, "Camera unavailable", "a replacement message should drop the previous kind");

// Missing elements are tolerated.
const bare = createMeetingStatusRouter({ isInMeeting: () => true });
bare.show("ignored");
assert.equal(bare.message, "ignored", "show without sinks should still record the message");
bare.clear();
assert.equal(bare.message, "", "clear should reset the recorded message");

console.log("meeting status router tests passed");
