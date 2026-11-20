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
	"context"
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

func applyWeakNetProfile(t *testing.T, rate, delay, loss string, extra ...string) {
	t.Helper()
	args := []string{"qdisc", "replace", "dev", "lo", "root", "netem", "rate", rate, "delay", delay}
	if loss != "" {
		args = append(args, "loss", loss)
	}
	args = append(args, extra...)
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
	// ICE consent legitimately flaps while an impaired queue drains: the
	// connection reads "disconnected" transiently even while RTP keeps
	// moving, so poll instead of failing on one sample. A dead or failed
	// peer still fails the check once the window closes.
	deadline := time.Now().Add(10 * time.Second)
	for {
		if state := peer.ConnectionState(); state == pion.PeerConnectionStateConnected {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s connection state = %s, want connected within the recovery window", name, peer.ConnectionState())
		}
		time.Sleep(100 * time.Millisecond)
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
	// limit optionally caps the netem queue in packets so a rate-only tier
	// congests through tail drops instead of bufferbloating the window away.
	limit string
}

var (
	weakNetTierClean    = weakNetTier{rate: "", delay: "", loss: ""}
	weakNetTierModerate = weakNetTier{rate: "200kbit", delay: "200ms", loss: "3%"}
	weakNetTierSevere   = weakNetTier{rate: "100kbit", delay: "300ms", loss: "5%"}
	// A pure bandwidth cap with no injected loss: the room's paced video
	// (150 kbps) plus audio overruns the pipe, so congestion — not netem —
	// produces the drops, the way a thin consumer uplink does.
	weakNetTierCapped = weakNetTier{rate: "130kbit", delay: "50ms", loss: "0%", limit: "30"}
	// A total media outage: every packet on this port is dropped while the
	// ICE agents stay inside their disconnected window, so the blackout test
	// proves media freezes and then recovers without any renegotiation.
	weakNetTierBlackout = weakNetTier{rate: "10gbit", delay: "50ms", loss: "100%"}
)

// weakNetTierID names a subscriber after its tier so failure messages and
// per-tier count maps read the same way the browser scenario logs do.
func weakNetTierID(tier weakNetTier) string {
	switch tier {
	case weakNetTierClean:
		return "clean"
	case weakNetTierModerate:
		return "moderate"
	case weakNetTierSevere:
		return "severe"
	case weakNetTierCapped:
		return "capped"
	case weakNetTierBlackout:
		return "blackout"
	default:
		return "subscriber"
	}
}

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
		weakNetTierCapped:   {"1:40", "40:"},
		weakNetTierBlackout: {"1:50", "50:"},
	} {
		run("tc", "class", "add", "dev", "lo", "parent", "1:", "classid", class[0], "htb", "rate", tier.rate, "ceil", tier.rate)
		netemArgs := []string{"qdisc", "add", "dev", "lo", "parent", class[0], "handle", class[1], "netem",
			"delay", tier.delay, "loss", tier.loss}
		if tier.limit != "" {
			netemArgs = append(netemArgs, "limit", tier.limit)
		}
		run("tc", netemArgs...)
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
	case weakNetTierCapped:
		classID = "1:40"
	case weakNetTierBlackout:
		classID = "1:50"
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

// newWeakNetRoomFixture wires one publisher and its subscribers through the
// router on clean loopback, with per-subscriber UDP port blocks for the room
// classifiers. The default room is three subscribers on the clean, moderate,
// and severe tiers; tests pass tiersOverride to shape a different mix (the
// four-distinct-qualities room). Sustained streaming starts inside the
// fixture; impairment classes are applied afterwards by the test — unless
// impairBeforeNegotiation is set, in which case the subscriber handshakes
// themselves run under the tiers the test installed beforehand (the cold-join
// ordering, where no clean state ever exists).
func newWeakNetRoomFixture(t *testing.T, limits Limits, impairBeforeNegotiation bool, tiersOverride ...weakNetTier) (
	*weakNetNACKCounter,
	[]*weakNetRoomSubscriber,
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

	tiers := []weakNetTier{weakNetTierClean, weakNetTierModerate, weakNetTierSevere}
	if len(tiersOverride) > 0 {
		tiers = tiersOverride
	}
	portBlocks := make([][2]uint16, len(tiers))
	ids := make([]string, len(tiers))
	subscribers := make([]*weakNetRoomSubscriber, len(tiers))
	for i, tier := range tiers {
		base := uint16(52000 + i*100)
		portBlocks[i] = [2]uint16{base, base + 19}
		ids[i] = weakNetTierID(tier)
	}

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
	// port for the room classifiers. Under the cold-join ordering the
	// handshake itself runs under the tiers: the subscriber's port is
	// classified once its socket binds (gathering complete) but before the
	// first connectivity check flows.
	for i, id := range ids {
		subscriber := subscribers[i]
		egressConnection := subscriberEgressConnection(t, router, id)
		if impairBeforeNegotiation {
			negotiateWeakNetSubscriberUnderTier(t, egressConnection, subscriber)
			continue
		}
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

// gaps reports every video sequence the sink found missing at the
// high-water mark, whether or not it was later repaired: proof that the
// impairment reached the flow even when NACK repair hid all of it.
func (s *weakNetSink) gaps() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gapTotal
}

// weakNetMeshMember is one participant of the symmetric mesh: a single
// client peer connection that publishes audio and a camera and receives
// every other member's streams, as the browser client does, and the SFU-side
// peer it is registered with. Its ICE socket is pinned to its own UDP port
// block so the member's access link can be shaped by port.
type weakNetMeshMember struct {
	id     string
	tier   weakNetTier
	client *pion.PeerConnection
	sfu    *internalwebrtc.Peer
	audio  *pion.TrackLocalStaticRTP
	camera *pion.TrackLocalStaticRTP
	// nacks counts retransmission requests that reach this member's camera
	// sender from any receiver in the room.
	nacks *weakNetNACKCounter
	port  uint16

	mu      sync.Mutex
	inbound map[string]*weakNetSink // keyed by the publishing member's ID
}

// weakNetMeshSinkFrom returns the sink collecting what this member receives
// from one publisher, creating it on the publisher's first track.
func (m *weakNetMeshMember) weakNetMeshSinkFrom(sourceID string) *weakNetSink {
	m.mu.Lock()
	defer m.mu.Unlock()
	sink := m.inbound[sourceID]
	if sink == nil {
		sink = newWeakNetSink()
		m.inbound[sourceID] = sink
	}
	return sink
}

// weakNetMeshFlow is one directed publisher → receiver flow at one instant.
type weakNetMeshFlow struct {
	audio, video, gaps int
}

// weakNetMeshSnapshot reads every directed flow in the room, keyed
// "publisher->receiver".
func weakNetMeshSnapshot(members []*weakNetMeshMember) map[string]weakNetMeshFlow {
	flows := make(map[string]weakNetMeshFlow, len(members)*(len(members)-1))
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher == receiver {
				continue
			}
			sink := receiver.weakNetMeshSinkFrom(publisher.id)
			audio, video, _, _, _ := sink.counts()
			flows[weakNetMeshFlowKey(publisher, receiver)] = weakNetMeshFlow{audio: audio, video: video, gaps: sink.gaps()}
		}
	}
	return flows
}

