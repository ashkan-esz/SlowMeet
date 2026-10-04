(function exposeRemoteScreenVideo(root, factory) {
  const bindRemoteScreenTrack = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = bindRemoteScreenTrack;
  } else {
    root.bindRemoteScreenTrack = bindRemoteScreenTrack;
  }
})(typeof globalThis === "object" ? globalThis : this, function createRemoteScreenBinder() {
  return function bindRemoteScreenTrack(video, track, onEnded = () => {}, createStream = (item) => new MediaStream([item])) {
    const stream = createStream(track);
    video.srcObject = stream;
    track.addEventListener("ended", () => {
      bindRemoteScreenTrack.clear(video, stream, onEnded);
    }, { once: true });
    return stream;
  };
});

const bindRemoteScreenTrack = typeof module === "object" && module.exports
  ? module.exports
  : globalThis.bindRemoteScreenTrack;
bindRemoteScreenTrack.clear = function clearRemoteScreenTrack(video, expectedStream, onCleared = () => {}) {
  if (video.srcObject !== expectedStream) return false;
  video.srcObject = null;
  video.pause?.();
  onCleared();
  return true;
};
