package webrtc

import (
	"encoding/binary"
	"runtime"
	"sync"
	"testing"
	"time"

	pion "github.com/pion/webrtc/v4"
)

// arrivalLog records when stream packets arrive so a test can measure the
// longest silence on a path.
type arrivalLog struct {
	mu    sync.Mutex
	times []time.Time
}

func (l *arrivalLog) add() {
	l.mu.Lock()
	l.times = append(l.times, time.Now())
	l.mu.Unlock()
}

// longestGap returns the longest interval without an arrival inside
// [from, to], counting the window edges.
func (l *arrivalLog) longestGap(from, to time.Time) time.Duration {
	l.mu.Lock()
	defer l.mu.Unlock()
	previous := from
	var longest time.Duration
	for _, at := range l.times {
		if at.Before(from) || at.After(to) {
			continue
		}
		if gap := at.Sub(previous); gap > longest {
			longest = gap
		}
		previous = at
	}
	if gap := to.Sub(previous); gap > longest {
		longest = gap
	}
	return longest
}

// restartPair is a SlowMeet server Peer connected over loopback to a plain
// pion client peer, with an unreliable data channel streaming both ways.
type restartPair struct {
	server         *Peer
	client         *pion.PeerConnection
	atServer       *arrivalLog
	atClient       *arrivalLog
	stopStreaming  chan struct{}
	streamingEnded sync.WaitGroup
}

func (p *restartPair) close() {
	close(p.stopStreaming)
	p.streamingEnded.Wait()
	_ = p.client.Close()
	_ = p.server.Close()
}

// streamOn sends a small sequenced packet every 20 ms until stop closes,
// like a 50 packets/s audio stream.
func streamOn(channel *pion.DataChannel, stop <-chan struct{}, done *sync.WaitGroup) {
	done.Add(1)
	go func() {
		defer done.Done()
		ticker := time.NewTicker(20 * time.Millisecond)
		defer ticker.Stop()
		packet := make([]byte, 160)
		var sequence uint32
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				binary.BigEndian.PutUint32(packet, sequence)
				sequence++
				// A send during a path gap is expected to fail or be dropped;
				// the arrival log is what the test judges.
				_ = channel.Send(packet)
			}
		}
	}()
}

// offerFromServer runs one full offer/answer round with candidates embedded in
// the descriptions. holdAnswer delays the answer on its way back to the
// server, modelling the signaling round trip plus the browser's candidate
// gathering during which a restarted server has no new path yet.
func (p *restartPair) offerFromServer(t *testing.T, iceRestart bool, holdAnswer time.Duration) {
	t.Helper()
	serverGathered := pion.GatheringCompletePromise(p.server.Connection())
	if _, err := p.server.CreateOffer(iceRestart); err != nil {
		t.Fatalf("server offer: %v", err)
	}
	<-serverGathered
	if err := p.client.SetRemoteDescription(*p.server.Connection().LocalDescription()); err != nil {
		t.Fatalf("client set offer: %v", err)
	}
	clientGathered := pion.GatheringCompletePromise(p.client)
	answer, err := p.client.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("client answer: %v", err)
	}
	if err := p.client.SetLocalDescription(answer); err != nil {
		t.Fatalf("client set answer: %v", err)
	}
	<-clientGathered
	time.Sleep(holdAnswer)
	if err := p.server.SetRemoteAnswer(p.client.LocalDescription().SDP); err != nil {
		t.Fatalf("server set answer: %v", err)
	}
}

func newRestartPair(t *testing.T) *restartPair {
	t.Helper()
	server, err := NewPeerWithConfiguration(pion.Configuration{})
	if err != nil {
		t.Fatalf("server peer: %v", err)
	}
	client, err := pion.NewPeerConnection(pion.Configuration{})
	if err != nil {
		_ = server.Close()
		t.Fatalf("client peer: %v", err)
	}
	pair := &restartPair{
		server: server, client: client,
		atServer: &arrivalLog{}, atClient: &arrivalLog{},
		stopStreaming: make(chan struct{}),
	}
	unordered := false
	noRetransmits := uint16(0)
	serverChannel, err := server.Connection().CreateDataChannel("stream", &pion.DataChannelInit{
		Ordered: &unordered, MaxRetransmits: &noRetransmits,
	})
	if err != nil {
		pair.close()
		t.Fatalf("data channel: %v", err)
	}
	opened := make(chan struct{}, 2)
	serverChannel.OnOpen(func() {
		streamOn(serverChannel, pair.stopStreaming, &pair.streamingEnded)
		opened <- struct{}{}
	})
	serverChannel.OnMessage(func(pion.DataChannelMessage) { pair.atServer.add() })
	client.OnDataChannel(func(clientChannel *pion.DataChannel) {
		clientChannel.OnOpen(func() {
			streamOn(clientChannel, pair.stopStreaming, &pair.streamingEnded)
			opened <- struct{}{}
		})
		clientChannel.OnMessage(func(pion.DataChannelMessage) { pair.atClient.add() })
	})
	pair.offerFromServer(t, false, 0)
	for range 2 {
		select {
		case <-opened:
		case <-time.After(10 * time.Second):
			pair.close()
			t.Fatal("data channel did not open")
		}
	}
	return pair
}

