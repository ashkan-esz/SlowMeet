package webrtc

import (
	"encoding/binary"
	"testing"
	"time"

	ice "github.com/pion/ice/v4"
	"github.com/pion/srtp/v3"
	pion "github.com/pion/webrtc/v4"
)

// TestSFUPicksCheapestSRTPProfile connects an SFU peer to a default pion peer
// standing in for a browser (it offers all three profiles and prefers
// AES-256-GCM) and checks the SFU's cheapest-first order is what gets
// negotiated, whichever side sends the offer.
func TestSFUPicksCheapestSRTPProfile(t *testing.T) {
	cases := []struct {
		name      string
		hardware  bool
		sfuOffers bool
		want      string
	}{
		{"hardware AES, browser offers", true, false, "AES_128_GCM"},
		{"hardware AES, SFU offers", true, true, "AES_128_GCM"},
		{"software AES, browser offers", false, false, "AES128_CM_HMAC_SHA1_80"},
		{"software AES, SFU offers", false, true, "AES128_CM_HMAC_SHA1_80"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			previous := hardwareAES
			hardwareAES = testCase.hardware
			t.Cleanup(func() { hardwareAES = previous })

			sfu, err := newPeerWithPortRange(pion.Configuration{}, 0, 0, true, "127.0.0.1")
			if err != nil {
				t.Fatalf("create SFU peer: %v", err)
			}
			defer sfu.Close()
			negotiated := make(chan [2]string, 1)
			sfu.OnCiphersNegotiated(func(srtpCipher, dtlsCipher string) {
				negotiated <- [2]string{srtpCipher, dtlsCipher}
			})

			var settings pion.SettingEngine
			settings.SetICEMulticastDNSMode(ice.MulticastDNSModeDisabled)
			settings.SetNetworkTypes([]pion.NetworkType{pion.NetworkTypeUDP4})
			settings.SetIncludeLoopbackCandidate(true)
			browser, err := pion.NewAPI(pion.WithSettingEngine(settings)).NewPeerConnection(pion.Configuration{})
			if err != nil {
				t.Fatalf("create browser peer: %v", err)
			}
			defer browser.Close()

			offerer, answerer := browser, sfu.Connection()
			if testCase.sfuOffers {
				offerer, answerer = answerer, offerer
			}
			if _, err := offerer.AddTransceiverFromKind(pion.RTPCodecTypeAudio); err != nil {
				t.Fatalf("add audio transceiver: %v", err)
			}
			describe := func(connection *pion.PeerConnection, create func() (pion.SessionDescription, error)) pion.SessionDescription {
				t.Helper()
				gathered := pion.GatheringCompletePromise(connection)
				description, err := create()
				if err != nil {
					t.Fatalf("create description: %v", err)
				}
				if err := connection.SetLocalDescription(description); err != nil {
					t.Fatalf("set local description: %v", err)
				}
				select {
				case <-gathered:
				case <-time.After(5 * time.Second):
					t.Fatal("ICE candidate gathering did not complete")
				}
				return *connection.LocalDescription()
			}
			offer := describe(offerer, func() (pion.SessionDescription, error) { return offerer.CreateOffer(nil) })
			if err := answerer.SetRemoteDescription(offer); err != nil {
				t.Fatalf("set remote offer: %v", err)
			}
			answer := describe(answerer, func() (pion.SessionDescription, error) { return answerer.CreateAnswer(nil) })
			if err := offerer.SetRemoteDescription(answer); err != nil {
				t.Fatalf("set remote answer: %v", err)
			}

			select {
			case ciphers := <-negotiated:
				if ciphers[0] != testCase.want {
					t.Fatalf("SRTP profile = %q, want %q", ciphers[0], testCase.want)
				}
				if ciphers[1] == "" {
					t.Fatal("DTLS cipher suite was not reported")
				}
			case <-time.After(10 * time.Second):
				t.Fatal("peers did not finish the DTLS handshake")
			}
		})
	}
}

// BenchmarkSRTPEncrypt measures what one outgoing media packet costs under
// each SRTP profile a browser will negotiate. srtpProfileOrder is built from
// these numbers; rerun with GODEBUG=cpu.aes=off,cpu.pclmulqdq=off to see the
// software fallback a host without hardware AES gets.
func BenchmarkSRTPEncrypt(b *testing.B) {
	profiles := []struct {
		name    string
		profile srtp.ProtectionProfile
	}{
		{"AES128GCM", srtp.ProtectionProfileAeadAes128Gcm},
		{"AES256GCM", srtp.ProtectionProfileAeadAes256Gcm},
		{"AES128CTRSHA1", srtp.ProtectionProfileAes128CmHmacSha1_80},
	}
	sizes := []struct {
		name    string
		payload int
	}{
		{"audio80", 80},
		{"video1200", 1200},
	}
	for _, candidate := range profiles {
		for _, size := range sizes {
			b.Run(candidate.name+"/"+size.name, func(b *testing.B) {
				keyLen, err := candidate.profile.KeyLen()
				if err != nil {
					b.Fatal(err)
				}
				saltLen, err := candidate.profile.SaltLen()
				if err != nil {
					b.Fatal(err)
				}
				context, err := srtp.CreateContext(make([]byte, keyLen), make([]byte, saltLen), candidate.profile)
				if err != nil {
					b.Fatal(err)
				}
				// A minimal RTP header (version 2, no extensions) and payload.
				packet := make([]byte, 12+size.payload)
				packet[0] = 0x80
				packet[1] = 96
				binary.BigEndian.PutUint32(packet[8:], 0x1234)
				encrypted := make([]byte, 0, len(packet)+32)
				b.SetBytes(int64(len(packet)))
				b.ReportAllocs()
				b.ResetTimer()
				for sequence := 0; b.Loop(); sequence++ {
					binary.BigEndian.PutUint16(packet[2:], uint16(sequence))
					if _, err := context.EncryptRTP(encrypted, packet, nil); err != nil {
						b.Fatal(err)
					}
				}
			})
		}
	}
}
