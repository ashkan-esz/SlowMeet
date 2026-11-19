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
    const setTimer = settings.setTimeout || ((callback, delay) => setTimeout(callback, delay));
    const clearTimer = settings.clearTimeout || ((timer) => clearTimeout(timer));
    let current = '';
    let currentKind = '';
    let dismissTimer;

    // show replaces the current message. The in-meeting banner has no close
    // control, so a message stays until something replaces or clears it:
    // options.duration (ms) dismisses a confirmation on its own, and
    // options.kind labels a message so clear(kind) can retire it once the
    // condition it describes is over.
    function show(message, options) {
      const text = typeof message === 'string' ? message : '';
      const opts = options || {};
      const duration = Number(opts.duration) > 0 ? Number(opts.duration) : 0;
      if (dismissTimer !== undefined) {
        clearTimer(dismissTimer);
        dismissTimer = undefined;
      }
      current = text;
      currentKind = text && typeof opts.kind === 'string' ? opts.kind : '';
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
        if (duration) {
          dismissTimer = setTimer(() => {
            dismissTimer = undefined;
            show('');
          }, duration);
        }
      } else if (joinStatus) {
        joinStatus.textContent = text;
      }
    }

    return {
      show,
      // clear() hides whatever is showing; clear(kind) hides it only when the
      // current message was shown with that kind.
      clear(kind) {
        if (kind !== undefined && kind !== currentKind) return;
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
