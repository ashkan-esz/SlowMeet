package signaling

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/media"
	"SlowMeet/internal/meeting"
	"SlowMeet/internal/metrics"
	"SlowMeet/internal/ratelimit"
	"SlowMeet/internal/webrtc"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	pion "github.com/pion/webrtc/v4"
)

const (
	// Browser SDP offers grow with media sections and ICE candidates. Keep a
	// bounded limit that accommodates renegotiation for screen sharing.
	maxSignalingMessageSize = 64 * 1024

	websocketPongWait   = 60 * time.Second
	websocketPingPeriod = (websocketPongWait * 9) / 10
	websocketWriteWait  = 10 * time.Second
	// outboundQueueSize must hold the worst-case join replay (at the 100
	// participant cap: ack + chat history + roster + media states + screen
	// state ≈ 202 messages) with headroom for concurrent room chatter.
	outboundQueueSize   = 512
	maxJoinAttempts     = 5
	chatRoomID          = "default"
	chatHistoryLimit    = 100
	chatHistoryTTL      = 30 * time.Minute
	reactionBurstLimit  = 6
	reactionBurstWindow = 3 * time.Second

	// Chat fan-out is the most expensive room event (history entry, N-member
	// queue writes), so it is burst-limited per connection far above normal
	// typing but below a flood.
	chatBurstLimit  = 10
	chatBurstWindow = 10 * time.Second

	// The browser tries at most three ICE restarts during recovery. Allow twice
	// that budget per 30 seconds while bounding the expensive pion CreateOffer.
	iceRestartBurstLimit  = 6
	iceRestartBurstWindow = 30 * time.Second

	// The browser normally sends about two subscription updates per second;
	// leave burst headroom while bounding router and renegotiation work.
	videoSubscriptionsBurstLimit  = 30
	videoSubscriptionsBurstWindow = 10 * time.Second

	// maxPendingCandidates bounds the ICE candidates queued before a remote
	// description exists, so a misbehaving client cannot queue without bound.
	maxPendingCandidates = 512

	// Failed meeting-password attempts are throttled per client IP to slow
	// down online guessing of the room password.
	joinPasswordFailuresPerMinute = 20
	joinPasswordFailureBurst      = 20
)

var chatHistoryExpiry = chatHistoryTTL

// iceFailureTeardownDelay gives a failed ICE connection a short grace period
// to recover (for example through a client-driven restart) before the
// signaling connection is torn down. A variable so tests can shorten it.
var iceFailureTeardownDelay = 5 * time.Second

// supersededPeerCloseDelay frees a superseded session's peer connection long
// after its reclaim, once any re-publish swap has settled. Closing earlier
// would error forward loops of publications the resume re-binds.
const supersededPeerCloseDelay = 10 * time.Second

type roomChatHistory struct {
	messages []ChatHistoryEntry
	expiry   *time.Timer
}

type client struct {
	conn           *websocket.Conn
	finished       chan struct{}
	outbound       chan *Message
	writerDone     chan struct{}
	remoteIP       string
	participant    meeting.Participant
	participantID  string
	reconnectToken string
	resumed        bool
	joined         bool
	// announced records whether this participant's join was broadcast to the
	// room; only announced departures broadcast a left event. Written by the
	// connection's read loop and read by its cleanup path (same goroutine).
	announced                     bool
	intentionalLeave              bool
	joinAttempts                  int
	admissionExpired              bool // guarded by Hub.mu
	peer                          *webrtc.Peer
	negotiationMu                 sync.Mutex
	negotiationReady              bool
	remoteDescription             bool
	iceFailureTimer               *time.Timer // guarded by negotiationMu
	pendingCandidates             []Message
	pendingLocalCandidates        []Message
	offerInFlight                 bool
	offerICERestart               bool
	pendingOffer                  bool
	pendingICERestart             bool
	activeScreenMediaStreamID     string
	activeScreenMediaTrackID      string
	reactionWindowStart           time.Time
	reactionCount                 int
	chatWindowStart               time.Time
	chatCount                     int
	iceRestartWindowStart         time.Time
	iceRestartCount               int
	videoSubscriptionsWindowStart time.Time
	videoSubscriptionsCount       int
}

type offerPeer interface {
	CreateOffer(iceRestart bool) (string, error)
}

type answerCandidatePeer interface {
	SetRemoteAnswer(sdp string) error
	AddICECandidate(candidate string, mid *string, mlineIndex *uint16) error
}

