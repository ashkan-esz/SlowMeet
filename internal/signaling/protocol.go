package signaling

import (
	"fmt"
	"strings"
	"time"

	"SlowMeet/internal/meeting"
)

type ChatHistoryEntry struct {
	ID        string    `json:"id"`
	Author    string    `json:"author"`
	Text      string    `json:"text"`
	Timestamp time.Time `json:"timestamp"`
}

const (
	ProtocolVersion  = 1
	TypeJoin         = "join"
	TypeLeave        = "leave"
	TypeParticipant  = "participant"
	TypeJoined       = "participant_joined"
	TypeLeft         = "participant_left"
	TypeOffer        = "offer"
	TypeAnswer       = "answer"
	TypeCandidate    = "candidate"
	TypeICERestart   = "ice_restart"
	TypeMediaState   = "media_state"
	TypeHandState    = "hand_state"
	TypeNetworkState = "network_state"
	TypeScreenShare  = "screen_share"
	TypeScreenState  = "screen_share_state"
	TypeConfigUpdate = "config_update"
	TypeChat         = "chat_message"
	TypeReaction     = "emoji_reaction"
	TypeRoomFull     = "room_full"
	TypeError        = "error"
)

var approvedReactionEmojis = map[string]struct{}{
	"👍": {}, "👎": {}, "❤️": {}, "😂": {}, "🎉": {}, "😮": {},
	"👏": {}, "🙌": {}, "🔥": {}, "💯": {}, "😢": {}, "🤔": {},
}

type Message struct {
	Version            int                  `json:"version"`
	Type               string               `json:"type"`
	Name               string               `json:"name,omitempty"`
	Password           string               `json:"password,omitempty"`
	ReconnectToken     string               `json:"reconnect_token,omitempty"`
	ParticipantID      string               `json:"participant_id,omitempty"`
	MediaStreamID      string               `json:"media_stream_id,omitempty"`
	Error              string               `json:"error,omitempty"`
	Participant        *meeting.Participant `json:"participant,omitempty"`
	TargetID           string               `json:"target_id,omitempty"`
	SDP                string               `json:"sdp,omitempty"`
	Candidate          string               `json:"candidate,omitempty"`
	SDPMid             *string              `json:"sdp_mid,omitempty"`
	SDPMLineIndex      *uint16              `json:"sdp_mline_index,omitempty"`
	AudioEnabled       *bool                `json:"audio_enabled,omitempty"`
	VideoEnabled       *bool                `json:"video_enabled,omitempty"`
	VideoPaused        *bool                `json:"video_paused,omitempty"`
	HandRaised         *bool                `json:"hand_raised,omitempty"`
	HandOrder          int                  `json:"hand_order,omitempty"`
	MaxVideoBitrate    int                  `json:"max_video_bitrate,omitempty"`
	MaxVideoFPS        int                  `json:"max_video_fps,omitempty"`
	MaxAudioBitrate    int                  `json:"max_audio_bitrate,omitempty"`
	MaxVideoQuality    string               `json:"max_video_quality,omitempty"`
	ScreenShareEnabled *bool                `json:"screen_share_enabled,omitempty"`
	RetainChatHistory  *bool                `json:"retain_chat_history,omitempty"`
	RTTMs              int                  `json:"rtt_ms,omitempty"`
	PacketLoss10       int                  `json:"packet_loss10,omitempty"`
	JitterMs           int                  `json:"jitter_ms,omitempty"`
	VideoKbps          int                  `json:"video_kbps,omitempty"`
	AudioKbps          int                  `json:"audio_kbps,omitempty"`
	ScreenShareActive  *bool                `json:"screen_share_active,omitempty"`
	ScreenShareOwner   string               `json:"screen_share_owner,omitempty"`
	ChatText           string               `json:"text,omitempty"`
	Emoji              string               `json:"emoji,omitempty"`
	ChatHistory        []ChatHistoryEntry   `json:"chat_history,omitempty"`
}

func (m Message) Validate() error {
	if m.Version != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version %d", m.Version)
	}
	if len(m.MediaStreamID) > 128 {
		return fmt.Errorf("media_stream_id is too long")
	}
	switch m.Type {
	case TypeJoin:
		if m.Name == "" {
			return fmt.Errorf("name is required")
		}
		if len(m.ReconnectToken) > 128 {
			return fmt.Errorf("reconnect_token is too long")
		}
	case TypeLeave:
		if m.ParticipantID == "" {
			return fmt.Errorf("participant_id is required")
		}
	case TypeOffer, TypeAnswer:
		if m.SDP == "" {
			return fmt.Errorf("sdp is required")
		}
	case TypeCandidate:
		if m.Candidate == "" {
			return fmt.Errorf("candidate is required")
		}
	case TypeICERestart:
	case TypeMediaState:
		if m.ParticipantID == "" || (m.AudioEnabled == nil && m.VideoEnabled == nil) {
			return fmt.Errorf("media state requires participant_id and a state")
		}
	case TypeHandState:
		if m.ParticipantID == "" || m.HandRaised == nil {
			return fmt.Errorf("hand state requires participant_id and state")
		}
	case TypeNetworkState:
		if m.ParticipantID == "" {
			return fmt.Errorf("network state requires participant_id")
		}
		if m.RTTMs < -1 || m.PacketLoss10 < -1 || m.PacketLoss10 > 1000 ||
			m.JitterMs < -1 || m.VideoKbps < -1 || m.AudioKbps < -1 ||
			m.RTTMs > 120000 || m.JitterMs > 120000 {
			return fmt.Errorf("network state contains invalid values")
		}
	case TypeScreenShare:
		if m.ParticipantID == "" || m.ScreenShareActive == nil {
			return fmt.Errorf("screen share requires participant_id and state")
		}
	case TypeChat:
		text := strings.TrimSpace(m.ChatText)
		if m.ParticipantID == "" || text == "" {
			return fmt.Errorf("chat message requires participant_id and text")
		}
		if len([]rune(text)) > 500 {
			return fmt.Errorf("chat message is too long")
		}
	case TypeReaction:
		if m.ParticipantID == "" || m.Emoji == "" {
			return fmt.Errorf("reaction requires participant_id and emoji")
		}
		if _, ok := approvedReactionEmojis[m.Emoji]; !ok {
			return fmt.Errorf("unsupported reaction emoji")
		}
	default:
		return fmt.Errorf("unknown message type %q", m.Type)
	}
	return nil
}
