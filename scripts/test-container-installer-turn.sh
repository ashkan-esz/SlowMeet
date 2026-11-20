#!/usr/bin/env bash
# Several variables are read only by installer functions sourced at run time
# (SC2034), and the recording stubs are called through "$engine" (SC2329).
# shellcheck disable=SC2034,SC2329
set -Eeuo pipefail

# Checks how the image installer (deploy/install-container.sh) sets up TURN:
# what a fresh installation writes to .env for each choice, and which ports
# and mounts the container is started with. Nothing here needs root or a
# container engine; the engine is a recording stub.

readonly INSTALLER=deploy/install-container.sh
TEMP_DIR=$(mktemp -d)
readonly TEMP_DIR
trap 'rm -rf "$TEMP_DIR"' EXIT

test_fail() {
    printf 'container installer TURN test failed: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    local file=$1 expected=$2
    grep -Fq -- "$expected" "$file" || test_fail "expected '$expected' in $file:
$(cat "$file")"
}

assert_not_contains() {
    local file=$1 unexpected=$2
    if grep -Fq -- "$unexpected" "$file"; then
        test_fail "did not expect '$unexpected' in $file:
$(cat "$file")"
    fi
}

# --- Installer functions under test ------------------------------------------

INSTALL_DIR="$TEMP_DIR/slowmeet-container"
ENV_FILE="$INSTALL_DIR/.env"
STATE_FILE="$TEMP_DIR/state"
CONTAINER_NAME=slowmeet-container
VOLUME_NAME=slowmeet-container-data
ENGINE_LOG="$TEMP_DIR/engine.log"
LOG_FILE="$TEMP_DIR/installer.log"
http_publish_address=127.0.0.1

for name in prompt yes_no read_state_value read_env_value choose_turn_mode generate_turn_secret \
    turn_env_settings create_env_file port_in_use turn_run_arguments start_container; do
    # shellcheck source=/dev/null
    source <(sed -n "/^$name() {/,/^}/p" "$INSTALLER")
    declare -F "$name" >/dev/null || test_fail "the installer no longer defines $name"
done

# What the installer tells the operator is recorded; its fail still ends the
# (sub)shell it is called in.
log() { printf '%s\n' "$*" >> "$LOG_FILE"; }
fail() {
    printf 'ERROR: %s\n' "$*" >> "$LOG_FILE"
    exit 1
}
# Engines record their arguments.
docker() { printf 'docker %s\n' "$*" >> "$ENGINE_LOG"; }
podman() { printf 'podman %s\n' "$*" >> "$ENGINE_LOG"; }
# Ports listed in BUSY_PORTS ("udp:3478 tcp:5349") are taken on the host.
BUSY_PORTS=''
port_in_use() { [[ " $BUSY_PORTS " == *" $1:$2 "* ]]; }

reset_install() {
    # $1: .env contents (printf %b format)
    rm -rf "$INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
    printf '%b' "$1" > "$ENV_FILE"
    printf 'image=ghcr.io/ashkan-esz/slowmeet:latest\n' > "$STATE_FILE"
    : > "$ENGINE_LOG"
    : > "$LOG_FILE"
    BUSY_PORTS=''
}

run_line() { grep -- ' run --detach ' "$ENGINE_LOG" || test_fail 'the container was not started'; }

readonly base_env='HTTP_PUBLISH_ADDRESS=127.0.0.1\nHTTP_PUBLISH_PORT=8080\nICE_UDP_PORT_MIN=50000\nICE_UDP_PORT_MAX=50100\n'

# --- Starting the container ----------------------------------------------------

# Without the relay the container starts exactly as it always did.
engine=docker
reset_install "$base_env"
start_container
[[ "$(run_line)" == 'docker run --detach --name slowmeet-container --restart unless-stopped --init --read-only --tmpfs /tmp:size=16m,noexec,nosuid,nodev --cap-drop ALL --security-opt no-new-privileges:true --env-file '"$ENV_FILE"' --publish 127.0.0.1:8080:8080 --publish 50000-50100:50000-50100/udp --volume slowmeet-container-data:/app/data ghcr.io/ashkan-esz/slowmeet:latest' ]] \
    || test_fail "an installation without the relay must start as before, got: $(run_line)"

# An external TURN server needs nothing published either.
reset_install "$base_env"'TURN_URLS=turn:turn.example.com:3478\nTURN_SHARED_SECRET=abc\n'
start_container
assert_not_contains "$ENGINE_LOG" '3478:3478'

