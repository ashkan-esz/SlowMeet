package turnserver

import (
	"bytes"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/stun/v4"
	"github.com/pion/turn/v5"
)

// fakeNow is a clock tests move by hand.
type fakeNow struct{ unix atomic.Int64 }

func (c *fakeNow) now() time.Time { return time.Unix(c.unix.Load(), 0) }

func TestAuthHandlerChecksExpiryOnlyForNewAllocations(t *testing.T) {
	clock := &fakeNow{}
	clock.unix.Store(1_800_000_000)
	handler := newAuthHandler(testSecret, clock.now, quietLogger())
	cfg := testConfig(t, 1)
	username, password, _ := cfg.TURNCredentials("browser", clock.now().Add(-2*cfg.TURNCredentialTTL))
	wantKey := turn.GenerateAuthKey(username, testRealm, password)

	for _, method := range []stun.Method{stun.MethodRefresh, stun.MethodCreatePermission, stun.MethodChannelBind} {
		_, key, ok := handler(&turn.RequestAttributes{Username: username, Realm: testRealm, Method: method})
		if !ok || !bytes.Equal(key, wantKey) {
			t.Fatalf("%v with an expired credential: ok=%v, want the credential's key so a running call keeps its relay", method, ok)
		}
	}
	if _, _, ok := handler(&turn.RequestAttributes{Username: username, Realm: testRealm, Method: stun.MethodAllocate}); ok {
		t.Fatal("an expired credential made a new allocation")
	}
	fresh, _, _ := cfg.TURNCredentials("browser", clock.now())
	if _, _, ok := handler(&turn.RequestAttributes{Username: fresh, Realm: testRealm, Method: stun.MethodAllocate}); !ok {
		t.Fatal("a valid credential was refused an allocation")
	}
	for _, method := range []stun.Method{stun.MethodAllocate, stun.MethodRefresh} {
		if _, _, ok := handler(&turn.RequestAttributes{Username: "browser", Realm: testRealm, Method: method}); ok {
			t.Fatalf("%v: a username without an expiry time was accepted", method)
		}
	}
}

func TestRelayedCallOutlivesItsCredential(t *testing.T) {
	// A browser keeps the credential it joined with. When its lifetime is
	// over, the call it already relays must go on; only new allocations are
	// refused.
	clock := &fakeNow{}
	clock.unix.Store(time.Now().Unix())
	cfg := testConfig(t, 4)
	server, err := startWith(cfg, quietLogger(), startOptions{listenHost: "127.0.0.1", now: clock.now})
	if err != nil {
		t.Fatalf("start relay: %v", err)
	}
	defer server.Close()
	username, password := browserCredentials(t, cfg)
	client := newTURNClient(t, server, "udp", username, password)
	relay, err := client.Allocate()
	if err != nil {
		t.Fatalf("allocate: %v", err)
	}
	defer relay.Close()

	clock.unix.Add(int64(2 * cfg.TURNCredentialTTL / time.Second))

	sfu := sfuSocket(t, cfg)
	if err := client.CreatePermission(sfu.LocalAddr()); err != nil {
		t.Fatalf("a running call lost its relay when the credential expired: %v", err)
	}
	if _, err := relay.WriteTo([]byte("still relayed"), sfu.LocalAddr()); err != nil {
		t.Fatal(err)
	}
	if payload, _ := readDatagram(t, sfu); payload != "still relayed" {
		t.Fatalf("SFU received %q", payload)
	}
	if late, err := newTURNClient(t, server, "udp", username, password).Allocate(); err == nil {
		_ = late.Close()
		t.Fatal("an expired credential made a new allocation")
	}
}
