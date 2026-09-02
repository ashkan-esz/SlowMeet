package signaling

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sync"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/media"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/metrics"
	"SlowMeet/internal/webrtc"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	pion "github.com/pion/webrtc/v4"
)

const (
	websocketPongWait   = 60 * time.Second
	websocketPingPeriod = (websocketPongWait * 9) / 10
	websocketWriteWait  = 10 * time.Second
)

type client struct {
	conn              *websocket.Conn
	writeMu           sync.Mutex
	participant       meeting.Participant
	reconnectToken    string
	intentionalLeave  bool
	peer              *webrtc.Peer
	negotiationMu     sync.Mutex
	offerInFlight     bool
	pendingOffer      bool
	pendingICERestart bool
}

type pendingReconnect struct {
	participant meeting.Participant
	token       string
	timer       *time.Timer
}

type Hub struct {
	Meeting  *meeting.Meeting
	Config   *config.Store
	Logger   *slog.Logger
	Upgrader websocket.Upgrader

	mu           sync.RWMutex
	clients      map[*client]struct{}
	router       *media.Router
	pending      map[string]*pendingReconnect
	metrics      *metrics.Metrics
	screenSharer *client
	closed       bool
}

func (h *Hub) ActiveParticipants() int {
	return h.Meeting.Count()
}

func (h *Hub) Metrics() *metrics.Metrics {
	return h.metrics
}

func (h *Hub) Close() {
	h.mu.Lock()
	h.closed = true
	pending := make([]*pendingReconnect, 0, len(h.pending))
	for token, reconnect := range h.pending {
		delete(h.pending, token)
		pending = append(pending, reconnect)
	}
	h.mu.Unlock()
	for _, reconnect := range pending {
		if reconnect.timer != nil {
			reconnect.timer.Stop()
		}
		_ = h.Meeting.Leave(reconnect.participant.ID)
	}
	h.mu.RLock()
	connections := make([]*websocket.Conn, 0, len(h.clients))
	for client := range h.clients {
		connections = append(connections, client.conn)
	}
	h.mu.RUnlock()
	for _, conn := range connections {
		_ = conn.Close()
	}
}

func (h *Hub) BroadcastConfig(cfg config.Config) {
	screenShareEnabled := cfg.EnableScreenShare
	releasedScreenShare := false
	h.mu.Lock()
	if !cfg.EnableScreenShare && h.screenSharer != nil {
		h.screenSharer = nil
		releasedScreenShare = true
	}
	h.mu.Unlock()
	h.router.SetLimits(media.Limits{
		MaxAudioBitrate: cfg.MaxAudioBitrate,
		MaxVideoBitrate: cfg.MaxVideoBitrate,
		MaxVideoFPS:     cfg.MaxVideoFPS,
	})
	h.broadcast(Message{
		Version: ProtocolVersion, Type: TypeConfigUpdate,
		MaxVideoBitrate: cfg.MaxVideoBitrate, MaxVideoFPS: cfg.MaxVideoFPS,
		MaxAudioBitrate: cfg.MaxAudioBitrate, MaxVideoQuality: cfg.EffectiveMaxVideoQuality(),
		ScreenShareEnabled: &screenShareEnabled,
	})
	if releasedScreenShare {
		h.broadcast(h.screenShareMessage(false, ""))
	}
}

func NewHub(m *meeting.Meeting, cfg *config.Store, logger *slog.Logger) *Hub {
	snapshot := cfg.Snapshot()
	return &Hub{
		Meeting: m, Config: cfg, Logger: logger,
		Upgrader: websocket.Upgrader{CheckOrigin: sameOrigin},
		clients:  make(map[*client]struct{}),
		pending:  make(map[string]*pendingReconnect),
		metrics:  &metrics.Metrics{},
		router: media.NewRouter(media.Limits{
			MaxAudioBitrate: snapshot.MaxAudioBitrate,
			MaxVideoBitrate: snapshot.MaxVideoBitrate,
			MaxVideoFPS:     snapshot.MaxVideoFPS,
		}),
	}
}

