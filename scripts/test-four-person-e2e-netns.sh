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
  # Firefox candidate gathering stalls inside the disposable namespace;
  # the mixed-quality dimension is what this runner exercises, so all four
  # participants run on Chromium here. Host runs keep the mixed engines.
  export MEDIA_E2E_FOUR_ENGINES=chromium
  exec node scripts/test-four-person-e2e.js
'
