// SlowMeet patch — not part of upstream pion/ice. See ../README.md.

package ice

import (
	"context"
	"net/netip"
	"time"
)

// Upstream Restart is break-before-make: it clears the selected pair and
// closes every candidate at once, so no application data can be sent or
// received until the restarted session finishes its own checks. An SFU that
// restarts ICE on purpose (SlowMeet rotates TURN/TCP relay connections every
// few seconds) turns that into a media gap of a second or more per restart.
//
// With this patch Restart detaches the selected pair and its two candidates
// instead of closing them (the "legacy pair"). The restarted session is
// otherwise untouched: new credentials, empty checklist, fresh gathering. The
// legacy pair only carries application data:
//
//   - Conn.Write uses it while no pair is selected;
//   - non-STUN packets arriving on its local candidate from its remote
//     address are still accepted;
//   - STUN on it fails the new credentials and is ignored, as it should be.
//
// Once a new pair is selected the agent stops sending on the legacy pair but
// keeps receiving on it until the remote has been quiet there for
// legacyPairDrainTimeout: a browser whose old pair outranks the new one (a
// direct host pair replaced by a relay) keeps sending on the old pair until
// its own connectivity timeout, several seconds after the restart. The legacy
// pair is also released when it has been kept for legacyPairMaxLifetime, when
// another Restart replaces it, or when the agent closes.
const (
	legacyPairMaxLifetime  = 10 * time.Second
	legacyPairDrainTimeout = 500 * time.Millisecond
)

// retainSelectedPairAsLegacy must run on the agent loop, before the selected
// pair is cleared and the candidates are deleted.
func (a *Agent) retainSelectedPairAsLegacy() {
	a.releaseLegacyPair()

	pair := a.getSelectedPair()
	if pair == nil {
		return
	}

	a.detachCandidate(a.localCandidates, pair.Local)
	a.detachCandidate(a.remoteCandidates, pair.Remote)
	a.legacyPair.Store(pair)
	a.legacyPairDeadline = time.Now().Add(legacyPairMaxLifetime)
	a.scheduleLegacyPairRelease(legacyPairMaxLifetime)
}

// detachCandidate removes one candidate from a candidate set without closing
// it, so deleteAllCandidates leaves it running.
func (a *Agent) detachCandidate(set map[NetworkType][]Candidate, candidate Candidate) {
	networkType := candidate.NetworkType()
	candidates := set[networkType]
	for i, c := range candidates {
		if c == candidate {
			set[networkType] = append(candidates[:i:i], candidates[i+1:]...)

			return
		}
	}
}

// scheduleLegacyPairRelease (agent loop) arms the release of the current
// legacy pair, replacing any earlier schedule. It is a no-op without one.
func (a *Agent) scheduleLegacyPairRelease(after time.Duration) {
	pair := a.legacyPair.Load()
	if pair == nil {
		return
	}

	a.legacyPairTimerMu.Lock()
	defer a.legacyPairTimerMu.Unlock()
	if a.legacyPairRelease != nil {
		a.legacyPairRelease.Stop()
	}
	a.legacyPairRelease = time.AfterFunc(after, func() {
		// The timer fires off the agent loop; the release itself must not.
		_ = a.loop.Run(a.loop, func(context.Context) {
			if a.legacyPair.Load() != pair {
				return
			}
			// While draining, hold on for as long as the remote still sends
			// application data on the legacy pair (bounded by the deadline).
			quietFor := time.Since(pair.Remote.LastReceived())
			if a.getSelectedPair() != nil && quietFor < legacyPairDrainTimeout &&
				time.Now().Before(a.legacyPairDeadline) {
				a.scheduleLegacyPairRelease(legacyPairDrainTimeout - quietFor)

				return
			}
			a.releaseLegacyPair()
		})
	})
}

func (a *Agent) stopLegacyPairReleaseTimer() {
	a.legacyPairTimerMu.Lock()
	defer a.legacyPairTimerMu.Unlock()
	if a.legacyPairRelease != nil {
		a.legacyPairRelease.Stop()
		a.legacyPairRelease = nil
	}
}

// releaseLegacyPair (agent loop) closes the legacy pair's candidates.
func (a *Agent) releaseLegacyPair() {
	pair := a.legacyPair.Swap(nil)
	if pair == nil {
		return
	}
	a.stopLegacyPairReleaseTimer()

	if err := pair.Local.close(); err != nil {
		a.log.Warnf("Failed to close legacy local candidate %s: %v", pair.Local, err)
	}
	if err := pair.Remote.close(); err != nil {
		a.log.Warnf("Failed to close legacy remote candidate %s: %v", pair.Remote, err)
	}
}

// legacyRemoteCandidate (agent loop) returns the legacy pair's remote
// candidate when a non-STUN packet arrived on the legacy local candidate from
// the legacy remote address, else nil.
func (a *Agent) legacyRemoteCandidate(local Candidate, remote netip.AddrPort) Candidate {
	pair := a.legacyPair.Load()
	if pair == nil || pair.Local != local || !addrPortEqual(pair.Remote.addrPort(), remote) {
		return nil
	}

	return pair.Remote
}
