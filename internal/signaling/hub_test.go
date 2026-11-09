package signaling

import (
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"SlowMeet/internal/config"
	"SlowMeet/internal/media"
	"SlowMeet/internal/meeting"
	internalwebrtc "SlowMeet/internal/webrtc"
	"github.com/gorilla/websocket"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

func TestHubJoinLeaveLifecycle(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		MaxParticipants:     2,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})

	var firstJoined Message
	readTestMessage(t, first, &firstJoined)
	if firstJoined.Type != TypeParticipant || firstJoined.Participant == nil {
		t.Fatalf("first join response = %+v", firstJoined)
	}
	if firstJoined.ReconnectToken == "" {
		t.Fatal("first join response did not include reconnect token")
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})

	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	if secondJoined.Type != TypeParticipant {
		t.Fatalf("second join response = %+v", secondJoined)
	}
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant.Name != "Ashkan" {
		t.Fatalf("existing participant broadcast = %+v", secondSeesFirst)
	}
	if secondSeesFirst.ReconnectToken != "" {
		t.Fatal("reconnect token leaked in participant broadcast")
	}

	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)
	if firstSeesSecond.Type != TypeJoined || firstSeesSecond.Participant.Name != "Ali" {
		t.Fatalf("participant broadcast = %+v", firstSeesSecond)
	}
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeChat,
		ParticipantID: firstJoined.Participant.ID, ChatText: "Hello room",
	})
	var secondSeesChat Message
	readTestMessage(t, second, &secondSeesChat)
	if secondSeesChat.Type != TypeChat || secondSeesChat.ParticipantID != firstJoined.Participant.ID ||
		secondSeesChat.Name != "Ashkan" || secondSeesChat.ChatText != "Hello room" {
		t.Fatalf("chat broadcast = %+v", secondSeesChat)
	}

	hub.BroadcastConfig(config.Config{
		MaxVideoBitrate:   250000,
		MaxVideoFPS:       10,
		MaxAudioBitrate:   32000,
		EnableScreenShare: false,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var update Message
		readTestMessage(t, conn, &update)
		if update.Type != TypeConfigUpdate || update.MaxVideoBitrate != 250000 ||
			update.MaxVideoFPS != 10 || update.MaxAudioBitrate != 32000 ||
			update.ScreenShareEnabled == nil || *update.ScreenShareEnabled {
			t.Fatalf("configuration update = %+v", update)
		}
	}
	writeTestMessage(t, first, Message{
		Version:       ProtocolVersion,
		Type:          TypeLeave,
		ParticipantID: firstJoined.Participant.ID,
	})
	var left Message
	readTestMessage(t, second, &left)
	if left.Type != TypeLeft || left.Participant.Name != "Ashkan" {
		t.Fatalf("leave broadcast = %+v", left)
	}
}

func TestVideoMediaStateBecameActive(t *testing.T) {
	state := func(enabled bool, paused *bool) Message {
		return Message{VideoEnabled: &enabled, VideoPaused: paused}
	}
	paused := true
	unpaused := false

	tests := []struct {
		name     string
		previous Message
		current  Message
		want     bool
	}{
		{
			name:     "camera resumed after off",
			previous: state(false, nil),
			current:  state(true, nil),
			want:     true,
		},
		{
			name:     "video unpaused while enabled",
			previous: state(true, &paused),
			current:  state(true, &unpaused),
			want:     true,
		},
		{
			name:     "initial enabled state is not a resume",
			previous: Message{},
			current:  state(true, nil),
			want:     false,
		},
		{
			name:     "repeated enabled state is not a resume",
			previous: state(true, nil),
			current:  state(true, nil),
			want:     false,
		},
		{
			name:     "camera disabled",
			previous: state(true, nil),
			current:  state(false, nil),
			want:     false,
		},
		{
			name:     "video remains paused",
			previous: state(true, &paused),
			current:  state(true, &paused),
			want:     false,
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := videoMediaStateBecameActive(test.previous, test.current); got != test.want {
				t.Fatalf("videoMediaStateBecameActive() = %t, want %t", got, test.want)
			}
		})
	}
}

func TestHubReplaysLatestMediaStateToLateJoiners(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		MaxParticipants:     3,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(3), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	initialAudio, initialVideo := true, true
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeMediaState, ParticipantID: firstJoined.Participant.ID,
		AudioEnabled: &initialAudio, VideoEnabled: &initialVideo,
	})
	latestAudio, latestVideo, latestPaused := false, false, true
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeMediaState, ParticipantID: firstJoined.Participant.ID,
		AudioEnabled: &latestAudio, VideoEnabled: &latestVideo, VideoPaused: &latestPaused,
	})

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant.ID != firstJoined.Participant.ID {
		t.Fatalf("second existing participant = %+v", secondSeesFirst)
	}
	var secondSeesFirstState Message
	readTestMessage(t, second, &secondSeesFirstState)
	if secondSeesFirstState.Type != TypeMediaState || secondSeesFirstState.ParticipantID != firstJoined.Participant.ID ||
		secondSeesFirstState.AudioEnabled == nil || *secondSeesFirstState.AudioEnabled ||
		secondSeesFirstState.VideoEnabled == nil || *secondSeesFirstState.VideoEnabled ||
		secondSeesFirstState.VideoPaused == nil || !*secondSeesFirstState.VideoPaused {
		t.Fatalf("replayed media state = %+v, want latest state from first participant", secondSeesFirstState)
	}

	updatedAudio, updatedVideo := true, false
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeMediaState, ParticipantID: firstJoined.Participant.ID,
		AudioEnabled: &updatedAudio, VideoEnabled: &updatedVideo,
	})
	var secondSeesUpdate Message
	readTestMessage(t, second, &secondSeesUpdate)
	if secondSeesUpdate.Type != TypeMediaState || secondSeesUpdate.ParticipantID != firstJoined.Participant.ID ||
		secondSeesUpdate.AudioEnabled == nil || !*secondSeesUpdate.AudioEnabled ||
		secondSeesUpdate.VideoEnabled == nil || *secondSeesUpdate.VideoEnabled {
		t.Fatalf("broadcast media state = %+v, want updated state from first participant", secondSeesUpdate)
	}

	third := dialTestSocket(t, socketURL)
	defer third.Close()
	writeTestMessage(t, third, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Sara"})
	var thirdJoined Message
	readTestMessage(t, third, &thirdJoined)
	joinedIDs := make(map[string]bool)
	for range 2 {
		var existing Message
		readTestMessage(t, third, &existing)
		if existing.Type != TypeJoined || existing.Participant == nil {
			t.Fatalf("third participant roster message = %+v", existing)
		}
		joinedIDs[existing.Participant.ID] = true
	}
	if !joinedIDs[firstJoined.Participant.ID] || !joinedIDs[secondJoined.Participant.ID] {
		t.Fatalf("third participant roster IDs = %v", joinedIDs)
	}
	var thirdSeesState Message
	readTestMessage(t, third, &thirdSeesState)
	if thirdSeesState.Type != TypeMediaState || thirdSeesState.ParticipantID != firstJoined.Participant.ID ||
		thirdSeesState.AudioEnabled == nil || !*thirdSeesState.AudioEnabled ||
		thirdSeesState.VideoEnabled == nil || *thirdSeesState.VideoEnabled {
		t.Fatalf("third participant state replay = %+v, want only first participant state", thirdSeesState)
	}
}

func TestChatHistoryRetentionIsRoomScopedCappedAndExpiring(t *testing.T) {
	oldExpiry := chatHistoryExpiry
	chatHistoryExpiry = 20 * time.Millisecond
	t.Cleanup(func() { chatHistoryExpiry = oldExpiry })

	cfg := config.Config{RetainChatHistory: true, MaxParticipants: 2}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	t.Cleanup(hub.Close)

	for index := 0; index < 105; index++ {
		hub.recordChatMessage("room-a", ChatHistoryEntry{
			ID: fmt.Sprintf("message-%d", index), Author: "Ashkan", Text: "hello",
			Timestamp: time.Unix(int64(index), 0).UTC(),
		})
	}
	if got := hub.chatHistorySnapshot("room-a"); len(got) != chatHistoryLimit || got[0].ID != "message-5" {
		t.Fatalf("room-a history = %d messages starting with %q, want 100 starting with message-5", len(got), got[0].ID)
	}
	if got := hub.chatHistorySnapshot("room-b"); got != nil {
		t.Fatalf("room-b history = %#v, want nil", got)
	}

	hub.scheduleChatHistoryExpiry("room-a")
	time.Sleep(50 * time.Millisecond)
	if got := hub.chatHistorySnapshot("room-a"); got != nil {
		t.Fatalf("expired room history = %#v, want nil", got)
	}
}

func TestChatHistoryIsReplayedToNewRoomMembers(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		RetainChatHistory:   true,
		MaxParticipants:     3,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(3), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant.ID != firstJoined.Participant.ID {
		t.Fatalf("second existing participant = %+v", secondSeesFirst)
	}
	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)
	if firstSeesSecond.Type != TypeJoined || firstSeesSecond.Participant.ID != secondJoined.Participant.ID {
		t.Fatalf("first new participant = %+v", firstSeesSecond)
	}
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeChat,
		ParticipantID: firstJoined.Participant.ID, ChatText: "Retained hello",
	})
	var secondSeesChat Message
	readTestMessage(t, second, &secondSeesChat)

	third := dialTestSocket(t, socketURL)
	defer third.Close()
	writeTestMessage(t, third, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Sara"})
	var thirdJoined Message
	readTestMessage(t, third, &thirdJoined)
	if len(thirdJoined.ChatHistory) != 1 || thirdJoined.ChatHistory[0].Text != "Retained hello" ||
		thirdJoined.ChatHistory[0].Author != "Ashkan" {
		t.Fatalf("replayed chat history = %#v", thirdJoined.ChatHistory)
	}
}