func weakNetMeshFlowKey(publisher, receiver *weakNetMeshMember) string {
	return publisher.id + "->" + receiver.id
}

// weakNetMeshDelta subtracts an earlier snapshot of the same flow.
func weakNetMeshDelta(after, before weakNetMeshFlow) weakNetMeshFlow {
	return weakNetMeshFlow{
		audio: after.audio - before.audio,
		video: after.video - before.video,
		gaps:  after.gaps - before.gaps,
	}
}

// newWeakNetMeshFixture wires a symmetric room through one router on clean
// loopback: every member publishes audio and a camera and subscribes to every
// other member, so each member's link carries its own uplink and all of the
// room's downlinks — unlike newWeakNetRoomFixture, whose single clean
// publisher always leaves every subscriber one clean inbound path. Members
// are named p1..pN in tier order. All uplinks are established before media
// flows, the SFU's resulting offers are answered once the full mesh of
// targets exists, and sustained streaming runs from inside the fixture until
// cleanup. Impairment is applied afterwards by the test.
func newWeakNetMeshFixture(t *testing.T, limits Limits, tiers ...weakNetTier) []*weakNetMeshMember {
	t.Helper()
	router := NewRouter(limits)
	ids := make([]string, len(tiers))
	for i := range tiers {
		ids[i] = fmt.Sprintf("p%d", i+1)
	}
	members := make([]*weakNetMeshMember, len(tiers))
	for i, id := range ids {
		base := uint16(54000 + i*100)
		member := &weakNetMeshMember{
			id:      id,
			tier:    tiers[i],
			client:  newWeakNetPionPeerWithPorts(t, base, base+19),
			sfu:     newWeakNetWrapperPeer(t),
			nacks:   &weakNetNACKCounter{},
			inbound: make(map[string]*weakNetSink),
			audio: newIntegrationTrack(pion.RTPCodecCapability{
				MimeType: pion.MimeTypeOpus, ClockRate: 48000, Channels: 2,
			}, id+"-audio"),
			camera: newIntegrationTrack(pion.RTPCodecCapability{
				MimeType: pion.MimeTypeVP8, ClockRate: 90000,
			}, id+"-video"),
		}
		members[i] = member
		t.Cleanup(func() {
			router.Unregister(member.id)
			_ = member.client.Close()
			_ = member.sfu.Close()
		})

		member.client.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
			// Egress track IDs are "<publisher>|<role>".
			sourceID, _, _ := strings.Cut(track.ID(), "|")
			sink := member.weakNetMeshSinkFrom(sourceID)
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
		if _, err := member.client.AddTrack(member.audio); err != nil {
			t.Fatalf("add %s audio track: %v", id, err)
		}
		cameraSender, err := member.client.AddTrack(member.camera)
		if err != nil {
			t.Fatalf("add %s camera track: %v", id, err)
		}
		member.nacks.read(cameraSender)

		others := make([]string, 0, len(ids)-1)
		for _, other := range ids {
			if other != id {
				others = append(others, other)
			}
		}
		router.SetVideoSubscriptionsWithLayer(id, others, "medium")
		router.Register(id, member.sfu, nil)
		member.sfu.OnTrack(func(track *pion.TrackRemote, _ *pion.RTPReceiver) {
			role := SourceRoleCamera
			if track.Kind() == pion.RTPCodecTypeAudio {
				role = SourceRoleAudio
			}
			router.Publish(member.id, role, member.sfu, track)
		})
	}

	// Every uplink comes up before any media flows, so all publications
	// appear while every receiver is already registered. The client's ICE
	// socket is bound once its offer has gathered; the later SFU offer reuses
	// the same transport, so this port carries both directions.
	for _, member := range members {
		negotiateIntegrationPeers(t, member.client, member.sfu.Connection())
		waitIntegrationPeerConnected(t, member.client, member.id+" client")
		waitIntegrationPeerConnected(t, member.sfu.Connection(), member.id+" SFU peer")
		member.port = weakNetLocalPort(t, member.client)
	}

	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	for _, member := range members {
		sendWeakNetPackets(member.audio, pion.RTPCodecTypeAudio, weakNetAudioInterval, weakNetAudioPayloadBytes, stop)
		sendWeakNetPackets(member.camera, pion.RTPCodecTypeVideo, weakNetVideoInterval, weakNetVideoPayloadBytes, stop)
	}
	// Each of the 2N publications fans out to the N-1 other members.
	waitIntegrationPublicationTargets(t, router, 2*len(members), 2*len(members)*(len(members)-1))
	for _, member := range members {
		negotiateIntegrationPeers(t, member.sfu.Connection(), member.client)
	}

	deadline := time.After(20 * time.Second)
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher == receiver {
				continue
			}
			sink := receiver.weakNetMeshSinkFrom(publisher.id)
			for sink.arrived() < 2 {
				select {
				case <-deadline:
					audio, video, _, _, _ := sink.counts()
					t.Fatalf("%s never received both of %s's tracks on clean loopback (audio=%d video=%d)",
						receiver.id, publisher.id, audio, video)
				default:
				}
				time.Sleep(20 * time.Millisecond)
			}
		}
	}
	return members
}

