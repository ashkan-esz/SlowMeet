package turnserver

import (
	"crypto/tls"
	"crypto/x509"
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
	// notAfter is when the loaded certificate expires; zero if that could not
	// be read. lastExpiryWarning is when its expiry was last warned about.
	notAfter          time.Time
	lastExpiryWarning time.Time
}

const (
	// certExpiryWarningPeriod is how long before a certificate expires the
	// relay starts warning. Renewal normally happens a month ahead, so a
	// certificate this close to its end means renewal has stopped working, or
	// its result no longer reaches these files.
	certExpiryWarningPeriod = 14 * 24 * time.Hour
	// certExpiryWarningInterval is how often that warning repeats.
	certExpiryWarningInterval = 24 * time.Hour
)

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
		r.warnAboutExpiry(now)
	}
	if r.certificate == nil {
		return nil, errNoCertificate
	}
	return r.certificate, nil
}

// prime looks at the certificate files once when the relay starts, so that a
// missing, unreadable or mismatched pair, or a certificate about to expire, is
// reported then and not when the first client that needs TURN over TLS fails.
// It changes nothing else: the relay starts either way.
func (r *certReloader) prime() {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	r.lastCheck = now
	r.reload()
	r.warnAboutExpiry(now)
}

// warnAboutExpiry warns, at most once per certExpiryWarningInterval, while the
// loaded certificate is expired or close to it. Browsers refuse an expired
// certificate, which takes TURN over TLS away without any error on this side.
// It runs with the checks handshakes trigger, so a relay nobody connects to
// over TLS says nothing after startup. The caller holds r.mu.
func (r *certReloader) warnAboutExpiry(now time.Time) {
	if r.certificate == nil || r.notAfter.IsZero() {
		return
	}
	remaining := r.notAfter.Sub(now)
	if remaining >= certExpiryWarningPeriod {
		return
	}
	if !r.lastExpiryWarning.IsZero() && now.Sub(r.lastExpiryWarning) < certExpiryWarningInterval {
		return
	}
	r.lastExpiryWarning = now
	r.logger.Warn("turn_server_certificate_expiring",
		"not_after", r.notAfter.UTC().Format(time.RFC3339),
		"expired", remaining <= 0,
		"hint", "browsers refuse an expired certificate, so TURN over TLS stops working: "+
			"check that renewal runs and that TURN_SERVER_TLS_CERT_FILE receives its result")
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
	r.notAfter = leafNotAfter(&certificate)
	// A renewed certificate close to its end is worth a warning of its own.
	r.lastExpiryWarning = time.Time{}
	r.logger.Info("turn_server_certificate_loaded", "renewed", renewed)
}

// leafNotAfter returns when the first certificate of a loaded chain expires,
// or the zero time if it cannot be parsed.
func leafNotAfter(certificate *tls.Certificate) time.Time {
	if certificate.Leaf != nil {
		return certificate.Leaf.NotAfter
	}
	if len(certificate.Certificate) == 0 {
		return time.Time{}
	}
	leaf, err := x509.ParseCertificate(certificate.Certificate[0])
	if err != nil {
		return time.Time{}
	}
	return leaf.NotAfter
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