type candidatePeer interface {
	AddICECandidate(candidate string, mid *string, mlineIndex *uint16) error
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

	// passwordLimiter throttles failed meeting-password attempts per client IP.
	passwordLimiter *ratelimit.Limiter

	mu                    sync.RWMutex
	clients               map[*client]struct{}
	roomMembers           map[*client]struct{}
	router                *media.Router
	pending               map[string]*pendingReconnect
	activeTokens          map[string]*client
	mediaStates           map[string]Message
	metrics               *metrics.Metrics
	screenSharer          *client
	chatHistory           map[string]*roomChatHistory
	closed                bool
	pendingConnections    int
	maxPendingConnections int
	joinTimeout           time.Duration
}

func videoMediaStateBecameActive(previous, current Message) bool {
	if previous.VideoEnabled == nil || current.VideoEnabled == nil {
		return false
	}

	active := func(state Message) bool {
		return state.VideoEnabled != nil && *state.VideoEnabled &&
			(state.VideoPaused == nil || !*state.VideoPaused)
	}
	return !active(previous) && active(current)
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
		// The grace window deferred this client's media teardown; shutdown
		// must release it, or the peer connections and forward goroutines
		// outlive the hub.
		if reconnect.client != nil {
			h.teardownClientMedia(reconnect.client)
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
	releasedScreenSharerID := ""
	h.mu.Lock()
	if !cfg.EnableScreenShare && h.screenSharer != nil {
		releasedScreenSharerID = h.screenSharer.participant.ID
		h.screenSharer.activeScreenMediaStreamID = ""
		h.screenSharer.activeScreenMediaTrackID = ""
		h.screenSharer = nil
		releasedScreenShare = true
	}
	h.mu.Unlock()
	h.router.SetLimits(media.Limits{
		MaxAudioBitrate: cfg.MaxAudioBitrate,
		MaxVideoBitrate: cfg.MaxVideoBitrate,
		MaxVideoFPS:     cfg.MaxVideoFPS,
	})
	if releasedScreenSharerID != "" {
		h.router.SetPublicationActive(releasedScreenSharerID, media.SourceRoleScreen, false)
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
		maxPendingConnections: 128,
		joinTimeout:           15 * time.Second,
		passwordLimiter:       ratelimit.New(joinPasswordFailuresPerMinute, joinPasswordFailureBurst),
		Upgrader:              websocket.Upgrader{CheckOrigin: sameOrigin},
		clients:               make(map[*client]struct{}),
		roomMembers:           make(map[*client]struct{}),
		pending:               make(map[string]*pendingReconnect),
		activeTokens:          make(map[string]*client),
		mediaStates:           make(map[string]Message),
		chatHistory:           make(map[string]*roomChatHistory),
		metrics:               &metrics.Metrics{},
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
	return h.chatHistorySnapshotLocked(roomID)
}

// chatHistorySnapshotLocked copies the room chat history. The caller must
// hold h.mu (at least for reading).
func (h *Hub) chatHistorySnapshotLocked(roomID string) []ChatHistoryEntry {
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
	h.recordChatMessageLocked(roomID, entry)
	h.mu.Unlock()
}

// recordChatMessageLocked appends the entry to the room history. The caller
// must hold h.mu and is responsible for the RetainChatHistory check.
func (h *Hub) recordChatMessageLocked(roomID string, entry ChatHistoryEntry) {
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

// recordAndBroadcastChat records a chat message and fans it out as one atomic
// step. Admission snapshots the chat replay under the same lock, so a client
// admitted concurrently sees a given message either in its replay or as a
// live broadcast — never neither and never both.
func (h *Hub) recordAndBroadcastChat(c *client, msg Message, entry *ChatHistoryEntry) {
	msg.prepare()
	h.mu.Lock()
	if entry != nil {
		h.recordChatMessageLocked(chatRoomID, *entry)
	}
	for member := range h.roomMembers {
		if member != c {
			_ = member.writePrepared(&msg)
		}
	}
	h.mu.Unlock()
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
		h.expireChatHistory(roomID, history, 0)
	})
}

// expireChatHistory deletes the room's history once the room has stayed empty
// for the full TTL. If the room refilled before the timer fired — or refills
// while it is firing — the deletion is postponed by re-arming instead, so
// history survives for the occupants and is still cleaned when the room
// empties again.
func (h *Hub) expireChatHistory(roomID string, history *roomChatHistory, depth int) {
	if depth > 8 {
		// The room keeps refilling; leave the history for the next explicit
		// schedule/close event rather than looping indefinitely.
		return
	}
	if h.Meeting.Count() != 0 {
		h.mu.Lock()
		if current := h.chatHistory[roomID]; current == history {
			current.expiry = time.AfterFunc(chatHistoryExpiry, func() {
				h.expireChatHistory(roomID, history, depth+1)
			})
		}
		h.mu.Unlock()
		return
	}
	h.mu.Lock()
	if current := h.chatHistory[roomID]; current == history {
		delete(h.chatHistory, roomID)
	}
	h.mu.Unlock()
}

func (h *Hub) disconnect(c *client) {
	if c.participant.ID == "" {
		return
	}

	h.mu.Lock()
	superseded := c.reconnectToken != "" && h.activeTokens[c.reconnectToken] != c
	if c.reconnectToken != "" && !superseded {
		delete(h.activeTokens, c.reconnectToken)
	}
	timeout := h.Config.Snapshot().ReconnectTimeout
	// The reconnect grace window defers media teardown: publications and the
	// peer connection stay alive so a resumed client re-binds its streams
	// through publication swap — no renegotiation for the rest of the room —
	// instead of every network blip costing an unsubscribe, republish, and
	// renegotiation cycle on weak connections.
	graceEligible := !superseded && !c.intentionalLeave && !h.closed &&
		c.reconnectToken != "" && (c.joined || c.resumed) && timeout > 0
	clients := make([]*client, 0, len(h.roomMembers))
	for client := range h.roomMembers {
		if client.participant.ID != "" && client.participant.ID != c.participant.ID {
			clients = append(clients, client)
		}
	}
	h.mu.Unlock()

	if !graceEligible {
		h.teardownClientMedia(c)
	}

	if c.joined {
		h.metrics.PeerLeft()
	}
	h.releaseScreenShare(c)

	h.mu.Lock()
	if superseded {
		h.mu.Unlock()
		return
	}
	if c.intentionalLeave || h.closed || c.reconnectToken == "" || (!c.joined && !c.resumed) {
		h.mu.Unlock()
		h.removeClientParticipant(c)
		return
	}
	if timeout == 0 {
		// An explicitly zero reconnect timeout means no grace period: the
		// participant leaves the meeting immediately instead of waiting for a
		// reconnect.
		h.mu.Unlock()
		h.removeClientParticipant(c)
		h.Logger.Info("participant_disconnected", "participant_id", c.participant.ID, "name", c.participant.Name)
		return
	}
	pending := &pendingReconnect{
		participant: c.participant,
		token:       c.reconnectToken,
		client:      c,
	}
	h.pending[c.reconnectToken] = pending
	h.mu.Unlock()

	left := Message{Version: ProtocolVersion, Type: TypeLeft, Participant: &c.participant}
	left.prepare()
	for _, client := range clients {
		_ = client.write(left)
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
				// The grace window lapsed without a resume: release the media
				// that was kept alive for it, then free the meeting slot.
				h.teardownClientMedia(c)
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

// teardownClientMedia releases a client's media plane: publications and
// receivers' subscriptions, then the peer connection. On the reconnect-grace
// path it runs when the window expires instead of at drop time.
func (h *Hub) teardownClientMedia(c *client) {
	h.router.Unregister(c.participant.ID)
	if c.peer != nil {
		_ = c.peer.Close()
	}
}

func (h *Hub) screenShareMessage(active bool, owner string) Message {
	return Message{
		Version: ProtocolVersion, Type: TypeScreenState,
		ParticipantID: owner, ScreenShareOwner: owner,
		ScreenShareActive: &active,
	}
}

func (h *Hub) requestScreenShare(c *client, active bool, mediaIDs ...string) error {
	mediaStreamID := ""
	mediaTrackID := ""
	if len(mediaIDs) > 0 {
		mediaStreamID = mediaIDs[0]
	}
	if len(mediaIDs) > 1 {
		mediaTrackID = mediaIDs[1]
	}
	cfg := h.Config.Snapshot()
	if active && !cfg.EnableScreenShare {
		return fmt.Errorf("screen sharing is disabled")
	}
	h.mu.Lock()
	previousOwner := ""
	if h.screenSharer != nil {
		previousOwner = h.screenSharer.participant.ID
	}
	if active {
		if h.screenSharer != nil && h.screenSharer != c {
			h.mu.Unlock()
			return fmt.Errorf("screen sharing is already active")
		}
		h.screenSharer = c
		c.activeScreenMediaStreamID = mediaStreamID
		c.activeScreenMediaTrackID = mediaTrackID
	} else if h.screenSharer == c {
		h.screenSharer = nil
		c.activeScreenMediaStreamID = ""
		c.activeScreenMediaTrackID = ""
	}
	owner := ""
	if h.screenSharer != nil {
		owner = h.screenSharer.participant.ID
	}
	h.mu.Unlock()
	// Keep the screen publication registered while paused. The browser reuses
	// its sender/transceiver across stop and re-share, so Pion does not emit a
	// second OnTrack event for the same remote track.
	h.router.SetPublicationActive(c.participant.ID, media.SourceRoleScreen, active)
	// Re-asserting an unchanged state (a duplicate start, or a stop from a
	// non-sharer) must not re-fan-out the same broadcast.
	if owner != previousOwner {
		h.broadcast(h.screenShareMessage(owner != "", owner))
	}
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

func (h *Hub) screenShareTrackID(c *client) string {
	h.mu.RLock()
	defer h.mu.RUnlock()
	if h.screenSharer != c {
		return ""
	}
	return c.activeScreenMediaTrackID
}

func (h *Hub) releaseScreenShare(c *client) {
	h.mu.Lock()
	if h.screenSharer != c {
		h.mu.Unlock()
		return
	}
	h.screenSharer = nil
	c.activeScreenMediaStreamID = ""
	c.activeScreenMediaTrackID = ""
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
	// c.participant and c.participantID are read by other goroutines (for
	// example disconnect snapshotting clients under h.mu), so they must be
	// written while h.mu is held.
	if pending != nil {
		c.participantID = pending.participant.ID
		c.participant = pending.participant
	} else {
		c.participantID = previous.participantID
		c.participant = previous.participant
	}
	c.reconnectToken = token
	c.resumed = true
	h.activeTokens[token] = c
	h.mu.Unlock()

	if previous != nil {
		if previous.conn != nil {
			_ = previous.conn.Close()
		}
		if previous.peer != nil {
			// Closing the superseded peer right away would error the forward
			// loops of the publications this resume is about to re-bind via
			// swap, tearing down media and dragging the room through a full
			// renegotiation. Free it once the resume has settled instead; if
			// the client never re-publishes, the dead publications are
			// cleaned up by that close.
			previousPeer := previous.peer
			time.AfterFunc(supersededPeerCloseDelay, func() { _ = previousPeer.Close() })
		}
		if previous.finished != nil {
			<-previous.finished
		}
	}
	return c.participant, true, activeTakeover
}

func (h *Hub) removeParticipant(participant meeting.Participant) {
	h.forgetMediaState(participant.ID)
	if h.Meeting.Leave(participant.ID) {
		h.broadcast(Message{Version: ProtocolVersion, Type: TypeLeft, Participant: &participant})
		h.scheduleChatHistoryExpiry(chatRoomID)
		h.Logger.Info("participant_left", "participant_id", participant.ID, "name", participant.Name)
	}
}

// removeClientParticipant releases a disconnected client's meeting slot. A
// client whose join failed before the room was told about it never produced a
// join event, so its departure must not broadcast a phantom left event either.
func (h *Hub) removeClientParticipant(c *client) {
	if !c.announced {
		h.forgetMediaState(c.participant.ID)
		_ = h.Meeting.Leave(c.participant.ID)
		return
	}
	h.removeParticipant(c.participant)
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

// scheduleICEFailureTeardown closes the signaling connection after a short
// grace period when ICE fails terminally. Without this, a failed peer
// connection keeps its participant, publications, and receiver subscriptions
// until the WebSocket heartbeat notices, leaving black tiles for up to a
// minute. Closing the connection routes the participant through the ordinary
// reconnect flow.
func (h *Hub) scheduleICEFailureTeardown(c *client) {
	c.negotiationMu.Lock()
	defer c.negotiationMu.Unlock()
	if c.iceFailureTimer != nil {
		return
	}
	c.iceFailureTimer = time.AfterFunc(iceFailureTeardownDelay, func() {
		c.negotiationMu.Lock()
		c.iceFailureTimer = nil
		participantID := c.participantID
		conn := c.conn
		c.negotiationMu.Unlock()
		// timer.Stop loses the race against an already-running callback, so
		// re-check the live ICE state: a connection that recovered at the same
		// moment the deadline fired must not be torn down.
		if conn == nil || h.iceConnectionRecovered(c) {
			return
		}
		h.Logger.Info("ice_failure_teardown", "participant_id", participantID)
		_ = conn.Close()
	})
}

// iceConnectionRecovered reports whether the peer connection has returned to
// a progressing ICE state since the failure timer was armed.
func (h *Hub) iceConnectionRecovered(c *client) bool {
	c.negotiationMu.Lock()
	peer := c.peer
	c.negotiationMu.Unlock()
	if peer == nil || peer.Connection() == nil {
		return false
	}
	switch peer.Connection().ICEConnectionState() {
	case pion.ICEConnectionStateChecking, pion.ICEConnectionStateConnected, pion.ICEConnectionStateCompleted:
		return true
	default:
		return false
	}
}

// cancelICEFailureTeardown stops a pending ICE failure teardown, for example
// because negotiation is progressing again.
func (h *Hub) cancelICEFailureTeardown(c *client) {
	c.negotiationMu.Lock()
	defer c.negotiationMu.Unlock()
	if c.iceFailureTimer != nil {
		c.iceFailureTimer.Stop()
		c.iceFailureTimer = nil
	}
}

func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// Reserve before upgrading so unauthenticated sockets have their own bound.
	h.mu.Lock()
	if h.closed || h.pendingConnections >= h.maxPendingConnections {
		h.mu.Unlock()
		http.Error(w, "too many pending connections", http.StatusServiceUnavailable)
		return
	}
	h.pendingConnections++
	h.mu.Unlock()
	var releaseOnce sync.Once
	releasePending := func() {
		releaseOnce.Do(func() {
			h.mu.Lock()
			h.pendingConnections--
			h.mu.Unlock()
		})
	}
	defer releasePending()
	conn, err := h.Upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxSignalingMessageSize)
	conn.SetReadDeadline(time.Now().Add(websocketPongWait))
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(websocketPongWait))
	})
	c := &client{
		conn:       conn,
		finished:   make(chan struct{}),
		outbound:   make(chan *Message, outboundQueueSize),
		writerDone: make(chan struct{}),
		remoteIP:   ratelimit.ClientIPWithTrustedProxyCIDRs(r, h.Config.Snapshot().TrustedProxyCIDRs),
	}
	done := make(chan struct{})
	c.startWriter(done)
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		close(done)
		_ = conn.Close()
		<-c.writerDone
		return
	}
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	admissionTimer := time.AfterFunc(h.joinTimeout, func() {
		h.expireAdmission(c)
	})
	defer admissionTimer.Stop()
	defer func() {
		close(done)
		conn.Close()
		<-c.writerDone
		h.cancelICEFailureTeardown(c)
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
		// A live client keeps exchanging data frames even when its pong
		// control frames are swallowed by an intermediary; every successful
		// read is proof of liveness.
		_ = conn.SetReadDeadline(time.Now().Add(websocketPongWait))
		if msg.Type == TypeJoin && c.participant.ID == "" {
			c.joinAttempts++
			if c.joinAttempts > maxJoinAttempts {
				c.writeAndFlush(Message{
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
				msg = roomMessage(c, msg)
				h.mu.Lock()
				previousState, hadPreviousState := h.mediaStates[c.participant.ID]
				h.mediaStates[c.participant.ID] = msg
				h.mu.Unlock()
				h.broadcastExcept(c, msg)
				if hadPreviousState && videoMediaStateBecameActive(previousState, msg) {
					h.router.RequestVideoKeyFrameForPublisher(c.participant.ID, func(err error) {
						h.Logger.Error("video_keyframe_request_failed", "participant_id", c.participant.ID,
							"direction", "publisher", "trigger", "media_state_resume", "error", err)
					})
				}
				continue
			}
			if msg.Type == TypeVideoSubscriptions {
				if !c.allowVideoSubscriptions() {
					// Subscription state is self-correcting on the next update.
					continue
				}
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
						h.mu.Lock()
						c.participant = participant
						h.mu.Unlock()
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
				if err := h.requestScreenShare(c, *msg.ScreenShareActive, msg.MediaStreamID, msg.MediaTrackID); err != nil {
					_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
				}
				continue
			}
			if msg.Type == TypeChat {
				if !c.allowChat() {
					// Unlike reactions (silently dropped), a dropped chat
					// message is user-meaningful, so the sender is told it
					// did not go through. The text is not echoed back.
					_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "chat message rate limit exceeded"})
					continue
				}
				msg = roomMessage(c, msg)
				var entry *ChatHistoryEntry
				if h.Config.Snapshot().RetainChatHistory {
					entry = &ChatHistoryEntry{
						ID: uuid.NewString(), ParticipantID: c.participant.ID, Author: c.participant.Name,
						Text: msg.ChatText, Timestamp: time.Now().UTC(),
					}
				}
				h.recordAndBroadcastChat(c, msg, entry)
				continue
			}
			if msg.Type == TypeReaction {
				if !c.allowReaction() {
					continue
				}
				msg = roomMessage(c, msg)
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
		if cfg.MeetingPassword != "" && !h.passwordLimiter.AllowAttempt(c.remoteIP) {
			c.writeAndFlush(Message{Version: ProtocolVersion, Type: TypeError, Error: "too many password attempts"})
			return
		}
		if !cfg.CheckMeetingPassword(msg.Password) {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "invalid meeting password"})
			continue
		}
		if cfg.MeetingPassword != "" {
			h.passwordLimiter.RefundAttempt(c.remoteIP)
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
			h.mu.Lock()
			c.participant = participant
			c.participantID = participant.ID
			c.reconnectToken = uuid.NewString()
			h.activeTokens[c.reconnectToken] = c
			h.mu.Unlock()
		}
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
			// The reclaim already reserved the resumed slot; a hard failure
			// here must not hold that slot (plus a dead media reservation)
			// for the whole reconnect grace window. Drop the resume intent so
			// the disconnect treats this as a fresh, announced departure.
			c.resumed = false
			c.writeAndFlush(Message{Version: ProtocolVersion, Type: TypeError, Error: "unable to initialize WebRTC"})
			return
		}
		c.peer.OnICECandidate(func(candidate pion.ICECandidateInit) {
			_ = c.sendOrQueueLocalCandidate(Message{
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
				h.cancelICEFailureTeardown(c)
			case pion.ICEConnectionStateChecking:
				h.cancelICEFailureTeardown(c)
			case pion.ICEConnectionStateDisconnected:
				event = "network_degraded"
			case pion.ICEConnectionStateFailed:
				event = "webrtc_failed"
				h.metrics.ConnectionFailed()
				h.scheduleICEFailureTeardown(c)
			}
			h.Logger.Info(event, "participant_id", participant.ID, "ice_state", state.String())
		})
		c.peer.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
			role := media.SourceRoleAudio
			if track.Kind() == pion.RTPCodecTypeVideo {
				role = media.SourceRoleCamera
				if streamID := h.screenShareStreamID(c); streamID != "" && track.StreamID() == streamID {
					role = media.SourceRoleScreen
				} else if trackID := h.screenShareTrackID(c); trackID != "" && track.ID() == trackID {
					role = media.SourceRoleScreen
				}
			}
			layer := ""
			if role == media.SourceRoleCamera {
				layer = media.CameraLayerFromRID(track.RID())
			}
			// Read the participant ID from the join-flow local instead of
			// c.participant: OnTrack runs on a Pion goroutine that does not
			// hold h.mu, so touching c.participant here would race the hand
			// state handler that rewrites it.
			h.router.Publish(participant.ID, role, c.peer, track, layer)
		})
		h.router.Register(participant.ID, c.peer, func() error {
			return h.sendOffer(c, false)
		})
		if err := h.admit(c, participant, Message{Version: ProtocolVersion, Type: TypeParticipant, Participant: &participant,
			ReconnectToken: c.reconnectToken}, activeTakeover); err != nil {
			// Admission failed after reclaim (deadline or shutdown): the
			// resumed slot must not linger in a grace window with media
			// registered against a peer that will never produce tracks.
			c.resumed = false
			return
		}
		admissionTimer.Stop()
		releasePending()
		if !activeTakeover {
			h.broadcastExcept(c, Message{Version: ProtocolVersion, Type: TypeJoined, Participant: &participant})
		}
		h.Logger.Info("participant_joined", "participant_id", participant.ID, "name", participant.Name)
		c.joined = true
		c.announced = true
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