func TestDisablingChatHistoryClearsExistingMessages(t *testing.T) {
	retain := true
	store := config.NewStore(config.Config{
		HTTPAddr:            ":8080",
		RetainChatHistory:   true,
		MaxParticipants:     2,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	})
	hub := NewHub(meeting.New(2), store, slog.Default())
	t.Cleanup(hub.Close)
	hub.recordChatMessage("default", ChatHistoryEntry{ID: "message-1", Author: "Ashkan", Text: "hello"})
	if got := hub.chatHistorySnapshot("default"); len(got) != 1 {
		t.Fatalf("initial history length = %d, want 1", len(got))
	}
	retain = false
	if err := store.Update(config.AdminUpdate{RetainChatHistory: &retain}); err != nil {
		t.Fatalf("disabling retention failed: %v", err)
	}
	hub.clearChatHistory()
	if got := hub.chatHistorySnapshot("default"); got != nil {
		t.Fatalf("cleared history = %#v, want nil", got)
	}
}

func TestSendOfferWaitsForInitialBrowserOffer(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{}), slog.Default())
	client := &client{}

	if err := hub.sendOffer(client, false); err != nil {
		t.Fatalf("sendOffer() before negotiation ready returned error: %v", err)
	}
	client.negotiationMu.Lock()
	ready, pending := client.negotiationReady, client.pendingOffer
	client.negotiationMu.Unlock()
	if ready || !pending {
		t.Fatalf("unexpected negotiation state: ready=%t pending=%t", ready, pending)
	}
}

func TestRouterOfferWaitsUntilBrowserAnswerIsWritten(t *testing.T) {
	serverConnections := make(chan *websocket.Conn, 1)
	websocketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnections <- conn
	}))
	defer websocketServer.Close()

	browserConn, _, err := websocket.DefaultDialer.Dial("ws"+websocketServer.URL[len("http"):], nil)
	if err != nil {
		t.Fatalf("dial websocket test peer: %v", err)
	}
	defer browserConn.Close()
	serverConn := <-serverConnections
	defer serverConn.Close()

	serverPeer, err := internalwebrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create signaling peer: %v", err)
	}
	defer serverPeer.Close()
	browserPeer, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create browser peer: %v", err)
	}
	defer browserPeer.Close()
	if _, err := browserPeer.AddTransceiverFromKind(
		pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add browser receive transceiver: %v", err)
	}
	offer, err := browserPeer.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create browser offer: %v", err)
	}
	if err := browserPeer.SetLocalDescription(offer); err != nil {
		t.Fatalf("set browser local offer: %v", err)
	}
	<-pion.GatheringCompletePromise(browserPeer)
	offer = *browserPeer.LocalDescription()

	hub := NewHub(meeting.New(1), config.NewStore(config.Config{}), slog.Default())
	c := &client{
		conn:             serverConn,
		finished:         make(chan struct{}),
		outbound:         make(chan *Message, outboundQueueSize),
		writerDone:       make(chan struct{}),
		peer:             serverPeer,
		negotiationReady: true,
	}
	startTestWriter(t, c)

	handledOffer := make(chan struct{})
	go func() {
		hub.handleWebRTCMessage(c, Message{Version: ProtocolVersion, Type: TypeOffer, SDP: offer.SDP})
		close(handledOffer)
	}()
	waitForLocalAnswer(t, serverPeer.Connection())

	// The router offer is requested while the browser answer is still being
	// handed to the connection. The outbound queue must preserve the answer's
	// head-of-line position so the browser sees the answer before the offer.
	select {
	case <-handledOffer:
	case <-time.After(2 * time.Second):
		t.Fatal("browser offer handling did not finish")
	}
	offerResult := make(chan error, 1)
	go func() { offerResult <- hub.sendOffer(c, false) }()
	select {
	case err := <-offerResult:
		if err != nil {
			t.Fatalf("send deferred router offer: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("deferred router offer did not finish")
	}

	_ = browserConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var answer Message
	if err := browserConn.ReadJSON(&answer); err != nil {
		t.Fatalf("read browser answer: %v", err)
	}
	if answer.Type != TypeAnswer {
		t.Fatalf("first signaling message = %q, want answer", answer.Type)
	}
	var routerOffer Message
	if err := browserConn.ReadJSON(&routerOffer); err != nil {
		t.Fatalf("read deferred router offer: %v", err)
	}
	if routerOffer.Type != TypeOffer {
		t.Fatalf("second signaling message = %q, want offer", routerOffer.Type)
	}
}

func TestCompletedNegotiationsRequestCameraKeyFrames(t *testing.T) {
	serverConnections := make(chan *websocket.Conn, 1)
	websocketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnections <- conn
	}))
	defer websocketServer.Close()

	browserConn, _, err := websocket.DefaultDialer.Dial("ws"+websocketServer.URL[len("http"):], nil)
	if err != nil {
		t.Fatalf("dial websocket test peer: %v", err)
	}
	defer browserConn.Close()
	serverConn := <-serverConnections
	defer serverConn.Close()

	publisherBrowser, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create publisher browser peer: %v", err)
	}
	defer publisherBrowser.Close()
	publisherIngress, err := internalwebrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create publisher ingress peer: %v", err)
	}
	defer publisherIngress.Close()
	receiverPeer, err := internalwebrtc.NewPeer(nil)
	if err != nil {
		t.Fatalf("create receiver server peer: %v", err)
	}
	defer receiverPeer.Close()
	receiverBrowser, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create receiver browser peer: %v", err)
	}
	defer receiverBrowser.Close()
	if _, err := publisherIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add publisher ingress transceiver: %v", err)
	}
	if _, err := receiverBrowser.AddTransceiverFromKind(
		pion.RTPCodecTypeVideo,
		pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add receiver browser transceiver: %v", err)
	}

	hub := NewHub(meeting.New(2), config.NewStore(config.Config{}), slog.Default())
	hub.router.Register("receiver", receiverPeer, nil)
	t.Cleanup(func() {
		hub.router.Unregister("receiver")
		hub.router.Unregister("publisher")
	})
	publicationReady := make(chan struct{})
	publisherIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		hub.router.Publish("publisher", media.SourceRoleCamera, publisherIngress, track)
		close(publicationReady)
	})
	publisherTrack, err := pion.NewTrackLocalStaticRTP(
		pion.RTPCodecCapability{MimeType: pion.MimeTypeVP8, ClockRate: 90_000},
		"publisher-camera", "publisher-stream",
	)
	if err != nil {
		t.Fatalf("create publisher camera track: %v", err)
	}
	publisherSender, err := publisherBrowser.AddTrack(publisherTrack)
	if err != nil {
		t.Fatalf("add publisher camera track: %v", err)
	}
	negotiateHubTestPeers(t, publisherBrowser, publisherIngress.Connection())
	waitForPeerConnected(t, publisherBrowser)
	waitForPeerConnected(t, publisherIngress.Connection())
	if err := publisherTrack.WriteRTP(&rtp.Packet{
		Header:  rtp.Header{Version: 2, Marker: true, PayloadType: 96, SequenceNumber: 1, Timestamp: 9_000},
		Payload: []byte{0x10, 0x00},
	}); err != nil {
		t.Fatalf("write initial camera packet: %v", err)
	}
	select {
	case <-publicationReady:
	case <-time.After(5 * time.Second):
		t.Fatal("camera publication was not created")
	}

	pliReceived := make(chan struct{}, 8)
	go func() {
		for {
			packets, _, readErr := publisherSender.ReadRTCP()
			if readErr != nil {
				return
			}
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.PictureLossIndication); ok {
					select {
					case pliReceived <- struct{}{}:
					default:
					}
				}
			}
		}
	}()
	awaitPLIRequests := func(negotiation string) {
		t.Helper()
		for attempt := range 3 {
			select {
			case <-pliReceived:
			case <-time.After(2 * time.Second):
				t.Fatalf("camera publisher received only %d of 3 keyframe requests after %s", attempt, negotiation)
			}
		}
	}

	offer, err := receiverBrowser.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create receiver browser offer: %v", err)
	}
	if err := receiverBrowser.SetLocalDescription(offer); err != nil {
		t.Fatalf("set receiver browser offer: %v", err)
	}
	<-pion.GatheringCompletePromise(receiverBrowser)
	c := &client{
		conn:             serverConn,
		peer:             receiverPeer,
		participant:      meeting.Participant{ID: "receiver"},
		negotiationReady: true,
	}
	c.outbound = make(chan *Message, outboundQueueSize)
	c.writerDone = make(chan struct{})
	startTestWriter(t, c)
	hub.handleWebRTCMessage(c, Message{
		Version: ProtocolVersion,
		Type:    TypeOffer,
		SDP:     receiverBrowser.LocalDescription().SDP,
	})
	browserConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var answer Message
	if err := browserConn.ReadJSON(&answer); err != nil {
		t.Fatalf("read receiver answer: %v", err)
	}
	if answer.Type != TypeAnswer {
		t.Fatalf("receiver offer response type = %q, want answer", answer.Type)
	}
	if err := receiverBrowser.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeAnswer,
		SDP:  answer.SDP,
	}); err != nil {
		t.Fatalf("set receiver browser remote answer: %v", err)
	}
	awaitPLIRequests("receiver-initiated negotiation")

	if err := hub.sendOffer(c, false); err != nil {
		t.Fatalf("send server offer: %v", err)
	}
	browserConn.SetReadDeadline(time.Now().Add(2 * time.Second))
	var serverOffer Message
	if err := browserConn.ReadJSON(&serverOffer); err != nil {
		t.Fatalf("read server offer: %v", err)
	}
	if serverOffer.Type != TypeOffer {
		t.Fatalf("server negotiation message type = %q, want offer", serverOffer.Type)
	}
	if err := receiverBrowser.SetRemoteDescription(pion.SessionDescription{
		Type: pion.SDPTypeOffer,
		SDP:  serverOffer.SDP,
	}); err != nil {
		t.Fatalf("set receiver browser remote offer: %v", err)
	}
	answerToServerOffer, err := receiverBrowser.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create answer to server offer: %v", err)
	}
	if err := receiverBrowser.SetLocalDescription(answerToServerOffer); err != nil {
		t.Fatalf("set receiver browser local answer: %v", err)
	}
	<-pion.GatheringCompletePromise(receiverBrowser)
	hub.handleWebRTCMessage(c, Message{
		Version: ProtocolVersion,
		Type:    TypeAnswer,
		SDP:     receiverBrowser.LocalDescription().SDP,
	})
	awaitPLIRequests("server-offer answer")
}