func (h *Hub) disconnect(c *client) {
	if c.participant.ID == "" {
		return
	}
	h.router.Unregister(c.participant.ID)
	if c.peer != nil {
		_ = c.peer.Close()
	}
	h.metrics.PeerLeft()
	h.releaseScreenShare(c)
	h.mu.RLock()
	closed := h.closed
	h.mu.RUnlock()
	if c.intentionalLeave || closed {
		h.removeParticipant(c.participant)
		return
	}
	h.deferReconnect(c.participant, c.reconnectToken)
	h.Logger.Info("participant_disconnected", "participant_id", c.participant.ID, "name", c.participant.Name)
}

func (h *Hub) screenShareMessage(active bool, owner string) Message {
	return Message{
		Version: ProtocolVersion, Type: TypeScreenState,
		ParticipantID: owner, ScreenShareOwner: owner,
		ScreenShareActive: &active,
	}
}

func (h *Hub) requestScreenShare(c *client, active bool) error {
	cfg := h.Config.Snapshot()
	if active && !cfg.EnableScreenShare {
		return fmt.Errorf("screen sharing is disabled")
	}
	h.mu.Lock()
	if active {
		if h.screenSharer != nil && h.screenSharer != c {
			h.mu.Unlock()
			return fmt.Errorf("screen sharing is already active")
		}
		h.screenSharer = c
	} else if h.screenSharer == c {
		h.screenSharer = nil
	}
	owner := ""
	if h.screenSharer != nil {
		owner = h.screenSharer.participant.ID
	}
	h.mu.Unlock()
	h.broadcast(h.screenShareMessage(owner != "", owner))
	return nil
}

func (h *Hub) releaseScreenShare(c *client) {
	h.mu.Lock()
	if h.screenSharer != c {
		h.mu.Unlock()
		return
	}
	h.screenSharer = nil
	h.mu.Unlock()
	active := false
	h.broadcast(h.screenShareMessage(active, ""))
}

func (h *Hub) deferReconnect(participant meeting.Participant, token string) {
	if token == "" {
		h.removeParticipant(participant)
		return
	}
	timeout := h.Config.Snapshot().ReconnectTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	pending := &pendingReconnect{participant: participant, token: token}
	timer := time.NewTimer(timeout)
	pending.timer = timer
	h.mu.Lock()
	h.pending[token] = pending
	clients := make([]*client, 0, len(h.clients))
	for client := range h.clients {
		if client.participant.ID != "" && client.participant.ID != participant.ID {
			clients = append(clients, client)
		}
	}
	h.mu.Unlock()
	for _, client := range clients {
		_ = client.write(Message{Version: ProtocolVersion, Type: TypeLeft, Participant: &participant})
	}
	go func() {
		<-timer.C
		h.mu.Lock()
		current, exists := h.pending[token]
		if exists && current == pending {
			delete(h.pending, token)
		}
		h.mu.Unlock()
		if exists && current == pending {
			_ = h.Meeting.Leave(participant.ID)
			h.Logger.Info("participant_reconnect_expired", "participant_id", participant.ID)
		}
	}()
}

func (h *Hub) reclaim(token string) (meeting.Participant, bool) {
	if token == "" {
		return meeting.Participant{}, false
	}
	h.mu.Lock()
	pending, exists := h.pending[token]
	if exists {
		delete(h.pending, token)
	}
	h.mu.Unlock()
	if !exists {
		return meeting.Participant{}, false
	}
	if pending.timer != nil {
		pending.timer.Stop()
	}
	return pending.participant, true
}

func (h *Hub) isPendingParticipant(id string) bool {
	h.mu.RLock()
	defer h.mu.RUnlock()
	for _, pending := range h.pending {
		if pending.participant.ID == id {
			return true
		}
	}
	return false
}

