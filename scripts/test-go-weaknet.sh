#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
  echo "The Go weak-network suite requires Linux user and network namespaces." >&2
  exit 2
fi

for required in unshare ip tc go; do
  if ! command -v "$required" >/dev/null 2>&1; then
    echo "The Go weak-network suite requires '$required'." >&2
    exit 2
  fi
done

repo_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$repo_root"

# Compile the tagged test binary before entering the disposable namespace:
# the toolchain never needs the soon-impaired network and the namespace
# lifetime stays short.
test_dir=$(mktemp -d)
cleanup() { rm -rf "$test_dir"; }
trap cleanup EXIT
go test -tags weaknet -race ./internal/media/ -c -o "$test_dir/weaknet.test"

# The qdisc is attached only to the loopback created inside this disposable
# network namespace; no physical or shared host interface is changed. The
# guard environment variable keeps the tagged tests from ever shaping a host
# interface when someone runs the binary directly.
unshare --user --map-root-user --net --fork --kill-child=TERM /bin/sh -c '
  set -eu
  ip link set lo up
  export SLOWMEET_WEAKNET_NETNS=1
  exec "$1" -test.run "^TestWeakNet" -test.v
' sh "$test_dir/weaknet.test"