// installWeakNetMeshQdisc gives every impaired member its own access link at
// its tier: one htb class for its uplink (packets leaving its port) and one
// for its downlink (packets arriving at its port), each with the tier's rate,
// delay, and loss. Unlike installWeakNetRoomQdisc, whose classes are shared
// by every port of the same tier, two members on the same tier never share
// capacity here — each has a separate line, the way two people on two bad
// home connections do. Clean members stay on the default class.
func installWeakNetMeshQdisc(t *testing.T, members []*weakNetMeshMember) {
	t.Helper()
	run := func(args ...string) {
		t.Helper()
		out, err := exec.Command("tc", args...).CombinedOutput()
		if err != nil {
			t.Fatalf("install mesh qdisc: tc %s: %v: %s", strings.Join(args, " "), err, strings.TrimSpace(string(out)))
		}
	}
	run("qdisc", "replace", "dev", "lo", "root", "handle", "1:", "htb", "default", "10")
	run("class", "add", "dev", "lo", "parent", "1:", "classid", "1:10", "htb", "rate", "10gbit", "ceil", "10gbit")
	for i, member := range members {
		if member.tier == weakNetTierClean {
			continue
		}
		portArg := fmt.Sprintf("%d", member.port)
		for direction, selector := range []string{"sport", "dport"} {
			minor := 0x100 + i*2 + direction
			classID := fmt.Sprintf("1:%x", minor)
			run("class", "add", "dev", "lo", "parent", "1:", "classid", classID,
				"htb", "rate", member.tier.rate, "ceil", member.tier.rate)
			netemArgs := []string{"qdisc", "add", "dev", "lo", "parent", classID, "handle", fmt.Sprintf("%x:", minor),
				"netem", "delay", member.tier.delay, "loss", member.tier.loss}
			if member.tier.limit != "" {
				netemArgs = append(netemArgs, "limit", member.tier.limit)
			}
			run(netemArgs...)
			run("filter", "add", "dev", "lo", "protocol", "ip", "parent", "1:", "prio", "1", "u32",
				"match", "ip", selector, portArg, "0xffff", "flowid", classID)
		}
	}
	t.Cleanup(func() { _ = exec.Command("tc", "qdisc", "del", "dev", "lo", "root").Run() })
}

