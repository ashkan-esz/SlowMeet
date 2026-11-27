#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "The four-person mixed-quality room test requires Linux user and network namespaces." >&2
  exit 2
fi

for required in unshare ip tc node; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "The four-person mixed-quality room test requires '$required'." >&2
    exit 2
  fi
done

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

# The qdisc is attached only to the loopback created inside this disposable
# network namespace; no physical or shared host interface is changed.
exec unshare --user --map-root-user --net --fork --kill-child=TERM /bin/sh -c '
  set -eu
  ip link set lo up
  unset MEDIA_E2E_FOUR_RECONNECT_GRACE
  export MEDIA_E2E_FOUR_NETNS=1
  # All four participants run on Chromium here unless the caller asks for
  # MEDIA_E2E_FOUR_ENGINES=mixed: the mixed-quality dimension is what this
  # runner exercises, and four Chromium browsers are lighter than two of
  # each. Host runs keep the mixed engines.
  export MEDIA_E2E_FOUR_ENGINES="${MEDIA_E2E_FOUR_ENGINES:-chromium}"
  # Firefox gathers only the address of its default route here ("use only
  # default local addresses", even with media.peerconnection.ice.
  # default_address_only off), and the namespace has none ("failed to find
  # default addresses"): no candidate at all. A default route over loopback
  # does not help (it is a local route, with no source address). A dummy
  # interface does: its address becomes the Firefox host candidate, and
  # traffic between it and 127.0.0.1 (the SFU) is local, so it still crosses
  # lo and its port classifiers.
  if [ "$MEDIA_E2E_FOUR_ENGINES" != chromium ]; then
    ip link add dummy0 type dummy
    ip addr add 10.77.0.1/24 dev dummy0
    ip link set dummy0 up
    ip route add default dev dummy0
  fi
  exec node scripts/test-four-person-e2e.js
'
