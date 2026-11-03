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
func (h *Hub) admit(c *client, participant meeting.Participant, response Message, activeTakeover bool) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || c.admissionExpired {
		return errors.New("admission expired")
	}
	h.roomMembers[c] = struct{}{}
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
	// Roster replay: participants inside their reconnect grace window were
	// already announced as departed and re-announce when they return.
	pendingIDs := make(map[string]struct{}, len(h.pending))
	for _, reconnect := range h.pending {
		pendingIDs[reconnect.participant.ID] = struct{}{}
	}
	for _, existing := range h.Meeting.List() {
		if existing.ID == participant.ID {
			continue
		}
		if _, pending := pendingIDs[existing.ID]; pending {
			continue
		}
		_ = c.write(Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &existing})
	}
	for _, state := range h.mediaStates {
		_ = c.write(state)
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
