//go:build weaknet

// Real peer connections forwarding media through a genuinely impaired
// loopback: tc netem limits the namespace's bandwidth, delay, and loss while
// live RTP flows publisher → SFU → subscriber. The tests pin the weak-network
// guarantees from docs/network-testing.md at the transport level: audio
// survives impairment that starves video, loss is repaired, and removing the
// impairment restores the flow without renegotiation. They only run inside
// scripts/test-go-weaknet.sh, which provides a disposable network namespace;
// SLOWMEET_WEAKNET_NETNS guards against ever shaping a host interface.
package media

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/pion/logging"

	internalwebrtc "SlowMeet/internal/webrtc"
	"github.com/pion/ice/v4"
	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	pion "github.com/pion/webrtc/v4"
)

// Inside the disposable namespace there is no multicast route for mDNS
// candidate resolution, so the fixture peers use the app's own loopback peer
// path: mDNS disabled, NAT 1-to-1 onto 127.0.0.1, loopback candidates only.
func newWeakNetPionPeer(t *testing.T) *pion.PeerConnection {
	return newWeakNetPionPeerWithPorts(t, 0, 0)
}

// newWeakNetPionPeerWithPorts pins the peer's ICE sockets to a UDP port block
// so per-participant traffic classifiers can match its flows by port.
func newWeakNetPionPeerWithPorts(t *testing.T, portMin, portMax uint16) *pion.PeerConnection {
	t.Helper()
	settingEngine := pion.SettingEngine{}
	settingEngine.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
	settingEngine.SetNetworkTypes([]pion.NetworkType{pion.NetworkTypeUDP4})
	settingEngine.SetIncludeLoopbackCandidate(true)
	if portMin != 0 && portMax != 0 {
		if err := settingEngine.SetEphemeralUDPPortRange(portMin, portMax); err != nil {
			t.Fatalf("pin weak-network UDP port range: %v", err)
		}
	}
	if os.Getenv("SLOWMEET_WEAKNET_DEBUG") == "1" {
		factory := logging.NewDefaultLoggerFactory()
		factory.DefaultLogLevel = logging.LogLevelDebug
		settingEngine.LoggerFactory = factory
	}
	api := pion.NewAPI(pion.WithSettingEngine(settingEngine))
	peer, err := api.NewPeerConnection(pion.Configuration{})
	if err != nil {
		t.Fatalf("create weak-network Pion peer: %v", err)
	}
	return peer
}

func newWeakNetWrapperPeer(t *testing.T) *internalwebrtc.Peer {
	t.Helper()
	peer, err := internalwebrtc.NewPeerWithTURNURLsAndPortRangeAndPolicyAndPublicIP(
		nil, nil, "", "", 0, 0, true, "all", "127.0.0.1")
	if err != nil {
		t.Fatalf("create weak-network wrapped peer: %v", err)
	}
	return peer
}

const weakNetGuard = "SLOWMEET_WEAKNET_NETNS"

// weakNetAudioPayloadBytes and weakNetVideoPayloadBytes are realistic wire
// sizes: ~20ms Opus frames and ~1200-byte video RTP packets. netem shapes by
// wire bytes, so tiny synthetic payloads would never congest the pipe.
const (
	weakNetAudioPayloadBytes = 120
	weakNetVideoPayloadBytes = 1200
	weakNetAudioInterval     = 20 * time.Millisecond
	weakNetVideoInterval     = 33 * time.Millisecond
)

type weakNetSink struct {
	mu         sync.Mutex
	audioCount int
	videoCount int
	nacks      int
	lastVideo  uint16
	videoSeen  map[uint16]struct{}
	gapTotal   int
	repaired   int
}

func newWeakNetSink() *weakNetSink {
	return &weakNetSink{videoSeen: make(map[uint16]struct{})}
}

// readPublisherNACKs counts retransmission requests that reach the
// publisher's camera sender. The SFU relays subscriber NACKs to the
// publisher with the media SSRC rewritten, so this counter proves the whole
// loss-repair loop (subscriber NACK → SFU relay → publisher RTX) is alive.
func (s *weakNetSink) readPublisherNACKs(sender *pion.RTPSender) {
	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.TransportLayerNack); ok {
					s.mu.Lock()
					s.nacks++
					s.mu.Unlock()
				}
			}
		}
	}()
}

