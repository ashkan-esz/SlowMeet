package media

// DownlinkQuality reports what participantID's download loses and queues of
// the packets the SFU sends it, measured from that participant's own
// transport-cc feedback (webrtc.Peer.DownlinkQuality): loss in tenths of a
// percent and jitter in milliseconds, or -1 for both without a measurement.
// Unlike a receiver's estimate from its inbound streams, nothing of any
// sender's uplink is in it.
func (r *Router) DownlinkQuality(participantID string) (loss10, jitterMs int) {
	r.mu.RLock()
	peer := r.peers[participantID]
	r.mu.RUnlock()
	loss10, jitterMs, _, ok := peer.DownlinkQuality()
	if !ok {
		return -1, -1
	}
	return loss10, jitterMs
}
