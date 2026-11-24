package media

import (
	"time"

	"github.com/pion/rtp"
)

const (
	videoRepairHistorySize = 64
	videoRepairWindow      = 2 * time.Second
)

type videoRepairFrame struct {
	timestamp uint32
	marker    uint16
	forwarded time.Time
	seen      [(maxFramePackets + 63) / 64]uint64
}

// videoFrameHistory is owned by the publication's ingress goroutine. It is
// bounded independently of the number of receivers and retains no RTP payloads.
type videoFrameHistory struct {
	frames [videoRepairHistorySize]videoRepairFrame
	next   int
}

func (h *videoFrameHistory) remember(packets []*rtp.Packet, now time.Time) {
	var marker *rtp.Packet
	for _, packet := range packets {
		if packet.Marker {
			marker = packet
			break
		}
	}
	if marker == nil {
		return
	}
	frame := videoRepairFrame{
		timestamp: marker.Timestamp,
		marker:    marker.SequenceNumber,
		forwarded: now,
	}
	for _, packet := range packets {
		frame.markSeen(packet.SequenceNumber)
	}
	h.frames[h.next] = frame
	h.next = (h.next + 1) % len(h.frames)
}

func (h *videoFrameHistory) find(packet *rtp.Packet, now time.Time) *videoRepairFrame {
	for i := range h.frames {
		frame := &h.frames[i]
		if frame.forwarded.IsZero() || frame.timestamp != packet.Timestamp ||
			now.Sub(frame.forwarded) > videoRepairWindow ||
			uint16(frame.marker-packet.SequenceNumber) >= maxFramePackets {
			continue
		}
		return frame
	}
	return nil
}

func (h *videoFrameHistory) repair(packet *rtp.Packet, now time.Time) *videoRepairFrame {
	frame := h.find(packet, now)
	if frame != nil && !frame.hasSeen(packet.SequenceNumber) {
		return frame
	}
	return nil
}

func (f *videoRepairFrame) hasSeen(sequence uint16) bool {
	offset := uint16(f.marker - sequence)
	return offset < maxFramePackets && f.seen[offset/64]&(uint64(1)<<(offset%64)) != 0
}

func (f *videoRepairFrame) markSeen(sequence uint16) {
	offset := uint16(f.marker - sequence)
	if offset < maxFramePackets {
		f.seen[offset/64] |= uint64(1) << (offset % 64)
	}
}

func queueVideoPacket(pub *publication, frame *videoFrameBuffer, history *videoFrameHistory,
	frames chan<- videoFrame, packet *rtp.Packet,
) bool {
	// Do not wait for missing packets before forwarding a frame: retransmissions
	// and reordered packets can follow it through the same bounded pacer queue.
	if frame.hasLastTimestamp && !rtpTimestampAfter(packet.Timestamp, frame.lastTimestamp) {
		if prior := history.find(packet, time.Now()); prior != nil {
			if prior.hasSeen(packet.SequenceNumber) {
				return true
			}
			if enqueueVideoFrame(frames, videoFrame{packets: []*rtp.Packet{packet}}) {
				prior.markSeen(packet.SequenceNumber)
			}
		}
		return false
	}

	oversized := frame.oversized
	packets, _, complete := frame.add(packet)
	if frame.oversized != oversized {
		pub.videoDrops.FrameTooLarge()
	}
	switch {
	case !complete:
	case !pub.limiter.allowFrame(packets[0].Timestamp):
		pub.videoDrops.FrameFPSLimit()
		pub.keyFrameAfterDrop.Store(true)
	case !enqueueVideoFrame(frames, videoFrame{packets: packets}):
		pub.videoDrops.FrameQueueFull()
		pub.keyFrameAfterDrop.Store(true)
	default:
		history.remember(packets, time.Now())
	}
	return false
}

// keyFrameAfterDropInterval bounds the keyframes a publisher is asked for
// because the SFU dropped its frames: a stream that keeps exceeding the limits
// is repaired once a second, not on every drop.
const keyFrameAfterDropInterval = time.Second

// keyFrameAfterDropDue reports whether to ask the publisher for a keyframe
// now, after the SFU dropped a frame whole (the frame-rate gate or a full
// pacing queue). Every later frame builds on the dropped one, so receivers
// show nothing until a keyframe; left to them, that is their own timeout of
// about three seconds (B20 in docs/network-testing.md). A frame larger than
// the SFU buffers is not answered this way: the next keyframe would be too
// large again.
//
// The need stays pending while it must wait, for the once-a-second bound or
// for the shared request budget (allowKeyFrameRequest): a request that went
// out moments ago may have produced its keyframe before the drop.
func (pub *publication) keyFrameAfterDropDue(now time.Time) bool {
	if !pub.keyFrameAfterDrop.Load() {
		return false
	}
	last := pub.lastDropKeyFrameRequest.Load()
	if last != 0 && now.UnixNano()-last < int64(keyFrameAfterDropInterval) {
		return false
	}
	if !pub.allowKeyFrameRequest(now) {
		return false
	}
	pub.lastDropKeyFrameRequest.Store(now.UnixNano())
	pub.keyFrameAfterDrop.Store(false)
	return true
}