func (s *weakNetSink) record(kind pion.RTPCodecType, sequence uint16) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if kind == pion.RTPCodecTypeAudio {
		s.audioCount++
		return
	}
	s.videoCount++
	_, duplicate := s.videoSeen[sequence]
	s.videoSeen[sequence] = struct{}{}
	if s.lastVideo != 0 && sequence < s.lastVideo {
		if !duplicate {
			// A sequence below the high-water mark that was never seen before
			// is a retransmission the receiver pulled back with NACK, or an
			// SFU repair frame: proof that loss was repaired instead of
			// ending the stream. Pion's receive-side NACK buffer releases
			// packets in order, so repairs do not surface as out-of-order
			// reads — they surface as previously missing sequences arriving.
			s.repaired++
		}
		return
	}
	if s.lastVideo != 0 && sequence > s.lastVideo {
		s.gapTotal += int(sequence - s.lastVideo - 1)
	}
	s.lastVideo = sequence
}

// counts reports subscriber arrivals plus how many video sequences were
// missing at the high-water mark and how many of those arrived late through
// repair. Unresolved gaps cost a corrupted frame until the next keyframe.
func (s *weakNetSink) counts() (audio, video, missing, repaired, nacks int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	unresolved := s.gapTotal - s.repaired
	if unresolved < 0 {
		unresolved = 0
	}
	return s.audioCount, s.videoCount, unresolved, s.repaired, s.nacks
}

func skipWithoutWeakNetNamespace(t *testing.T) {
	t.Helper()
	if os.Getenv(weakNetGuard) != "1" {
		t.Skip("weak-network integration tests must run through scripts/test-go-weaknet.sh")
	}
	if _, err := exec.Command("tc", "qdisc", "show", "dev", "lo").CombinedOutput(); err != nil {
		t.Skip("tc is unavailable inside the weak-network namespace")
	}
}

func applyWeakNetProfile(t *testing.T, rate, delay, loss string) {
	t.Helper()
	args := []string{"qdisc", "replace", "dev", "lo", "root", "netem", "rate", rate, "delay", delay}
	if loss != "" {
		args = append(args, "loss", loss)
	}
	out, err := exec.Command("tc", args...).CombinedOutput()
	if err != nil {
		t.Fatalf("apply netem profile: %v: %s", err, strings.TrimSpace(string(out)))
	}
	t.Cleanup(func() {
		_ = exec.Command("tc", "qdisc", "del", "dev", "lo", "root").Run()
	})
}

