#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "The weak-network soak requires Linux user and network namespaces." >&2
  exit 2
fi

for required in unshare ip tc node go; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "The weak-network soak requires '$required'." >&2
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
  export SOAK_NETNS=1
  export SOAK_IMPAIRMENT="${SOAK_IMPAIRMENT:-1}"
  # Host runs keep the plain soak; the wrapper exists for the impairment
  # mode, so default it on here (set SOAK_IMPAIRMENT=0 for a clean soak in
  # the namespace).
  exec node scripts/test-soak.js
'