func TestWeakNetMixedQualityRoomIsolatesParticipants(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	feedback, subscribers := newWeakNetRoomFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	}, false)

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

// One room, four subscribers, four different links at once — the Go-level
// shape of the all-distinct-qualities browser scenario. Audio must survive
// every tier (including the rate-only capped one, where congestion rather
// than injected loss does the damage), the loss tiers must show genuine
// gaps, the capped tier's video must trail the clean tier's, the clean
// tier's own flow must stay well ahead of the severe one (no cross-tier
// drag), the publisher's repair loop must see NACKs, and every impaired
// tier must recover once the classes are lifted.
func TestWeakNetAllDistinctQualitiesIsolateEveryTier(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	feedback, subscribers := newWeakNetRoomFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	}, false, weakNetTierClean, weakNetTierModerate, weakNetTierSevere, weakNetTierCapped)

	installWeakNetRoomQdisc(t)
	for _, subscriber := range subscribers {
		classifyWeakNetPort(t, subscriber.port, subscriber.tier)
	}

	time.Sleep(8 * time.Second)
	counts := make(map[string][2]int, len(subscribers))
	for _, subscriber := range subscribers {
		audio, video, missing, _, _ := subscriber.sink.counts()
		counts[subscriber.id] = [2]int{audio, video}
		t.Logf("%s tier: audio=%d video=%d missing=%d", subscriber.id, audio, video, missing)
		if audio < 30 {
			t.Fatalf("%s tier lost audio entirely: audio=%d (audio must survive every tier)", subscriber.id, audio)
		}
		if subscriber.tier == weakNetTierClean {
			if audio < 150 || video < 60 {
				t.Fatalf("clean subscriber starved on its own clean class: audio=%d video=%d", audio, video)
			}
			continue
		}
		if missing == 0 {
			if subscriber.tier == weakNetTierCapped {
				t.Fatalf("capped tier saw no sequence gaps under a standing queue: the rate cap never produced tail drops (audio=%d video=%d)", audio, video)
			}
			t.Fatalf("%s tier saw no loss: the impairment never reached its flows (video=%d)", subscriber.id, video)
		}
	}

	clean := counts["clean"]
	// The rate-only tier must trail the clean tier: its standing queue eats
	// video before audio, but it never stops the clean flow.
	if counts["capped"][1] >= clean[1] {
		t.Fatalf("capped tier video=%d matched or beat the clean tier's video=%d: the rate cap must trail the clean tier", counts["capped"][1], clean[1])
	}
	// Isolation: the clean subscriber's video flow must stay well ahead of
	// the severe one, proving the impaired tiers' congestion never drags the
	// clean tier down.
	if clean[1] < counts["severe"][1]*2 {
		t.Fatalf("isolation violated: clean video=%d vs severe video=%d", clean[1], counts["severe"][1])
	}
	if feedback.count() < 1 {
		t.Fatal("the publisher never saw a NACK: the room's repair loop is dead")
	}

	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	for _, subscriber := range subscribers[1:] {
		afterAudio, afterVideo, _, _, _ := subscriber.sink.counts()
		before := counts[subscriber.id]
		if afterAudio == before[0] {
			t.Fatalf("%s subscriber audio stopped flowing after the impairment was lifted", subscriber.id)
		}
		if afterVideo == before[1] && afterVideo > 0 {
			t.Fatalf("%s subscriber video stopped flowing after the impairment was lifted", subscriber.id)
		}
	}
}

// An inconsistent link: the impairment arrives, lifts, and returns the way a
// flapping connection does. Every impaired window must show genuine loss
// with the NACK repair loop re-engaged, every clean window must restore the
// flow, and the endpoint must come through all three cycles still connected.
func TestWeakNetFluctuatingImpairment(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	sink, targetClient := newWeakNetFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	})

	time.Sleep(2 * time.Second)
	for cycle := 1; cycle <= 3; cycle++ {
		applyWeakNetProfile(t, "500kbit", "100ms", "3%")
		time.Sleep(8 * time.Second)
		audio, video, missing, _, nacks := sink.counts()
		if audio < 100 {
			t.Fatalf("cycle %d: audio packets over the impaired window = %d, want >= 100: audio must survive every impaired window", cycle, audio)
		}
		if missing == 0 {
			t.Fatalf("cycle %d: no sequence gaps over the impaired window: the impairment never reached the subscriber (audio=%d video=%d)", cycle, audio, video)
		}
		if nacks < 1 {
			t.Fatalf("cycle %d: the publisher never saw a NACK: the loss-repair loop did not re-engage (audio=%d video=%d)", cycle, audio, video)
		}
		waitWeakNetConnected(t, targetClient, "target")

		removeWeakNetProfile(t)
		cleanAudioStart := audio
		time.Sleep(3 * time.Second)
		cleanAudio, cleanVideo, _, _, _ := sink.counts()
		if cleanAudio == cleanAudioStart {
			t.Fatalf("cycle %d: audio stopped flowing while the impairment was lifted", cycle)
		}
		if cleanVideo == video {
			t.Fatalf("cycle %d: video stopped flowing while the impairment was lifted", cycle)
		}
		waitWeakNetConnected(t, targetClient, "target")
	}

	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	waitWeakNetConnected(t, targetClient, "target")
}

