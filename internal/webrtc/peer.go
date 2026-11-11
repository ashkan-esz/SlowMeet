package webrtc

import (
	"fmt"
	"net"
	"sync"

	ice "github.com/pion/ice/v4"
	"github.com/pion/interceptor"
	"github.com/pion/interceptor/pkg/nack"
	"github.com/pion/interceptor/pkg/report"
	"github.com/pion/interceptor/pkg/twcc"
	"github.com/pion/logging"
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
	var turnURLs []string
	if turnURL != "" {
		turnURLs = []string{turnURL}
	}
	return NewPeerWithTURNURLsAndPortRange(iceServers, turnURLs, username, password, portMin, portMax, false)
}

func NewPeerWithTURNURLsAndPortRange(iceServers, turnURLs []string, username, password string, portMin, portMax int, ipv4Only bool) (*Peer, error) {
	return NewPeerWithTURNURLsAndPortRangeAndPolicy(iceServers, turnURLs, username, password, portMin, portMax, ipv4Only, "all")
}

func NewPeerWithTURNURLsAndPortRangeAndPolicy(iceServers, turnURLs []string, username, password string, portMin, portMax int, ipv4Only bool, transportPolicy string) (*Peer, error) {
	return NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(
		iceServers, turnURLs, username, password, portMin, portMax, ipv4Only, transportPolicy, "",
	)
}

func NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(iceServers, turnURLs []string, username, password string, portMin, portMax int, ipv4Only bool, transportPolicy, publicIP string) (*Peer, error) {
	configuration := pion.Configuration{}
	switch transportPolicy {
	case "", "all":
		configuration.ICETransportPolicy = pion.ICETransportPolicyAll
	case "relay":
		configuration.ICETransportPolicy = pion.ICETransportPolicyRelay
	default:
		return nil, fmt.Errorf("ICE transport policy must be all or relay")
	}
	for _, server := range iceServers {
		configuration.ICEServers = append(configuration.ICEServers, pion.ICEServer{URLs: []string{server}})
	}
	if len(turnURLs) > 0 {
		configuration.ICEServers = append(configuration.ICEServers, pion.ICEServer{
			URLs:       append([]string(nil), turnURLs...),
			Username:   username,
			Credential: password,
		})
	}
	return newPeerWithPortRange(configuration, portMin, portMax, ipv4Only, publicIP)
}

func NewPeerWithConfiguration(configuration pion.Configuration) (*Peer, error) {
	return NewPeerWithPortRange(configuration, 0, 0)
}

func NewPeerWithPortRange(configuration pion.Configuration, portMin, portMax int) (*Peer, error) {
	return newPeerWithPortRange(configuration, portMin, portMax, false, "")
}

// newMediaEngineAndRegistry replicates pion's RegisterDefaultInterceptors
// (webrtc/v4@v4.2.23 interceptor.go:33-74, including its logger wiring and
// the default logger fallback of api.go:40-42) minus the stats interceptor
// (interceptor.go:69). The recorder data the stats interceptor collects is
// consumed only by PeerConnection.GetStats, which nothing in this application
// calls (the SR/RR report interceptors keep their own per-stream state), while
// it adds a full rtp.Header clone plus a mutex critical section to every
// outgoing packet, mutex-and-counter work to every inbound packet, and an
// O(streams) walk under a shared mutex to every RTCP batch. The skipped step
// touches no MediaEngine state, so codecs, header extensions, and feedback
// negotiation are unchanged; TestCustomRegistrySDPMatchesDefault pins the
// negotiated SDP against a default-construction peer. Re-verify this recipe
// against interceptor.go if the pion version is ever bumped.
func newMediaEngineAndRegistry(settingEngine *pion.SettingEngine) (*pion.MediaEngine, *interceptor.Registry, error) {
	loggerFactory := settingEngine.LoggerFactory
	if loggerFactory == nil {
		loggerFactory = logging.NewDefaultLoggerFactory()
	}
	mediaEngine := &pion.MediaEngine{}
	if err := mediaEngine.RegisterDefaultCodecs(); err != nil {
		return nil, nil, err
	}
	registry := &interceptor.Registry{}
	if err := pion.ConfigureNackWithOptions(mediaEngine, registry,
		[]nack.GeneratorOption{nack.WithGeneratorLoggerFactory(loggerFactory)},
		nack.WithResponderLoggerFactory(loggerFactory)); err != nil {
		return nil, nil, err
	}
	if err := pion.ConfigureRTCPReportsWithOptions(registry,
		[]report.ReceiverOption{report.WithReceiverLoggerFactory(loggerFactory)},
		report.WithSenderLoggerFactory(loggerFactory)); err != nil {
		return nil, nil, err
	}
	if err := pion.ConfigureSimulcastExtensionHeaders(mediaEngine); err != nil {
		return nil, nil, err
	}
	if err := pion.ConfigureTWCCSenderWithOptions(mediaEngine, registry,
		twcc.WithLoggerFactory(loggerFactory)); err != nil {
		return nil, nil, err
	}
	return mediaEngine, registry, nil
}

func newPeerWithPortRange(configuration pion.Configuration, portMin, portMax int, ipv4Only bool, publicIP string) (*Peer, error) {
	settingEngine := pion.SettingEngine{}
	if portMin != 0 || portMax != 0 {
		if portMin < 1 || portMin > 65535 || portMax < 1 || portMax > 65535 || portMin > portMax {
			return nil, fmt.Errorf("ICE UDP port range must be between 1 and 65535 with minimum <= maximum")
		}
		if err := settingEngine.SetEphemeralUDPPortRange(uint16(portMin), uint16(portMax)); err != nil {
			return nil, fmt.Errorf("configure ICE UDP port range: %w", err)
		}
	}
	if ipv4Only {
		settingEngine.SetNetworkTypes([]pion.NetworkType{pion.NetworkTypeUDP4})
	}
	if publicIP != "" {
		publicAddress := net.ParseIP(publicIP)
		if publicAddress == nil {
			return nil, fmt.Errorf("ICE public IP must be a valid IP address")
		}
		settingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
		settingEngine.SetNAT1To1IPs([]string{publicIP}, pion.ICECandidateTypeHost)
		if publicAddress.IsLoopback() {
			settingEngine.SetIncludeLoopbackCandidate(true)
			settingEngine.SetIPFilter(func(candidateIP net.IP) bool {
				return candidateIP.IsLoopback()
			})
		}
	}
	mediaEngine, registry, err := newMediaEngineAndRegistry(&settingEngine)
	if err != nil {
		return nil, fmt.Errorf("configure media engine and interceptors: %w", err)
	}
	api := pion.NewAPI(pion.WithSettingEngine(settingEngine),
		pion.WithMediaEngine(mediaEngine), pion.WithInterceptorRegistry(registry))
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

func (p *Peer) RemoveTrack(sender *pion.RTPSender) error {
	if sender == nil || p == nil || p.connection == nil {
		return nil
	}
	if err := p.connection.RemoveTrack(sender); err != nil {
		return fmt.Errorf("remove track: %w", err)
	}
	return nil
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