func TestICERestartBuffersCandidatesUntilAnswer(t *testing.T) {
	serverConnections := make(chan *websocket.Conn, 1)
	websocketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnections <- conn
	}))
	defer websocketServer.Close()

	browserConn, _, err := websocket.DefaultDialer.Dial("ws"+websocketServer.URL[len("http"):], nil)
	if err != nil {
		t.Fatalf("dial websocket test peer: %v", err)
	}
	defer browserConn.Close()
	serverConn := <-serverConnections
	defer serverConn.Close()

	c := &client{
		conn:              serverConn,
		negotiationReady:  true,
		remoteDescription: true,
	}
	c.outbound = make(chan *Message, outboundQueueSize)
	c.writerDone = make(chan struct{})
	startTestWriter(t, c)
	peer := &restartSignalingPeer{}

	if err := sendOfferWithPeer(c, peer, true); err != nil {
		t.Fatalf("send ICE restart offer: %v", err)
	}
	var offer Message
	readTestMessage(t, browserConn, &offer)
	if offer.Type != TypeOffer || offer.SDP != "restart offer" {
		t.Fatalf("ICE restart offer = %+v", offer)
	}
	if c.remoteDescription {
		t.Fatal("remote description remained active while the restart offer was in flight")
	}

	candidate := Message{
		Version:       ProtocolVersion,
		Type:          TypeCandidate,
		Candidate:     "candidate:restart-generation",
		SDPMid:        stringPointer("0"),
		SDPMLineIndex: uint16Pointer(0),
	}
	c.negotiationMu.Lock()
	if err := addOrQueueCandidate(c, peer, candidate); err != nil {
		c.negotiationMu.Unlock()
		t.Fatalf("queue restart candidate: %v", err)
	}
	queued := len(c.pendingCandidates)
	c.negotiationMu.Unlock()
	if queued != 1 {
		t.Fatalf("pending candidates = %d, want 1 before restart answer", queued)
	}
	if len(peer.candidates) != 0 {
		t.Fatal("restart candidate was applied before its answer installed the matching remote description")
	}

	c.negotiationMu.Lock()
	err = applyRemoteAnswer(c, peer, "restart answer")
	c.negotiationMu.Unlock()
	if err != nil {
		t.Fatalf("apply restart answer and buffered candidate: %v", err)
	}
	if !c.remoteDescription {
		t.Fatal("remote description was not marked active after applying the restart answer")
	}
	if got := len(c.pendingCandidates); got != 0 {
		t.Fatalf("pending candidates after answer = %d, want 0", got)
	}
	if len(peer.candidates) != 1 || peer.candidates[0] != candidate.Candidate {
		t.Fatalf("applied candidates = %v, want [%q]", peer.candidates, candidate.Candidate)
	}
}

func TestServerOfferIsWrittenBeforeGatheredCandidates(t *testing.T) {
	serverConnections := make(chan *websocket.Conn, 1)
	websocketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnections <- conn
	}))
	defer websocketServer.Close()

	browserConn, _, err := websocket.DefaultDialer.Dial("ws"+websocketServer.URL[len("http"):], nil)
	if err != nil {
		t.Fatalf("dial websocket test peer: %v", err)
	}
	defer browserConn.Close()
	serverConn := <-serverConnections
	defer serverConn.Close()

	c := &client{conn: serverConn, negotiationReady: true, remoteDescription: true}
	c.outbound = make(chan *Message, outboundQueueSize)
	c.writerDone = make(chan struct{})
	startTestWriter(t, c)
	candidate := Message{
		Version:       ProtocolVersion,
		Type:          TypeCandidate,
		Candidate:     "candidate:restart-generation",
		SDPMid:        stringPointer("0"),
		SDPMLineIndex: uint16Pointer(0),
	}
	candidateStarted := make(chan struct{})
	candidateWritten := make(chan error, 1)
	peer := &restartSignalingPeer{
		onCreateOffer: func() {
			go func() {
				close(candidateStarted)
				candidateWritten <- c.sendOrQueueLocalCandidate(candidate)
			}()
			<-candidateStarted
		},
	}

	if err := sendOfferWithPeer(c, peer, true); err != nil {
		t.Fatalf("send ICE restart offer: %v", err)
	}
	var offer Message
	readTestMessage(t, browserConn, &offer)
	if offer.Type != TypeOffer {
		t.Fatalf("first signaling message = %q, want offer", offer.Type)
	}
	var gatheredCandidate Message
	readTestMessage(t, browserConn, &gatheredCandidate)
	if gatheredCandidate.Type != TypeCandidate || gatheredCandidate.Candidate != candidate.Candidate {
		t.Fatalf("second signaling message = %+v, want restart candidate after offer", gatheredCandidate)
	}
	if err := <-candidateWritten; err != nil {
		t.Fatalf("write gathered restart candidate: %v", err)
	}
}

type restartSignalingPeer struct {
	remoteAnswer   string
	candidates     []string
	onCreateOffer  func()
	failCandidates map[string]bool
}

func (p *restartSignalingPeer) CreateOffer(iceRestart bool) (string, error) {
	if !iceRestart {
		return "", errors.New("expected an ICE restart offer")
	}
	if p.onCreateOffer != nil {
		p.onCreateOffer()
	}
	return "restart offer", nil
}

func (p *restartSignalingPeer) SetRemoteAnswer(sdp string) error {
	p.remoteAnswer = sdp
	return nil
}

func (p *restartSignalingPeer) AddICECandidate(candidate string, _ *string, _ *uint16) error {
	if p.remoteAnswer == "" {
		return errors.New("candidate arrived before remote answer")
	}
	if p.failCandidates[candidate] {
		return fmt.Errorf("candidate %q is unusable", candidate)
	}
	p.candidates = append(p.candidates, candidate)
	return nil
}

func stringPointer(value string) *string { return &value }

func uint16Pointer(value uint16) *uint16 { return &value }

func negotiateHubTestPeers(t *testing.T, offerer, answerer *pion.PeerConnection) {
	t.Helper()
	offer, err := offerer.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create peer offer: %v", err)
	}
	if err := offerer.SetLocalDescription(offer); err != nil {
		t.Fatalf("set peer local offer: %v", err)
	}
	<-pion.GatheringCompletePromise(offerer)
	if err := answerer.SetRemoteDescription(*offerer.LocalDescription()); err != nil {
		t.Fatalf("set peer remote offer: %v", err)
	}
	answer, err := answerer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create peer answer: %v", err)
	}
	if err := answerer.SetLocalDescription(answer); err != nil {
		t.Fatalf("set peer local answer: %v", err)
	}
	<-pion.GatheringCompletePromise(answerer)
	if err := offerer.SetRemoteDescription(*answerer.LocalDescription()); err != nil {
		t.Fatalf("set peer remote answer: %v", err)
	}
}