func (c *client) allowChat() bool {
	now := time.Now()
	if c.chatWindowStart.IsZero() || now.Sub(c.chatWindowStart) >= chatBurstWindow {
		c.chatWindowStart = now
		c.chatCount = 0
	}
	if c.chatCount >= chatBurstLimit {
		return false
	}
	c.chatCount++
	return true
}

func (c *client) allowICERestart() bool {
	now := time.Now()
	if c.iceRestartWindowStart.IsZero() || now.Sub(c.iceRestartWindowStart) >= iceRestartBurstWindow {
		c.iceRestartWindowStart = now
		c.iceRestartCount = 0
	}
	if c.iceRestartCount >= iceRestartBurstLimit {
		return false
	}
	c.iceRestartCount++
	return true
}

func (c *client) allowVideoSubscriptions() bool {
	now := time.Now()
	if c.videoSubscriptionsWindowStart.IsZero() || now.Sub(c.videoSubscriptionsWindowStart) >= videoSubscriptionsBurstWindow {
		c.videoSubscriptionsWindowStart = now
		c.videoSubscriptionsCount = 0
	}
	if c.videoSubscriptionsCount >= videoSubscriptionsBurstLimit {
		return false
	}
	c.videoSubscriptionsCount++
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
		if err := applyPendingCandidates(c, c.peer); err != nil {
			c.negotiationMu.Unlock()
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		c.remoteDescription = true
		wasNegotiationReady := c.negotiationReady
		c.negotiationReady = false
		answer, err := c.peer.CreateAnswer()
		if err != nil {
			c.negotiationReady = wasNegotiationReady
			c.negotiationMu.Unlock()
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
			return
		}
		c.negotiationMu.Unlock()
		if err := c.write(Message{Version: ProtocolVersion, Type: TypeAnswer, SDP: answer}); err != nil {
			return
		}
		h.router.RequestVideoKeyFrame(c.participant.ID, func(err error) {
			h.Logger.Error("video_keyframe_request_failed", "participant_id", c.participant.ID, "error", err)
		})
		c.negotiationMu.Lock()
		if err := c.flushPendingLocalCandidates(); err != nil {
			h.Logger.Error("ice_candidate_write_failed", "participant_id", c.participant.ID, "error", err)
		}
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
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "no offer in flight"})
			return
		}
		err := applyRemoteAnswer(c, c.peer, msg.SDP)
		// The media-section scan walks the full SDP; compute it only when the
		// debug record will actually be emitted.
		if h.Logger.Enabled(context.Background(), slog.LevelDebug) {
			h.Logger.Debug("sdp_answer_received",
				"participant_id", c.participantID,
				"bytes", len(msg.SDP),
				"media_sections", strings.Count(msg.SDP, "\nm="),
				"error", err,
			)
		}
		completedICERestart := c.offerICERestart
		c.offerICERestart = false
		shouldOffer := c.offerInFlight && c.pendingOffer
		pendingICERestart := c.pendingICERestart
		c.offerInFlight = false
		c.pendingOffer = false
		c.pendingICERestart = false
		c.negotiationMu.Unlock()
		if err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		} else {
			h.router.RequestVideoKeyFrame(c.participant.ID, func(err error) {
				h.Logger.Error("video_keyframe_request_failed", "participant_id", c.participant.ID, "error", err)
			})
			if completedICERestart {
				h.router.RequestVideoKeyFrameForPublisher(c.participant.ID, func(err error) {
					h.Logger.Error("video_keyframe_request_failed", "participant_id", c.participant.ID, "direction", "publisher", "error", err)
				})
			}
		}
		if shouldOffer {
			_ = h.sendOffer(c, pendingICERestart)
		}
	case TypeCandidate:
		c.negotiationMu.Lock()
		err := addOrQueueCandidate(c, c.peer, msg)
		c.negotiationMu.Unlock()
		if err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
	case TypeICERestart:
		if !c.allowICERestart() {
			// The browser's generic error path rearms its bounded recovery retry;
			// silently dropping would leave restartRequested latched.
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: "ice restart rate limit exceeded"})
			return
		}
		if err := h.sendOffer(c, true); err != nil {
			_ = c.write(Message{Version: ProtocolVersion, Type: TypeError, Error: err.Error()})
		}
	}
}