// A rate-shaped link with no injected loss: the SFU's own pacing (150 kbps
// video + 32 kbps audio) overruns the 130 kbit pipe, so the bottleneck is
// queueing, not netem loss. A deliberately small netem limit makes the
// standing queue tail-drop the overflow the way a shallow consumer buffer
// does, instead of bufferbloating the window away. The guarantee under pure
// congestion is unchanged: audio keeps flowing while video absorbs the drop.
func TestWeakNetRateCapOnlyBottleneck(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	sink, targetClient := newWeakNetFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	})

	time.Sleep(2 * time.Second)
	applyWeakNetProfile(t, "130kbit", "10ms", "", "limit", "30")
	time.Sleep(8 * time.Second)

	audio, video, missing, _, nacks := sink.counts()
	if audio < 60 {
		t.Fatalf("audio packets over the congested window = %d, want >= 60: audio must survive a pure rate bottleneck (video=%d)", audio, video)
	}
	if video >= audio {
		t.Fatalf("video packets = %d vs audio = %d: video must absorb the congestion before audio", video, audio)
	}
	if missing == 0 {
		t.Fatalf("no sequence gaps under a standing queue: the bottleneck never produced tail drops (audio=%d video=%d)", audio, video)
	}
	if nacks < 1 {
		t.Fatalf("the publisher never saw a NACK under the bottleneck: the repair loop is dead (audio=%d video=%d)", audio, video)
	}
	waitWeakNetConnected(t, targetClient, "target")

	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	afterAudio, afterVideo, _, _, _ := sink.counts()
	if afterAudio == audio {
		t.Fatal("audio stopped flowing after the bottleneck was lifted")
	}
	if afterVideo == video {
		t.Fatal("video stopped flowing after the bottleneck was lifted")
	}
	waitWeakNetConnected(t, targetClient, "target")
}

// waitWeakNetConnectedWithDeadline tolerates the slower ICE+DTLS handshakes
// that establishment-under-impairment produces; the shared 10s integration
// budget is calibrated for clean loopback.
func waitWeakNetConnectedWithDeadline(t *testing.T, peer *pion.PeerConnection, name string, timeout time.Duration) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	for {
		if peer.ConnectionState() == pion.PeerConnectionStateConnected {
			return
		}
		select {
		case <-ctx.Done():
			t.Fatalf("%s connection state under impairment = %s", name, peer.ConnectionState())
		case <-time.After(20 * time.Millisecond):
		}
	}
}

// negotiateWeakNetSubscriberUnderTier brings one subscriber's egress pair up
// with its UDP port classified into its tier between the socket bind and the
// first connectivity check, so the whole handshake — ICE checks, DTLS, and
// the initial media — happens under impairment. The port only becomes
// readable once the client gathers (its socket binds at SetLocalDescription),
// which is exactly the window between "the path exists" and "the path is
// used" that a cold join on a bad network must survive.
func negotiateWeakNetSubscriberUnderTier(t *testing.T, egressConnection *pion.PeerConnection, subscriber *weakNetRoomSubscriber) {
	t.Helper()
	offer, err := egressConnection.CreateOffer(nil)
	if err != nil {
		t.Fatalf("create egress offer: %v", err)
	}
	if err := egressConnection.SetLocalDescription(offer); err != nil {
		t.Fatalf("set egress offer: %v", err)
	}
	waitIntegrationGatheringComplete(t, egressConnection, subscriber.id+" egress")
	localOffer := egressConnection.LocalDescription()
	if localOffer == nil {
		t.Fatalf("%s egress has no local description after gathering", subscriber.id)
	}
	if err := subscriber.peer.SetRemoteDescription(*localOffer); err != nil {
		t.Fatalf("set client remote offer: %v", err)
	}
	answer, err := subscriber.peer.CreateAnswer(nil)
	if err != nil {
		t.Fatalf("create client answer: %v", err)
	}
	if err := subscriber.peer.SetLocalDescription(answer); err != nil {
		t.Fatalf("set client answer: %v", err)
	}
	waitIntegrationGatheringComplete(t, subscriber.peer, subscriber.id+" client")
	subscriber.port = weakNetLocalPort(t, subscriber.peer)
	classifyWeakNetPort(t, subscriber.port, subscriber.tier)
	localAnswer := subscriber.peer.LocalDescription()
	if localAnswer == nil {
		t.Fatalf("%s client has no local description after gathering", subscriber.id)
	}
	if err := egressConnection.SetRemoteDescription(*localAnswer); err != nil {
		t.Fatalf("set egress remote answer: %v", err)
	}
	waitWeakNetConnectedWithDeadline(t, subscriber.peer, subscriber.id+" client", 30*time.Second)
	waitWeakNetConnectedWithDeadline(t, egressConnection, subscriber.id+" egress", 30*time.Second)
}

