package turnserver

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeCertificateFiles writes a fresh self-signed certificate and key. Each
// call produces a different certificate, as a renewal does.
func writeCertificateFiles(t *testing.T, certFile, keyFile, commonName string) {
	t.Helper()
	if err := writeSelfSignedCertificate(certFile, keyFile, commonName); err != nil {
		t.Fatal(err)
	}
}

// writeSelfSignedCertificate does the work of writeCertificateFiles. TestMain
// needs it before any test exists.
func writeSelfSignedCertificate(certFile, keyFile, commonName string) error {
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate key: %w", err)
	}
	serial, err := rand.Int(rand.Reader, big.NewInt(1<<62))
	if err != nil {
		return fmt.Errorf("generate serial: %w", err)
	}
	template := &x509.Certificate{
		SerialNumber: serial,
		Subject:      pkix.Name{CommonName: commonName},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		DNSNames:     []string{commonName},
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1)},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		return fmt.Errorf("create certificate: %w", err)
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return fmt.Errorf("marshal key: %w", err)
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER})
	if err := os.WriteFile(certFile, certPEM, 0o600); err != nil {
		return fmt.Errorf("write certificate: %w", err)
	}
	if err := os.WriteFile(keyFile, keyPEM, 0o600); err != nil {
		return fmt.Errorf("write key: %w", err)
	}
	return nil
}

func writeCertificate(t *testing.T, directory, commonName string) (string, string) {
	t.Helper()
	certFile := filepath.Join(directory, "fullchain.pem")
	keyFile := filepath.Join(directory, "privkey.pem")
	writeCertificateFiles(t, certFile, keyFile, commonName)
	return certFile, keyFile
}

// touch moves a file's modification time forward, as rewriting it later would.
func touch(t *testing.T, path string, modified time.Time) {
	t.Helper()
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatalf("set modification time of %s: %v", path, err)
	}
}

type fakeClock struct{ current time.Time }

func (c *fakeClock) now() time.Time { return c.current }

func newTestReloader(certFile, keyFile string) (*certReloader, *fakeClock) {
	clock := &fakeClock{current: time.Unix(1_800_000_000, 0)}
	reloader := newCertReloader(certFile, keyFile, quietLogger())
	reloader.now = clock.now
	return reloader, clock
}

func served(t *testing.T, reloader *certReloader) []byte {
	t.Helper()
	certificate, err := reloader.GetCertificate(nil)
	if err != nil {
		t.Fatalf("GetCertificate() error = %v", err)
	}
	return certificate.Certificate[0]
}

func TestCertReloaderServesARenewedCertificateWithoutARestart(t *testing.T) {
	certFile, keyFile := writeCertificate(t, t.TempDir(), "relay.test")
	reloader, clock := newTestReloader(certFile, keyFile)
	original := served(t, reloader)

	// certbot's deploy hook replaces both files.
	writeCertificateFiles(t, certFile, keyFile, "relay.test")
	renewedAt := time.Now().Add(time.Minute)
	touch(t, certFile, renewedAt)
	touch(t, keyFile, renewedAt)

	// Within the check interval the files are not looked at again.
	clock.current = clock.current.Add(certCheckInterval - time.Second)
	if !bytes.Equal(served(t, reloader), original) {
		t.Fatal("the certificate was re-read before the check interval elapsed")
	}
	clock.current = clock.current.Add(2 * time.Second)
	renewed := served(t, reloader)
	if bytes.Equal(renewed, original) {
		t.Fatal("the renewed certificate was not picked up after the check interval")
	}
	// Unchanged files are not reloaded on later checks.
	clock.current = clock.current.Add(2 * certCheckInterval)
	if !bytes.Equal(served(t, reloader), renewed) {
		t.Fatal("an unchanged certificate must keep being served")
	}
}

func TestCertReloaderKeepsThePreviousCertificateWhenAReloadFails(t *testing.T) {
	certFile, keyFile := writeCertificate(t, t.TempDir(), "relay.test")
	reloader, clock := newTestReloader(certFile, keyFile)
	original := served(t, reloader)

	// Mid-renewal: the certificate is new but the key file is not written yet.
	if err := os.WriteFile(keyFile, []byte("not a key"), 0o600); err != nil {
		t.Fatalf("corrupt key: %v", err)
	}
	touch(t, keyFile, time.Now().Add(time.Minute))
	clock.current = clock.current.Add(certCheckInterval)
	if !bytes.Equal(served(t, reloader), original) {
		t.Fatal("a failed reload must keep serving the previous certificate")
	}

	// The files vanish entirely (for example an unmounted directory).
	if err := os.Remove(certFile); err != nil {
		t.Fatalf("remove certificate: %v", err)
	}
	clock.current = clock.current.Add(certCheckInterval)
	if !bytes.Equal(served(t, reloader), original) {
		t.Fatal("missing files must keep serving the previous certificate")
	}

	// A complete pair is picked up on the next check.
	writeCertificateFiles(t, certFile, keyFile, "relay.test")
	later := time.Now().Add(2 * time.Minute)
	touch(t, certFile, later)
	touch(t, keyFile, later)
	clock.current = clock.current.Add(certCheckInterval)
	if bytes.Equal(served(t, reloader), original) {
		t.Fatal("the repaired certificate was not picked up")
	}
}

func TestCertReloaderFailsHandshakesUntilFilesAppear(t *testing.T) {
	directory := t.TempDir()
	certFile := filepath.Join(directory, "fullchain.pem")
	keyFile := filepath.Join(directory, "privkey.pem")
	reloader, _ := newTestReloader(certFile, keyFile)

	for range 3 {
		if _, err := reloader.GetCertificate(nil); !errors.Is(err, errNoCertificate) {
			t.Fatalf("GetCertificate() error = %v, want errNoCertificate", err)
		}
	}
	// Without a certificate every handshake retries, so no clock advance is
	// needed once the files exist.
	writeCertificateFiles(t, certFile, keyFile, "relay.test")
	if len(served(t, reloader)) == 0 {
		t.Fatal("the certificate was not loaded once its files appeared")
	}
}