func applyRemoteAnswer(c *client, peer answerCandidatePeer, sdp string) error {
	if err := peer.SetRemoteAnswer(sdp); err != nil {
		return err
	}
	c.remoteDescription = true
	return applyPendingCandidates(c, peer)
}

func addOrQueueCandidate(c *client, peer candidatePeer, candidate Message) error {
	if !c.remoteDescription {
		if len(c.pendingCandidates) >= maxPendingCandidates {
			return fmt.Errorf("too many queued ICE candidates")
		}
		c.pendingCandidates = append(c.pendingCandidates, candidate)
		return nil
	}
	return peer.AddICECandidate(candidate.Candidate, candidate.SDPMid, candidate.SDPMLineIndex)
}

func applyPendingCandidates(c *client, peer candidatePeer) error {
	pending := c.pendingCandidates
	c.pendingCandidates = nil
	for index, candidate := range pending {
		if err := peer.AddICECandidate(candidate.Candidate, candidate.SDPMid, candidate.SDPMLineIndex); err != nil {
			// Keep the not-yet-applied candidates queued so one malformed
			// candidate does not discard the valid ones behind it.
			c.pendingCandidates = append(append([]Message(nil), pending[index+1:]...), c.pendingCandidates...)
			return err
		}
	}
	return nil
}

