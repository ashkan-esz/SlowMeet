package media

import (
	"testing"

	pion "github.com/pion/webrtc/v4"
)

func TestVideoCodecName(t *testing.T) {
	tests := []struct {
		mime string
		fmtp string
		want string
	}{
		{mime: "video/VP8", want: "vp8"},
		{mime: "video/H264", fmtp: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f", want: "h264"},
		{mime: "video/AV1", want: "av1"},
		{mime: "video/VP9", fmtp: "profile-id=0", want: "vp9"},
		{mime: "video/VP9", want: "vp9"},
		// Profiles other than 0 and codecs outside the configuration get names
		// no allowed list contains.
		{mime: "video/VP9", fmtp: "profile-id=2", want: "vp9-profile-2"},
		{mime: "video/H265", want: "video/h265"},
		{mime: "", want: ""},
	}
	for _, test := range tests {
		got := VideoCodecName(pion.RTPCodecCapability{MimeType: test.mime, SDPFmtpLine: test.fmtp})
		if got != test.want {
			t.Errorf("VideoCodecName(%q, %q) = %q, want %q", test.mime, test.fmtp, got, test.want)
		}
	}
}

func TestIngressCodecActionFor(t *testing.T) {
	tests := []struct {
		name                       string
		publication, packet, track uint8
		sameCodec                  bool
		want                       ingressCodecAction
	}{
		{name: "packet in the publication's codec", publication: 96, packet: 96, track: 96, sameCodec: true, want: ingressForward},
		{name: "track moved to the packet's payload type", publication: 96, packet: 98, track: 98, want: ingressRepublish},
		{name: "stray packet while the track stays put", publication: 96, packet: 98, track: 96, sameCodec: true, want: ingressDrop},
		{name: "late packet of a third payload type", publication: 96, packet: 45, track: 98, want: ingressDrop},
		// A simulcast layer starts without a payload type and learns it from
		// its first packet, so that a later change is seen.
		{name: "first packet of a layer without a payload type", publication: 0, packet: 45, track: 45, sameCodec: true, want: ingressAdopt},
		{name: "layer changed codec before its first packet was read", publication: 0, packet: 98, track: 98, want: ingressRepublish},
		{name: "stray packet on a layer without a payload type", publication: 0, packet: 98, track: 45, sameCodec: true, want: ingressDrop},
		{name: "change after the payload type was adopted", publication: 45, packet: 98, track: 98, want: ingressRepublish},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := ingressCodecActionFor(test.publication, test.packet, test.track, test.sameCodec)
			if got != test.want {
				t.Fatalf("ingressCodecActionFor(%d, %d, %d, %v) = %d, want %d",
					test.publication, test.packet, test.track, test.sameCodec, got, test.want)
			}
		})
	}
}

func testCodecPublication(sourceID string, role SourceRole, codecName string) *publication {
	return &publication{
		key:       publicationKey(sourceID, role, ""),
		sourceID:  sourceID,
		role:      role,
		codecName: codecName,
		tracks:    make(map[string]*publicationTarget),
		senders:   make(map[string]*pion.RTPSender),
	}
}

func TestVideoCodecFiltersGateSubscriptions(t *testing.T) {
	router := NewRouter()
	vp9Camera := testCodecPublication("publisher", SourceRoleCamera, "vp9")
	av1Screen := testCodecPublication("publisher", SourceRoleScreen, "av1")
	audio := testCodecPublication("publisher", SourceRoleAudio, "")

	// Nothing is filtered until the router knows a receiver's codecs.
	if !router.shouldSubscribeLocked(vp9Camera, "unknown") {
		t.Fatal("a receiver without a codec list must not be filtered")
	}

	router.SetReceiverVideoCodecs("phone", []string{"vp9", "vp8"})
	router.SetReceiverVideoCodecs("legacy", []string{"vp8", "h264"})
	if !router.shouldSubscribeLocked(vp9Camera, "phone") {
		t.Fatal("phone decodes vp9 and must receive it")
	}
	if router.shouldSubscribeLocked(av1Screen, "phone") {
		t.Fatal("phone does not decode av1 and must not be subscribed to it")
	}
	if router.shouldSubscribeLocked(vp9Camera, "legacy") {
		t.Fatal("legacy receiver must not be subscribed to vp9")
	}
	if !router.shouldSubscribeLocked(audio, "legacy") {
		t.Fatal("audio is never filtered by video codec")
	}

	// A codec the server stops allowing reaches nobody, whatever they decode.
	router.SetAllowedVideoCodecs([]string{"vp8", "h264"})
	if router.shouldSubscribeLocked(vp9Camera, "phone") || router.shouldSubscribeLocked(vp9Camera, "unknown") {
		t.Fatal("a disallowed codec must not be forwarded")
	}
	if !router.shouldSubscribeLocked(audio, "phone") {
		t.Fatal("audio must survive a video codec restriction")
	}
	router.SetAllowedVideoCodecs([]string{"av1", "vp9", "vp8", "h264"})
	if !router.shouldSubscribeLocked(vp9Camera, "phone") {
		t.Fatal("re-allowing the codec must restore the subscription")
	}

	// Forgetting the receiver forgets its codec list.
	router.Unregister("phone")
	if !router.shouldSubscribeLocked(av1Screen, "phone") {
		t.Fatal("an unregistered receiver's codec list must be dropped")
	}
}