func (h *Hub) removeParticipant(participant meeting.Participant) {
	if h.Meeting.Leave(participant.ID) {
		h.broadcast(Message{Version: ProtocolVersion, Type: TypeLeft, Participant: &participant})
		h.Logger.Info("participant_left", "participant_id", participant.ID, "name", participant.Name)
	}
}

func sameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	return err == nil && parsed.Host == r.Host
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	conn, err := h.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(16 * 1024)
	conn.SetReadDeadline(time.Now().Add(websocketPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(websocketPongWait))
	})
	c := &client{conn: conn}
	done := make(chan struct{})
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		close(done)
		conn.Close()
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
		h.disconnect(c)
	}()
	go func() {
		ticker := time.NewTicker(websocketPingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				_ = conn.WriteControl(
					websocket.PingMessage,
					nil,
					time.Now().Add(5*time.Second),
				)
			case <-done:
				return
			}
		}
	}()

	for {
		var msg Message
		if err := readMessage(conn, &msg); err != nil {
			return
		}
		if err := msg.Validate(); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			continue
		}
		if msg.Type != TypeJoin {
			if c.participant.ID == "" {
				_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "join is required before this message"})
				continue
			}
			if msg.Type == TypeLeave {
				if msg.ParticipantID != c.participant.ID {
					_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "participant_id does not belong to this connection"})
					continue
				}
				c.intentionalLeave = true
				return
			}
			if msg.Type == TypeMediaState {
				msg.ParticipantID = c.participant.ID
				h.broadcastExcept(c, msg)
				continue
			}
			if msg.Type == TypeNetworkState {
				msg.ParticipantID = c.participant.ID
				h.metrics.ObserveNetwork(msg.RTTMs, msg.PacketLoss10, msg.JitterMs, msg.VideoKbps, msg.AudioKbps)
				continue
			}
			if msg.Type == TypeScreenShare {
				msg.ParticipantID = c.participant.ID
				if err := h.requestScreenShare(c, *msg.ScreenShareActive); err != nil {
					_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
				}
				continue
			}
			h.handleWebRTCMessage(c, msg)
			continue
		}
		if c.participant.ID != "" {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "already joined"})
			continue
		}
		cfg := h.Config.Snapshot()
		if !cfg.CheckMeetingPassword(msg.Password) {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "invalid meeting password"})
			continue
		}
		participant, resumed := h.reclaim(msg.ReconnectToken)
		var err error
		if !resumed {
			participant, err = h.Meeting.Join(msg.Name)
			if err != nil {
				_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
				continue
			}
		}
		c.participant = participant
		c.reconnectToken = msg.ReconnectToken
		if !resumed {
			c.reconnectToken = uuid.NewString()
		}
		c.peer, err = webrtc.NewPeerWithTURN(cfg.STUNServers, cfg.TURNURL, cfg.TURNUsername, cfg.TURNPassword)
		if err != nil {
			if resumed {
				h.deferReconnect(participant, c.reconnectToken)
			} else {
				_ = h.Meeting.Leave(participant.ID)
			}
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
		c.peer.OnICEConnectionStateChange(func(state pion.ICEConnectionState) {
			event := "webrtc_state_changed"
			switch state {
			case pion.ICEConnectionStateConnected, pion.ICEConnectionStateCompleted:
				event = "webrtc_connected"
			case pion.ICEConnectionStateDisconnected:
				event = "network_degraded"
			case pion.ICEConnectionStateFailed:
				event = "webrtc_failed"
				h.metrics.ConnectionFailed()
			}
			h.Logger.Info(event, "participant_id", participant.ID, "ice_state", state.String())
		})
		c.peer.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
			h.router.Publish(c.participant.ID, c.peer, track)
		})
		h.router.Register(participant.ID, c.peer, func() error {
			return h.sendOffer(c, false)
		})
		_ = c.write(Message{Version: ProtocolVersion, Type: TypeParticipant, Participant: &participant, ReconnectToken: c.reconnectToken})
		for _, existing := range h.Meeting.List() {
			if existing.ID != participant.ID && !h.isPendingParticipant(existing.ID) {
				_ = c.write(Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &existing})
			}
		}
		h.mu.RLock()
		screenOwner := ""
		if h.screenSharer != nil {
			screenOwner = h.screenSharer.participant.ID
		}
		h.mu.RUnlock()
		if screenOwner != "" {
			_ = c.write(h.screenShareMessage(true, screenOwner))
		}
		h.broadcastExcept(c, Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &participant})
		h.Logger.Info("participant_joined", "participant_id", participant.ID, "name", participant.Name)
		h.metrics.PeerJoined()
		if resumed {
			h.metrics.Reconnected()
		}
	}
}

