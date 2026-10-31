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

// Missing elements are tolerated.
const bare = createMeetingStatusRouter({ isInMeeting: () => true });
bare.show("ignored");
assert.equal(bare.message, "ignored", "show without sinks should still record the message");
bare.clear();
assert.equal(bare.message, "", "clear should reset the recorded message");

console.log("meeting status router tests passed");