func waitForPeerConnected(t *testing.T, peer *pion.PeerConnection) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for peer.ConnectionState() != pion.PeerConnectionStateConnected {
		if time.Now().After(deadline) {
			t.Fatalf("peer connection state = %s, want connected", peer.ConnectionState())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func waitForLocalAnswer(t *testing.T, peer *pion.PeerConnection) {
	t.Helper()
	deadline := time.After(2 * time.Second)
	for {
		local := peer.LocalDescription()
		if local != nil && local.Type == pion.SDPTypeAnswer {
			return
		}
		select {
		case <-deadline:
			t.Fatalf("peer local description = %v, want an answer", local)
		case <-time.After(10 * time.Millisecond):
		}
	}
}

func TestWebSocketLivenessConfiguration(t *testing.T) {
	if websocketPongWait <= websocketPingPeriod {
		t.Fatalf("pong wait %s must exceed ping period %s", websocketPongWait, websocketPingPeriod)
	}
	if websocketWriteWait <= 0 || websocketWriteWait >= websocketPongWait {
		t.Fatalf("write wait %s must be positive and below pong wait %s", websocketWriteWait, websocketPongWait)
	}
}

func TestReactionRateLimit(t *testing.T) {
	client := &client{}
	for range reactionBurstLimit {
		if !client.allowReaction() {
			t.Fatal("reaction within burst limit was rejected")
		}
	}
	if client.allowReaction() {
		t.Fatal("reaction beyond burst limit was accepted")
	}
	client.reactionWindowStart = time.Now().Add(-reactionBurstWindow)
	if !client.allowReaction() {
		t.Fatal("reaction after rate-limit window was rejected")
	}
}

func TestReactionBroadcastsToAllParticipantsWithoutHistory(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		RetainChatHistory:   true,
		MaxParticipants:     2,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)

	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeReaction,
		ParticipantID: "spoofed", Name: "Spoofed", Emoji: "🎉",
	})
	var firstReaction, secondReaction Message
	readTestMessage(t, first, &firstReaction)
	readTestMessage(t, second, &secondReaction)
	for _, got := range []Message{firstReaction, secondReaction} {
		if got.Type != TypeReaction || got.Emoji != "🎉" ||
			got.ParticipantID != firstJoined.Participant.ID || got.Name != "Ashkan" {
			t.Fatalf("reaction = %+v, want authenticated broadcast", got)
		}
	}
	if got := hub.chatHistorySnapshot("default"); got != nil {
		t.Fatalf("reaction was stored in chat history: %#v", got)
	}
}

func TestHubRejectsWrongPasswordAndFullMeeting(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		MeetingPassword:     "secret",
		MaxParticipants:     2,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	wrong := dialTestSocket(t, socketURL)
	defer wrong.Close()
	writeTestMessage(t, wrong, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Wrong", Password: "nope",
	})
	var passwordError Message
	readTestMessage(t, wrong, &passwordError)
	if passwordError.Type != TypeError || passwordError.Error != "invalid meeting password" {
		t.Fatalf("wrong password response = %+v", passwordError)
	}

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", Password: "secret",
	})
	var joined Message
	readTestMessage(t, first, &joined)
	if joined.Type != TypeParticipant {
		t.Fatalf("valid join response = %+v", joined)
	}
	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Sara", Password: "secret",
	})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	if secondJoined.Type != TypeParticipant {
		t.Fatalf("second valid join response = %+v", secondJoined)
	}
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant == nil ||
		secondSeesFirst.Participant.Name != "Ashkan" {
		t.Fatalf("second participant update = %+v", secondSeesFirst)
	}
	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)
	if firstSeesSecond.Type != TypeJoined || firstSeesSecond.Participant == nil ||
		firstSeesSecond.Participant.Name != "Sara" {
		t.Fatalf("first participant update = %+v", firstSeesSecond)
	}

	waiting := dialTestSocket(t, socketURL)
	defer waiting.Close()
	full := dialTestSocket(t, socketURL)
	defer full.Close()
	writeTestMessage(t, full, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ali", Password: "secret",
	})
	var fullError Message
	readTestMessage(t, full, &fullError)
	if fullError.Type != TypeError || fullError.Error != "meeting is full" {
		t.Fatalf("full meeting response = %+v", fullError)
	}
	for _, member := range []*websocket.Conn{first, second} {
		var roomFull Message
		readTestMessage(t, member, &roomFull)
		if roomFull.Type != TypeRoomFull || roomFull.Name != "" || roomFull.Participant != nil {
			t.Fatalf("room-full notification = %+v, want anonymous %q event", roomFull, TypeRoomFull)
		}
	}
	assertNoTestMessage(t, waiting)
	assertNoTestMessage(t, full)

	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeLeave, ParticipantID: joined.Participant.ID,
	})
	deadline := time.Now().Add(time.Second)
	for hub.Meeting.Count() != 1 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := hub.Meeting.Count(); got != 1 {
		t.Fatalf("meeting count after participant leaves = %d, want 1", got)
	}

	retry := dialTestSocket(t, socketURL)
	defer retry.Close()
	writeTestMessage(t, retry, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ali", Password: "secret",
	})
	var retryJoined Message
	readTestMessage(t, retry, &retryJoined)
	if retryJoined.Type != TypeParticipant {
		t.Fatalf("retry after capacity opens = %+v, want participant", retryJoined)
	}
}

func TestHubRejectsMessagesBeforeJoin(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 3, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(3), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	conn := dialTestSocket(t, socketURL)
	defer conn.Close()
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeICERestart})

	var response Message
	readTestMessage(t, conn, &response)
	if response.Type != TypeError || response.Error != "join is required before this message" {
		t.Fatalf("pre-join response = %+v", response)
	}
}

func TestHubAllowsOnlyOneScreenShare(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, EnableScreenShare: true,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	active := true
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: firstJoined.Participant.ID, ScreenShareActive: &active,
	})
	var granted Message
	readTestMessage(t, first, &granted)
	if granted.Type != TypeScreenState || granted.ScreenShareOwner != firstJoined.Participant.ID ||
		granted.ScreenShareActive == nil || !*granted.ScreenShareActive {
		t.Fatalf("screen-share grant = %+v", granted)
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var existing Message
	readTestMessage(t, second, &existing)
	var state Message
	readTestMessage(t, second, &state)
	if state.Type != TypeScreenState || state.ScreenShareOwner != firstJoined.Participant.ID {
		t.Fatalf("late-join screen state = %+v", state)
	}

	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: secondJoined.Participant.ID, ScreenShareActive: &active,
	})
	var denied Message
	readTestMessage(t, second, &denied)
	if denied.Type != TypeError || denied.Error != "screen sharing is already active" {
		t.Fatalf("second screen-share request = %+v", denied)
	}
}

func TestHubReleasesScreenShareWhenOwnerDisconnects(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, EnableScreenShare: true,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: time.Second,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	observer := dialTestSocket(t, socketURL)
	defer observer.Close()
	writeTestMessage(t, observer, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Observer"})
	var observerJoined Message
	readTestMessage(t, observer, &observerJoined)

	owner := dialTestSocket(t, socketURL)
	writeTestMessage(t, owner, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var ownerJoined Message
	readTestMessage(t, owner, &ownerJoined)
	var ownerSeesObserver Message
	readTestMessage(t, owner, &ownerSeesObserver)
	var observerSeesOwner Message
	readTestMessage(t, observer, &observerSeesOwner)
	active := true
	writeTestMessage(t, owner, Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: ownerJoined.Participant.ID, ScreenShareActive: &active,
	})
	var ownerState Message
	readTestMessage(t, owner, &ownerState)
	var observerState Message
	readTestMessage(t, observer, &observerState)
	owner.Close()

	var released Message
	readTestMessage(t, observer, &released)
	if released.Type != TypeScreenState || released.ScreenShareActive == nil || *released.ScreenShareActive {
		t.Fatalf("disconnect release state = %+v", released)
	}
}

func TestHubScreenShareLeaseBindsToConnection(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{
		HTTPAddr: ":8080", EnableScreenShare: true,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}), slog.Default())
	old := &client{participant: meeting.Participant{ID: "old"}}
	replacement := &client{participant: meeting.Participant{ID: "same-participant"}}
	hub.mu.Lock()
	hub.screenSharer = old
	hub.mu.Unlock()

	hub.releaseScreenShare(replacement)
	hub.mu.RLock()
	current := hub.screenSharer
	hub.mu.RUnlock()
	if current != old {
		t.Fatal("stale replacement cleared the active screen-share lease")
	}
	hub.releaseScreenShare(old)
	hub.mu.RLock()
	current = hub.screenSharer
	hub.mu.RUnlock()
	if current != nil {
		t.Fatal("owner did not release the screen-share lease")
	}
}

func TestHubAllowsScreenShareReleaseWhenDisabled(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{
		HTTPAddr: ":8080", EnableScreenShare: false,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}), slog.Default())
	owner := &client{participant: meeting.Participant{ID: "owner"}}
	hub.mu.Lock()
	hub.screenSharer = owner
	hub.mu.Unlock()

	if err := hub.requestScreenShare(owner, false); err != nil {
		t.Fatalf("release with screen sharing disabled: %v", err)
	}
	hub.mu.RLock()
	current := hub.screenSharer
	hub.mu.RUnlock()
	if current != nil {
		t.Fatal("disabled screen sharing release did not clear the lease")
	}
	if err := hub.requestScreenShare(owner, true); err == nil {
		t.Fatal("acquisition with screen sharing disabled succeeded")
	}
}

func TestHubScreenShareStreamIDTracksLeaseLifecycle(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{
		HTTPAddr: ":8080", EnableScreenShare: true,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}), slog.Default())
	owner := &client{participant: meeting.Participant{ID: "owner"}}

	if err := hub.requestScreenShare(owner, true, "screen-stream-1"); err != nil {
		t.Fatalf("start first share: %v", err)
	}
	if got := hub.screenShareStreamID(owner); got != "screen-stream-1" {
		t.Fatalf("first share stream ID = %q, want screen-stream-1", got)
	}

	if err := hub.requestScreenShare(owner, false); err != nil {
		t.Fatalf("stop first share: %v", err)
	}
	if got := hub.screenShareStreamID(owner); got != "" {
		t.Fatalf("stream ID after stop = %q, want empty", got)
	}

	if err := hub.requestScreenShare(owner, true, "screen-stream-2"); err != nil {
		t.Fatalf("start restarted share: %v", err)
	}
	if got := hub.screenShareStreamID(owner); got != "screen-stream-2" {
		t.Fatalf("restarted share stream ID = %q, want screen-stream-2", got)
	}
}