func readMessage(conn *websocket.Conn, message *Message) error {
	messageType, payload, err := conn.ReadMessage()
	if err != nil {
		return err
	}
	if messageType != websocket.TextMessage {
		return fmt.Errorf("signaling messages must be text")
	}
	return decodeMessage(payload, message)
}

func decodeMessage(payload []byte, message *Message) error {
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(message); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		if err == nil {
			return fmt.Errorf("signaling message must contain one JSON object")
		}
		return err
	}
	return nil
}

func (h *Hub) handleWebRTCMessage(c *client, msg Message) {
	switch msg.Type {
	case TypeOffer:
		c.negotiationMu.Lock()
		if c.offerInFlight {
			// The server is the impolite offerer. The browser's polite
			// negotiation path rolls back its colliding offer and answers
			// this server offer instead.
			c.negotiationMu.Unlock()
			return
		}
		if err := c.peer.SetRemoteOffer(msg.SDP); err != nil {
			c.negotiationMu.Unlock()
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		answer, err := c.peer.CreateAnswer()
		if err != nil {
			c.negotiationMu.Unlock()
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		c.negotiationMu.Unlock()
		_ = c.write(Message{Version: ProtocolVersion, Type: TypeAnswer, SDP: answer})
	case TypeAnswer:
		c.negotiationMu.Lock()
		if !c.offerInFlight {
			c.negotiationMu.Unlock()
			return
		}
		err := c.peer.SetRemoteAnswer(msg.SDP)
		shouldOffer := c.offerInFlight && c.pendingOffer
		iceRestart := c.pendingICERestart
		c.offerInFlight = false
		c.pendingOffer = false
		c.pendingICERestart = false
		c.negotiationMu.Unlock()
		if err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
		if shouldOffer {
			_ = h.sendOffer(c, iceRestart)
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
	if c.offerInFlight {
		c.pendingOffer = true
		c.pendingICERestart = c.pendingICERestart || iceRestart
		c.negotiationMu.Unlock()
		return nil
	}
	c.offerInFlight = true
	offer, err := c.peer.CreateOffer(iceRestart)
	if err != nil {
		c.offerInFlight = false
		c.negotiationMu.Unlock()
		return err
	}
	err = c.write(Message{Version: ProtocolVersion, Type: TypeOffer, SDP: offer})
	if err != nil {
		c.offerInFlight = false
	}
	c.negotiationMu.Unlock()
	return err
}

func (c *client) write(msg Message) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	if err := c.conn.SetWriteDeadline(time.Now().Add(websocketWriteWait)); err != nil {
		return err
	}
	defer c.conn.SetWriteDeadline(time.Time{})
	return c.conn.WriteJSON(msg)
}

func (h *Hub) broadcast(msg Message) {
	h.mu.RLock()
	clients := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		clients = append(clients, c)
	}
	h.mu.RUnlock()
	for _, c := range clients {
		_ = c.write(msg)
	}
}

func (h *Hub) broadcastExcept(excluded *client, msg Message) {
	h.mu.RLock()
	clients := make([]*client, 0, len(h.clients))
	for c := range h.clients {
		if c != excluded {
			clients = append(clients, c)
		}
	}
	h.mu.RUnlock()
	for _, c := range clients {
		_ = c.write(msg)
	}
}
