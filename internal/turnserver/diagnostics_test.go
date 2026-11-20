package turnserver

import (
	"bytes"
	"errors"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"SlowMeet/internal/config"
)

// loggedReloader is a certReloader whose log output the test can read.
func loggedReloader(certFile, keyFile string) (*certReloader, *fakeClock, *bytes.Buffer) {
	var logs bytes.Buffer
	clock := &fakeClock{current: time.Now()}
	reloader := newCertReloader(certFile, keyFile, slog.New(slog.NewTextHandler(&logs, nil)))
	reloader.now = clock.now
	return reloader, clock, &logs
}

func TestCertReloaderReportsAMissingCertificateWhenTheRelayStarts(t *testing.T) {
	directory := t.TempDir()
	reloader, _, logs := loggedReloader(filepath.Join(directory, "fullchain.pem"), filepath.Join(directory, "privkey.pem"))

	reloader.prime()
	if got := strings.Count(logs.String(), "turn_server_certificate_unavailable"); got != 1 {
		t.Fatalf("%d warnings about the missing certificate at startup, want 1:\n%s", got, logs)
	}
	// The relay runs without it, and the first client does not repeat what
	// startup already said.
	if _, err := reloader.GetCertificate(nil); !errors.Is(err, errNoCertificate) {
		t.Fatalf("GetCertificate() error = %v, want errNoCertificate", err)
	}
	if got := strings.Count(logs.String(), "turn_server_certificate_unavailable"); got != 1 {
		t.Fatalf("the missing certificate was reported %d times, want once:\n%s", got, logs)
	}
}

func TestCertReloaderLoadsTheCertificateWhenTheRelayStarts(t *testing.T) {
	certFile, keyFile := writeCertificate(t, t.TempDir(), "relay.test")
	reloader, _, logs := loggedReloader(certFile, keyFile)
	reloader.prime()
	if !strings.Contains(logs.String(), "turn_server_certificate_loaded") {
		t.Fatalf("the certificate was not loaded at startup:\n%s", logs)
	}
	if _, err := reloader.GetCertificate(nil); err != nil {
		t.Fatalf("GetCertificate() error = %v", err)
	}
}

func TestCertReloaderWarnsWhileTheCertificateIsCloseToExpiry(t *testing.T) {
	// The test certificate is valid for one more hour.
	certFile, keyFile := writeCertificate(t, t.TempDir(), "relay.test")
	reloader, clock, logs := loggedReloader(certFile, keyFile)
	warnings := func() int { return strings.Count(logs.String(), "turn_server_certificate_expiring") }
	check := func() {
		t.Helper()
		if _, err := reloader.GetCertificate(nil); err != nil {
			t.Fatalf("GetCertificate() error = %v", err)
		}
	}

	issued := clock.current
	clock.current = issued.Add(-30 * 24 * time.Hour)
	reloader.prime()
	if warnings() != 0 {
		t.Fatalf("warned about a certificate with a month left:\n%s", logs)
	}

	clock.current = issued
	check()
	if warnings() != 1 || !strings.Contains(logs.String(), "expired=false") {
		t.Fatalf("want one warning for a certificate an hour from expiry:\n%s", logs)
	}
	// Later checks within a day stay quiet, also once it has expired.
	clock.current = issued.Add(2 * time.Hour)
	check()
	if warnings() != 1 {
		t.Fatalf("the expiry warning repeated within a day:\n%s", logs)
	}
	clock.current = issued.Add(25 * time.Hour)
	check()
	if warnings() != 2 || !strings.Contains(logs.String(), "expired=true") {
		t.Fatalf("want a second warning, for an expired certificate, a day later:\n%s", logs)
	}
}

func TestStartWarnsWhenTheRelayRangeCannotHoldAFullRoom(t *testing.T) {
	warned := func(participants int, rotate time.Duration) bool {
		var logs bytes.Buffer
		warnAboutRelayRange(slog.New(slog.NewTextHandler(&logs, nil)), config.Config{
			TURNServerRelayPortMin: config.DefaultTURNServerRelayPortMin,
			TURNServerRelayPortMax: config.DefaultTURNServerRelayPortMax,
			MaxParticipants:        participants,
			TURNTCPRotateInterval:  rotate,
		})
		return strings.Contains(logs.String(), "turn_server_relay_range_small")
	}
	if warned(5, 12*time.Second) {
		t.Fatal("warned about the default range for the default room size")
	}
	if warned(config.MaxAllowedParticipants, 0) {
		t.Fatal("warned although rotation is off and every participant holds one allocation")
	}
	if !warned(config.MaxAllowedParticipants, 12*time.Second) {
		t.Fatal("no warning for the largest room on a rotating method with the default range")
	}
}
