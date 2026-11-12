package signaling

import (
	"encoding/json"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"SlowMeet/internal/meeting"
)

type ChatHistoryEntry struct {
	ID            string    `json:"id"`
	ParticipantID string    `json:"participant_id,omitempty"`
	Author        string    `json:"author"`
	Text          string    `json:"text"`
	Timestamp     time.Time `json:"timestamp"`
}

const (
	ProtocolVersion        = 1
	TypeJoin               = "join"
	TypeLeave              = "leave"
	TypeParticipant        = "participant"
	TypeJoined             = "participant_joined"
	TypeLeft               = "participant_left"
	TypeOffer              = "offer"
	TypeAnswer             = "answer"
	TypeCandidate          = "candidate"
	TypeICERestart         = "ice_restart"
	TypeMediaState         = "media_state"
	TypeHandState          = "hand_state"
	TypeNetworkState       = "network_state"
	TypeVideoSubscriptions = "set_video_subscriptions"
	TypeScreenShare        = "screen_share"
	TypeScreenState        = "screen_share_state"
	TypeConfigUpdate       = "config_update"
	TypeChat               = "chat_message"
	TypeReaction           = "emoji_reaction"
	TypeRoomFull           = "room_full"
	TypeError              = "error"
	MaxCameraSubscriptions = 64
	maxReportedVideoKbps   = 25_000
	maxReportedAudioKbps   = 1_024
)

var approvedReactionEmojis = map[string]struct{}{
	"👍": {}, "👎": {}, "❤️": {}, "😂": {}, "🎉": {}, "😮": {},
	"👏": {}, "🙌": {}, "🔥": {}, "💯": {}, "😢": {}, "🤔": {},
}

type Message struct {
	Version              int                  `json:"version"`
	Type                 string               `json:"type"`
	Name                 string               `json:"name,omitempty"`
	Password             string               `json:"password,omitempty"`
	ReconnectToken       string               `json:"reconnect_token,omitempty"`
	ParticipantID        string               `json:"participant_id,omitempty"`
	CameraParticipantIDs []string             `json:"camera_participant_ids,omitempty"`
	CameraLayer          string               `json:"camera_layer,omitempty"`
	MediaStreamID        string               `json:"media_stream_id,omitempty"`
	MediaTrackID         string               `json:"media_track_id,omitempty"`
	Error                string               `json:"error,omitempty"`
	Participant          *meeting.Participant `json:"participant,omitempty"`
	TargetID             string               `json:"target_id,omitempty"`
	SDP                  string               `json:"sdp,omitempty"`
	Candidate            string               `json:"candidate,omitempty"`
	SDPMid               *string              `json:"sdp_mid,omitempty"`
	SDPMLineIndex        *uint16              `json:"sdp_mline_index,omitempty"`
	AudioEnabled         *bool                `json:"audio_enabled,omitempty"`
	VideoEnabled         *bool                `json:"video_enabled,omitempty"`
	VideoPaused          *bool                `json:"video_paused,omitempty"`
	HandRaised           *bool                `json:"hand_raised,omitempty"`
	HandOrder            int                  `json:"hand_order,omitempty"`
	MaxVideoBitrate      int                  `json:"max_video_bitrate,omitempty"`
	MaxVideoFPS          int                  `json:"max_video_fps,omitempty"`
	MaxAudioBitrate      int                  `json:"max_audio_bitrate,omitempty"`
	MaxVideoQuality      string               `json:"max_video_quality,omitempty"`
	ScreenShareEnabled   *bool                `json:"screen_share_enabled,omitempty"`
	RetainChatHistory    *bool                `json:"retain_chat_history,omitempty"`
	RTTMs                int                  `json:"rtt_ms,omitempty"`
	PacketLoss10         int                  `json:"packet_loss10,omitempty"`
	JitterMs             int                  `json:"jitter_ms,omitempty"`
	VideoKbps            int                  `json:"video_kbps,omitempty"`
	AudioKbps            int                  `json:"audio_kbps,omitempty"`
	ScreenShareActive    *bool                `json:"screen_share_active,omitempty"`
	ScreenShareOwner     string               `json:"screen_share_owner,omitempty"`
	ChatText             string               `json:"text,omitempty"`
	Emoji                string               `json:"emoji,omitempty"`
	ChatHistory          []ChatHistoryEntry   `json:"chat_history,omitempty"`

	// flush is an internal sentinel that is never serialized: the writer
	// goroutine closes it after every queued message before it has been
	// written, so senders can wait for the outbound queue to drain.
	flush chan struct{}

	// raw caches a pre-serialized form of the message so a broadcast to many
	// clients encodes it once instead of once per writer goroutine. It is
	// never serialized (unexported) and safe to share between writers because
	// WriteMessage copies the payload onto the wire before returning.
	raw []byte
}

// prepare serializes the message once so fan-out to many clients shares the
// encoded bytes instead of each writer goroutine re-marshaling the full
// struct. Safe to call on every broadcast: the second call is a no-op.
func (m *Message) prepare() {
	if m.raw == nil {
		m.raw, _ = json.Marshal(m)
	}
}

func (m Message) Validate() error {
	if m.Version != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version %d", m.Version)
	}
	if len(m.MediaStreamID) > 128 {
		return fmt.Errorf("media_stream_id is too long")
	}
	if len(m.MediaTrackID) > 128 {
		return fmt.Errorf("media_track_id is too long")
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
		// Browsers signal end-of-candidates with an empty candidate string and
		// the associated media section. Keep rejecting messages with neither a
		// candidate nor an m-line selector.
		if m.Candidate == "" && m.SDPMid == nil && m.SDPMLineIndex == nil {
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
			m.RTTMs > 120000 || m.JitterMs > 120000 ||
			m.VideoKbps > maxReportedVideoKbps || m.AudioKbps > maxReportedAudioKbps {
			return fmt.Errorf("network state contains invalid values")
		}
	case TypeVideoSubscriptions:
		if m.CameraLayer != "" && m.CameraLayer != "low" && m.CameraLayer != "medium" && m.CameraLayer != "high" {
			return fmt.Errorf("camera_layer must be low, medium, or high")
		}
		if len(m.CameraParticipantIDs) > MaxCameraSubscriptions {
			return fmt.Errorf("too many camera subscriptions")
		}
		for _, participantID := range m.CameraParticipantIDs {
			if strings.TrimSpace(participantID) == "" || len(participantID) > 128 {
				return fmt.Errorf("camera subscription participant_id is invalid")
			}
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
		if utf8.RuneCountInString(text) > 500 {
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
