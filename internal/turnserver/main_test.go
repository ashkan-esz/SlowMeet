package turnserver

import (
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// trustedCertFile and trustedKeyFile hold a certificate for 127.0.0.1 that
// this test binary trusts as a root. A real ICE agent verifies the certificate
// of a turns: server and offers no way to switch that off, so the tests that
// run one against the relay's TLS listener serve this certificate.
var trustedCertFile, trustedKeyFile string

func TestMain(m *testing.M) {
	os.Exit(runTests(m))
}

func runTests(m *testing.M) int {
	directory, err := os.MkdirTemp("", "turnserver-test-certificate")
	if err != nil {
		fmt.Fprintln(os.Stderr, "create certificate directory:", err)
		return 1
	}
	defer os.RemoveAll(directory)
	trustedCertFile = filepath.Join(directory, "fullchain.pem")
	trustedKeyFile = filepath.Join(directory, "privkey.pem")
	if err := writeSelfSignedCertificate(trustedCertFile, trustedKeyFile, "relay.test"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 1
	}
	// Go reads the system roots once, on the first verification, so this has
	// to be set before any test runs. It only affects this process.
	if err := os.Setenv("SSL_CERT_FILE", trustedCertFile); err != nil {
		fmt.Fprintln(os.Stderr, "trust the test certificate:", err)
		return 1
	}
	return m.Run()
}
