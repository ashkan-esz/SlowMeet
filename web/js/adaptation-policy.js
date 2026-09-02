function chooseAdaptationLevel(level, poorSamples, goodSamples, profileCount) {
  if (poorSamples >= 2 && level > 0) {
    return { level: level - 1, reset: "poor" };
  }
  if (goodSamples >= 5 && level < profileCount - 1) {
    return { level: level + 1, reset: "good" };
  }
  return { level, reset: null };
}

if (typeof module !== "undefined") {
  module.exports = { chooseAdaptationLevel };
}
