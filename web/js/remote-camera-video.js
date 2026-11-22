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

  // selectLayer picks the layer track to show. The SFU forwards each receiver
  // exactly one layer of a camera (the active one nearest the preference),
  // so when the caller can tell which layer tracks are receiving packets
  // (isFlowing), the nearest flowing one wins; the browser's muted flag lags
  // the switch by seconds and is only the fallback (B12).
  bindRemoteCameraTrack.selectLayer = function selectLayer(tracks, preferredLayer, isFlowing) {
    const quality = ["low", "medium", "high"];
    const preferredIndex = quality.indexOf(preferredLayer);
    const candidates = [...tracks.entries()]
      .filter(([, track]) => track.readyState === "live")
      .sort(([layerA], [layerB]) => {
        const indexA = quality.indexOf(layerA);
        const indexB = quality.indexOf(layerB);
        const distanceA = Math.abs(indexA - preferredIndex);
        const distanceB = Math.abs(indexB - preferredIndex);
        return distanceA - distanceB || indexA - indexB;
      });
    if (typeof isFlowing === "function") {
      const flowing = candidates.find(([, track]) => isFlowing(track));
      if (flowing) return flowing[1];
    }
    return candidates.find(([, track]) => !track.muted)?.[1] || candidates[0]?.[1];
  };

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