func TestHubCloseCleansUpJoinedParticipants(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	conn := dialTestSocket(t, socketURL)
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, conn, &joined)
	if joined.Type != TypeParticipant {
		t.Fatalf("join response = %+v", joined)
	}

	hub.Close()
	defer conn.Close()
	for deadline := time.Now().Add(time.Second); time.Now().Before(deadline); {
		if hub.ActiveParticipants() == 0 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("active participants after Close() = %d, want 0", hub.ActiveParticipants())
}

func TestHubReconnectReclaimsParticipantDuringGracePeriod(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 1, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 200 * time.Millisecond,
	}
	hub := NewHub(meeting.New(1), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, first, &joined)
	if joined.Type != TypeParticipant || joined.ReconnectToken == "" {
		t.Fatalf("join response = %+v", joined)
	}
	first.Close()

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan",
		ReconnectToken: joined.ReconnectToken,
	})
	var rejoined Message
	readTestMessage(t, second, &rejoined)
	if rejoined.Type != TypeParticipant || rejoined.Participant.ID != joined.Participant.ID {
		t.Fatalf("reconnect response = %+v, want participant %q", rejoined, joined.Participant.ID)
	}
}

func TestHubReconnectTakesOverStillConnectedParticipant(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 3, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: time.Second,
	}
	hub := NewHub(meeting.New(3), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	defer hub.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, first, &joined)
	if joined.Type != TypeParticipant || joined.ReconnectToken == "" {
		t.Fatalf("initial join response = %+v", joined)
	}

	observer := dialTestSocket(t, socketURL)
	defer observer.Close()
	writeTestMessage(t, observer, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var observerJoined Message
	readTestMessage(t, observer, &observerJoined)
	if observerJoined.Type != TypeParticipant {
		t.Fatalf("observer join response = %+v", observerJoined)
	}
	var observerSeesOriginal Message
	readTestMessage(t, observer, &observerSeesOriginal)
	if observerSeesOriginal.Type != TypeJoined || observerSeesOriginal.Participant.ID != joined.Participant.ID {
		t.Fatalf("observer existing participant = %+v", observerSeesOriginal)
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan",
		ReconnectToken: joined.ReconnectToken,
	})
	var rejoined Message
	readTestMessage(t, second, &rejoined)
	if rejoined.Type != TypeParticipant || rejoined.Participant.ID != joined.Participant.ID {
		t.Fatalf("reconnect response = %+v, want participant %q", rejoined, joined.Participant.ID)
	}
	var secondSeesObserver Message
	readTestMessage(t, second, &secondSeesObserver)
	if secondSeesObserver.Type != TypeJoined || secondSeesObserver.Participant.ID != observerJoined.Participant.ID {
		t.Fatalf("reconnecting participant roster = %+v", secondSeesObserver)
	}
	if got := hub.ActiveParticipants(); got != 2 {
		t.Fatalf("active participants after reconnect = %d, want 2", got)
	}
	if err := observer.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		t.Fatalf("set observer read deadline: %v", err)
	}
	var unexpected Message
	if err := observer.ReadJSON(&unexpected); err == nil {
		t.Fatalf("observer received duplicate reconnect event: %+v", unexpected)
	} else if netErr, ok := err.(net.Error); !ok || !netErr.Timeout() {
		t.Fatalf("observer read after active reconnect: %v", err)
	}

	first.Close()
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		hub.mu.RLock()
		pending := len(hub.pending)
		hub.mu.RUnlock()
		if pending == 0 {
			if got := hub.ActiveParticipants(); got != 2 {
				t.Fatalf("active participants after old connection cleanup = %d, want 2", got)
			}
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("superseded connection created a pending reconnect")
}

func TestHubHidesDisconnectedParticipantDuringGracePeriod(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: time.Second,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, first, &joined)
	first.Close()

	// Allow the closed handler to register the reconnect grace session.
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		hub.mu.RLock()
		pending := len(hub.pending)
		hub.mu.RUnlock()
		if pending > 0 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	hub.mu.RLock()
	pending := len(hub.pending)
	hub.mu.RUnlock()
	if pending == 0 {
		t.Fatal("disconnect did not enter reconnect grace period")
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var response Message
	readTestMessage(t, second, &response)
	if response.Type != TypeParticipant {
		t.Fatalf("join response = %+v", response)
	}
	_ = second.SetReadDeadline(time.Now().Add(100 * time.Millisecond))
	var unexpected Message
	if err := second.ReadJSON(&unexpected); err == nil {
		t.Fatalf("received disconnected participant: %+v", unexpected)
	}
}

func TestHubReconnectExpiryReleasesParticipantSlot(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 1, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 40 * time.Millisecond,
	}
	hub := NewHub(meeting.New(1), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, first, &joined)
	first.Close()

	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && hub.ActiveParticipants() != 0 {
		time.Sleep(10 * time.Millisecond)
	}
	if got := hub.ActiveParticipants(); got != 0 {
		t.Fatalf("active participants after reconnect expiry = %d, want 0", got)
	}

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var rejoined Message
	readTestMessage(t, second, &rejoined)
	if rejoined.Type != TypeParticipant || rejoined.Participant.Name != "Ali" {
		t.Fatalf("fresh join after expiry = %+v", rejoined)
	}
}

func TestHubLimitsJoinAttemptsPerConnection(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MeetingPassword: "secret", MaxParticipants: 1,
		DefaultVideoQuality: "low", DefaultVideoFPS: 15, MaxVideoFPS: 30,
		DefaultAudioBitrate: 32000, MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
	}
	hub := NewHub(meeting.New(1), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	conn := dialTestSocket(t, socketURL)
	defer conn.Close()
	for attempt := 0; attempt < maxJoinAttempts; attempt++ {
		writeTestMessage(t, conn, Message{
			Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", Password: "wrong",
		})
		var response Message
		readTestMessage(t, conn, &response)
		if response.Type != TypeError || response.Error != "invalid meeting password" {
			t.Fatalf("attempt %d response = %+v", attempt+1, response)
		}
	}

	writeTestMessage(t, conn, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", Password: "wrong",
	})
	var response Message
	readTestMessage(t, conn, &response)
	if response.Type != TypeError || response.Error != "too many join attempts" {
		t.Fatalf("limit response = %+v", response)
	}
	if _, _, err := conn.NextReader(); err == nil {
		t.Fatal("connection remained open after join-attempt limit")
	}
}

func TestHubRaisedHandQueueBroadcastsAndRejectsSpoofing(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:            ":8080",
		MaxParticipants:     2,
		DefaultVideoQuality: "low",
		DefaultVideoFPS:     15,
		MaxVideoFPS:         30,
		DefaultAudioBitrate: 32000,
		MaxVideoBitrate:     500000,
		MaxAudioBitrate:     64000,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var secondJoined Message
	readTestMessage(t, second, &secondJoined)
	var secondSeesFirst Message
	readTestMessage(t, second, &secondSeesFirst)
	if secondSeesFirst.Type != TypeJoined || secondSeesFirst.Participant.ID != firstJoined.Participant.ID {
		t.Fatalf("second existing participant = %+v", secondSeesFirst)
	}
	var firstSeesSecond Message
	readTestMessage(t, first, &firstSeesSecond)
	if firstSeesSecond.Type != TypeJoined || firstSeesSecond.Participant.ID != secondJoined.Participant.ID {
		t.Fatalf("first new participant = %+v", firstSeesSecond)
	}

	firstRaised := true
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: firstJoined.Participant.ID, HandRaised: &firstRaised,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var update Message
		readTestMessage(t, conn, &update)
		if update.Type != TypeHandState || update.ParticipantID != firstJoined.Participant.ID ||
			update.HandRaised == nil || !*update.HandRaised || update.HandOrder != 1 {
			t.Fatalf("first raised-hand update = %+v", update)
		}
	}

	secondRaised := true
	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: secondJoined.Participant.ID, HandRaised: &secondRaised,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var update Message
		readTestMessage(t, conn, &update)
		if update.Type != TypeHandState || update.ParticipantID != secondJoined.Participant.ID ||
			update.HandRaised == nil || !*update.HandRaised || update.HandOrder != 2 {
			t.Fatalf("second raised-hand update = %+v", update)
		}
	}

	firstLowered := false
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: firstJoined.Participant.ID, HandRaised: &firstLowered,
	})
	for _, conn := range []*websocket.Conn{first, second} {
		var lowered Message
		readTestMessage(t, conn, &lowered)
		var compacted Message
		readTestMessage(t, conn, &compacted)
		if lowered.ParticipantID != firstJoined.Participant.ID || lowered.HandRaised == nil ||
			*lowered.HandRaised || lowered.HandOrder != 0 ||
			compacted.ParticipantID != secondJoined.Participant.ID || compacted.HandRaised == nil ||
			!*compacted.HandRaised || compacted.HandOrder != 1 {
			t.Fatalf("lowered queue updates = %+v, %+v", lowered, compacted)
		}
	}

	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeHandState,
		ParticipantID: secondJoined.Participant.ID, HandRaised: &secondRaised,
	})
	var spoofed Message
	readTestMessage(t, first, &spoofed)
	if spoofed.Type != TypeError || spoofed.Error != "participant_id does not belong to this connection" {
		t.Fatalf("spoofed hand-state response = %+v", spoofed)
	}
}

func dialTestSocket(t *testing.T, url string) *websocket.Conn {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	return conn
}

