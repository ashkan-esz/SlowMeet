(function exposeRemoteScreenVideo(root, factory) {
  const bindRemoteScreenTrack = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = bindRemoteScreenTrack;
  } else {
    root.bindRemoteScreenTrack = bindRemoteScreenTrack;
  }
})(typeof globalThis === "object" ? globalThis : this, function createRemoteScreenBinder() {
  const bindings = new WeakMap();
  const activeBindings = new WeakMap();

  function detachListeners(binding) {
    binding.track.removeEventListener?.("unmute", binding.attemptPlayback);
    binding.track.removeEventListener?.("ended", binding.clearOnEnded);
    binding.video.removeEventListener?.("loadedmetadata", binding.retryOnMetadata);
    bindings.delete(binding.stream);
    if (activeBindings.get(binding.video) === binding) activeBindings.delete(binding.video);
  }

  function bindRemoteScreenTrack(video, track, onEnded = () => {}, createStream = (item) => new MediaStream([item])) {
    const previousBinding = activeBindings.get(video);
    if (previousBinding) detachListeners(previousBinding);

    const stream = createStream(track);

    video.autoplay = true;
    video.muted = true;
    video.playsInline = true;

    const attemptPlayback = () => {
      if (video.srcObject !== stream) return;
      try {
        const playback = video.play?.();
        playback?.catch?.(() => {});
      } catch (_) {
        // Playback is retried when the track unmutes or metadata becomes available.
      }
    };
    const clearOnEnded = () => {
      bindRemoteScreenTrack.clear(video, stream, onEnded);
    };
    const retryOnMetadata = () => attemptPlayback();
    const binding = { stream, track, video, attemptPlayback, clearOnEnded, retryOnMetadata };

    video.srcObject = stream;
    track.addEventListener("unmute", attemptPlayback);
    track.addEventListener("ended", clearOnEnded, { once: true });
    video.addEventListener("loadedmetadata", retryOnMetadata, { once: true });
    bindings.set(stream, binding);
    activeBindings.set(video, binding);
    attemptPlayback();
    return stream;
  }

  bindRemoteScreenTrack.clear = function clearRemoteScreenTrack(video, expectedStream, onCleared = () => {}) {
    const binding = bindings.get(expectedStream);
    if (video.srcObject !== expectedStream) {
      if (binding) detachListeners(binding);
      return false;
    }
    if (binding) detachListeners(binding);
    video.srcObject = null;
    video.pause?.();
    onCleared();
    return true;
  };

  return bindRemoteScreenTrack;
});
