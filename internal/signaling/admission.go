package signaling

import "errors"

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
// response is queued before broadcasts or service authorization can see c.
func (h *Hub) admit(c *client, response Message) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed || c.admissionExpired {
		return errors.New("admission expired")
	}
	if err := c.write(response); err != nil {
		return err
	}
	h.roomMembers[c] = struct{}{}
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
