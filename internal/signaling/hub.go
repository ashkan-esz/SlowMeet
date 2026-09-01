package signaling

import (
	"log/slog"
	"net/http"
	"sync"

	"SlowMeet/internal/config"
	"SlowMeet/internal/media"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/webrtc"
	"github.com/gorilla/websocket"
	pion "github.com/pion/webrtc/v4"
)

type client struct {
	conn          *websocket.Conn
	writeMu       sync.Mutex
	participant   meeting.Participant
	peer          *webrtc.Peer
	negotiationMu sync.Mutex
}

type Hub struct {
	Meeting  *meeting.Meeting
	Config   config.Config
	Logger   *slog.Logger
	Upgrader websocket.Upgrader

	mu      sync.RWMutex
	clients map[*client]struct{}
	router  *media.Router
}

func NewHub(m *meeting.Meeting, cfg config.Config, logger *slog.Logger) *Hub {
	return &Hub{
		Meeting: m, Config: cfg, Logger: logger,
		Upgrader: websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }},
		clients:  make(map[*client]struct{}),
		router:   media.NewRouter(),
	}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := h.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := &client{conn: conn}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		conn.Close()
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		if c.participant.ID != "" && h.Meeting.Leave(c.participant.ID) {
			h.router.Unregister(c.participant.ID)
			if c.peer != nil {
				_ = c.peer.Close()
			}
			h.broadcast(Message{Version: ProtocolVersion, Type: TypeLeft, Participant: &c.participant})
			h.Logger.Info("participant_left", "participant_id", c.participant.ID, "name", c.participant.Name)
		}
	}()

	for {
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			return
		}
		if err := msg.Validate(); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			continue
		}
		if msg.Type != TypeJoin {
			if c.participant.ID != "" {
				h.handleWebRTCMessage(c, msg)
			}
			continue
		}
		if c.participant.ID != "" {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "already joined"})
			continue
		}
		if !h.Config.CheckMeetingPassword(msg.Password) {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "invalid meeting password"})
			continue
		}
		participant, err := h.Meeting.Join(msg.Name)
		if err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			continue
		}
		c.participant = participant
		c.peer, err = webrtc.NewPeer(h.Config.STUNServers)
		if err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "unable to initialize WebRTC"})
			return
		}
		c.peer.OnICECandidate(func(candidate pion.ICECandidateInit) {
			_ = c.write(Message{
				Version: ProtocolVersion, Type: TypeCandidate,
				Candidate: candidate.Candidate, SDPMid: candidate.SDPMid,
				SDPMLineIndex: candidate.SDPMLineIndex,
			})
		})
		c.peer.OnTrack(func(track *pion.TrackRemote) {
			h.router.Publish(c.participant.ID, track)
		})
		h.router.Register(participant.ID, c.peer, func() error {
			return h.sendOffer(c, false)
		})
		_ = c.write(Message{Version: ProtocolVersion, Type: TypeParticipant, Participant: &participant})
		for _, existing := range h.Meeting.List() {
			if existing.ID != participant.ID {
				_ = c.write(Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &existing})
			}
		}
		h.broadcastExcept(c, Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &participant})
		h.Logger.Info("participant_joined", "participant_id", participant.ID, "name", participant.Name)
	}
}

func (h *Hub) handleWebRTCMessage(c *client, msg Message) {
	switch msg.Type {
	case TypeOffer:
		if err := c.peer.SetRemoteOffer(msg.SDP); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		answer, err := c.peer.CreateAnswer()
		if err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		_ = c.write(Message{Version: ProtocolVersion, Type: TypeAnswer, SDP: answer})
	case TypeAnswer:
		if err := c.peer.SetRemoteAnswer(msg.SDP); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
	case TypeCandidate:
		if err := c.peer.AddICECandidate(msg.Candidate, msg.SDPMid, msg.SDPMLineIndex); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
	case TypeICERestart:
		if err := h.sendOffer(c, true); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
	}
}

func (h *Hub) sendOffer(c *client, iceRestart bool) error {
	c.negotiationMu.Lock()
	defer c.negotiationMu.Unlock()
	offer, err := c.peer.CreateOffer(iceRestart)
	if err != nil {
		return err
	}
	return c.write(Message{Version: ProtocolVersion, Type: TypeOffer, SDP: offer})
}

func (c *client) write(msg Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	return c.conn.WriteJSON(msg)
}

func (h *Hub) broadcast(msg Message) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		_ = c.write(msg)
	}
}

func (h *Hub) broadcastExcept(excluded *client, msg Message) {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for c := range h.clients {
		if c != excluded {
			_ = c.write(msg)
		}
	}
}
