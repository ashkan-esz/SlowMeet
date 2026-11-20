package media

import (
	"os"
	"testing"
)

// knownFailing skips the calling (sub)test unless SLOWMEET_KNOWN_FAILING=1.
// It marks an assertion that pins a documented defect (see "Known issues
// pinned by tests" in docs/network-testing.md): the test stays in the tree,
// make check stays green, and the defect is re-checked on demand. Delete the
// call once the defect is fixed.
func knownFailing(t *testing.T, reason string) {
	t.Helper()
	if os.Getenv("SLOWMEET_KNOWN_FAILING") != "1" {
		t.Skipf("known failing (SLOWMEET_KNOWN_FAILING=1 to run): %s", reason)
	}
}

// skipUnlessExtended keeps slow or not yet calibrated tests out of make check
// and the CI weak-network job (which selects every ^TestWeakNet test). Run
// them with SLOWMEET_EXTENDED=1; a test is promoted by deleting the call once
// it has passed repeatedly.
func skipUnlessExtended(t *testing.T) {
	t.Helper()
	if os.Getenv("SLOWMEET_EXTENDED") != "1" {
		t.Skip("extended test (SLOWMEET_EXTENDED=1 to run)")
	}
}
