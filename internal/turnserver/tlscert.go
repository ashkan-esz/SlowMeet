package turnserver

import (
	"crypto/tls"
	"errors"
	"log/slog"
	"os"
	"sync"
	"time"
)

// certCheckInterval bounds how often a loaded certificate's files are checked
// for a renewal. A handshake costs far more than two stat calls, but there is
// no reason to pay for them on every one.
const certCheckInterval = 30 * time.Second

var errNoCertificate = errors.New("no TURN TLS certificate is loaded")

// certReloader serves the TURN-over-TLS certificate from disk and picks up a
// renewed one without a restart, which would drop every relayed call.
//
// A missing or unreadable certificate does not stop the relay: handshakes fail
// until the files appear, and a certificate that was loaded once keeps being
// served if a later read fails (a renewal writes the two files one after the
// other, so a read in between can see a mismatched pair).
type certReloader struct {
	certFile string
	keyFile  string
	interval time.Duration
	now      func() time.Time
	logger   *slog.Logger

	mu          sync.Mutex
	certificate *tls.Certificate
	certModTime time.Time
	keyModTime  time.Time
	lastCheck   time.Time
	lastFailure string
}

func newCertReloader(certFile, keyFile string, logger *slog.Logger) *certReloader {
	return &certReloader{
		certFile: certFile,
		keyFile:  keyFile,
		interval: certCheckInterval,
		now:      time.Now,
		logger:   logger,
	}
}

// GetCertificate is the tls.Config callback run for each handshake.
func (r *certReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if r.certificate == nil || now.Sub(r.lastCheck) >= r.interval {
		r.lastCheck = now
		r.reload()
	}
	if r.certificate == nil {
		return nil, errNoCertificate
	}
	return r.certificate, nil
}

// reload loads the key pair when it is new or its files changed. The caller
// holds r.mu.
func (r *certReloader) reload() {
	certInfo, err := os.Stat(r.certFile)
	if err != nil {
		r.reportFailure(err)
		return
	}
	keyInfo, err := os.Stat(r.keyFile)
	if err != nil {
		r.reportFailure(err)
		return
	}
	if r.certificate != nil && certInfo.ModTime().Equal(r.certModTime) && keyInfo.ModTime().Equal(r.keyModTime) {
		return
	}
	certificate, err := tls.LoadX509KeyPair(r.certFile, r.keyFile)
	if err != nil {
		r.reportFailure(err)
		return
	}
	renewed := r.certificate != nil
	r.certificate = &certificate
	r.certModTime = certInfo.ModTime()
	r.keyModTime = keyInfo.ModTime()
	r.lastFailure = ""
	r.logger.Info("turn_server_certificate_loaded", "renewed", renewed)
}

// reportFailure logs a load failure once per distinct cause rather than once
// per handshake.
func (r *certReloader) reportFailure(err error) {
	if message := err.Error(); message != r.lastFailure {
		r.lastFailure = message
		r.logger.Warn("turn_server_certificate_unavailable",
			"error", message, "serving_previous", r.certificate != nil)
	}
}