# The relay's listen ports are published; the relay port range never is.
reset_install "$base_env"'TURN_SERVER_ENABLED=true\nTURN_SHARED_SECRET=abc\n'
start_container
assert_contains "$ENGINE_LOG" '--publish 3478:3478/udp --publish 3478:3478/tcp'
assert_not_contains "$ENGINE_LOG" '5349'
assert_not_contains "$ENGINE_LOG" '49152'
assert_not_contains "$ENGINE_LOG" 'turn-certs'
[[ "$(run_line)" == *' ghcr.io/ashkan-esz/slowmeet:latest' ]] || test_fail 'the image must stay the last argument'

# With a certificate directory, TURN over TLS is published and the directory
# mounted read-only; ports an operator changed are followed.
reset_install "$base_env"'TURN_SERVER_ENABLED=true\nTURN_SERVER_PORT=3500\nTURN_SERVER_TLS_PORT=6000\nTURN_CERT_DIR=/etc/turn-certs\n'
start_container
assert_contains "$ENGINE_LOG" '--volume /etc/turn-certs:/etc/slowmeet/turn-certs:ro --publish 3500:3500/udp --publish 3500:3500/tcp --publish 6000:6000/tcp'
assert_not_contains "$ENGINE_LOG" ':ro,Z'

# Podman needs the SELinux relabel suffix on the mount.
engine=podman
reset_install "$base_env"'TURN_SERVER_ENABLED=true\nTURN_CERT_DIR=/etc/turn-certs\n'
start_container
assert_contains "$ENGINE_LOG" '--restart always'
assert_contains "$ENGINE_LOG" '--volume /etc/turn-certs:/etc/slowmeet/turn-certs:ro,Z --publish 3478:3478/udp --publish 3478:3478/tcp --publish 5349:5349/tcp'
engine=docker

# TURN over TLS switched off keeps its port unpublished.
reset_install "$base_env"'TURN_SERVER_ENABLED=true\nTURN_SERVER_TLS_PORT=0\nTURN_CERT_DIR=/etc/turn-certs\n'
start_container
assert_not_contains "$ENGINE_LOG" '--publish 0:0'
assert_not_contains "$ENGINE_LOG" '5349'

# A port another service holds is left out with a warning; the container
# still starts, with the ports that are free.
reset_install "$base_env"'TURN_SERVER_ENABLED=true\nTURN_CERT_DIR=/etc/turn-certs\n'
BUSY_PORTS='udp:3478 tcp:5349'
start_container
assert_contains "$ENGINE_LOG" '--publish 3478:3478/tcp'
assert_not_contains "$ENGINE_LOG" '3478:3478/udp'
assert_not_contains "$ENGINE_LOG" '5349:5349/tcp'
assert_contains "$LOG_FILE" 'port 3478/udp is already in use'
assert_contains "$LOG_FILE" 'port 5349/tcp is already in use'

# A port that is not a number stops the run before any container starts.
reset_install "$base_env"'TURN_SERVER_ENABLED=true\nTURN_SERVER_PORT=turn\n'
if (start_container) 2>/dev/null; then
    test_fail 'an invalid TURN_SERVER_PORT must stop the run'
fi
assert_not_contains "$ENGINE_LOG" ' run --detach '
assert_contains "$LOG_FILE" 'TURN_SERVER_PORT in the environment file must be a port number'

# --- A fresh installation's .env ------------------------------------------------

# Answers are read from descriptor 3, as the installer reads the terminal:
# HTTP port, admin password (twice), meeting password, then the arguments: ICE
# public IP, STUN servers, and the TURN answers.
answers() { printf '%s\n' 8080 admin-password admin-password '' "$@"; }
new_env() {
    rm -rf "$INSTALL_DIR"
    : > "$LOG_FILE"
    create_env_file 3< <(answers "$@") 2>/dev/null
}

# No relay: nothing about TURN but the empty URL list.
new_env '' '' none
assert_contains "$ENV_FILE" 'TURN_URLS='
assert_not_contains "$ENV_FILE" 'TURN_SERVER_ENABLED'
assert_not_contains "$ENV_FILE" 'TURN_SHARED_SECRET'
# A fixed username and password never reach browsers and are not asked for.
assert_not_contains "$ENV_FILE" 'TURN_USERNAME'
assert_not_contains "$ENV_FILE" 'TURN_PASSWORD'
assert_contains "$ENV_FILE" 'ADMIN_PASSWORD=admin-password'
assert_contains "$ENV_FILE" 'ICE_UDP_PORT_MAX=50100'
[[ "$(stat -c '%a' "$ENV_FILE")" == 600 ]] || test_fail 'the environment file holds passwords and must be private'