func (h *Hub) sendOffer(c *client, iceRestart bool) error {
	return sendOfferWithPeer(c, c.peer, iceRestart)
}

func sendOfferWithPeer(c *client, peer offerPeer, iceRestart bool) error {
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
	c.offerICERestart = iceRestart
	previousRemoteDescription := c.remoteDescription
	if iceRestart {
		// Browser candidates gathered for the restarted ICE credentials must
		// wait until their answer becomes the active remote description.
		c.remoteDescription = false
	}
	offer, err := peer.CreateOffer(iceRestart)
	if err != nil {
		c.offerInFlight = false
		c.offerICERestart = false
		c.remoteDescription = previousRemoteDescription
		c.negotiationMu.Unlock()
		return err
	}
	err = c.write(Message{Version: ProtocolVersion, Type: TypeOffer, SDP: offer})
	if err == nil {
		// SDP size telemetry, logged only after a successful write: offer
		// bytes grow with m-line count, and when they approach
		// maxSignalingMessageSize the connection is torn down on read — this
		// line is the early warning that feeds the renegotiation-slimming
		// work (single-sender simulcast). sendOfferWithPeer is package-level
		// (no hub logger), so the default logger carries the debug line.
		if slog.Default().Enabled(context.Background(), slog.LevelDebug) {
			slog.Default().Debug("sdp_offer_sent",
				"participant_id", c.participantID,
				"bytes", len(offer),
				"media_sections", strings.Count(offer, "\nm="),
				"ice_restart", iceRestart,
			)
		}
	} else {
		c.offerInFlight = false
		c.offerICERestart = false
		c.remoteDescription = previousRemoteDescription
	}
	c.negotiationMu.Unlock()
	return err
}

