package signaling

import (
	"fmt"

	"SlowMeet/internal/meeting"
)

const (
	ProtocolVersion = 1
	TypeJoin        = "join"
	TypeLeave       = "leave"
	TypeParticipant = "participant"
	TypeJoined      = "participant_joined"
	TypeLeft        = "participant_left"
	TypeOffer       = "offer"
	TypeAnswer      = "answer"
	TypeCandidate   = "candidate"
	TypeICERestart  = "ice_restart"
	TypeError       = "error"
)

type Message struct {
	Version       int                  `json:"version"`
	Type          string               `json:"type"`
	Name          string               `json:"name,omitempty"`
	Password      string               `json:"password,omitempty"`
	ParticipantID string               `json:"participant_id,omitempty"`
	Error         string               `json:"error,omitempty"`
	Participant   *meeting.Participant `json:"participant,omitempty"`
	TargetID      string               `json:"target_id,omitempty"`
	SDP           string               `json:"sdp,omitempty"`
	Candidate     string               `json:"candidate,omitempty"`
	SDPMid        *string              `json:"sdp_mid,omitempty"`
	SDPMLineIndex *uint16              `json:"sdp_mline_index,omitempty"`
}

func (m Message) Validate() error {
	if m.Version != ProtocolVersion {
		return fmt.Errorf("unsupported protocol version %d", m.Version)
	}
	switch m.Type {
	case TypeJoin:
		if m.Name == "" {
			return fmt.Errorf("name is required")
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
	default:
		return fmt.Errorf("unknown message type %q", m.Type)
	}
	return nil
}
