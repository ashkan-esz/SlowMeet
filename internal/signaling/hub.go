package signaling

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"maps"
	"net/http"
	"net/url"
	"slices"
	"strings"
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
	maxJoinAttempts     = 5
	chatRoomID          = "default"
	chatHistoryLimit    = 100
	chatHistoryTTL      = 30 * time.Minute
	reactionBurstLimit  = 6
	reactionBurstWindow = 3 * time.Second
)

var chatHistoryExpiry = chatHistoryTTL

type roomChatHistory struct {
	messages []ChatHistoryEntry
	expiry   *time.Timer
}

type client struct {
	conn                      *websocket.Conn
	finished                  chan struct{}
	writeMu                   sync.Mutex
	participant               meeting.Participant
	participantID             string
	reconnectToken            string
	resumed                   bool
	joined                    bool
	intentionalLeave          bool
	joinAttempts              int
	peer                      *webrtc.Peer
	negotiationMu             sync.Mutex
	negotiationReady          bool
	remoteDescription         bool
	pendingCandidates         []Message
	offerInFlight             bool
	pendingOffer              bool
	pendingICERestart         bool
	activeScreenMediaStreamID string
	reactionWindowStart       time.Time
	reactionCount             int
}

type pendingReconnect struct {
	participant meeting.Participant
	token       string
	client      *client
	timer       *time.Timer
}

type Hub struct {
	Meeting  *meeting.Meeting
	Config   *config.Store
	Logger   *slog.Logger
	Upgrader websocket.Upgrader

	mu           sync.RWMutex
	clients      map[*client]struct{}
	roomMembers  map[*client]struct{}
	router       *media.Router
	pending      map[string]*pendingReconnect
	activeTokens map[string]*client
	mediaStates  map[string]Message
	metrics      *metrics.Metrics
	screenSharer *client
	chatHistory  map[string]*roomChatHistory
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
	for _, history := range h.chatHistory {
		if history.expiry != nil {
			history.expiry.Stop()
		}
	}
	h.chatHistory = make(map[string]*roomChatHistory)
	h.mediaStates = make(map[string]Message)
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
	retainChatHistory := cfg.RetainChatHistory
	releasedScreenShare := false
	var releasedScreenSharer *client
	h.mu.Lock()
	if !cfg.EnableScreenShare && h.screenSharer != nil {
		releasedScreenSharer = h.screenSharer
		releasedScreenSharer.activeScreenMediaStreamID = ""
		h.screenSharer = nil
		releasedScreenShare = true
	}
	h.mu.Unlock()
	h.router.SetLimits(media.Limits{
		MaxAudioBitrate: cfg.MaxAudioBitrate,
		MaxVideoBitrate: cfg.MaxVideoBitrate,
		MaxVideoFPS:     cfg.MaxVideoFPS,
	})
	if releasedScreenSharer != nil {
		h.router.Unpublish(releasedScreenSharer.participant.ID, media.SourceRoleScreen)
	}
	h.broadcast(Message{
		Version: ProtocolVersion, Type: TypeConfigUpdate,
		MaxVideoBitrate: cfg.MaxVideoBitrate, MaxVideoFPS: cfg.MaxVideoFPS,
		MaxAudioBitrate: cfg.MaxAudioBitrate, MaxVideoQuality: cfg.EffectiveMaxVideoQuality(),
		ScreenShareEnabled: &screenShareEnabled,
		RetainChatHistory:  &retainChatHistory,
	})
	if !cfg.RetainChatHistory {
		h.clearChatHistory()
	}
	if releasedScreenShare {
		h.broadcast(h.screenShareMessage(false, ""))
	}
}

func NewHub(m *meeting.Meeting, cfg *config.Store, logger *slog.Logger) *Hub {
	snapshot := cfg.Snapshot()
	return &Hub{
		Meeting: m, Config: cfg, Logger: logger,
		Upgrader:     websocket.Upgrader{CheckOrigin: sameOrigin},
		clients:      make(map[*client]struct{}),
		roomMembers:  make(map[*client]struct{}),
		pending:      make(map[string]*pendingReconnect),
		activeTokens: make(map[string]*client),
		mediaStates:  make(map[string]Message),
		chatHistory:  make(map[string]*roomChatHistory),
		metrics:      &metrics.Metrics{},
		router: media.NewRouter(media.Limits{
			MaxAudioBitrate: snapshot.MaxAudioBitrate,
			MaxVideoBitrate: snapshot.MaxVideoBitrate,
			MaxVideoFPS:     snapshot.MaxVideoFPS,
		}),
	}
}

