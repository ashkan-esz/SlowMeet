#!/bin/sh
# Probe whether a UDP path carries valid STUN traffic. Sends real RFC 5389
# Binding Requests at 50pps for a fixed window and counts round-trip responses
# (responses are server-generated, so they prove the full round trip).
#
# Verdicts observed during the Nov 2026 VPS investigation
# (docs/vps-regression-diagnostics.md):
#   responses ≈ sent                  -> STUN path clear (direct WebRTC viable)
#   responses in the 10-20 range,     -> valid-STUN blocking active: the path
#   all early                           allows ~16 packets then cuts the flow
#   responses = 0                     -> UDP to this host:port fully blocked
#
# Usage: ./scripts/probe-stun-path.sh [host] [port] [seconds]
#   host    default meet.g69.lol (the VPS's coturn answers STUN always)
#   port    default 3478
#   seconds default 15

set -u
HOST="${1:-meet.g69.lol}"
PORT="${2:-3478}"
SECONDS_PROBE="${3:-15}"

exec python3 - "$HOST" "$PORT" "$SECONDS_PROBE" <<'EOF'
import socket, struct, os, sys, time

host, port, seconds = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setblocking(False)
dst = (host, port)

sent = 0
responses = 0
first_resp = None
last_resp = None
start = time.time()
while time.time() - start < seconds:
    try:
        while True:
            data, addr = s.recvfrom(2048)
            responses += 1
            now = time.time() - start
            first_resp = first_resp if first_resp is not None else now
            last_resp = now
    except BlockingIOError:
        pass
    # RFC 5389 Binding Request: type 0x0001, length 0, magic cookie, txid
    pkt = struct.pack(">HHI", 0x0001, 0, 0x2112A442) + os.urandom(12)
    s.sendto(pkt, dst)
    sent += 1
    time.sleep(0.02)
# final drain
deadline = time.time() + 2
while time.time() < deadline:
    try:
        data, addr = s.recvfrom(2048)
        responses += 1
        last_resp = time.time() - start
    except BlockingIOError:
        time.sleep(0.02)

print(f"sent={sent} responses={responses} "
      f"responses_window=[{first_resp:.2f}s .. {last_resp:.2f}s]" if responses else
      f"sent={sent} responses=0")

if sent and responses >= 0.8 * sent:
    print("VERDICT: STUN path CLEAR — direct UDP WebRTC should work on this network.")
elif responses:
    print("VERDICT: valid-STUN blocking ACTIVE — the path allows roughly the first "
          f"{responses} packets of a flow, then cuts it. Direct WebRTC cannot work; "
          "TURN-over-TCP relay is required.")
else:
    print("VERDICT: UDP fully blocked to this host:port (no responses at all).")
EOF
