#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
TEST_DIR=$(mktemp -d)
readonly ROOT_DIR TEST_DIR
trap 'rm -rf -- "$TEST_DIR"' EXIT
: > "$TEST_DIR/empty.env"
: > "$TEST_DIR/.env"

fail() {
    printf 'Container binding test failed: %s\n' "$*" >&2
    exit 1
}

check_binding() {
    local compose_file=$1 expected_address=$2 output_file=$3
    shift 3
    "$@" docker compose \
        --project-directory "$TEST_DIR" \
        --env-file "$TEST_DIR/empty.env" \
        --file "$compose_file" \
        config --format json --no-env-resolution > "$output_file"
    jq -e --arg address "$expected_address" \
        '[.services.slowmeet.ports[] | select(.target == 8080 and .protocol == "tcp") | .host_ip] == [$address]' \
        "$output_file" >/dev/null \
        || fail "$compose_file resolved its HTTP binding to an unexpected address"
}

for compose_file in docker-compose.yml podman-compose.yml; do
    compose_fixture="$TEST_DIR/$compose_file"
    cp "$ROOT_DIR/$compose_file" "$compose_fixture"
    check_binding "$compose_fixture" 127.0.0.1 "$TEST_DIR/default.json" env -u HTTP_PUBLISH_ADDRESS -u HTTP_PUBLISH_PORT
    check_binding "$compose_fixture" 0.0.0.0 "$TEST_DIR/public.json" env HTTP_PUBLISH_ADDRESS=0.0.0.0
done

awk -F= '$1 == "HTTP_PUBLISH_ADDRESS" && $2 == "127.0.0.1" { found=1 } END { exit !found }' \
    "$ROOT_DIR/.env.example" \
    || fail '.env.example does not use the loopback HTTP binding by default'

printf 'Container HTTP binding checks passed.\n'