func (h *Hub) clearChatHistory() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, history := range h.chatHistory {
		if history.expiry != nil {
			history.expiry.Stop()
		}
	}
	h.chatHistory = make(map[string]*roomChatHistory)
}

func (h *Hub) cancelChatHistoryExpiry(roomID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if history := h.chatHistory[roomID]; history != nil && history.expiry != nil {
		history.expiry.Stop()
		history.expiry = nil
	}
}

func (h *Hub) chatHistorySnapshot(roomID string) []ChatHistoryEntry {
	if !h.Config.Snapshot().RetainChatHistory {
		return nil
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	history := h.chatHistory[roomID]
	if history == nil || len(history.messages) == 0 {
		return nil
	}
	return append([]ChatHistoryEntry(nil), history.messages...)
}

func (h *Hub) recordChatMessage(roomID string, entry ChatHistoryEntry) {
	if !h.Config.Snapshot().RetainChatHistory {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	history := h.chatHistory[roomID]
	if history == nil {
		history = &roomChatHistory{}
		h.chatHistory[roomID] = history
	}
	if history.expiry != nil {
		history.expiry.Stop()
		history.expiry = nil
	}
	history.messages = append(history.messages, entry)
	if len(history.messages) > chatHistoryLimit {
		history.messages = history.messages[len(history.messages)-chatHistoryLimit:]
	}
}

func (h *Hub) scheduleChatHistoryExpiry(roomID string) {
	if !h.Config.Snapshot().RetainChatHistory || h.Meeting.Count() != 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	history := h.chatHistory[roomID]
	if history == nil {
		return
	}
	if history.expiry != nil {
		history.expiry.Stop()
	}
	history.expiry = time.AfterFunc(chatHistoryExpiry, func() {
		if h.Meeting.Count() != 0 {
			return
		}
		h.mu.Lock()
		delete(h.chatHistory, roomID)
		h.mu.Unlock()
	})
}

func (h *Hub) disconnect(c *client) {
	if c.participant.ID == "" {
		return
	}
	h.router.Unregister(c.participant.ID)
	if c.peer != nil {
		_ = c.peer.Close()
	}
	if c.joined {
		h.metrics.PeerLeft()
	}
	h.releaseScreenShare(c)

	h.mu.Lock()
	if c.reconnectToken != "" && h.activeTokens[c.reconnectToken] != c {
		h.mu.Unlock()
		return
	}
	if c.reconnectToken != "" {
		delete(h.activeTokens, c.reconnectToken)
	}
	if c.intentionalLeave || h.closed || c.reconnectToken == "" || (!c.joined && !c.resumed) {
		h.mu.Unlock()
		h.removeParticipant(c.participant)
		return
	}

	timeout := h.Config.Snapshot().ReconnectTimeout
	if timeout == 0 {
		timeout = 30 * time.Second
	}
	pending := &pendingReconnect{
		participant: c.participant,
		token:       c.reconnectToken,
		client:      c,
	}
	h.pending[c.reconnectToken] = pending
	clients := make([]*client, 0, len(h.clients))
	for client := range h.clients {
		if client.participant.ID != "" && client.participant.ID != c.participant.ID {
			clients = append(clients, client)
		}
	}
	h.mu.Unlock()

	for _, client := range clients {
		_ = client.write(Message{Version: ProtocolVersion, Type: TypeLeft, Participant: &c.participant})
	}
	h.mu.Lock()
	if h.pending[c.reconnectToken] == pending {
		pending.timer = time.AfterFunc(timeout, func() {
			h.mu.Lock()
			current, exists := h.pending[c.reconnectToken]
			if exists && current == pending {
				delete(h.pending, c.reconnectToken)
			}
			h.mu.Unlock()
			if exists && current == pending {
				_ = h.Meeting.Leave(c.participant.ID)
				h.forgetMediaState(c.participant.ID)
				h.scheduleChatHistoryExpiry(chatRoomID)
				h.Logger.Info("participant_reconnect_expired", "participant_id", c.participant.ID)
			}
		})
	}
	h.mu.Unlock()
	h.Logger.Info("participant_disconnected", "participant_id", c.participant.ID, "name", c.participant.Name)
}

func (h *Hub) screenShareMessage(active bool, owner string) Message {
	return Message{
		Version: ProtocolVersion, Type: TypeScreenState,
		ParticipantID: owner, ScreenShareOwner: owner,
		ScreenShareActive: &active,
	}
}

func (h *Hub) requestScreenShare(c *client, active bool, mediaStreamIDs ...string) error {
	mediaStreamID := ""
	if len(mediaStreamIDs) > 0 {
		mediaStreamID = mediaStreamIDs[0]
	}
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
		c.activeScreenMediaStreamID = mediaStreamID
	} else if h.screenSharer == c {
		h.screenSharer = nil
		c.activeScreenMediaStreamID = ""
	}
	owner := ""
	if h.screenSharer != nil {
		owner = h.screenSharer.participant.ID
	}
	h.mu.Unlock()
	if !active {
		h.router.Unpublish(c.participant.ID, media.SourceRoleScreen)
	}
	h.broadcast(h.screenShareMessage(owner != "", owner))
	return nil
}

func (h *Hub) screenShareStreamID(c *client) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.screenSharer != c {
		return ""
	}
	return c.activeScreenMediaStreamID
}