// write enqueues a message for the client's writer goroutine. It never blocks:
// fan-out from other clients' read loops must not stall on a slow consumer. A
// full queue means the connection is not draining, so it is closed and the
// read loop's cleanup path takes over.
func (c *client) write(msg Message) error {
	return c.writePrepared(&msg)
}

// writePrepared enqueues a message pointer for the client's writer goroutine.
// Broadcast fan-out passes the same *Message to every member: the writers only
// read msg.raw and msg.flush (WriteMessage copies the payload onto the wire
// before returning), and the channel send establishes the happens-before edge.
// The shared struct is therefore immutable once enqueued — never mutate a
// Message after passing it here. Like write, it never blocks: a full queue
// closes the connection.
func (c *client) writePrepared(msg *Message) error {
	if c.conn == nil || c.outbound == nil {
		return errors.New("client connection is not initialized")
	}
	select {
	case c.outbound <- msg:
		return nil
	default:
		_ = c.conn.Close()
		return fmt.Errorf("outbound queue is full")
	}
}

// writeFrame serializes one message onto the connection. Called only from the
// writer goroutine, so no additional locking is required alongside the
// concurrent WriteControl pings.
func (c *client) writeFrame(msg *Message) error {
	if msg.flush != nil {
		// A bare flush sentinel carries no payload and must not reach the
		// wire; it only signals that everything queued before it was written.
		close(msg.flush)
		return nil
	}
	if err := c.conn.SetWriteDeadline(time.Now().Add(websocketWriteWait)); err != nil {
		return err
	}
	var err error
	if msg.raw != nil {
		// Broadcasts serialize once and share the encoded bytes; WriteMessage
		// copies the payload onto the wire before returning.
		err = c.conn.WriteMessage(websocket.TextMessage, msg.raw)
	} else {
		err = c.conn.WriteJSON(msg)
	}
	if err != nil {
		return err
	}
	return c.conn.SetWriteDeadline(time.Time{})
}