// Joining is part of the weak-network contract: every other room test joins
// on clean loopback and arms the impairment afterwards. This one installs the
// room qdisc first, so all three subscriber handshakes establish under their
// tiers — ICE checks, DTLS, and the first media seconds all impaired. The
// guarantee: establishment completes on every tier, audio survives on every
// tier, loss is repaired through NACK, and recovery is immediate on lift.
func TestWeakNetColdJoinEstablishesUnderImpairment(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	installWeakNetRoomQdisc(t)
	feedback, subscribers := newWeakNetRoomFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	}, true)

	time.Sleep(8 * time.Second)
	for _, subscriber := range subscribers {
		audio, video, missing, _, _ := subscriber.sink.counts()
		t.Logf("%s tier after a cold join: audio=%d video=%d missing=%d", subscriber.id, audio, video, missing)
		if audio < 30 {
			t.Fatalf("%s tier lost audio after joining under impairment: audio=%d (audio must survive establishment on a bad link)", subscriber.id, audio)
		}
		if subscriber.tier != weakNetTierClean && missing == 0 {
			t.Fatalf("%s tier saw no loss after joining under impairment: the impairment never reached its flows", subscriber.id)
		}
	}
	if feedback.count() < 1 {
		t.Fatal("the publisher never saw a NACK: the repair loop never engaged for the cold-joined room")
	}

	beforeAudio, beforeVideo, _, _, _ := subscribers[2].sink.counts()
	removeWeakNetProfile(t)
	time.Sleep(2 * time.Second)
	afterAudio, afterVideo, _, _, _ := subscribers[2].sink.counts()
	if afterAudio == beforeAudio {
		t.Fatal("severe subscriber audio stopped flowing after the impairment was lifted")
	}
	if afterVideo == beforeVideo {
		t.Fatal("severe subscriber video stopped flowing after the impairment was lifted")
	}
}

// A total media outage on one subscriber's port while every other flow stays
// clean, the way a dead radio or a NAT timeout severs one participant's path
// mid-call: that subscriber's media must freeze completely while the rest of
// the room keeps flowing, and once the outage lifts, media must resume on the
// same connection — the ICE agents stay inside their disconnected window, so
// no renegotiation or restart may be required.
func TestWeakNetBlackoutStopsMediaThenRecovers(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	_, subscribers := newWeakNetRoomFixture(t, Limits{
		MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30,
	}, false)

	time.Sleep(2 * time.Second)
	installWeakNetRoomQdisc(t)
	classifyWeakNetPort(t, subscribers[1].port, weakNetTierBlackout)
	time.Sleep(1 * time.Second) // let the classification take effect and in-flight packets drain
	frozenAudio, frozenVideo, _, _, _ := subscribers[1].sink.counts()
	cleanAudioStart, _, _, _, _ := subscribers[0].sink.counts()

	time.Sleep(8 * time.Second)

	blackoutAudio, blackoutVideo, _, _, _ := subscribers[1].sink.counts()
	if blackoutAudio != frozenAudio || blackoutVideo != frozenVideo {
		t.Fatalf("blacked-out subscriber still received media: audio %d -> %d, video %d -> %d (a total outage must freeze its flows)",
			frozenAudio, blackoutAudio, frozenVideo, blackoutVideo)
	}
	cleanAudioEnd, cleanVideoEnd, _, _, _ := subscribers[0].sink.counts()
	if cleanAudioEnd == cleanAudioStart || cleanVideoEnd == 0 {
		t.Fatalf("the clean subscriber stopped flowing during the blackout: audio %d -> %d, video=%d",
			cleanAudioStart, cleanAudioEnd, cleanVideoEnd)
	}

	// The blackout window sits inside the ICE disconnected timeout, so
	// lifting the outage must resume the same connection without any
	// renegotiation. Right after the window the agent is still legitimately
	// disconnected; recovery is asserted after the lift below.
	removeWeakNetProfile(t)
	time.Sleep(3 * time.Second)
	recoveredAudio, recoveredVideo, missing, _, _ := subscribers[1].sink.counts()
	if recoveredAudio == blackoutAudio {
		t.Fatal("blacked-out subscriber audio never resumed after the outage was lifted")
	}
	if recoveredVideo == blackoutVideo && blackoutVideo > 0 {
		t.Fatal("blacked-out subscriber video never resumed after the outage was lifted")
	}
	if missing == 0 {
		t.Fatal("no sequence gaps around the blackout: the outage never reached the RTP stream")
	}
	waitWeakNetConnected(t, subscribers[1].peer, "blackout client")
}

