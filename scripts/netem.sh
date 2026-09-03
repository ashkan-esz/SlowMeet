#!/bin/sh
set -eu

usage() {
  echo "Usage: sudo $0 --interface IFACE --scenario SCENARIO [--duration SECONDS]" >&2
  echo "Scenarios: 1mbit, 500kbit, 200kbit, 100kbit, changing" >&2
  exit 2
}

interface=""
scenario=""
duration=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --interface)
      [ "$#" -ge 2 ] || usage
      interface="$2"
      shift 2
      ;;
    --scenario)
      [ "$#" -ge 2 ] || usage
      scenario="$2"
      shift 2
      ;;
    --duration)
      [ "$#" -ge 2 ] || usage
      duration="$2"
      shift 2
      ;;
    --help|-h)
      usage
      ;;
    *)
      usage
      ;;
  esac
done

[ -n "$interface" ] && [ -n "$scenario" ] || usage
case "$duration" in
  ''|*[!0-9]*) usage ;;
esac

cleanup() {
  tc qdisc del dev "$interface" root 2>/dev/null || true
}
trap cleanup EXIT INT TERM

apply_profile() {
  rate="$1"
  delay="$2"
  loss="$3"
  if [ "$loss" = "0" ]; then
    tc qdisc replace dev "$interface" root netem rate "$rate" delay "$delay"
  else
    tc qdisc replace dev "$interface" root netem rate "$rate" delay "$delay" loss "$loss"
  fi
}

case "$scenario" in
  1mbit)
    apply_profile 1mbit 50ms 0
    ;;
  500kbit)
    apply_profile 500kbit 100ms 1%
    ;;
  200kbit)
    apply_profile 200kbit 200ms 3%
    ;;
  100kbit)
    apply_profile 100kbit 300ms 5%
    ;;
  changing)
    [ "$duration" -gt 0 ] || {
      echo "--duration is required for the changing scenario" >&2
      exit 2
    }
    slice=$((duration / 4))
    [ "$slice" -gt 0 ] || slice=1
    apply_profile 1mbit 50ms 0
    sleep "$slice"
    apply_profile 200kbit 200ms 3%
    sleep "$slice"
    apply_profile 80kbit 300ms 5%
    sleep "$slice"
    apply_profile 1mbit 50ms 0
    remaining=$((duration - slice * 3))
    [ "$remaining" -gt 0 ] && sleep "$remaining"
    ;;
  *)
    echo "unknown scenario: $scenario" >&2
    usage
    ;;
esac

if [ "$duration" -gt 0 ] && [ "$scenario" != "changing" ]; then
  sleep "$duration"
fi