// flushOutbound waits until every message enqueued so far has been handed to
// the connection (or the writer gave up). It returns immediately when the
// writer has already exited.
func (c *client) flushOutbound() {
	if c.conn == nil || c.outbound == nil {
		return
	}
	sentinel := &Message{flush: make(chan struct{})}
	select {
	case c.outbound <- sentinel:
		select {
		case <-sentinel.flush:
		case <-c.writerDone:
		}
	case <-c.writerDone:
	}
}

// writeAndFlush delivers a final message on a connection that is about to
// close, so it is not silently discarded by the cleanup path.
func (c *client) writeAndFlush(msg Message) {
	_ = c.write(msg)
	c.flushOutbound()
}

// startWriter launches the goroutine that serializes outbound frames for this
// client. It exits when stop is closed or a frame write fails; closing the
// connection unblocks an in-flight frame write immediately.
func (c *client) startWriter(stop <-chan struct{}) {
	go func() {
		defer close(c.writerDone)
		for {
			select {
			case <-stop:
				return
			case msg := <-c.outbound:
				if err := c.writeFrame(msg); err != nil {
					_ = c.conn.Close()
					return
				}
			}
		}
	}()
}

func (c *client) sendOrQueueLocalCandidate(candidate Message) error {
	c.negotiationMu.Lock()
	defer c.negotiationMu.Unlock()
	if !c.negotiationReady {
		c.pendingLocalCandidates = append(c.pendingLocalCandidates, candidate)
		return nil
	}
	return c.write(candidate)
}

// flushPendingLocalCandidates must be called with negotiationMu held.
func (c *client) flushPendingLocalCandidates() error {
	pending := c.pendingLocalCandidates
	c.pendingLocalCandidates = nil
	for index, candidate := range pending {
		if err := c.write(candidate); err != nil {
			c.pendingLocalCandidates = append(pending[index:], c.pendingLocalCandidates...)
			return err
		}
	}
	return nil
}

func (h *Hub) broadcast(msg Message) {
	h.broadcastToRoom(msg)
}

func (h *Hub) broadcastExcept(excluded *client, msg Message) {
	msg.prepare()
	// Fan out directly under the read lock: writePrepared never blocks (a full
	// queue closes the connection), so collecting a slice first would only
	// allocate per broadcast.
	h.mu.RLock()
	for c := range h.roomMembers {
		if c != excluded {
			_ = c.writePrepared(&msg)
		}
	}
	h.mu.RUnlock()
}

func (h *Hub) broadcastToRoom(msg Message) {
	msg.prepare()
	h.mu.RLock()
	for c := range h.roomMembers {
		_ = c.writePrepared(&msg)
	}
	h.mu.RUnlock()
}
