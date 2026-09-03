#!/bin/sh
set -eu

port="${LOWMEET_SMOKE_PORT:-18080}"
config_dir="$(mktemp -d)"
server_pid=""

cleanup() {
  if [ -n "$server_pid" ]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rmdir "$config_dir" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

HTTP_ADDR="127.0.0.1:${port}" \
CONFIG_FILE="${config_dir}/config.json" \
ADMIN_PASSWORD= \
GOCACHE="${GOCACHE:-/tmp/slowmeet-gocache}" \
go run . >/tmp/lowmeet-smoke.log 2>&1 &
server_pid=$!

ready=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${port}/health" >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.2
done
if [ "$ready" -ne 1 ]; then
  echo "LowMeet did not become healthy"
  cat /tmp/lowmeet-smoke.log
  exit 1
fi

curl -fsS "http://127.0.0.1:${port}/health" | grep -q '"status":"ok"'
curl -fsS "http://127.0.0.1:${port}/ready" | grep -q '"status":"ready"'
curl -fsS "http://127.0.0.1:${port}/config" | grep -q '"max_video_bitrate"'
curl -fsS "http://127.0.0.1:${port}/" | grep -q 'LowMeet'
curl -fsS "http://127.0.0.1:${port}/admin.html" | grep -q 'Live signal'
curl -fsS -I "http://127.0.0.1:${port}/admin" | grep -q '302'
echo "LowMeet smoke test passed"
