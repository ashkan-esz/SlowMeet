(function (root) {
  "use strict";

  const METRIC_KEYS = [
    "rttMs", "jitterMs", "packetLossPct", "inboundVideoKbps", "outboundVideoKbps",
    "inboundAudioKbps", "outboundAudioKbps"
  ];

  function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  function createConnectionHistory() {
    let recording = null;

    function snapshot() {
      if (!recording) return null;
      return {
        schemaVersion: 1,
        startedAt: recording.startedAt,
        endedAt: recording.endedAt,
        stateTransitions: recording.stateTransitions.map((event) => ({...event})),
        samples: recording.samples.map((sample) => ({...sample}))
      };
    }

    return {
      start(at = Date.now(), initialState = {}) {
        recording = {
          schemaVersion: 1,
          startedAt: at,
          endedAt: null,
          stateTransitions: [],
          samples: []
        };
        for (const state of ["connection", "ice"]) {
          if (typeof initialState[state] === "string") {
            recording.stateTransitions.push({at, state, value: initialState[state], initial: true});
          }
        }
        return snapshot();
      },
      stop(at = Date.now()) {
        if (recording && recording.endedAt === null) recording.endedAt = at;
        return snapshot();
      },
      clear() {
        recording = null;
      },
      isRecording() {
        return Boolean(recording && recording.endedAt === null);
      },
      addTransition(state, value, at = Date.now()) {
        if (!recording || recording.endedAt !== null || typeof value !== "string") return;
        const previous = [...recording.stateTransitions].reverse().find((event) => event.state === state);
        if (previous?.value === value) return;
        recording.stateTransitions.push({at, state, value});
      },
      addSample(sample) {
        if (!recording || recording.endedAt !== null || !sample) return;
        const clean = {at: finiteOrNull(sample.at) ?? Date.now()};
        for (const key of METRIC_KEYS) clean[key] = finiteOrNull(sample[key]);
        recording.samples.push(clean);
      },
      get() {
        return snapshot();
      },
      exportJSON() {
        return snapshot();
      }
    };
  }

  const api = {createConnectionHistory};
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SlowMeetConnectionHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