// newWeakNetFixture wires a publisher and one subscriber through the router on
// clean loopback. Impairment is applied after the peers are connected, the way
// a call degrades mid-meeting on a weak link, so the ICE and DTLS handshakes
// never run under the shaped pipe. It returns the publisher's tracks for
// streaming, the sink collecting what the subscriber received, and the
// subscriber peer for connection-state checks.
func newWeakNetFixture(t *testing.T, limits Limits) (*weakNetSink, *pion.PeerConnection) {
	t.Helper()
	router := NewRouter(limits)

	sourceClient := newWeakNetPionPeer(t)
	sourceIngress := newWeakNetWrapperPeer(t)
	targetEgress := newWeakNetWrapperPeer(t)
	targetClient := newWeakNetPionPeer(t)
	t.Cleanup(func() {
		router.Unregister("source")
		router.Unregister("target")
		_ = sourceClient.Close()
		_ = targetClient.Close()
		_ = sourceIngress.Close()
		_ = targetEgress.Close()
	})

	sink := newWeakNetSink()
	targetTracks := make(chan receivedRTP, 3)
	targetClient.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		targetTracks <- receivedRTP{kind: track.Kind(), track: track}
		go func() {
			for {
				packet, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				sink.record(track.Kind(), packet.SequenceNumber)
			}
		}()
	})

	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeAudio, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add audio receive transceiver: %v", err)
	}
	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeVideo, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add video receive transceiver: %v", err)
	}

	router.SetVideoSubscriptionsWithLayer("target", []string{"source"}, "medium")
	router.Register("source", sourceIngress, nil)
	router.Register("target", targetEgress, nil)

	audioTrack := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2,
	}, "source-audio")
	videoTrack := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType: pion.MimeTypeVP8, ClockRate: 90000,
	}, "source-video")
	if _, err := sourceClient.AddTrack(audioTrack); err != nil {
		t.Fatalf("add audio track: %v", err)
	}
	videoSender, err := sourceClient.AddTrack(videoTrack)
	if err != nil {
		t.Fatalf("add camera track: %v", err)
	}
	sink.readPublisherNACKs(videoSender)
	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		role := SourceRoleCamera
		if track.Kind() == pion.RTPCodecTypeAudio {
			role = SourceRoleAudio
		}
		router.Publish("source", role, sourceIngress, track)
	})

	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "source client")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "source ingress")

	sendWeakNetPacket(t, audioTrack, pion.RTPCodecTypeAudio, 120)
	sendWeakNetPacket(t, videoTrack, pion.RTPCodecTypeVideo, 1200)
	waitIntegrationPublicationTargets(t, router, 2, 2)
	negotiateIntegrationPeers(t, targetEgress.Connection(), targetClient)
	waitIntegrationPeerConnected(t, targetClient, "target client")
	waitIntegrationPeerConnected(t, targetEgress.Connection(), "target egress")

	// Stream continuously from here: the pre-negotiation probes were written
	// before the subscriber transport existed, and isolated probes race the
	// receiver binding, so the subscriber's OnTrack needs a live flow.
	stop := make(chan struct{})
	sendWeakNetPackets(audioTrack, pion.RTPCodecTypeAudio, weakNetAudioInterval, weakNetAudioPayloadBytes, stop)
	sendWeakNetPackets(videoTrack, pion.RTPCodecTypeVideo, weakNetVideoInterval, weakNetVideoPayloadBytes, stop)
	t.Cleanup(func() { close(stop) })

	seen := make(map[pion.RTPCodecType]bool)
	deadline := time.After(10 * time.Second)
	for len(seen) < 2 {
		select {
		case received := <-targetTracks:
			seen[received.kind] = true
		case <-deadline:
			audioIn, videoIn, _, _, _ := sink.counts()
			audioPub := router.currentPublication("source/audio")
			cameraPub := router.currentPublication("source/camera")
			pubAges := func(p *publication) string {
				if p == nil {
					return "nil"
				}
				last := p.lastPacketAt.Load()
				if last == 0 {
					return "no-packets"
				}
				return fmt.Sprintf("last-packet %s ago", time.Since(time.Unix(0, last)).Round(time.Millisecond))
			}
			t.Fatalf("timed out waiting for forwarded tracks; seen %v\n"+
				"states: source=%s/%s ingress=%s/%s egress=%s/%s target=%s/%s\n"+
				"subscriber sink: audio=%d video=%d; publications: audio=%s camera=%s",
				seen,
				sourceClient.ConnectionState(), sourceClient.ICEConnectionState(),
				sourceIngress.Connection().ConnectionState(), sourceIngress.Connection().ICEConnectionState(),
				targetEgress.Connection().ConnectionState(), targetEgress.Connection().ICEConnectionState(),
				targetClient.ConnectionState(), targetClient.ICEConnectionState(),
				audioIn, videoIn,
				pubAges(audioPub), pubAges(cameraPub))
		}
	}
	return sink, targetClient
}

func sendWeakNetPacket(t *testing.T, track *pion.TrackLocalStaticRTP, kind pion.RTPCodecType, payloadBytes int) {
	t.Helper()
	packet := &rtp.Packet{
		Header: rtp.Header{
			Version:     2,
			Marker:      kind == pion.RTPCodecTypeVideo,
			PayloadType: integrationPayloadType(kind),
			SSRC:        42 + uint32(kind),
		},
		Payload: make([]byte, payloadBytes),
	}
	if err := track.WriteRTP(packet); err != nil {
		t.Fatalf("write %s RTP: %v", kind, err)
	}
}

