package webrtc

import (
	"fmt"
	"sync"

	"github.com/pion/dtls/v3"
	"github.com/pion/dtls/v3/pkg/protocol/extension"
	"github.com/pion/dtls/v3/pkg/protocol/handshake"
	"golang.org/x/sys/cpu"
)

// HardwareAES reports whether this CPU accelerates AES-GCM: both the AES
// rounds and the carry-less multiply GHASH needs. A VPS can hide these flags
// from its guests, in which case Go falls back to software AES-GCM that costs
// roughly twenty times more per video packet.
func HardwareAES() bool {
	return (cpu.X86.HasAES && cpu.X86.HasPCLMULQDQ) ||
		(cpu.ARM64.HasAES && cpu.ARM64.HasPMULL)
}

// hardwareAES is read once; tests override it to exercise both orders.
var hardwareAES = HardwareAES()

// srtpProfileOrder lists the SRTP profiles the SFU offers, cheapest first for
// this host. The order matters because the DTLS server's own preference picks
// the profile, and pion's default puts AES-256-GCM first.
//
// It follows BenchmarkSRTPEncrypt (ns per 1200-byte video packet):
//
//	                 hardware AES   software
//	AES-128-GCM           264         5312
//	AES-256-GCM           284         6132
//	AES-128-CTR+SHA1     1443         3140
//
// All three stay offered in both orders, so no browser loses compatibility;
// they are also the whole menu, since browsers negotiate no unencrypted or
// short-tag SRTP profile over DTLS. GCM carries a 16-byte tag against 10 for
// HMAC-SHA1-80, so the hardware order spends 6 more bytes per packet to save
// CPU.
func srtpProfileOrder(hardwareAES bool) []dtls.SRTPProtectionProfile {
	if hardwareAES {
		return []dtls.SRTPProtectionProfile{
			dtls.SRTP_AEAD_AES_128_GCM,
			dtls.SRTP_AEAD_AES_256_GCM,
			dtls.SRTP_AES128_CM_HMAC_SHA1_80,
		}
	}
	return []dtls.SRTPProtectionProfile{
		dtls.SRTP_AES128_CM_HMAC_SHA1_80,
		dtls.SRTP_AEAD_AES_128_GCM,
		dtls.SRTP_AEAD_AES_256_GCM,
	}
}

// cipherReport hands the ciphers the SFU selected to whoever asked for them.
// It reads them from the SFU's own DTLS ServerHello rather than from
// PeerConnection.GetStats, which reads connection state without a lock and
// races with a concurrent close.
type cipherReport struct {
	mu       sync.Mutex
	handler  func(srtpCipher, dtlsCipher string)
	reported bool
}

func (r *cipherReport) serverHello(hello handshake.MessageServerHello) handshake.Message {
	srtpCipher, dtlsCipher := "", ""
	if hello.CipherSuiteID != nil {
		dtlsCipher = dtls.CipherSuiteName(dtls.CipherSuiteID(*hello.CipherSuiteID))
	}
	for _, candidate := range hello.Extensions {
		if useSRTP, ok := candidate.(*extension.UseSRTP); ok && len(useSRTP.ProtectionProfiles) > 0 {
			srtpCipher = srtpProfileName(useSRTP.ProtectionProfiles[0])
		}
	}
	r.mu.Lock()
	handler := r.handler
	first := !r.reported && handler != nil
	if first {
		r.reported = true
	}
	r.mu.Unlock()
	if first {
		handler(srtpCipher, dtlsCipher)
	}
	return &hello
}

func srtpProfileName(profile dtls.SRTPProtectionProfile) string {
	switch profile {
	case dtls.SRTP_AEAD_AES_128_GCM:
		return "AES_128_GCM"
	case dtls.SRTP_AEAD_AES_256_GCM:
		return "AES_256_GCM"
	case dtls.SRTP_AES128_CM_HMAC_SHA1_80:
		return "AES128_CM_HMAC_SHA1_80"
	}
	return fmt.Sprintf("0x%04x", uint16(profile))
}

// OnCiphersNegotiated calls handler once, when the SFU answers the browser's
// DTLS ClientHello, with the SRTP profile and DTLS cipher suite it selected.
// Register it before the first offer or answer is exchanged.
func (p *Peer) OnCiphersNegotiated(handler func(srtpCipher, dtlsCipher string)) {
	p.ciphers.mu.Lock()
	p.ciphers.handler = handler
	p.ciphers.mu.Unlock()
}
