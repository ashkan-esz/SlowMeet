package webrtc

import (
	"fmt"
	"sync"

	"github.com/pion/rtcp"
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
	return NewPeerWithConfiguration(configuration)
}

func NewPeerWithTURN(iceServers []string, turnURL, username, password string) (*Peer, error) {
	return NewPeerWithTURNAndPortRange(iceServers, turnURL, username, password, 0, 0)
}

func NewPeerWithTURNAndPortRange(iceServers []string, turnURL, username, password string, portMin, portMax int) (*Peer, error) {
	configuration := pion.Configuration{}
	for _, server := range iceServers {
		configuration.ICEServers = append(configuration.ICEServers, pion.ICEServer{URLs: []string{server}})
	}
	if turnURL != "" {
		configuration.ICEServers = append(configuration.ICEServers, pion.ICEServer{
			URLs:       []string{turnURL},
			Username:   username,
			Credential: password,
		})
	}
	return NewPeerWithPortRange(configuration, portMin, portMax)
}

func NewPeerWithConfiguration(configuration pion.Configuration) (*Peer, error) {
	return NewPeerWithPortRange(configuration, 0, 0)
}

func NewPeerWithPortRange(configuration pion.Configuration, portMin, portMax int) (*Peer, error) {
	settingEngine := pion.SettingEngine{}
	if portMin != 0 || portMax != 0 {
		if portMin < 1 || portMin > 65535 || portMax < 1 || portMax > 65535 || portMin > portMax {
			return nil, fmt.Errorf("ICE UDP port range must be between 1 and 65535 with minimum <= maximum")
		}
		if err := settingEngine.SetEphemeralUDPPortRange(uint16(portMin), uint16(portMax)); err != nil {
			return nil, fmt.Errorf("configure ICE UDP port range: %w", err)
		}
	}
	api := pion.NewAPI(pion.WithSettingEngine(settingEngine))
	connection, err := api.NewPeerConnection(configuration)
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

func (p *Peer) AddTrack(track pion.TrackLocal) (*pion.RTPSender, error) {
	sender, err := p.connection.AddTrack(track)
	if err != nil {
		return nil, fmt.Errorf("add track: %w", err)
	}
	return sender, nil
}

func (p *Peer) WriteRTCP(packets []rtcp.Packet) error {
	return p.connection.WriteRTCP(packets)
}

func (p *Peer) OnTrack(handler func(*pion.TrackRemote, *pion.RTPReceiver)) {
	p.connection.OnTrack(func(track *pion.TrackRemote, receiver *pion.RTPReceiver) {
		handler(track, receiver)
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

func (p *Peer) OnICEConnectionStateChange(handler func(pion.ICEConnectionState)) {
	p.connection.OnICEConnectionStateChange(handler)
}

func (p *Peer) Close() error {
	var err error
	p.closeOnce.Do(func() { err = p.connection.Close() })
	return err
}