func writeTestMessage(t *testing.T, conn *websocket.Conn, msg Message) {
	t.Helper()
	if err := conn.WriteJSON(msg); err != nil {
		t.Fatalf("write message: %v", err)
	}
}

// startTestWriter launches the outbound writer goroutine for a client
// constructed directly in a test and stops it when the test finishes.
func startTestWriter(t *testing.T, c *client) {
	t.Helper()
	stop := make(chan struct{})
	c.startWriter(stop)
	t.Cleanup(func() { close(stop) })
}

func readTestMessage(t *testing.T, conn *websocket.Conn, msg *Message) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	if err := conn.ReadJSON(msg); err != nil {
		t.Fatalf("read message: %v", err)
	}
}

func assertNoTestMessage(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	if err := conn.SetReadDeadline(time.Now().Add(50 * time.Millisecond)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	var msg Message
	err := conn.ReadJSON(&msg)
	if err == nil {
		t.Fatalf("received unexpected message: %+v", msg)
	}
	var networkErr net.Error
	if !errors.As(err, &networkErr) || !networkErr.Timeout() {
		t.Fatalf("read without message returned %v, want timeout", err)
	}
}

func TestHubZeroReconnectTimeoutLeavesImmediately(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 0,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	socketURL := "ws" + server.URL[len("http"):]
	conn := dialTestSocket(t, socketURL)
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, conn, &joined)
	if joined.Type != TypeParticipant {
		t.Fatalf("join response = %+v", joined)
	}
	conn.Close()

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if hub.ActiveParticipants() == 0 {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("participant slot held for %v after disconnect with zero reconnect timeout", hub.ActiveParticipants())
}

func TestHubBroadcastDoesNotBlockOnStalledClient(t *testing.T) {
	hub := NewHub(meeting.New(4), config.NewStore(config.Config{}), slog.Default())

	serverConnections := make(chan *websocket.Conn, 2)
	websocketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnections <- conn
	}))
	defer websocketServer.Close()
	dial := func() *websocket.Conn {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+websocketServer.URL[len("http"):], nil)
		if err != nil {
			t.Fatalf("dial websocket test peer: %v", err)
		}
		return conn
	}

	// Healthy client: the peer side is drained by the test.
	healthyConn := dial()
	defer healthyConn.Close()
	healthy := &client{
		conn:       <-serverConnections,
		finished:   make(chan struct{}),
		outbound:   make(chan *Message, outboundQueueSize),
		writerDone: make(chan struct{}),
	}
	defer healthy.conn.Close()
	startTestWriter(t, healthy)

	// Stalled client: the peer side is never read, so its writer goroutine
	// wedges in WriteJSON once the socket buffers fill up.
	stalledPeer := dial()
	defer stalledPeer.Close()
	stalled := &client{
		conn:       <-serverConnections,
		finished:   make(chan struct{}),
		outbound:   make(chan *Message, outboundQueueSize),
		writerDone: make(chan struct{}),
	}
	defer stalled.conn.Close()
	startTestWriter(t, stalled)

	hub.mu.Lock()
	hub.clients[healthy] = struct{}{}
	hub.clients[stalled] = struct{}{}
	hub.roomMembers[healthy] = struct{}{}
	hub.roomMembers[stalled] = struct{}{}
	hub.mu.Unlock()

	bulky := Message{Version: ProtocolVersion, Type: TypeOffer, SDP: strings.Repeat("a", 256*1024)}
	for i := 0; i < 32; i++ {
		if err := stalled.write(bulky); err != nil {
			break
		}
	}

	start := time.Now()
	hub.broadcast(Message{Version: ProtocolVersion, Type: TypeConfigUpdate, MaxVideoFPS: 30})
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatalf("broadcast blocked for %v behind a stalled client", elapsed)
	}
	var received Message
	readTestMessage(t, healthyConn, &received)
	if received.Type != TypeConfigUpdate {
		t.Fatalf("healthy client message type = %q, want config_update", received.Type)
	}

	// A client that stops draining its queue is disconnected instead of
	// wedging the hub: once the queue is full, write fails and the
	// connection is closed.
	overflow := Message{Version: ProtocolVersion, Type: TypeConfigUpdate}
	closed := false
	for i := 0; i < outboundQueueSize+32; i++ {
		if err := stalled.write(overflow); err != nil {
			closed = true
			break
		}
	}
	if !closed {
		t.Fatal("stalled client connection was not closed after its outbound queue overflowed")
	}
}

func TestHubHandStateUnderConcurrentConfigBroadcast(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 2, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		EnableScreenShare: true,
	}
	hub := NewHub(meeting.New(2), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	defer hub.Close()

	socketURL := "ws" + server.URL[len("http"):]
	sharerConn := dialTestSocket(t, socketURL)
	defer sharerConn.Close()
	writeTestMessage(t, sharerConn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var sharerJoined Message
	readTestMessage(t, sharerConn, &sharerJoined)
	if sharerJoined.Type != TypeParticipant {
		t.Fatalf("sharer join response = %+v", sharerJoined)
	}
	observerConn := dialTestSocket(t, socketURL)
	defer observerConn.Close()
	writeTestMessage(t, observerConn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	var observerJoined Message
	readTestMessage(t, observerConn, &observerJoined)
	if observerJoined.Type != TypeParticipant {
		t.Fatalf("observer join response = %+v", observerJoined)
	}

	var sharer *client
	hub.mu.RLock()
	for c := range hub.clients {
		if c.participant.ID == sharerJoined.Participant.ID {
			sharer = c
		}
	}
	hub.mu.RUnlock()
	if sharer == nil {
		t.Fatal("sharer client not found in hub registry")
	}

	// Exercise the hand-state participant update concurrently with config
	// broadcasts that read the screen sharer's participant identity. Run
	// under -race: the update must be synchronized with those readers.
	toggles := make(chan error, 1)
	go func() {
		var err error
		for i := 0; i < 200; i++ {
			raised := i%2 == 0
			err = sharerConn.WriteJSON(Message{
				Version: ProtocolVersion, Type: TypeHandState,
				ParticipantID: sharerJoined.Participant.ID, HandRaised: &raised,
			})
			if err != nil {
				break
			}
		}
		toggles <- err
	}()

	broadcastCfg := cfg
	for i := 0; i < 100; i++ {
		broadcastCfg.EnableScreenShare = i%2 == 1
		if i%2 == 0 {
			hub.mu.Lock()
			hub.screenSharer = sharer
			hub.mu.Unlock()
		}
		hub.BroadcastConfig(broadcastCfg)
	}
	if err := <-toggles; err != nil {
		t.Fatalf("hand state toggling failed: %v", err)
	}
}

func TestHubAnswerWithoutOfferReturnsError(t *testing.T) {
	hub := NewHub(meeting.New(1), config.NewStore(config.Config{}), slog.Default())

	serverConnections := make(chan *websocket.Conn, 1)
	websocketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnections <- conn
	}))
	defer websocketServer.Close()

	browserConn, _, err := websocket.DefaultDialer.Dial("ws"+websocketServer.URL[len("http"):], nil)
	if err != nil {
		t.Fatalf("dial websocket test peer: %v", err)
	}
	defer browserConn.Close()
	serverConn := <-serverConnections
	defer serverConn.Close()

	c := &client{conn: serverConn, finished: make(chan struct{})}
	c.outbound = make(chan *Message, outboundQueueSize)
	c.writerDone = make(chan struct{})
	startTestWriter(t, c)

	hub.handleWebRTCMessage(c, Message{Version: ProtocolVersion, Type: TypeAnswer, SDP: "stray answer"})
	var response Message
	readTestMessage(t, browserConn, &response)
	if response.Type != TypeError || response.Error != "no offer in flight" {
		t.Fatalf("stray answer response = %+v, want no-offer error", response)
	}
}

func TestHubChatRecordedDuringJoinIsDeliveredExactlyOnce(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:          ":8080",
		MaxParticipants:   4,
		RetainChatHistory: true,
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)

	// Chats recorded while the second client is being admitted must reach it
	// exactly once: through the admission replay or the live broadcast. The
	// old snapshot-before-admit ordering could drop them entirely.
	const concurrentChats = 40
	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writes := make(chan struct{})
	go func() {
		defer close(writes)
		for i := 0; i < concurrentChats; i++ {
			writeTestMessage(t, first, Message{
				Version: ProtocolVersion, Type: TypeChat,
				ParticipantID: firstJoined.Participant.ID, ChatText: fmt.Sprintf("burst %d", i),
			})
		}
	}()
	writeTestMessage(t, second, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ali"})
	<-writes

	seen := make(map[string]int)
	collect := func(entry ChatHistoryEntry) {
		seen[entry.ID]++
	}
	var joined Message
	readTestMessage(t, second, &joined)
	if joined.Type != TypeParticipant {
		t.Fatalf("second join response = %+v", joined)
	}
	for _, entry := range joined.ChatHistory {
		collect(entry)
	}
	for len(seen) < concurrentChats {
		var broadcast Message
		readTestMessage(t, second, &broadcast)
		if broadcast.Type != TypeChat {
			continue
		}
		collect(ChatHistoryEntry{ID: broadcast.ChatText})
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("chat %q reached the joiner %d times, want exactly once", id, count)
		}
	}
}

