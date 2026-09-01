package webrtc

import (
	"fmt"
	"sync"

	pion "github.com/pion/webrtc/v4"
)

type Peer struct {
	connection *pion.PeerConnection
	closeOnce  sync.Once
}

func NewPeer(iceServers []string) (*Peer, error) {
	configuration := pion.Configuration{}
	for _, server := range iceServers {
		configuration.ICEServers = append(configuration.ICEServers, pion.ICEServer{URLs: []string{server}})
	}
	connection, err := pion.NewPeerConnection(configuration)
	if err != nil {
		return nil, fmt.Errorf("create peer connection: %w", err)
	}
	return &Peer{connection: connection}, nil
}

func (p *Peer) Connection() *pion.PeerConnection {
	return p.connection
}

func (p *Peer) SetRemoteOffer(sdp string) error {
	return p.connection.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeOffer,
		SDP:  sdp,
	})
}

func (p *Peer) CreateAnswer() (string, error) {
	answer, err := p.connection.CreateAnswer(nil)
	if err != nil {
		return "", fmt.Errorf("create answer: %w", err)
	}
	if err := p.connection.SetLocalDescription(answer); err != nil {
		return "", fmt.Errorf("set local description: %w", err)
	}
	return answer.SDP, nil
}

func (p *Peer) SetRemoteAnswer(sdp string) error {
	return p.connection.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeAnswer,
		SDP:  sdp,
	})
}

func (p *Peer) CreateOffer(iceRestart bool) (string, error) {
	offer, err := p.connection.CreateOffer(&pion.OfferOptions{ICERestart: iceRestart})
	if err != nil {
		return "", fmt.Errorf("create offer: %w", err)
	}
	if err := p.connection.SetLocalDescription(offer); err != nil {
		return "", fmt.Errorf("set local description: %w", err)
	}
	return offer.SDP, nil
}

func (p *Peer) AddTrack(track pion.TrackLocal) error {
	if _, err := p.connection.AddTrack(track); err != nil {
		return fmt.Errorf("add track: %w", err)
	}
	return nil
}

func (p *Peer) OnTrack(handler func(*pion.TrackRemote)) {
	p.connection.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		handler(track)
	})
}

func (p *Peer) AddICECandidate(candidate string, mid *string, mlineIndex *uint16) error {
	return p.connection.AddICECandidate(pion.ICECandidateInit{
		Candidate:     candidate,
		SDPMid:        mid,
		SDPMLineIndex: mlineIndex,
	})
}

func (p *Peer) OnICECandidate(handler func(pion.ICECandidateInit)) {
	p.connection.OnICECandidate(func(candidate *pion.ICECandidate) {
		if candidate != nil {
			handler(candidate.ToJSON())
		}
	})
}

func (p *Peer) Close() error {
	var err error
	p.closeOnce.Do(func() { err = p.connection.Close() })
	return err
}
