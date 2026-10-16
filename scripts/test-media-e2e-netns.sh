#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "The isolated media network test requires Linux user and network namespaces." >&2
  exit 2
fi

for required in unshare ip tc node; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "The isolated media network test requires '$required'." >&2
    exit 2
  fi
done

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

# The qdisc is attached only to loopback created inside this disposable network
# namespace. No physical or shared host interface is changed.
exec unshare --user --map-root-user --net --fork --kill-child=TERM /bin/sh -c '
  set -eu
  ip link set lo up
  unset MEDIA_E2E_BASE_URL MEDIA_E2E_REAL_MEDIA MEDIA_E2E_HEADED
  unset MEDIA_E2E_SCREEN_SHARE MEDIA_E2E_SCREEN_SHARE_NATIVE MEDIA_E2E_NETNS
  export MEDIA_E2E_NETNS=1
  export MEDIA_E2E_NETWORK_IMPAIRMENT=1
  export MEDIA_E2E_DEVICE_FIXTURES=1
  export MEDIA_E2E_PROFILE=network
  exec node scripts/test-media-e2e.js
'