func TestDisconnectBeforeAnnouncementDoesNotBroadcastLeft(t *testing.T) {
	hub := NewHub(meeting.New(4), config.NewStore(config.Config{MaxParticipants: 4}), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	observer := dialTestSocket(t, socketURL)
	defer observer.Close()
	writeTestMessage(t, observer, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Observer"})
	var observerJoined Message
	readTestMessage(t, observer, &observerJoined)
	if observerJoined.Type != TypeParticipant {
		t.Fatalf("observer join response = %+v", observerJoined)
	}

	// The join failed after Meeting.Join reserved the slot but before the room
	// was told about the participant: no phantom left event may be broadcast.
	participant, err := hub.Meeting.Join("Ashkan")
	if err != nil {
		t.Fatalf("join meeting: %v", err)
	}
	hub.disconnect(&client{participant: participant, participantID: participant.ID})
	if got := hub.Meeting.Count(); got != 1 {
		t.Fatalf("meeting participants after failed join = %d, want only the observer", got)
	}
	// A deadline read leaves a Gorilla connection in a broken state, so this
	// observer is consumed by the negative check and never read again.
	assertNoTestMessage(t, observer)

	// An announced departure still broadcasts its left event. A fresh observer
	// receives it because the timed-out read above retired the first one.
	announced, err := hub.Meeting.Join("Ali")
	if err != nil {
		t.Fatalf("join meeting: %v", err)
	}
	receiver := dialTestSocket(t, socketURL)
	defer receiver.Close()
	writeTestMessage(t, receiver, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Receiver"})
	var receiverJoined Message
	readTestMessage(t, receiver, &receiverJoined)
	if receiverJoined.Type != TypeParticipant {
		t.Fatalf("receiver join response = %+v", receiverJoined)
	}
	hub.disconnect(&client{participant: announced, participantID: announced.ID, announced: true})
	var left Message
	for {
		readTestMessage(t, receiver, &left)
		if left.Type == TypeLeft {
			break
		}
	}
	if left.Participant == nil || left.Participant.ID != announced.ID {
		t.Fatalf("announced departure broadcast = %+v", left)
	}
}

func TestAddOrQueueCandidateCapsPendingQueue(t *testing.T) {
	c := &client{}
	c.outbound = make(chan *Message, outboundQueueSize)
	c.writerDone = make(chan struct{})
	peer := &restartSignalingPeer{}

	for i := 0; i < maxPendingCandidates; i++ {
		if err := addOrQueueCandidate(c, peer, Message{Version: ProtocolVersion, Type: TypeCandidate, Candidate: "candidate:queued"}); err != nil {
			t.Fatalf("queue candidate %d: %v", i, err)
		}
	}
	if err := addOrQueueCandidate(c, peer, Message{Version: ProtocolVersion, Type: TypeCandidate, Candidate: "candidate:overflow"}); err == nil {
		t.Fatal("candidate queue overflow was accepted")
	}
	if got := len(c.pendingCandidates); got != maxPendingCandidates {
		t.Fatalf("pending candidates = %d, want %d", got, maxPendingCandidates)
	}
}

func TestICEFailureTeardownClosesConnectionAndCanBeCancelled(t *testing.T) {
	oldDelay := iceFailureTeardownDelay
	iceFailureTeardownDelay = 20 * time.Millisecond
	t.Cleanup(func() { iceFailureTeardownDelay = oldDelay })

	hub := NewHub(meeting.New(2), config.NewStore(config.Config{}), slog.Default())

	serverConnections := make(chan *websocket.Conn, 2)
	websocketServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrader := websocket.Upgrader{}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnections <- conn
	}))
	defer websocketServer.Close()
	dial := func(t *testing.T) (*websocket.Conn, *websocket.Conn) {
		t.Helper()
		browserConn, _, err := websocket.DefaultDialer.Dial("ws"+websocketServer.URL[len("http"):], nil)
		if err != nil {
			t.Fatalf("dial websocket test peer: %v", err)
		}
		t.Cleanup(func() { _ = browserConn.Close() })
		return browserConn, <-serverConnections
	}

	// A cancelled teardown must leave the connection open.
	cancelBrowser, cancelServer := dial(t)
	c := &client{conn: cancelServer, finished: make(chan struct{})}
	hub.scheduleICEFailureTeardown(c)
	hub.cancelICEFailureTeardown(c)
	if err := cancelBrowser.SetReadDeadline(time.Now().Add(100 * time.Millisecond)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	if _, _, err := cancelBrowser.ReadMessage(); err == nil {
		t.Fatal("cancelled ICE failure teardown still closed the connection")
	}

	// An armed teardown closes the connection after the grace period. Each
	// scenario uses a fresh connection because a timed-out read leaves a
	// Gorilla connection in a broken state.
	fireBrowser, fireServer := dial(t)
	hub.scheduleICEFailureTeardown(&client{conn: fireServer, finished: make(chan struct{})})
	if err := fireBrowser.SetReadDeadline(time.Now().Add(3 * time.Second)); err != nil {
		t.Fatalf("set read deadline: %v", err)
	}
	// The teardown closes the raw connection without a close frame, so any
	// non-timeout read error proves the connection was torn down.
	for {
		if _, _, err := fireBrowser.ReadMessage(); err != nil {
			if strings.Contains(err.Error(), "timeout") {
				t.Fatal("ICE failure teardown did not close the connection")
			}
			break
		}
	}
}

func TestHubScreenShareStateCorrectedAfterActiveTakeover(t *testing.T) {
	cfg := config.Config{
		HTTPAddr:          ":8080",
		MaxParticipants:   4,
		EnableScreenShare: true,
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()
	socketURL := "ws" + server.URL[len("http"):]

	first := dialTestSocket(t, socketURL)
	defer first.Close()
	writeTestMessage(t, first, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var firstJoined Message
	readTestMessage(t, first, &firstJoined)
	token := firstJoined.ReconnectToken
	if token == "" {
		t.Fatal("join response did not include a reconnect token")
	}

	screenShareActive := true
	writeTestMessage(t, first, Message{
		Version: ProtocolVersion, Type: TypeScreenShare,
		ParticipantID: firstJoined.Participant.ID, ScreenShareActive: &screenShareActive,
	})
	var shareState Message
	readTestMessage(t, first, &shareState)
	if shareState.Type != TypeScreenState || shareState.ScreenShareActive == nil || !*shareState.ScreenShareActive {
		t.Fatalf("screen share start state = %+v", shareState)
	}

	// A second connection reclaims the still-connected participant. The
	// superseded connection's cleanup releases the screen share before the
	// resumed client can receive broadcasts, so the join path must send the
	// (now inactive) state explicitly.
	second := dialTestSocket(t, socketURL)
	defer second.Close()
	writeTestMessage(t, second, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", ReconnectToken: token,
	})
	var resumed Message
	readTestMessage(t, second, &resumed)
	if resumed.Type != TypeParticipant || resumed.Participant == nil || resumed.Participant.ID != firstJoined.Participant.ID {
		t.Fatalf("resumed join response = %+v", resumed)
	}
	var corrected Message
	readTestMessage(t, second, &corrected)
	if corrected.Type != TypeScreenState || corrected.ScreenShareActive == nil || *corrected.ScreenShareActive {
		t.Fatalf("resumed client screen share state = %+v, want inactive correction", corrected)
	}
}

func TestApplyPendingCandidatesRequeuesRemainderOnError(t *testing.T) {
	c := &client{}
	c.outbound = make(chan *Message, outboundQueueSize)
	c.writerDone = make(chan struct{})
	peer := &restartSignalingPeer{}

	first := Message{Version: ProtocolVersion, Type: TypeCandidate, Candidate: "candidate:first"}
	broken := Message{Version: ProtocolVersion, Type: TypeCandidate, Candidate: "candidate:broken"}
	third := Message{Version: ProtocolVersion, Type: TypeCandidate, Candidate: "candidate:third"}
	c.pendingCandidates = []Message{first, broken, third}
	peer.remoteAnswer = "restart answer"

	peer.failCandidates = map[string]bool{"candidate:broken": true}
	err := applyPendingCandidates(c, peer)
	if err == nil {
		t.Fatal("the failing candidate error was not surfaced")
	}
	if len(peer.candidates) != 1 || peer.candidates[0] != first.Candidate {
		t.Fatalf("applied candidates = %v, want only the first", peer.candidates)
	}
	if len(c.pendingCandidates) != 1 || c.pendingCandidates[0].Candidate != third.Candidate {
		t.Fatalf("queued candidates = %v, want the third preserved for retry", c.pendingCandidates)
	}
}

// seedPublicationFor installs a minimal fixture publication for a participant
// so teardown behavior is observable without a live media path.
func seedPublicationFor(t *testing.T, hub *Hub, participantID string) {
	t.Helper()
	hub.router.AddPublicationFixture(participantID, media.SourceRoleCamera)
}

func publicationRegistered(hub *Hub, participantID string) bool {
	return hub.router.HasPublication(participantID, media.SourceRoleCamera)
}

func waitForHubCondition(t *testing.T, description string, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if condition() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s within 2s", description)
}

func TestDisconnectWithinGraceKeepsPublicationsRegistered(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 4, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 30 * time.Second,
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	defer hub.Close()
	server := httptest.NewServer(hub)
	defer server.Close()

	conn := dialTestSocket(t, "ws"+server.URL[len("http"):])
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, conn, &joined)
	if joined.Type != TypeParticipant || joined.Participant == nil {
		t.Fatalf("join response = %+v", joined)
	}
	participantID := joined.Participant.ID
	seedPublicationFor(t, hub, participantID)

	// An abrupt socket drop inside the grace window must keep the
	// participant's publications registered so the resume can re-bind its
	// streams without an unsubscribe/republish renegotiation cycle.
	conn.Close()
	waitForHubCondition(t, "disconnect did not enter the reconnect grace window", func() bool {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		return len(hub.pending) == 1
	})
	if !publicationRegistered(hub, participantID) {
		t.Fatal("publications were torn down during the reconnect grace window")
	}
	if hub.ActiveParticipants() != 1 {
		t.Fatalf("meeting participants during grace = %d, want the slot kept", hub.ActiveParticipants())
	}

	// The resumed connection reclaims the slot and (with the publication
	// swap) re-binds the streams without renegotiation.
	resumed := dialTestSocket(t, "ws"+server.URL[len("http"):])
	defer resumed.Close()
	writeTestMessage(t, resumed, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", ReconnectToken: joined.ReconnectToken,
	})
	var resumedResponse Message
	readTestMessage(t, resumed, &resumedResponse)
	if resumedResponse.Type != TypeParticipant || resumedResponse.Participant == nil ||
		resumedResponse.Participant.ID != participantID {
		t.Fatalf("resume response = %+v, want the same participant identity", resumedResponse)
	}
	if !publicationRegistered(hub, participantID) {
		t.Fatal("resume tore down the publications that the swap was going to re-bind")
	}
}