// weakNetMeshWireOverheadBytes is what a forwarded RTP packet costs on the
// shaped link beyond its RTP marshal size (header plus payload, the size the
// SFU's limiters count): the SRTP auth tag, UDP, and IPv4 headers.
const weakNetMeshWireOverheadBytes = 10 + 8 + 20

// weakNetMeshFloorSafety divides the throughput a tier's preset predicts for
// one audio flow. The model treats the netem FIFO as sharing capacity in
// proportion to offered bytes, and ignores RTCP, NACK retransmissions, and
// STUN consent traffic that also cross the link, so the floor only claims
// that a third of the predicted audio survives.
const weakNetMeshFloorSafety = 3

// weakNetMeshTierRate reads a tier preset's rate ("200kbit") in bits per
// second.
func weakNetMeshTierRate(t *testing.T, tier weakNetTier) float64 {
	t.Helper()
	var kbit int
	if _, err := fmt.Sscanf(tier.rate, "%dkbit", &kbit); err != nil || kbit <= 0 {
		t.Fatalf("weak-network tier rate %q is not in kbit: %v", tier.rate, err)
	}
	return float64(kbit) * 1000
}

// weakNetMeshTierLoss reads a tier preset's netem loss ("3%") as a fraction.
func weakNetMeshTierLoss(t *testing.T, tier weakNetTier) float64 {
	t.Helper()
	var percent float64
	if _, err := fmt.Sscanf(tier.loss, "%f%%", &percent); err != nil || percent < 0 || percent >= 100 {
		t.Fatalf("weak-network tier loss %q is not a percentage: %v", tier.loss, err)
	}
	return percent / 100
}

// weakNetMeshAudioFloors derives, from a bad member's tier preset, the
// minimum audio packets over window for the two flows that cross exactly one
// impaired hop: its own audio reaching a clean receiver (its uplink only) and
// a clean publisher's audio reaching it (its downlink only). Each direction
// passes the fraction of offered load the tier's rate can carry, then the
// tier's loss, and never more than the SFU's audio budget admits.
//
// The uplink carries the member's own synthetic audio and camera at their
// source rates. The downlink is taken at its worst case: every one of the
// room's other members delivering audio at the SFU's full audio budget and
// video at the full video cap.
func weakNetMeshAudioFloors(t *testing.T, tier weakNetTier, limits Limits, roomSize int, window time.Duration) (uplink, downlink int) {
	t.Helper()
	rate := weakNetMeshTierRate(t, tier)
	survive := 1 - weakNetMeshTierLoss(t, tier)
	audioRTPBytes := float64(12 + weakNetAudioPayloadBytes)
	videoRTPBytes := float64(12 + weakNetVideoPayloadBytes)
	sourceAudioPPS := float64(time.Second) / float64(weakNetAudioInterval)
	sourceVideoPPS := float64(time.Second) / float64(weakNetVideoInterval)
	admittedAudioPPS := float64(rateForKind(pion.RTPCodecTypeAudio, limits)) / audioRTPBytes
	carried := func(offeredBitsPerSecond float64) float64 {
		return min(1, rate/offeredBitsPerSecond)
	}

	uplinkOffered := 8 * (sourceAudioPPS*(audioRTPBytes+weakNetMeshWireOverheadBytes) +
		sourceVideoPPS*(videoRTPBytes+weakNetMeshWireOverheadBytes))
	uplinkPPS := min(admittedAudioPPS, sourceAudioPPS*carried(uplinkOffered)*survive)

	perPublisherDownlink := 8*admittedAudioPPS*(audioRTPBytes+weakNetMeshWireOverheadBytes) +
		float64(limits.MaxVideoBitrate)*(videoRTPBytes+weakNetMeshWireOverheadBytes)/videoRTPBytes
	downlinkOffered := float64(roomSize-1) * perPublisherDownlink
	downlinkPPS := admittedAudioPPS * carried(downlinkOffered) * survive

	seconds := window.Seconds()
	return int(uplinkPPS * seconds / weakNetMeshFloorSafety), int(downlinkPPS * seconds / weakNetMeshFloorSafety)
}

