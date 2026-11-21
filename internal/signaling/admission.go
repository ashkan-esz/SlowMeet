package signaling

import (
	"errors"

	"SlowMeet/internal/meeting"
)

func (h *Hub) expireAdmission(c *client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if _, admitted := h.roomMembers[c]; !admitted {
		c.admissionExpired = true
		if c.conn != nil {
			_ = c.conn.Close()
		}
	}
}

// admit serializes the deadline and admission transition. The participant
// response, chat replay, and the roster/media/screen replay are all enqueued
// under one h.mu hold: no broadcast can interleave between the join ack and
// the replay, so the joiner can never have a live update overwritten by an
// older replayed state or miss one recorded in the window.
//
// The joiner's own participant_joined announcement goes out in the same hold,
// and the roster replay lists only members already in the room fan-out (and
// so already announced). That makes "announce me" and "tell me who is here"
// one step: of two participants admitted at the same moment, the second
// learns about the first from the replay and the first learns about the
// second from its announcement, never both (B5 in docs/network-testing.md).
func (h *Hub) admit(c *client, participant meeting.Participant, response Message, activeTakeover bool) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || c.admissionExpired {
		return errors.New("admission expired")
	}
	h.roomMembers[c] = struct{}{}
	if !activeTakeover {
		// A takeover's peers never saw this participant leave, so they get no
		// second announcement.
		h.broadcastExceptLocked(c, Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &participant})
	}
	// Announced from here on, so a departure must broadcast participant_left
	// even if the rest of the admission fails.
	h.announced[participant.ID] = struct{}{}
	c.announced = true
	// The chat replay is taken while holding h.mu immediately after the client
	// joins the room fan-out: every chat recorded up to this point is included
	// here, and anything recorded afterwards is delivered by the ordinary
	// broadcast path. Snapshotting before this point used to lose the messages
	// recorded in between. No other goroutine can enqueue a room broadcast to
	// c in this window because fan-out collects members under h.mu.
	response.ChatHistory = h.chatHistorySnapshotLocked(chatRoomID)
	if err := c.write(response); err != nil {
		return err
	}
	// Roster replay, in meeting order, of the participants the room knows as
	// present. Participants inside their reconnect grace window were already
	// announced as departed and re-announce when they return; participants
	// still being admitted announce themselves when their own admit runs.
	for _, existing := range h.Meeting.List() {
		if existing.ID == participant.ID {
			continue
		}
		if _, ok := h.announced[existing.ID]; !ok {
			continue
		}
		_ = c.write(Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &existing})
	}
	for _, state := range h.mediaStates {
		_ = c.write(state)
	}
	// Each sender's reported uplink, so the joiner does not charge a bad
	// sender uplink to its own link while waiting for the next change.
	for participantID, quality := range h.sourceQuality {
		if participantID == participant.ID {
			continue
		}
		if _, ok := h.announced[participantID]; !ok {
			continue
		}
		_ = c.write(sourceQualityMessage(participantID, quality.sentLoss10, quality.sentJitterMs))
	}
	screenOwner := ""
	if h.screenSharer != nil {
		screenOwner = h.screenSharer.participant.ID
	}
	if screenOwner != "" {
		_ = c.write(h.screenShareMessage(true, screenOwner))
	} else if activeTakeover {
		// The previous connection was superseded while it owned the screen
		// share, and its cleanup released the lease before this client was a
		// room member, so the resumed client missed the inactive broadcast.
		// Correct its state explicitly.
		_ = c.write(h.screenShareMessage(false, ""))
	}
	return nil
}

// ValidateActiveReconnectToken authorizes short-lived services tied to an
// admitted connection. A disconnected or superseded session cannot renew them.
func (h *Hub) ValidateActiveReconnectToken(token string) bool {
	if token == "" {
		return false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	c := h.activeTokens[token]
	_, admitted := h.roomMembers[c]
	return !h.closed && c != nil && admitted
}
