package signaling

import "strings"

// roomMessage copies only the fields allowed for client-originated broadcasts.
// A valid chat/reaction/state message may carry other protocol fields, but those
// fields must never be forwarded or retained in room history.
func roomMessage(c *client, incoming Message) Message {
	m := Message{Version: ProtocolVersion, Type: incoming.Type, ParticipantID: c.participant.ID}
	switch incoming.Type {
	case TypeMediaState:
		m.AudioEnabled = incoming.AudioEnabled
		m.VideoEnabled = incoming.VideoEnabled
		m.VideoPaused = incoming.VideoPaused
	case TypeChat:
		m.Name = c.participant.Name
		m.ChatText = strings.TrimSpace(incoming.ChatText)
	case TypeReaction:
		m.Name = c.participant.Name
		m.Emoji = incoming.Emoji
	}
	return m
}