// sendWeakNetPackets streams realistically sized packets at a steady cadence
// until the stop channel closes, so the impaired link carries a sustained
// flow for the whole measurement window.
func sendWeakNetPackets(track *pion.TrackLocalStaticRTP, kind pion.RTPCodecType, interval time.Duration, payloadBytes int, stop <-chan struct{}) {
	clockRate := uint32(90000)
	if kind == pion.RTPCodecTypeAudio {
		clockRate = 48000
	}
	go func() {
		sequence := uint16(100)
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				packet := &rtp.Packet{
					Header: rtp.Header{
						Version:        2,
						Marker:         kind == pion.RTPCodecTypeVideo,
						PayloadType:    integrationPayloadType(kind),
						SequenceNumber: sequence,
						Timestamp:      uint32(sequence) * (clockRate / 1000) * uint32(interval/time.Millisecond),
						SSRC:           42 + uint32(kind),
					},
					Payload: make([]byte, payloadBytes),
				}
				if err := track.WriteRTP(packet); err != nil {
					return
				}
				sequence++
			}
		}
	}()
}

func waitWeakNetConnected(t *testing.T, peer *pion.PeerConnection, name string) {
	t.Helper()
	if state := peer.ConnectionState(); state != pion.PeerConnectionStateConnected {
		t.Fatalf("%s connection state after impairment = %s, want connected", name, state)
	}
}

func removeWeakNetProfile(t *testing.T) {
	t.Helper()
	_ = exec.Command("tc", "qdisc", "del", "dev", "lo", "root").Run()
}

// Random loss over a clean pipe (the 500 kbps profile from
// docs/network-testing.md, with 3% loss instead of 1% so an 8s window sees
// enough gaps): the SFU's 150 kbps video cap keeps total egress well under
// the rate, so netem's queue never stands and every drop is genuine loss the
// receiver must repair through NACK while audio keeps flowing.
func TestWeakNetModerateImpairmentRepairsLossAndKeepsAudio(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	sink, targetClient := newWeakNetFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	})

	time.Sleep(2 * time.Second)
	applyWeakNetProfile(t, "500kbit", "100ms", "3%")
	time.Sleep(8 * time.Second)

	audio, video, missing, _, nacks := sink.counts()
	if audio < 100 {
		t.Fatalf("audio packets over the impaired window = %d, want >= 100: audio must survive a 500kbit/3%% link", audio)
	}
	if video < 40 {
		t.Fatalf("video packets over the impaired window = %d, want >= 40", video)
	}
	if missing == 0 {
		t.Fatalf("no sequence gaps over the impaired window: netem loss at 3%% never reached the subscriber (audio=%d video=%d)", audio, video)
	}
	if nacks < 1 {
		t.Fatalf("the publisher never saw a NACK over the impaired window: the loss-repair loop is dead (%d missing sequences, audio=%d video=%d)", missing, audio, video)
	}
	waitWeakNetConnected(t, targetClient, "target")

	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	afterAudio, _, _, _, _ := sink.counts()
	if afterAudio == audio {
		t.Fatal("audio stopped flowing after the impairment was lifted")
	}
	waitWeakNetConnected(t, targetClient, "target")
}

// The 100 kbps / 300 ms / 5% profile: the pipe fits audio and only scraps of
// video, matching the documented expectation that video degrades before audio
// and the connection itself survives.
func TestWeakNetSevereImpairmentDegradesVideoBeforeAudio(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	sink, targetClient := newWeakNetFixture(t, Limits{
		MaxAudioBitrate: 48_000, MaxVideoBitrate: 60_000, MaxVideoFPS: 15,
	})

	time.Sleep(2 * time.Second)
	applyWeakNetProfile(t, "100kbit", "300ms", "5%")
	time.Sleep(8 * time.Second)

	audio, video, missing, _, _ := sink.counts()
	if audio < 100 {
		t.Fatalf("audio packets over the impaired window = %d, want >= 100: audio must survive a 100kbit/5%% link", audio)
	}
	if video > audio/2 {
		t.Fatalf("video packets = %d vs audio = %d: video must degrade long before audio at 100kbit", video, audio)
	}
	if missing == 0 && video > 0 {
		t.Fatalf("no sequence gaps over the impaired window: netem loss at 5%% never reached the subscriber (audio=%d video=%d)", audio, video)
	}
	waitWeakNetConnected(t, targetClient, "target")

	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	afterAudio, afterVideo, _, _, _ := sink.counts()
	if afterAudio == audio {
		t.Fatal("audio stopped flowing after the impairment was lifted")
	}
	if afterVideo == video {
		t.Fatal("video stopped flowing after the impairment was lifted")
	}
	waitWeakNetConnected(t, targetClient, "target")
}