# The default answer is no relay.
new_env '' '' ''
assert_not_contains "$ENV_FILE" 'TURN_SERVER_ENABLED'

# Built-in relay: switched on, with a generated secret and URLs for the host
# browsers were told, which defaults to the ICE public IP.
new_env 203.0.113.7 '' builtin '' no
assert_contains "$ENV_FILE" 'ICE_PUBLIC_IP=203.0.113.7'
assert_contains "$ENV_FILE" 'TURN_SERVER_ENABLED=true'
assert_contains "$ENV_FILE" 'TURN_URLS=turn:203.0.113.7:3478?transport=udp,turn:203.0.113.7:3478?transport=tcp'
grep -Eq '^TURN_SHARED_SECRET=[a-f0-9]{64}$' "$ENV_FILE" || test_fail 'the built-in relay needs a generated 64-digit secret'
assert_not_contains "$ENV_FILE" 'turns:'
assert_not_contains "$ENV_FILE" 'TURN_CERT_DIR'
first_secret=$(read_env_value TURN_SHARED_SECRET)
new_env 203.0.113.7 '' builtin '' no
[[ "$(read_env_value TURN_SHARED_SECRET)" != "$first_secret" ]] || test_fail 'every installation needs its own secret'

# Built-in relay with TURN over TLS: the certificate directory is recorded for
# the mount, and the relay is told where the files are in the container.
cert_dir="$TEMP_DIR/certs"
mkdir -p "$cert_dir"
new_env '' '' builtin meet.example.com yes "$cert_dir"
assert_contains "$ENV_FILE" 'TURN_URLS=turn:meet.example.com:3478?transport=udp,turn:meet.example.com:3478?transport=tcp,turns:meet.example.com:5349?transport=tcp'
assert_contains "$ENV_FILE" "TURN_CERT_DIR=$cert_dir"
assert_contains "$ENV_FILE" 'TURN_SERVER_TLS_CERT_FILE=/etc/slowmeet/turn-certs/fullchain.pem'
assert_contains "$ENV_FILE" 'TURN_SERVER_TLS_KEY_FILE=/etc/slowmeet/turn-certs/privkey.pem'
# What was written starts the container with the relay's ports and the mount.
engine=docker
printf 'image=ghcr.io/ashkan-esz/slowmeet:latest\n' > "$STATE_FILE"
: > "$ENGINE_LOG"
start_container
assert_contains "$ENGINE_LOG" "--volume $cert_dir:/etc/slowmeet/turn-certs:ro --publish 3478:3478/udp --publish 3478:3478/tcp --publish 5349:5349/tcp"

# A host that is not a plain name or address, or a certificate directory that
# does not exist, stops the installation instead of writing a relay that
# cannot work.
for bad in 'builtin|meet.example.com/path|no' 'builtin||no' "builtin|meet.example.com|yes|$TEMP_DIR/missing"; do
    IFS='|' read -r -a turn_answers <<< "$bad"
    if (new_env '' '' "${turn_answers[@]}") 2>/dev/null; then
        test_fail "the installer accepted TURN answers '$bad'"
    fi
    [[ ! -e "$ENV_FILE" ]] || test_fail "an environment file was written for TURN answers '$bad'"
done

# External server: its URLs and the secret it shares with SlowMeet.
new_env '' '' external 'turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349' external-secret
assert_contains "$ENV_FILE" 'TURN_URLS=turn:turn.example.com:3478?transport=udp,turns:turn.example.com:5349'
assert_contains "$ENV_FILE" 'TURN_SHARED_SECRET=external-secret'
assert_not_contains "$ENV_FILE" 'TURN_SERVER_ENABLED'
for bad in 'external|https://turn.example.com|secret' 'external|turn:turn.example.com|'; do
    IFS='|' read -r -a turn_answers <<< "$bad"
    if (new_env '' '' "${turn_answers[@]}") 2>/dev/null; then
        test_fail "the installer accepted TURN answers '$bad'"
    fi
    [[ ! -e "$ENV_FILE" ]] || test_fail "an environment file was written for TURN answers '$bad'"
done

printf 'Container installer TURN checks passed.\n'