// One clean participant in a room of three bad ones, where every member
// publishes and subscribes — the Go-level shape of the 1-good/3-bad meeting.
// P2 and P4 sit on separate moderate links and P3 on a severe one, each
// shaped on its own UDP port in both directions, so the clean participant has
// no clean inbound stream at all: every stream it receives crossed a bad
// uplink, and every stream it sends crosses a bad downlink. The guarantees:
// audio keeps flowing on every pair touching the clean participant, at floors
// derived from the Go tier presets; the clean participant's own link adds no
// impairment (it receives each bad publisher better than any bad receiver
// does, and each bad receiver gets it better than any bad publisher); the
// repair loop for its stream stays alive; and every pair resumes on lift.
func TestWeakNetSymmetricMeshIsolatesCleanParticipant(t *testing.T) {
	skipWithoutWeakNetNamespace(t)
	limits := Limits{MaxAudioBitrate: 32_000, MaxVideoBitrate: 150_000, MaxVideoFPS: 30}
	members := newWeakNetMeshFixture(t, limits,
		weakNetTierClean, weakNetTierModerate, weakNetTierSevere, weakNetTierModerate)
	clean, bad := members[0], members[1:]

	const window = 8 * time.Second
	installWeakNetMeshQdisc(t, members)
	before := weakNetMeshSnapshot(members)
	nacksBefore := clean.nacks.count()
	time.Sleep(window)
	impaired := weakNetMeshSnapshot(members)
	flow := func(publisher, receiver *weakNetMeshMember) weakNetMeshFlow {
		key := weakNetMeshFlowKey(publisher, receiver)
		return weakNetMeshDelta(impaired[key], before[key])
	}
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher != receiver {
				got := flow(publisher, receiver)
				t.Logf("%s (%s) -> %s (%s): audio=%d video=%d gaps=%d", publisher.id, weakNetTierID(publisher.tier),
					receiver.id, weakNetTierID(receiver.tier), got.audio, got.video, got.gaps)
			}
		}
	}

	// The most audio any flow can carry over the window: the SFU's audio
	// budget. A bad member's tier must cost at least its preset loss.
	audioBudget := float64(rateForKind(pion.RTPCodecTypeAudio, limits)) / float64(12+weakNetAudioPayloadBytes) * window.Seconds()
	for _, member := range bad {
		uplinkFloor, downlinkFloor := weakNetMeshAudioFloors(t, member.tier, limits, len(members), window)
		tierCeiling := int(audioBudget * (1 - weakNetMeshTierLoss(t, member.tier)))
		t.Logf("%s (%s) audio floors from the tier preset: uplink %d, downlink %d; ceiling %d",
			member.id, weakNetTierID(member.tier), uplinkFloor, downlinkFloor, tierCeiling)

		fromBad := flow(member, clean)
		if fromBad.audio < uplinkFloor {
			t.Errorf("%s received %d audio packets from %s (%s uplink), want >= %d derived from the tier preset: audio must cross a bad uplink",
				clean.id, fromBad.audio, member.id, weakNetTierID(member.tier), uplinkFloor)
		}
		toBad := flow(clean, member)
		if toBad.audio < downlinkFloor {
			t.Errorf("%s received %d audio packets from %s across its %s downlink, want >= %d derived from the tier preset",
				member.id, toBad.audio, clean.id, weakNetTierID(member.tier), downlinkFloor)
		}
		if toBad.video == 0 {
			t.Errorf("%s's camera never reached %s across its %s downlink", clean.id, member.id, weakNetTierID(member.tier))
		}
		if fromBad.audio > tierCeiling || toBad.audio > tierCeiling {
			t.Errorf("%s flows carried %d (from) and %d (to) audio packets, above %d: the %s tier never reached the member's port",
				member.id, fromBad.audio, toBad.audio, tierCeiling, weakNetTierID(member.tier))
		}

		// Isolation, in both directions. A bad publisher's audio reaches the
		// clean participant through one impaired hop and any other bad
		// receiver through two, so the clean participant must hear it best;
		// a bad receiver gets the clean participant through one impaired hop
		// and every other bad publisher through two.
		for _, other := range bad {
			if other == member {
				continue
			}
			if viaBad := flow(member, other); fromBad.audio <= viaBad.audio {
				t.Errorf("%s's audio reached the clean %s (%d packets) no better than the bad %s (%d): the clean downlink must add no impairment",
					member.id, clean.id, fromBad.audio, other.id, viaBad.audio)
			}
			if fromOther := flow(other, member); toBad.audio <= fromOther.audio {
				t.Errorf("%s received the clean %s's audio (%d packets) no better than the bad %s's (%d): the clean uplink must add no impairment",
					member.id, clean.id, toBad.audio, other.id, fromOther.audio)
			}
		}
	}
	if nacks := clean.nacks.count() - nacksBefore; nacks < 1 {
		t.Errorf("%s's camera sender saw no NACK while its stream crossed three lossy downlinks: the repair loop is dead", clean.id)
	}
	if t.Failed() {
		return
	}

	removeWeakNetProfile(t)
	time.Sleep(3 * time.Second)
	lifted := weakNetMeshSnapshot(members)
	for _, receiver := range members {
		for _, publisher := range members {
			if publisher == receiver {
				continue
			}
			key := weakNetMeshFlowKey(publisher, receiver)
			got := weakNetMeshDelta(lifted[key], impaired[key])
			if got.audio == 0 {
				t.Errorf("%s audio stopped flowing after the impairment was lifted", key)
			}
			if got.video == 0 {
				t.Errorf("%s video stopped flowing after the impairment was lifted", key)
			}
		}
	}
	for _, member := range members {
		waitWeakNetConnected(t, member.client, member.id+" client")
	}
}