// weakNetLocalPort reads the UDP port of the peer's host candidate so room
// classifiers can match its flows in both directions.
func weakNetLocalPort(t *testing.T, peer *pion.PeerConnection) uint16 {
	t.Helper()
	description := peer.LocalDescription()
	if description == nil {
		t.Fatal("peer has no local description for port discovery")
	}
	for _, line := range strings.Split(strings.ReplaceAll(description.SDP, "\r", ""), "\n") {
		if !strings.HasPrefix(line, "a=candidate:") {
			continue
		}
		fields := strings.Fields(line)
		// a=candidate:<foundation> <component> udp <priority> <addr> <port> typ host
		if len(fields) >= 6 && fields[2] == "udp" {
			var port int
			if _, err := fmt.Sscanf(fields[5], "%d", &port); err == nil && port > 0 && port < 65536 {
				return uint16(port)
			}
		}
	}
	t.Fatal("no udp host candidate in the local description")
	return 0
}

// weakNetTier is one per-participant link quality.
type weakNetTier struct {
	rate  string
	delay string
	loss  string
}

var (
	weakNetTierClean    = weakNetTier{rate: "", delay: "", loss: ""}
	weakNetTierModerate = weakNetTier{rate: "200kbit", delay: "200ms", loss: "3%"}
	weakNetTierSevere   = weakNetTier{rate: "100kbit", delay: "300ms", loss: "5%"}
)

// The room qdisc shapes one loopback with per-participant classes: an htb
// root with a large clean default class and one impaired class per tier, so
// flows matched to a participant's UDP port inherit that participant's link
// quality in both directions while everyone else stays clean.
func installWeakNetRoomQdisc(t *testing.T) {
	t.Helper()
	run := func(name string, args ...string) {
		t.Helper()
		out, err := exec.Command(name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("install room qdisc: %v: %s", err, strings.TrimSpace(string(out)))
		}
	}
	run("tc", "qdisc", "replace", "dev", "lo", "root", "handle", "1:", "htb", "default", "10")
	run("tc", "class", "add", "dev", "lo", "parent", "1:", "classid", "1:10", "htb", "rate", "10gbit", "ceil", "10gbit")
	for tier, class := range map[weakNetTier][2]string{
		weakNetTierModerate: {"1:20", "20:"},
		weakNetTierSevere:   {"1:30", "30:"},
	} {
		run("tc", "class", "add", "dev", "lo", "parent", "1:", "classid", class[0], "htb", "rate", tier.rate, "ceil", tier.rate)
		run("tc", "qdisc", "add", "dev", "lo", "parent", class[0], "handle", class[1], "netem",
			"delay", tier.delay, "loss", tier.loss)
	}
	t.Cleanup(func() { _ = exec.Command("tc", "qdisc", "del", "dev", "lo", "root").Run() })
}

func classifyWeakNetPort(t *testing.T, port uint16, tier weakNetTier) {
	t.Helper()
	var classID string
	switch tier {
	case weakNetTierClean:
		return // the default class is already clean
	case weakNetTierModerate:
		classID = "1:20"
	case weakNetTierSevere:
		classID = "1:30"
	default:
		t.Fatalf("unknown weak-network tier %+v", tier)
	}
	portArg := fmt.Sprintf("%d", port)
	for _, selector := range []string{"sport", "dport"} {
		out, err := exec.Command("tc", "filter", "add", "dev", "lo", "protocol", "ip",
			"parent", "1:", "prio", "1", "u32",
			"match", "ip", selector, portArg, "0xffff", "flowid", classID).CombinedOutput()
		if err != nil {
			t.Fatalf("classify port %d (%s): %v: %s", port, selector, err, strings.TrimSpace(string(out)))
		}
	}
}

// weakNetNACKCounter counts retransmission requests reaching the publisher's
// camera sender across every subscriber in the room.
type weakNetNACKCounter struct {
	mu    sync.Mutex
	nacks int
}

func (c *weakNetNACKCounter) read(sender *pion.RTPSender) {
	go func() {
		for {
			packets, _, err := sender.ReadRTCP()
			if err != nil {
				return
			}
			for _, packet := range packets {
				if _, ok := packet.(*rtcp.TransportLayerNack); ok {
					c.mu.Lock()
					c.nacks++
					c.mu.Unlock()
				}
			}
		}
	}()
}

