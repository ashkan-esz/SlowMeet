package media

import (
	"encoding/binary"
	"sync"
	"testing"

	"github.com/pion/rtp"
)

// A receiver's forwarded packet carries none of the publisher's header
// extensions (its mid, rid and transport-wide sequence, under its own
// connection's IDs) and does carry the receiver's own transceiver mid. Each
// receiver's write is its own copy: every writer is handed the same
// *rtp.Packet, and the transport-cc interceptor then stamps each receiver's
// sequence into that copy in place.
func TestEgressHeaderExtensionsRewriteForEachReceiver(t *testing.T) {
	const publisherTransportCC, publisherMid, publisherRID, midID, transportCCID = 3, 4, 10, 4, 3
	shared := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 100, Timestamp: 9000, SSRC: 1}, Payload: []byte{1, 2, 3}}
	for id, payload := range map[uint8][]byte{publisherTransportCC: {0x27, 0x10}, publisherMid: []byte("4"), publisherRID: []byte("medium")} {
		if err := shared.Header.SetExtension(id, payload); err != nil {
			t.Fatalf("set publisher extension %d: %v", id, err)
		}
	}

	// Several receivers, each with its own transceiver mid, write the same
	// packet at once and stamp their own transport sequence, as the
	// interceptor does. Run with -race: any sharing between copies races.
	const writers = 8
	var wait sync.WaitGroup
	for writer := 0; writer < writers; writer++ {
		wait.Add(1)
		go func(writer int) {
			defer wait.Done()
			egress := &egressHeaderExtensions{resolved: true, midID: midID, mid: []byte{byte('1' + writer)}}
			for round := 0; round < 200; round++ {
				out := egress.packet(shared)
				number := make([]byte, 2)
				binary.BigEndian.PutUint16(number, uint16(writer*1000+round))
				if err := out.Header.SetExtension(transportCCID, number); err != nil {
					t.Errorf("writer %d: stamp: %v", writer, err)
					return
				}
				raw, err := out.Marshal()
				if err != nil {
					t.Errorf("writer %d: marshal: %v", writer, err)
					return
				}
				var sent rtp.Packet
				if err := sent.Unmarshal(raw); err != nil {
					t.Errorf("writer %d: unmarshal: %v", writer, err)
					return
				}
				if got := string(sent.Header.GetExtension(midID)); got != string(rune('1'+writer)) {
					t.Errorf("writer %d sent mid %q, want its own transceiver's %q", writer, got, string(rune('1'+writer)))
					return
				}
				if got, want := binary.BigEndian.Uint16(sent.Header.GetExtension(transportCCID)), uint16(writer*1000+round); got != want {
					t.Errorf("writer %d sent transport sequence %d, want its own %d", writer, got, want)
					return
				}
				if sent.Header.GetExtension(publisherRID) != nil {
					t.Errorf("writer %d forwarded the publisher's rid", writer)
					return
				}
				if ids := sent.Header.GetExtensionIDs(); len(ids) != 2 {
					t.Errorf("writer %d sent extensions %v, want only mid and transport-cc", writer, ids)
					return
				}
			}
		}(writer)
	}
	wait.Wait()

	// The shared packet still carries the publisher's extensions untouched.
	if got := string(shared.Header.GetExtension(publisherMid)); got != "4" {
		t.Fatalf("the shared packet's mid changed to %q", got)
	}
	if got := shared.Header.GetExtension(publisherTransportCC); len(got) != 2 || got[0] != 0x27 || got[1] != 0x10 {
		t.Fatalf("the shared packet's transport-cc changed to %v", got)
	}

	// Before the receiver's mid is known (or on a connection without the mid
	// extension, like audio) the publisher's extensions are still dropped.
	unresolved := (*egressHeaderExtensions)(nil).packet(shared)
	if unresolved == shared || unresolved.Header.Extension || len(unresolved.Header.Extensions) != 0 {
		t.Fatalf("without a resolved mid the publisher's extensions were forwarded: %+v", unresolved.Header.Extensions)
	}
	plain := &rtp.Packet{Header: rtp.Header{Version: 2}}
	if (*egressHeaderExtensions)(nil).packet(plain) != plain {
		t.Fatal("a packet with nothing to rewrite was copied")
	}
}
