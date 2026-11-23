package media

import (
	"encoding/binary"
	"sync"
	"testing"

	"github.com/pion/rtp"
)

// Every receiver's writer gets the same *rtp.Packet, and pion's
// TrackLocalStaticRTP.WriteRTP copies only the packet struct; the
// transport-cc interceptor then sets each receiver's own transport sequence
// number with Header.SetExtension, in place when the publisher's packet
// already carries that extension. Each write must therefore get its own
// extension array, or one receiver is sent another's number and floods the
// SFU with transport-cc feedback.
func TestWithOwnHeaderExtensionsIsolatesConcurrentWriters(t *testing.T) {
	const transportCCID = 3
	shared := &rtp.Packet{Header: rtp.Header{Version: 2, SequenceNumber: 100, Timestamp: 9000, SSRC: 1}, Payload: []byte{1, 2, 3}}
	if err := shared.Header.SetExtension(transportCCID, []byte{0, 0}); err != nil {
		t.Fatalf("set publisher extension: %v", err)
	}
	if err := shared.Header.SetExtension(1, []byte{0xaa}); err != nil {
		t.Fatalf("set second extension: %v", err)
	}

	// Several receivers' writers stamp their own sequence numbers at once,
	// as the interceptor does; each must read back exactly its own. Run with
	// -race: any sharing of the extension array is a data race.
	const writers = 8
	var wait sync.WaitGroup
	results := make([]uint16, writers)
	for writer := 0; writer < writers; writer++ {
		wait.Add(1)
		go func(writer int) {
			defer wait.Done()
			for round := 0; round < 200; round++ {
				own := withOwnHeaderExtensions(shared)
				number := make([]byte, 2)
				binary.BigEndian.PutUint16(number, uint16(writer*1000+round))
				if err := own.Header.SetExtension(transportCCID, number); err != nil {
					t.Errorf("writer %d: set extension: %v", writer, err)
					return
				}
				if _, err := own.Marshal(); err != nil {
					t.Errorf("writer %d: marshal: %v", writer, err)
					return
				}
				results[writer] = binary.BigEndian.Uint16(own.Header.GetExtension(transportCCID))
				if want := uint16(writer*1000 + round); results[writer] != want {
					t.Errorf("writer %d read transport sequence %d, want its own %d", writer, results[writer], want)
					return
				}
			}
		}(writer)
	}
	wait.Wait()

	// The shared packet is untouched, and an appended extension (a publisher
	// packet without transport-cc) lands in the copy only.
	if got := shared.Header.GetExtension(transportCCID); len(got) != 2 || got[0] != 0 || got[1] != 0 {
		t.Fatalf("the shared packet's transport-cc extension changed to %v", got)
	}
	own := withOwnHeaderExtensions(shared)
	if err := own.Header.SetExtension(5, []byte{0x55}); err != nil {
		t.Fatalf("append extension: %v", err)
	}
	if shared.Header.GetExtension(5) != nil {
		t.Fatal("an extension appended to the copy appeared on the shared packet")
	}

	// Without extensions there is nothing to share: the packet itself is used.
	plain := &rtp.Packet{Header: rtp.Header{Version: 2}}
	if withOwnHeaderExtensions(plain) != plain {
		t.Fatal("a packet without extensions was copied")
	}
}