func (c *weakNetNACKCounter) count() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.nacks
}

type weakNetRoomSubscriber struct {
	id   string
	tier weakNetTier
	sink *weakNetSink
	peer *pion.PeerConnection
	port uint16
}

// subscriberEgressConnection resolves a registered subscriber's SFU-side
// peer connection for negotiation.
func subscriberEgressConnection(t *testing.T, router *Router, id string) *pion.PeerConnection {
	t.Helper()
	router.mu.RLock()
	peer := router.peers[id]
	router.mu.RUnlock()
	if peer == nil {
		t.Fatalf("subscriber %q is not registered with the router", id)
	}
	return peer.Connection()
}

// newWeakNetRoomFixture wires one publisher and three subscribers (clean,
// moderate, severe) through the router on clean loopback, with per-subscriber
// UDP port blocks for the room classifiers. Sustained streaming starts inside
// the fixture; impairment classes are applied afterwards by the test.
func newWeakNetRoomFixture(t *testing.T, limits Limits) (
	*weakNetNACKCounter,
	*[3]*weakNetRoomSubscriber,
) {
	t.Helper()
	router := NewRouter(limits)
	sourceClient := newWeakNetPionPeer(t)
	sourceIngress := newWeakNetWrapperPeer(t)
	t.Cleanup(func() {
		router.Unregister("source")
		_ = sourceClient.Close()
		_ = sourceIngress.Close()
	})

	const subscriberCount = 3
	tiers := [3]weakNetTier{weakNetTierClean, weakNetTierModerate, weakNetTierSevere}
	portBlocks := [3][2]uint16{{52000, 52019}, {52100, 52119}, {52200, 52219}}
	ids := [3]string{"clean", "moderate", "severe"}
	subscribers := &[3]*weakNetRoomSubscriber{}

	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeAudio, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add audio receive transceiver: %v", err)
	}
	if _, err := sourceIngress.Connection().AddTransceiverFromKind(
		pion.RTPCodecTypeVideo, pion.RTPTransceiverInit{Direction: pion.RTPTransceiverDirectionRecvonly},
	); err != nil {
		t.Fatalf("add video receive transceiver: %v", err)
	}

	router.Register("source", sourceIngress, nil)
	for i, id := range ids {
		subscriber := &weakNetRoomSubscriber{id: id, tier: tiers[i], sink: newWeakNetSink()}
		subscribers[i] = subscriber
		egress := newWeakNetWrapperPeer(t)
		client := newWeakNetPionPeerWithPorts(t, portBlocks[i][0], portBlocks[i][1])
		subscriber.peer = client
		client.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
			go func() {
				for {
					packet, _, err := track.ReadRTP()
					if err != nil {
						return
					}
					subscriber.sink.record(track.Kind(), packet.SequenceNumber)
				}
			}()
		})
		router.SetVideoSubscriptionsWithLayer(id, []string{"source"}, "medium")
		router.Register(id, egress, nil)
		t.Cleanup(func() {
			router.Unregister(id)
			_ = client.Close()
			_ = egress.Close()
		})
	}

	audioTrack := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2,
	}, "source-audio")
	videoTrack := newIntegrationTrack(pion.RTPCodecCapability{
		MimeType: pion.MimeTypeVP8, ClockRate: 90000,
	}, "source-video")
	if _, err := sourceClient.AddTrack(audioTrack); err != nil {
		t.Fatalf("add audio track: %v", err)
	}
	videoSender, err := sourceClient.AddTrack(videoTrack)
	if err != nil {
		t.Fatalf("add camera track: %v", err)
	}
	feedback := &weakNetNACKCounter{}
	feedback.read(videoSender)

	sourceIngress.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
		role := SourceRoleCamera
		if track.Kind() == pion.RTPCodecTypeAudio {
			role = SourceRoleAudio
		}
		router.Publish("source", role, sourceIngress, track)
	})

	negotiateIntegrationPeers(t, sourceClient, sourceIngress.Connection())
	waitIntegrationPeerConnected(t, sourceClient, "source client")
	waitIntegrationPeerConnected(t, sourceIngress.Connection(), "source ingress")

	sendWeakNetPacket(t, audioTrack, pion.RTPCodecTypeAudio, weakNetAudioPayloadBytes)
	sendWeakNetPacket(t, videoTrack, pion.RTPCodecTypeVideo, weakNetVideoPayloadBytes)
	waitIntegrationPublicationTargets(t, router, 2, 5)

	// Bring every subscriber's egress pair up and remember its bound UDP
	// port for the room classifiers.
	for i, id := range ids {
		subscriber := subscribers[i]
		egressConnection := subscriberEgressConnection(t, router, id)
		negotiateIntegrationPeers(t, egressConnection, subscriber.peer)
		waitIntegrationPeerConnected(t, subscriber.peer, id+" client")
		waitIntegrationPeerConnected(t, egressConnection, id+" egress")
		subscriber.port = weakNetLocalPort(t, subscriber.peer)
	}

	// Stream continuously: isolated probes race the receiver bindings.
	stop := make(chan struct{})
	sendWeakNetPackets(audioTrack, pion.RTPCodecTypeAudio, weakNetAudioInterval, weakNetAudioPayloadBytes, stop)
	sendWeakNetPackets(videoTrack, pion.RTPCodecTypeVideo, weakNetVideoInterval, weakNetVideoPayloadBytes, stop)
	t.Cleanup(func() { close(stop) })

	deadline := time.After(20 * time.Second)
	for i, subscriber := range subscribers {
		for subscriber.sink.arrived() < 2 {
			select {
			case <-deadline:
				audioCount, videoCount, _, _, _ := subscriber.sink.counts()
				t.Fatalf("%s subscriber never received both tracks (audio=%d video=%d)", ids[i], audioCount, videoCount)
			default:
			}
			time.Sleep(20 * time.Millisecond)
		}
	}
	return feedback, subscribers
}