func TestGraceExpiryTearsDownDeferredMedia(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 4, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 150 * time.Millisecond,
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	defer hub.Close()
	server := httptest.NewServer(hub)
	defer server.Close()

	conn := dialTestSocket(t, "ws"+server.URL[len("http"):])
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, conn, &joined)
	participantID := joined.Participant.ID
	seedPublicationFor(t, hub, participantID)

	conn.Close()
	waitForHubCondition(t, "disconnect did not enter the reconnect grace window", func() bool {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		return len(hub.pending) == 1
	})
	waitForHubCondition(t, "grace expiry did not tear down the deferred media and slot", func() bool {
		return !publicationRegistered(hub, participantID) && hub.ActiveParticipants() == 0
	})
}

func TestIntentionalLeaveTearsDownMediaImmediately(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 4, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 30 * time.Second,
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	defer hub.Close()
	server := httptest.NewServer(hub)
	defer server.Close()

	conn := dialTestSocket(t, "ws"+server.URL[len("http"):])
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, conn, &joined)
	participantID := joined.Participant.ID
	seedPublicationFor(t, hub, participantID)

	writeTestMessage(t, conn, Message{
		Version: ProtocolVersion, Type: TypeLeave, ParticipantID: participantID,
	})
	waitForHubCondition(t, "intentional leave did not tear down media and the slot immediately", func() bool {
		return !publicationRegistered(hub, participantID) && hub.ActiveParticipants() == 0
	})
}

func TestHubCloseTearsDownGraceWindowMedia(t *testing.T) {
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 4, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout: 30 * time.Second,
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	server := httptest.NewServer(hub)
	defer server.Close()

	conn := dialTestSocket(t, "ws"+server.URL[len("http"):])
	writeTestMessage(t, conn, Message{Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan"})
	var joined Message
	readTestMessage(t, conn, &joined)
	participantID := joined.Participant.ID
	seedPublicationFor(t, hub, participantID)

	// Drop into the reconnect grace window, then shut the hub down: the
	// deferred media (peer connection, publications, forward goroutines)
	// must be released by Close, not outlive it.
	conn.Close()
	waitForHubCondition(t, "disconnect did not enter the reconnect grace window", func() bool {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		return len(hub.pending) == 1
	})

	hub.Close()

	if publicationRegistered(hub, participantID) {
		t.Fatal("hub shutdown left grace-window media registered")
	}
	if hub.ActiveParticipants() != 0 {
		t.Fatalf("hub shutdown left %d meeting slot(s) reserved", hub.ActiveParticipants())
	}
}

// buildGraceState constructs the post-disconnect state directly: a meeting
// slot held by a pending reconnect whose media was deferred, so a test can
// drive a resume against it without replaying the socket drop.
func buildGraceState(t *testing.T, hub *Hub, name string) (meeting.Participant, string) {
	t.Helper()
	participant, err := hub.Meeting.Join(name)
	if err != nil {
		t.Fatalf("meeting join: %v", err)
	}
	token := "token-" + name
	client := &client{
		participant: participant, participantID: participant.ID, reconnectToken: token,
		finished: make(chan struct{}),
	}
	close(client.finished) // the disconnect that created the pending entry has completed
	hub.mu.Lock()
	hub.activeTokens[token] = client
	hub.pending[token] = &pendingReconnect{participant: participant, token: token, client: client}
	hub.mu.Unlock()
	hub.router.AddPublicationFixture(participant.ID, media.SourceRoleCamera)
	return participant, token
}

func TestWebRTCInitFailureAfterReclaimReleasesSlotImmediately(t *testing.T) {
	// An invalid ICE transport policy makes every peer-connection creation
	// fail, deterministically exercising the failed-resume path.
	cfg := config.Config{
		HTTPAddr: ":8080", MaxParticipants: 4, DefaultVideoQuality: "low",
		DefaultVideoFPS: 15, MaxVideoFPS: 30, DefaultAudioBitrate: 32000,
		MaxVideoBitrate: 500000, MaxAudioBitrate: 64000,
		ReconnectTimeout:   30 * time.Second,
		ICETransportPolicy: "bogus",
	}
	hub := NewHub(meeting.New(4), config.NewStore(cfg), slog.Default())
	defer hub.Close()
	server := httptest.NewServer(hub)
	defer server.Close()

	participant, token := buildGraceState(t, hub, "Ashkan")

	resumed := dialTestSocket(t, "ws"+server.URL[len("http"):])
	defer resumed.Close()
	writeTestMessage(t, resumed, Message{
		Version: ProtocolVersion, Type: TypeJoin, Name: "Ashkan", ReconnectToken: token,
	})
	var resumeResponse Message
	readTestMessage(t, resumed, &resumeResponse)
	if resumeResponse.Type != TypeError || resumeResponse.Error != "unable to initialize WebRTC" {
		t.Fatalf("resume response = %+v, want the WebRTC failure", resumeResponse)
	}

	waitForHubCondition(t, "failed resume did not release the reclaimed slot", func() bool {
		return hub.ActiveParticipants() == 0 && len(hub.pending) == 0
	})
	if hub.router.HasPublication(participant.ID, media.SourceRoleCamera) {
		t.Fatal("the grace-window publication outlived the failed resume")
	}
}

func TestAdmissionFailureAfterReclaimReleasesSlotImmediately(t *testing.T) {
	hub := NewHub(meeting.New(4), config.NewStore(config.Config{
		MaxParticipants: 4, ReconnectTimeout: 30 * time.Second,
	}), slog.Default())
	defer hub.Close()

	participant, token := buildGraceState(t, hub, "Ashkan")

	// A resumed client whose admission deadline expires after reclaim: the
	// join flow drops the resume intent (c.resumed = false), and the ensuing
	// disconnect must release the slot and media immediately.
	resumed := &client{
		outbound:   make(chan *Message, outboundQueueSize),
		writerDone: make(chan struct{}),
		finished:   make(chan struct{}),
	}
	if _, resumedOK, _ := hub.reclaim(resumed, token); !resumedOK {
		t.Fatal("reclaim rejected a valid grace-window token")
	}
	hub.expireAdmission(resumed)
	if err := hub.admit(resumed, participant, Message{Version: ProtocolVersion, Type: TypeParticipant}, false); err == nil {
		t.Fatal("admission succeeded past its deadline")
	}
	resumed.resumed = false

	hub.disconnect(resumed)

	waitForHubCondition(t, "failed admission did not release the reclaimed slot", func() bool {
		return hub.ActiveParticipants() == 0 && len(hub.pending) == 0
	})
	if hub.router.HasPublication(participant.ID, media.SourceRoleCamera) {
		t.Fatal("the grace-window publication outlived the failed admission")
	}
}

func TestChatHistoryReArmSurvivesRoomRefill(t *testing.T) {
	oldExpiry := chatHistoryExpiry
	chatHistoryExpiry = 40 * time.Millisecond
	t.Cleanup(func() { chatHistoryExpiry = oldExpiry })

	hub := NewHub(meeting.New(4), config.NewStore(config.Config{RetainChatHistory: true}), slog.Default())
	defer hub.Close()

	hub.recordChatMessage("default", ChatHistoryEntry{ID: "m1", Text: "kept"})
	hub.scheduleChatHistoryExpiry("default")

	// The room refills just before the first expiry fires; the re-armed timer
	// must not delete the history while the room is occupied.
	time.Sleep(20 * time.Millisecond)
	if _, err := hub.Meeting.Join("Late"); err != nil {
		t.Fatalf("refill join: %v", err)
	}
	time.Sleep(80 * time.Millisecond)

	hub.mu.RLock()
	history := hub.chatHistory["default"]
	hub.mu.RUnlock()
	if history == nil || len(history.messages) != 1 {
		t.Fatalf("re-armed expiry deleted history while the room was occupied: %+v", history)
	}

	// Once the room empties again, the re-armed timer cleans up.
	hub.mu.Lock()
	participants := hub.Meeting.List()
	hub.mu.Unlock()
	for _, participant := range participants {
		_ = hub.Meeting.Leave(participant.ID)
	}
	waitForHubCondition(t, "re-armed expiry did not clean the emptied room's history", func() bool {
		hub.mu.RLock()
		defer hub.mu.RUnlock()
		return hub.chatHistory["default"] == nil
	})
}