func (h *Hub) releaseScreenShare(c *client) {
	h.mu.Lock()
	if h.screenSharer != c {
		h.mu.Unlock()
		return
	}
	h.screenSharer = nil
	c.activeScreenMediaStreamID = ""
	h.mu.Unlock()
	h.router.Unpublish(c.participant.ID, media.SourceRoleScreen)
	active := false
	h.broadcast(h.screenShareMessage(active, ""))
}

func (h *Hub) reclaim(c *client, token string) (meeting.Participant, bool, bool) {
	if token == "" {
		return meeting.Participant{}, false, false
	}
	h.mu.Lock()
	var previous *client
	var pending *pendingReconnect
	activeTakeover := false
	if reconnect, exists := h.pending[token]; exists {
		delete(h.pending, token)
		if reconnect.timer != nil {
			reconnect.timer.Stop()
		}
		pending = reconnect
		previous = reconnect.client
	} else if active := h.activeTokens[token]; active != nil {
		previous = active
		activeTakeover = true
	} else {
		h.mu.Unlock()
		return meeting.Participant{}, false, false
	}
	if pending != nil {
		c.participantID = pending.participant.ID
	} else {
		c.participantID = previous.participantID
	}
	c.reconnectToken = token
	c.resumed = true
	h.activeTokens[token] = c
	h.mu.Unlock()

	if previous != nil {
		if previous.conn != nil {
			_ = previous.conn.Close()
		}
		if previous.finished != nil {
			<-previous.finished
		}
	}
	if pending != nil {
		c.participant = pending.participant
	} else {
		c.participant = previous.participant
	}
	return c.participant, true, activeTakeover
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
	h.forgetMediaState(participant.ID)
	if h.Meeting.Leave(participant.ID) {
		h.broadcast(Message{Version: ProtocolVersion, Type: TypeLeft, Participant: &participant})
		h.scheduleChatHistoryExpiry(chatRoomID)
		h.Logger.Info("participant_left", "participant_id", participant.ID, "name", participant.Name)
	}
}