// arrived tracks how many distinct kinds the sink has seen; the two-person
// sink counts arrivals implicitly through OnTrack wiring.
func (s *weakNetSink) arrived() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	kinds := 0
	if s.audioCount > 0 {
		kinds++
	}
	if s.videoCount > 0 {
		kinds++
	}
	return kinds
}

func TestWeakNetMixedQualityRoomIsolatesParticipants(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	feedback, subscribers := newWeakNetRoomFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	})

	// Give every participant a different link: P1-class clean, moderate, and
	// severe tiers, classified per UDP port in both directions.
	installWeakNetRoomQdisc(t)
	for _, subscriber := range subscribers {
		classifyWeakNetPort(t, subscriber.port, subscriber.tier)
	}

	time.Sleep(8 * time.Second)
	counts := make(map[string][2]int, 3)
	for _, subscriber := range subscribers {
		audio, video, missing, _, _ := subscriber.sink.counts()
		counts[subscriber.id] = [2]int{audio, video}
		t.Logf("%s tier: audio=%d video=%d missing=%d", subscriber.id, audio, video, missing)
		if subscriber.tier == weakNetTierClean {
			if audio < 150 || video < 60 {
				t.Fatalf("clean subscriber starved on its own clean class: audio=%d video=%d", audio, video)
			}
			continue
		}
		if audio < 30 {
			t.Fatalf("%s tier lost audio entirely: audio=%d (audio must survive every tier)", subscriber.id, audio)
		}
		if missing == 0 {
			t.Fatalf("%s tier saw no loss: the impairment never reached its flows", subscriber.id)
		}
	}
	clean := counts["clean"]
	severe := counts["severe"]
	// Isolation: the clean subscriber's video flow must stay well ahead of
	// the severe one (its own floor is already asserted above), proving the
	// severe tier's congestion never drags the clean tier down.
	if clean[1] < severe[1]*2 {
		t.Fatalf("isolation violated: clean video=%d vs severe video=%d", clean[1], severe[1])
	}
	if feedback.count() < 1 {
		t.Fatal("the publisher never saw a NACK: the room's repair loop is dead")
	}

	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	afterSevereAudio, afterSevereVideo, _, _, _ := subscribers[2].sink.counts()
	if afterSevereAudio == severe[0] {
		t.Fatal("severe subscriber audio stopped flowing after the impairment was lifted")
	}
	if afterSevereVideo == severe[1] && afterSevereVideo > 0 {
		t.Fatal("severe subscriber video stopped flowing after the impairment was lifted")
	}
}
