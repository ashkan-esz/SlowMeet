'use strict';

// SlowMeetMeetingStatus routes status messages to the surface the user can
// actually see: the join-form status line before the meeting starts, and a
// dedicated in-meeting banner once the join form is hidden. Mid-meeting
// errors written only to the hidden join form were previously invisible.
(function (global) {
  function createMeetingStatusRouter(options) {
    const settings = options || {};
    const joinStatus = settings.joinStatus;
    const meetingStatus = settings.meetingStatus;
    const isInMeeting = settings.isInMeeting || (() => false);
    let current = '';

    function show(message) {
      const text = typeof message === 'string' ? message : '';
      current = text;
      if (!text) {
        if (meetingStatus) {
          meetingStatus.hidden = true;
          meetingStatus.textContent = '';
        }
        return;
      }
      if (isInMeeting()) {
        if (meetingStatus) {
          meetingStatus.textContent = text;
          meetingStatus.hidden = false;
        }
      } else if (joinStatus) {
        joinStatus.textContent = text;
      }
    }

    return {
      show,
      clear() {
        show('');
      },
      get message() {
        return current;
      }
    };
  }

  const api = { createMeetingStatusRouter };
  global.SlowMeetMeetingStatus = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
