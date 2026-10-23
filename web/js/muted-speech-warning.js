(function (root) {
  "use strict";

  const maxAlertsPerEpisode = 2;

  function advance(state, talking, now, activationDelay, deactivationHold, repeatInterval) {
    const current = state || { since: 0, quietSince: 0, lastWarnAt: 0, alertCount: 0 };
    if (talking) {
      const since = current.since || now;
      const initialWarningDue = current.alertCount === 0 && now - since >= activationDelay;
      const repeatWarningDue = current.alertCount > 0 &&
        current.alertCount < maxAlertsPerEpisode &&
        now - current.lastWarnAt >= repeatInterval;
      const shouldWarn = initialWarningDue || repeatWarningDue;
      return {
        state: {
          since,
          quietSince: 0,
          lastWarnAt: shouldWarn ? now : current.lastWarnAt,
          alertCount: shouldWarn ? current.alertCount + 1 : current.alertCount
        },
        shouldWarn
      };
    }

    if (!current.since) return { state: current, shouldWarn: false };
    const quietSince = current.quietSince || now;
    if (now - quietSince < deactivationHold) {
      return { state: { ...current, quietSince }, shouldWarn: false };
    }
    return { state: { since: 0, quietSince: 0, lastWarnAt: 0, alertCount: 0 }, shouldWarn: false };
  }

  const api = { advance };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (root) root.MutedSpeechWarning = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
