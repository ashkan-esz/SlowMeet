// Remembers, per remote participant, the track events app.js bound to that
// participant's tile, so they can be bound again when the participant
// resumes.
//
// A participant whose signaling drops is announced as departed
// (participant_left) and, when it resumes within the reconnect grace window,
// as joined again. The server keeps the participant's publications through
// the grace window and moves the resumed connection's media onto the
// receivers' existing senders (a publication swap), without a renegotiation,
// so no new ontrack event arrives: the tracks are the same live ones, but the
// tile was cleared (or rebuilt) when the participant left. Without rebinding
// them the room keeps receiving the participant's audio and video and plays
// neither (B11, B9 in docs/network-testing.md).
function createRemoteTrackMemory() {
  const events = new Map();

  return {
    // Records one bound track event, replacing an earlier one for the same
    // track so a rebind does not accumulate duplicates.
    remember(participantID, event) {
      if (!participantID || !event?.track) return;
      const kept = (events.get(participantID) || []).filter((entry) =>
        entry.track !== event.track && entry.track?.readyState !== "ended");
      kept.push(event);
      events.set(participantID, kept);
    },
    // Returns and forgets the participant's remembered events that
    // isBindable still accepts (a live track on a receiver that is still part
    // of the current connection).
    take(participantID, isBindable = () => true) {
      const remembered = events.get(participantID) || [];
      events.delete(participantID);
      return remembered.filter((event) => isBindable(event));
    },
    forget(participantID) {
      events.delete(participantID);
    },
    // Called when the peer connection is rebuilt: every receiver is new.
    clear() {
      events.clear();
    },
    size(participantID) {
      return (events.get(participantID) || []).length;
    }
  };
}

if (typeof module !== "undefined") {
  module.exports = { createRemoteTrackMemory };
}