func selectedPairID(t *testing.T, connection *pion.PeerConnection) string {
	t.Helper()
	pair, err := connection.SCTP().Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil {
		t.Fatalf("selected candidate pair unavailable: %v", err)
	}
	return pair.Local.String() + " <-> " + pair.Remote.String()
}

// A relay rotation is an ICE restart every few seconds. The server must keep
// media flowing on the old candidate pair until the restarted pair is
// selected; upstream pion/ice drops the old pair the moment the restart offer
// is created, which showed up as a 1-2 second audio/video freeze on every
// rotation (docs/vps-regression-diagnostics.md).
func TestICERestartKeepsMediaFlowingUntilNewPairIsSelected(t *testing.T) {
	pair := newRestartPair(t)
	defer pair.close()

	time.Sleep(500 * time.Millisecond) // steady state before the restart
	before := selectedPairID(t, pair.server.Connection())

	const answerHold = time.Second
	restartStarted := time.Now()
	pair.offerFromServer(t, true, answerHold)

	deadline := time.Now().Add(10 * time.Second)
	for pair.server.Connection().ICEConnectionState() != pion.ICEConnectionStateConnected &&
		pair.server.Connection().ICEConnectionState() != pion.ICEConnectionStateCompleted {
		if time.Now().After(deadline) {
			t.Fatalf("ICE did not reconnect after the restart: %s", pair.server.Connection().ICEConnectionState())
		}
		time.Sleep(20 * time.Millisecond)
	}
	time.Sleep(500 * time.Millisecond) // steady state on the new pair
	restartEnded := time.Now()

	if after := selectedPairID(t, pair.server.Connection()); after == before {
		t.Fatalf("the restart did not move to a new candidate pair: %s", after)
	}
	const tolerated = 300 * time.Millisecond
	if gap := pair.atClient.longestGap(restartStarted, restartEnded); gap > tolerated {
		t.Errorf("server -> client stream went silent for %v during the restart (tolerated %v)", gap, tolerated)
	}
	if gap := pair.atServer.longestGap(restartStarted, restartEnded); gap > tolerated {
		t.Errorf("client -> server stream went silent for %v during the restart (tolerated %v)", gap, tolerated)
	}
}

// Rotation restarts ICE for the whole meeting, so the path kept alive across
// each restart must be released once the new pair takes over.
func TestRepeatedICERestartsReleaseTheOldPath(t *testing.T) {
	pair := newRestartPair(t)
	defer pair.close()

	settle := func() int {
		time.Sleep(300 * time.Millisecond)
		runtime.GC()
		return runtime.NumGoroutine()
	}
	restart := func() {
		pair.offerFromServer(t, true, 0)
		deadline := time.Now().Add(10 * time.Second)
		for pair.server.Connection().ICEConnectionState() != pion.ICEConnectionStateConnected &&
			pair.server.Connection().ICEConnectionState() != pion.ICEConnectionStateCompleted {
			if time.Now().After(deadline) {
				t.Fatalf("ICE did not reconnect: %s", pair.server.Connection().ICEConnectionState())
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	for range 3 {
		restart()
	}
	baseline := settle()
	started := time.Now()
	for range 12 {
		restart()
	}
	if grown := settle() - baseline; grown > 8 {
		t.Fatalf("goroutines grew by %d across 12 restarts: a kept-alive path is not being released", grown)
	}
	if gap := pair.atClient.longestGap(started, time.Now()); gap > 500*time.Millisecond {
		t.Errorf("stream went silent for %v across back-to-back restarts", gap)
	}
}
