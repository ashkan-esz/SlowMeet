(function exposeRemoteCameraVideo(root, factory) {
  const bindRemoteCameraTrack = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = bindRemoteCameraTrack;
  } else {
    root.bindRemoteCameraTrack = bindRemoteCameraTrack;
  }
})(typeof globalThis === "object" ? globalThis : this, function createRemoteCameraBinder() {
  const activeBindings = new WeakMap();

  function detachListeners(binding) {
    binding.track.removeEventListener?.("unmute", binding.attemptPlayback);
    binding.track.removeEventListener?.("ended", binding.clearOnEnded);
    binding.video.removeEventListener?.("loadedmetadata", binding.retryOnMetadata);
    if (activeBindings.get(binding.video) === binding) activeBindings.delete(binding.video);
  }

  function bindRemoteCameraTrack(video, track, onEnded = () => {}, createStream = (item) => new MediaStream([item])) {
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
      if (video.srcObject !== stream) {
        detachListeners(binding);
        return;
      }
      detachListeners(binding);
      video.srcObject = null;
      video.pause?.();
      onEnded();
    };
    const retryOnMetadata = () => attemptPlayback();
    const binding = { stream, track, video, attemptPlayback, clearOnEnded, retryOnMetadata };

    video.srcObject = stream;
    track.addEventListener("unmute", attemptPlayback);
    track.addEventListener("ended", clearOnEnded, { once: true });
    video.addEventListener("loadedmetadata", retryOnMetadata, { once: true });
    activeBindings.set(video, binding);
    attemptPlayback();
    return stream;
  }

  bindRemoteCameraTrack.clear = function clearRemoteCameraTrack(video) {
    const binding = activeBindings.get(video);
    if (!binding) return false;
    detachListeners(binding);
    if (video.srcObject === binding.stream) video.srcObject = null;
    video.pause?.();
    return true;
  };

  return bindRemoteCameraTrack;
});