func (h *Hub) forgetMediaState(participantID string) {
	h.mu.Lock()
	delete(h.mediaStates, participantID)
	h.mu.Unlock()
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
	c := &client{conn: conn, finished: make(chan struct{})}
	done := make(chan struct{})
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		close(done)
		conn.Close()
		h.mu.Lock()
		delete(h.clients, c)
		delete(h.roomMembers, c)
		h.mu.Unlock()
		h.disconnect(c)
		close(c.finished)
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
		if msg.Type == TypeJoin && c.participant.ID == "" {
			c.joinAttempts++
			if c.joinAttempts > maxJoinAttempts {
				_ = c.write(Message{
					Version: ProtocolVersion, Type: TypeError,
					Error: "too many join attempts",
				})
				return
			}
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
				h.mu.Lock()
				h.mediaStates[c.participant.ID] = msg
				h.mu.Unlock()
				h.broadcastExcept(c, msg)
				continue
			}
			if msg.Type == TypeVideoSubscriptions {
				h.router.SetVideoSubscriptionsWithLayer(c.participant.ID, msg.CameraParticipantIDs, msg.CameraLayer)
				continue
			}
			if msg.Type == TypeHandState {
				if msg.ParticipantID != c.participant.ID {
					_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "participant_id does not belong to this connection"})
					continue
				}
				changed, err := h.Meeting.SetRaisedHand(c.participant.ID, *msg.HandRaised)
				if err != nil {
					_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
					continue
				}
				for _, participant := range changed {
					if participant.ID == c.participant.ID {
						c.participant = participant
					}
					raised := participant.RaisedHand
					h.broadcast(Message{
						Version: ProtocolVersion, Type: TypeHandState,
						ParticipantID: participant.ID, HandRaised: &raised,
						HandOrder: participant.HandOrder,
					})
				}
				continue
			}
			if msg.Type == TypeNetworkState {
				msg.ParticipantID = c.participant.ID
				h.metrics.ObserveNetwork(msg.RTTMs, msg.PacketLoss10, msg.JitterMs, msg.VideoKbps, msg.AudioKbps)
				continue
			}
			if msg.Type == TypeScreenShare {
				msg.ParticipantID = c.participant.ID
				if err := h.requestScreenShare(c, *msg.ScreenShareActive, msg.MediaStreamID); err != nil {
					_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
				}
				continue
			}
			if msg.Type == TypeChat {
				msg.ParticipantID = c.participant.ID
				msg.Name = c.participant.Name
				msg.ChatText = strings.TrimSpace(msg.ChatText)
				if h.Config.Snapshot().RetainChatHistory {
					h.recordChatMessage(chatRoomID, ChatHistoryEntry{
						ID: uuid.NewString(), Author: c.participant.Name,
						Text: msg.ChatText, Timestamp: time.Now().UTC(),
					})
				}
				h.broadcastExcept(c, msg)
				continue
			}
			if msg.Type == TypeReaction {
				if !c.allowReaction() {
					continue
				}
				msg.ParticipantID = c.participant.ID
				msg.Name = c.participant.Name
				h.broadcast(msg)
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
		participant, resumed, activeTakeover := h.reclaim(c, msg.ReconnectToken)
		var err error
		if !resumed {
			participant, err = h.Meeting.Join(msg.Name)
			if err != nil {
				if errors.Is(err, meeting.ErrMeetingFull) {
					h.broadcastToRoom(Message{Version: ProtocolVersion, Type: TypeRoomFull})
				}
				_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
				continue
			}
			c.participant = participant
			c.participantID = participant.ID
			c.reconnectToken = uuid.NewString()
			h.mu.Lock()
			h.activeTokens[c.reconnectToken] = c
			h.mu.Unlock()
		}
		c.participant = participant
		h.cancelChatHistoryExpiry(chatRoomID)
		turnUsername := cfg.TURNUsername
		turnPassword := cfg.TURNPassword
		if username, password, ok := cfg.TURNCredentials(participant.ID, time.Now()); ok {
			turnUsername = username
			turnPassword = password
		}
		c.peer, err = webrtc.NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(
			cfg.STUNServers, cfg.EffectiveTURNURLs(), turnUsername, turnPassword,
			cfg.ICEUDPPortMin, cfg.ICEUDPPortMax, cfg.ICEIPv4Only, cfg.ICETransportPolicy, cfg.ICEPublicIP,
		)
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
			role := media.SourceRoleAudio
			if track.Kind() == pion.RTPCodecTypeVideo {
				role = media.SourceRoleCamera
				if streamID := h.screenShareStreamID(c); streamID != "" && track.StreamID() == streamID {
					role = media.SourceRoleScreen
				}
			}
			layer := ""
			if role == media.SourceRoleCamera {
				layer = media.CameraLayerFromRID(track.RID())
			}
			h.router.Publish(c.participant.ID, role, c.peer, track, layer)
		})
		h.router.Register(participant.ID, c.peer, func() error {
			return h.sendOffer(c, false)
		})
		if err := c.write(Message{Version: ProtocolVersion, Type: TypeParticipant, Participant: &participant,
			ReconnectToken: c.reconnectToken, ChatHistory: h.chatHistorySnapshot(chatRoomID)}); err != nil {
			return
		}
		h.mu.Lock()
		h.roomMembers[c] = struct{}{}
		h.mu.Unlock()
		for _, existing := range h.Meeting.List() {
			if existing.ID != participant.ID && !h.isPendingParticipant(existing.ID) {
				_ = c.write(Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &existing})
			}
		}
		h.mu.RLock()
		for _, state := range h.mediaStates {
			_ = c.write(state)
		}
		h.mu.RUnlock()
		h.mu.RLock()
		screenOwner := ""
		if h.screenSharer != nil {
			screenOwner = h.screenSharer.participant.ID
		}
		h.mu.RUnlock()
		if screenOwner != "" {
			_ = c.write(h.screenShareMessage(true, screenOwner))
		}
		if !activeTakeover {
			h.broadcastExcept(c, Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &participant})
		}
		h.Logger.Info("participant_joined", "participant_id", participant.ID, "name", participant.Name)
		c.joined = true
		h.metrics.PeerJoined()
		if resumed {
			h.metrics.Reconnected()
		}
	}
}

func (c *client) allowReaction() bool {
	now := time.Now()
	if c.reactionWindowStart.IsZero() || now.Sub(c.reactionWindowStart) >= reactionBurstWindow {
		c.reactionWindowStart = now
		c.reactionCount = 0
	}
	if c.reactionCount >= reactionBurstLimit {
		return false
	}
	c.reactionCount++
	return true
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
		if err := applyPendingCandidates(c); err != nil {
			c.negotiationMu.Unlock()
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		c.remoteDescription = true
		answer, err := c.peer.CreateAnswer()
		if err != nil {
			c.negotiationMu.Unlock()
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		c.negotiationMu.Unlock()
		if err := c.write(Message{Version: ProtocolVersion, Type: TypeAnswer, SDP: answer}); err != nil {
			return
		}
		c.negotiationMu.Lock()
		c.negotiationReady = true
		shouldOffer := c.pendingOffer
		iceRestart := c.pendingICERestart
		c.pendingOffer = false
		c.pendingICERestart = false
		c.negotiationMu.Unlock()
		if shouldOffer {
			_ = h.sendOffer(c, iceRestart)
		}
	case TypeAnswer:
		c.negotiationMu.Lock()
		if !c.offerInFlight {
			c.negotiationMu.Unlock()
			return
		}
		err := c.peer.SetRemoteAnswer(msg.SDP)
		if err == nil {
			err = applyPendingCandidates(c)
		}
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
		c.negotiationMu.Lock()
		if !c.remoteDescription {
			c.pendingCandidates = append(c.pendingCandidates, msg)
			c.negotiationMu.Unlock()
			return
		}
		c.negotiationMu.Unlock()
		if err := c.peer.AddICECandidate(msg.Candidate, msg.SDPMid, msg.SDPMLineIndex); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
	case TypeICERestart:
		if err := h.sendOffer(c, true); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
	}
}

func applyPendingCandidates(c *client) error {
	pending := c.pendingCandidates
	c.pendingCandidates = nil
	for _, candidate := range pending {
		if err := c.peer.AddICECandidate(candidate.Candidate, candidate.SDPMid, candidate.SDPMLineIndex); err != nil {
			return err
		}
	}
	return nil
}

func (h *Hub) sendOffer(c *client, iceRestart bool) error {
	c.negotiationMu.Lock()
	if !c.negotiationReady {
		c.pendingOffer = true
		c.pendingICERestart = c.pendingICERestart || iceRestart
		c.negotiationMu.Unlock()
		return nil
	}
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

func (h *Hub) broadcastToRoom(msg Message) {
	h.mu.RLock()
	clients := slices.Collect(maps.Keys(h.roomMembers))
	h.mu.RUnlock()
	for _, c := range clients {
		_ = c.write(msg)
	}
}
