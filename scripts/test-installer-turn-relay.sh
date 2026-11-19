#!/usr/bin/env bash
# Many checks below compare literal installer source text (SC2016), and several
# variables are read only by installer functions sourced at run time (SC2034).
# shellcheck disable=SC2016,SC2034
set -Eeuo pipefail

# Checks how the installer sets up the TURN relay built into SlowMeet: a fresh
# installation, the certificate renewal hook, and moving an existing
# installation off the former coturn container. Nothing here needs root or a
# container engine; the commands that would are replaced by recording stubs.

readonly INSTALLER=deploy/install.sh
TEMP_DIR=$(mktemp -d)
readonly TEMP_DIR
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
    printf 'installer TURN relay test failed: %s\n' "$*" >&2
    exit 1
}

assert_contains() {
    local file=$1 expected=$2
    grep -Fq -- "$expected" "$file" || fail "expected '$expected' in $file"
}

assert_not_contains() {
    local file=$1 unexpected=$2
    if grep -Fq -- "$unexpected" "$file"; then
        fail "did not expect '$unexpected' in $file"
    fi
}

# --- Stubs ------------------------------------------------------------------

REAL_INSTALL=$(command -v install)
export REAL_INSTALL
export INSTALL_LOG="$TEMP_DIR/install.log"
export ENGINE_LOG="$TEMP_DIR/engine.log"
mkdir -p "$TEMP_DIR/bin"

# Setting an owner needs root. Record the full call, then run it without one.
cat > "$TEMP_DIR/bin/install" <<'STUB'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$INSTALL_LOG"
args=()
while (($#)); do
    case "$1" in
        -o|-g) shift 2 ;;
        *) args+=("$1"); shift ;;
    esac
done
exec "$REAL_INSTALL" "${args[@]}"
STUB

# Container engines record their arguments; `ps` lists FAKE_CONTAINERS.
for engine in docker podman podman-compose; do
    cat > "$TEMP_DIR/bin/$engine" <<'STUB'
#!/usr/bin/env bash
printf '%s %s\n' "${0##*/}" "$*" >> "$ENGINE_LOG"
if [[ "${1:-}" == ps ]]; then
    printf '%s' "${FAKE_CONTAINERS:-}"
fi
STUB
done
printf '#!/usr/bin/env bash\nexit 0\n' > "$TEMP_DIR/bin/systemctl"
chmod +x "$TEMP_DIR/bin/"*
export PATH="$TEMP_DIR/bin:$PATH"

# --- Installer functions under test ------------------------------------------

INSTALL_DIR="$TEMP_DIR/slowmeet"
ENV_FILE="$INSTALL_DIR/.env"
CERT_DIR="$TEMP_DIR/proxy-certs"
TURN_CERT_DIR="$TEMP_DIR/turn-certs"
CERT_HOOK="$TEMP_DIR/cert-hook"
PODMAN_SERVICE_FILE="$TEMP_DIR/slowmeet-podman.service"
LOG_FILE="$TEMP_DIR/installer.log"
domain=meet.example.com
container_engine=docker
enable_turn=yes
log() { printf '%s\n' "$*" >> "$LOG_FILE"; }

# shellcheck source=/dev/null
source <(sed -n '/^compose_file_is_configured() {/,/^wait_for_updated_service() {/p' "$INSTALLER" | sed '$d' \
    | awk '/^compose_file_is_configured\(\) \{/ { copying=1 } copying { print } copying && /^\)$/ { exit }')
# shellcheck source=/dev/null
source <(sed -n '/^write_podman_service() {/,/^write_install_state() {/p' "$INSTALLER" | sed '$d')
# shellcheck source=/dev/null
source <(sed -n '/^read_env_value() {/,/^set_admin_password() {/p' "$INSTALLER" | sed '$d')

for required in compose write_podman_service raise_relay_memory_limit install_turn_certs \
    enable_relay_compose_override remove_coturn_container migrate_coturn_relay write_cert_hook; do
    declare -F "$required" >/dev/null || fail "the installer no longer defines $required"
done

reset_install() {
    # $1: .env contents (printf %b format)
    rm -rf "$INSTALL_DIR" "$CERT_DIR" "$TURN_CERT_DIR"
    mkdir -p "$INSTALL_DIR/deploy/coturn" "$CERT_DIR"
    : > "$INSTALL_DIR/deploy/compose.turn.yml"
    : > "$INSTALL_DIR/deploy/podman-compose.turn.yml"
    printf '%b' "$1" > "$ENV_FILE"
    : > "$INSTALL_LOG"
    : > "$ENGINE_LOG"
    : > "$LOG_FILE"
}

assert_env() {
    local key=$1 expected=$2 actual
    actual=$(read_env_value "$key")
    [[ "$actual" == "$expected" ]] || fail "$key is '$actual', expected '$expected': $3"
}

# --- Nothing of coturn is left to install ------------------------------------

for gone in '--profile turn' 'write_coturn_config' 'raise_turn_cpu_limit' 'TURN_CONFIG_FILE "' \
    'ufw allow 49152:49999/udp' '-o 65534' 'SIGUSR2' 'restart coturn'; do
    assert_not_contains "$INSTALLER" "$gone"
done
for compose_file in docker-compose.yml podman-compose.yml; do
    assert_not_contains "$compose_file" 'coturn'
    assert_not_contains "$compose_file" 'profiles:'
done
[[ ! -e deploy/coturn ]] || fail 'deploy/coturn must not ship any more'
for kept in "ufw allow 3478/udp comment 'SlowMeet TURN UDP'" "ufw allow 3478/tcp comment 'SlowMeet TURN TCP'" \
    "ufw allow 5349/tcp comment 'SlowMeet TURN TLS'"; do
    assert_contains "$INSTALLER" "$kept"
done

# The two engines' overrides must enable the same relay: same ports, same
# settings, and the same mount apart from Podman's SELinux relabel suffix.
normalized_override() {
    grep -v '^[[:space:]]*#' "$1" | sed 's/:ro,Z"/:ro"/'
}
diff <(normalized_override deploy/compose.turn.yml) <(normalized_override deploy/podman-compose.turn.yml) >/dev/null \
    || fail 'deploy/compose.turn.yml and deploy/podman-compose.turn.yml have drifted apart'
for override in deploy/compose.turn.yml deploy/podman-compose.turn.yml; do
    assert_contains "$override" 'TURN_SERVER_ENABLED: "true"'
    assert_contains "$override" 'TURN_SERVER_TLS_CERT_FILE: /etc/slowmeet/turn-certs/fullchain.pem'
    assert_contains "$override" 'TURN_SERVER_TLS_KEY_FILE: /etc/slowmeet/turn-certs/privkey.pem'
    assert_contains "$override" '"${TURN_SERVER_PORT:-3478}:${TURN_SERVER_PORT:-3478}/udp"'
    assert_contains "$override" '"${TURN_SERVER_PORT:-3478}:${TURN_SERVER_PORT:-3478}/tcp"'
    assert_contains "$override" '"${TURN_SERVER_TLS_PORT:-5349}:${TURN_SERVER_TLS_PORT:-5349}/tcp"'
    assert_contains "$override" '${TURN_CERT_DIR:-./deploy/turn-certs}:/etc/slowmeet/turn-certs:ro'
done
[[ -f deploy/turn-certs/.gitignore ]] || fail 'the default TURN certificate directory must exist in the checkout'

line_of() {
    # $1: text, $2: literal pattern; prints the first matching line number
    grep -nF -- "$2" <<<"$1" | head -n1 | cut -d: -f1
}

# A fresh installation with TURN turns the built-in relay on.
fresh_install=$(sed -n '/^set_env ICE_PUBLIC_IP "\$public_ipv4"$/,/^chmod 0600 "\$ENV_FILE"$/p' "$INSTALLER")
for expected in 'raise_relay_memory_limit' 'set_env TURN_SERVER_ENABLED true' 'set_env TURN_SERVER_REALM "$domain"' \
    'set_env TURN_SHARED_SECRET "$turn_secret"' 'set_env TURN_CERT_DIR "$TURN_CERT_DIR"' \
    'turn:$domain:3478?transport=udp,turn:$domain:3478?transport=tcp,turns:$domain:5349?transport=tcp' \
    'install_turn_certs "/etc/letsencrypt/live/$domain"' 'install -d -o 10001 -g 10001 -m 0700 "$TURN_CERT_DIR"' \
    'enable_relay_compose_override' 'touch "$INSTALL_DIR/.turn-enabled"'; do
    [[ -n "$(line_of "$fresh_install" "$expected")" ]] || fail "a fresh TURN installation must run: $expected"
done
# Host networking is decided first: it only acts on an empty COMPOSE_FILE.
[[ "$(line_of "$fresh_install" 'enable_host_network_if_supported')" \
    -lt "$(line_of "$fresh_install" 'enable_relay_compose_override')" ]] \
    || fail 'host networking must be chosen before the relay override is added'

# --- Resource limits ---------------------------------------------------------

# .env starts as a copy of .env.example, so its shipped limits count as unset.
for shipped in 'SLOWMEET_CPUS=0.75' 'SLOWMEET_MEMORY_LIMIT=256m' 'SLOWMEET_GOMEMLIMIT=200MiB'; do
    grep -Fxq -- "$shipped" .env.example \
        || fail "the installer treats $shipped as the shipped default, but .env.example no longer ships it"
done
for removed in TURN_CONFIG_FILE TURN_CPUS TURN_MEMORY_LIMIT TURN_PIDS_LIMIT; do
    if grep -Eq "^#? ?$removed=" .env.example; then
        fail ".env.example still ships the coturn setting $removed"
    fi
done

# The relay shares the app's memory limit, which the installer raises. The CPU
# limit is never touched: it stays at the shipped 0.75 (or the operator's own
# value), with or without TURN.
assert_not_contains "$INSTALLER" 'set_env SLOWMEET_CPUS'
limits_after() {
    reset_install "$1"
    raise_relay_memory_limit
    printf '%s|%s|%s' "$(read_env_value SLOWMEET_CPUS)" "$(read_env_value SLOWMEET_MEMORY_LIMIT)" \
        "$(read_env_value SLOWMEET_GOMEMLIMIT)"
}
[[ "$(limits_after 'SLOWMEET_CPUS=0.75\nSLOWMEET_MEMORY_LIMIT=256m\nSLOWMEET_GOMEMLIMIT=200MiB\n')" == '0.75|384m|300MiB' ]] \
    || fail 'the shipped memory limits must be raised for the relay and the CPU limit must stay at 0.75'
[[ "$(limits_after 'OTHER=1\n')" == '|384m|300MiB' ]] \
    || fail 'missing memory limits must be set for the relay without adding a CPU limit'
[[ "$(limits_after 'SLOWMEET_CPUS=\nSLOWMEET_MEMORY_LIMIT=\nSLOWMEET_GOMEMLIMIT=\n')" == '|384m|300MiB' ]] \
    || fail 'empty memory limits must be set for the relay without setting a CPU limit'
[[ "$(limits_after 'SLOWMEET_CPUS=2.0\nSLOWMEET_MEMORY_LIMIT=512m\nSLOWMEET_GOMEMLIMIT=400MiB\n')" == '2.0|512m|400MiB' ]] \
    || fail "an operator's limits must be kept"
[[ "$(limits_after 'SLOWMEET_CPUS=0.50\nSLOWMEET_MEMORY_LIMIT=256m\nSLOWMEET_GOMEMLIMIT=200MiB\n')" == '0.50|384m|300MiB' ]] \
    || fail "an operator's lower CPU limit must be kept"
[[ "$(limits_after 'SLOWMEET_CPUS=0.75\nSLOWMEET_MEMORY_LIMIT=200m\nSLOWMEET_GOMEMLIMIT=200MiB\n')" == '0.75|200m|200MiB' ]] \
    || fail "the Go heap limit must not be raised above an operator's memory limit"
[[ "$(limits_after 'SLOWMEET_CPUS=0.75\nSLOWMEET_MEMORY_LIMIT=256m\nSLOWMEET_GOMEMLIMIT=180MiB\n')" == '0.75|384m|180MiB' ]] \
    || fail "an operator's Go heap limit must be kept"

# --- Compose override --------------------------------------------------------

override_after() {
    # $1: .env contents, $2: container engine
    reset_install "$1"
    container_engine=$2
    enable_relay_compose_override
    read_env_value COMPOSE_FILE
}
[[ "$(override_after 'ICE_PUBLIC_IP=203.0.113.7\n' docker)" == docker-compose.yml:deploy/compose.turn.yml ]] \
    || fail 'a bridge-network Docker installation must get the relay override'
[[ "$(override_after 'COMPOSE_FILE=\n' docker)" == docker-compose.yml:deploy/compose.turn.yml ]] \
    || fail 'an empty COMPOSE_FILE must get the relay override'
[[ "$(override_after 'COMPOSE_FILE=docker-compose.yml:deploy/compose.host-network.yml\n' docker)" \
    == docker-compose.yml:deploy/compose.turn.yml:deploy/compose.host-network.yml ]] \
    || fail 'the relay override must come before the host-network override, which drops its published ports'
[[ "$(override_after 'COMPOSE_FILE=docker-compose.yml\n' docker)" == docker-compose.yml:deploy/compose.turn.yml ]] \
    || fail "an operator's bridge-network choice must keep its first file and gain the relay override"
[[ "$(override_after 'COMPOSE_FILE=docker-compose.yml:custom.yml\n' docker)" \
    == docker-compose.yml:deploy/compose.turn.yml:custom.yml ]] \
    || fail "the relay override must be inserted before an operator's own overrides"
[[ "$(override_after 'COMPOSE_FILE=docker-compose.yml:deploy/compose.turn.yml:deploy/compose.host-network.yml\n' docker)" \
    == docker-compose.yml:deploy/compose.turn.yml:deploy/compose.host-network.yml ]] \
    || fail 'adding the relay override twice must change nothing'
[[ -z "$(override_after 'ICE_PUBLIC_IP=203.0.113.7\n' podman)" ]] \
    || fail 'Podman does not read COMPOSE_FILE and must not get one'
reset_install ''
rm -f "$INSTALL_DIR/deploy/compose.turn.yml"
if (enable_relay_compose_override) >/dev/null 2>&1; then
    fail 'a checkout without the relay override must stop the installer'
fi

# --- Compose commands --------------------------------------------------------

last_engine_call() { tail -n1 "$ENGINE_LOG"; }

reset_install ''
compose up -d --build
[[ "$(last_engine_call)" == "docker compose -f $INSTALL_DIR/docker-compose.yml up -d --build" ]] \
    || fail "Docker without COMPOSE_FILE ran: $(last_engine_call)"
reset_install 'COMPOSE_FILE=docker-compose.yml:deploy/compose.turn.yml\n'
compose up -d --build
[[ "$(last_engine_call)" == 'docker compose up -d --build' ]] \
    || fail "Docker with COMPOSE_FILE must leave the file list to Compose, but ran: $(last_engine_call)"

container_engine=podman
reset_install ''
compose up -d --build
[[ "$(last_engine_call)" == "podman-compose -f $INSTALL_DIR/podman-compose.yml up -d --build" ]] \
    || fail "Podman without TURN ran: $(last_engine_call)"
touch "$INSTALL_DIR/.turn-enabled"
compose up -d --build
[[ "$(last_engine_call)" == "podman-compose -f $INSTALL_DIR/podman-compose.yml -f $INSTALL_DIR/deploy/podman-compose.turn.yml up -d --build" ]] \
    || fail "Podman with TURN must pass the relay override, but ran: $(last_engine_call)"
# An older checkout that is only being uninstalled has no override file.
rm -f "$INSTALL_DIR/deploy/podman-compose.turn.yml"
compose down
[[ "$(last_engine_call)" == "podman-compose -f $INSTALL_DIR/podman-compose.yml down" ]] \
    || fail "Podman must not pass an override the checkout lacks, but ran: $(last_engine_call)"

reset_install ''
enable_turn=yes
write_podman_service
assert_contains "$PODMAN_SERVICE_FILE" "-f $INSTALL_DIR/podman-compose.yml -f $INSTALL_DIR/deploy/podman-compose.turn.yml up -d"
assert_contains "$PODMAN_SERVICE_FILE" "-f $INSTALL_DIR/podman-compose.yml -f $INSTALL_DIR/deploy/podman-compose.turn.yml down"
assert_not_contains "$PODMAN_SERVICE_FILE" '--profile'
enable_turn=no
write_podman_service
assert_contains "$PODMAN_SERVICE_FILE" "-f $INSTALL_DIR/podman-compose.yml up -d"
assert_not_contains "$PODMAN_SERVICE_FILE" 'podman-compose.turn.yml'
enable_turn=yes
container_engine=docker

# --- Certificates ------------------------------------------------------------

# The relay runs as the container user and needs its own readable copy.
reset_install ''
printf 'certificate\n' > "$CERT_DIR/fullchain.pem"
printf 'key\n' > "$CERT_DIR/privkey.pem"
install_turn_certs "$CERT_DIR"
[[ "$(cat "$TURN_CERT_DIR/fullchain.pem")" == certificate && "$(cat "$TURN_CERT_DIR/privkey.pem")" == key ]] \
    || fail 'the relay certificate copy was not installed'
assert_contains "$INSTALL_LOG" "-d -o 10001 -g 10001 -m 0700 $TURN_CERT_DIR"
assert_contains "$INSTALL_LOG" "-o 10001 -g 10001 -m 0400 $CERT_DIR/fullchain.pem $TURN_CERT_DIR/fullchain.pem"
assert_contains "$INSTALL_LOG" "-o 10001 -g 10001 -m 0400 $CERT_DIR/privkey.pem $TURN_CERT_DIR/privkey.pem"

# A renewal refreshes that copy and restarts nothing: the relay re-reads the
# files by itself, so relayed calls stay up.
write_cert_hook
bash -n "$CERT_HOOK" || fail 'the generated renewal hook is not valid shell'
[[ -x "$CERT_HOOK" ]] || fail 'the renewal hook must be executable'
assert_contains "$CERT_HOOK" 'if [[ -f /opt/slowmeet/.turn-enabled ]]; then'
assert_contains "$CERT_HOOK" 'install -d -o 10001 -g 10001 -m 0700 /etc/slowmeet/turn-certs'
assert_contains "$CERT_HOOK" 'install -o 10001 -g 10001 -m 0400 "$RENEWED_LINEAGE/fullchain.pem" /etc/slowmeet/turn-certs/fullchain.pem'
assert_contains "$CERT_HOOK" 'install -o 10001 -g 10001 -m 0400 "$RENEWED_LINEAGE/privkey.pem" /etc/slowmeet/turn-certs/privkey.pem'
assert_contains "$CERT_HOOK" 'systemctl reload "$proxy_mode"'
for unwanted in coturn compose docker podman SIGUSR2 ' kill ' 65534 container_engine; do
    assert_not_contains "$CERT_HOOK" "$unwanted"
done

# --- Moving an installation off coturn ---------------------------------------

coturn_env='TURN_URLS=turn:meet.example.com:3478?transport=udp,turns:meet.example.com:5349?transport=tcp\n'
coturn_env+='TURN_SHARED_SECRET=0123abcd\n'
coturn_env+="TURN_CONFIG_FILE=$INSTALL_DIR/deploy/coturn/turnserver.conf\n"
coturn_env+="TURN_CERT_DIR=$TURN_CERT_DIR\n"
coturn_env+='TURN_CPUS=0.50\nSLOWMEET_CPUS=0.75\nSLOWMEET_MEMORY_LIMIT=256m\nSLOWMEET_GOMEMLIMIT=200MiB\n'
coturn_config="$INSTALL_DIR/deploy/coturn/turnserver.conf"

write_installer_coturn_config() {
    cat > "$coturn_config" <<'EOF'
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=0123abcd
realm=meet.example.com
cert=/etc/letsencrypt/fullchain.pem
pkey=/etc/letsencrypt/privkey.pem
min-port=49152
max-port=49999
no-multicast-peers
no-tcp-relay
denied-peer-ip=0.0.0.0-255.255.255.255
allowed-peer-ip=203.0.113.7
EOF
}

# An installation the installer set up with coturn.
reset_install "$coturn_env"
write_installer_coturn_config
printf 'certificate\n' > "$CERT_DIR/fullchain.pem"
printf 'key\n' > "$CERT_DIR/privkey.pem"
migrate_coturn_relay
assert_env TURN_SERVER_ENABLED true 'the built-in relay must be switched on'
assert_env TURN_SERVER_REALM meet.example.com "coturn's realm is kept"
assert_env TURN_SERVER_PORT '' 'default listen ports are not written'
assert_env TURN_SERVER_TLS_PORT '' 'default listen ports are not written'
assert_env TURN_SERVER_RELAY_PORT_MIN '' 'the relay range is not carried over'
assert_env TURN_SERVER_RELAY_PORT_MAX '' 'the relay range is not carried over'
assert_env TURN_URLS 'turn:meet.example.com:3478?transport=udp,turns:meet.example.com:5349?transport=tcp' \
    'browsers must keep the same relay addresses'
assert_env TURN_SHARED_SECRET 0123abcd 'issued credentials must stay valid'
assert_env TURN_CERT_DIR "$TURN_CERT_DIR" "the installer's certificate directory is kept"
assert_env SLOWMEET_CPUS 0.75 'the app CPU limit is left as it was'
assert_env SLOWMEET_MEMORY_LIMIT 384m 'the relay shares the app memory limit'
assert_env SLOWMEET_GOMEMLIMIT 300MiB 'the Go heap limit follows the memory limit'
# The old configuration is set aside, private, for a rollback.
[[ ! -e "$coturn_config" ]] || fail 'turnserver.conf is no longer read and must not stay in place'
assert_contains "$coturn_config.migrated" 'static-auth-secret=0123abcd'
[[ "$(stat -c '%a' "$coturn_config.migrated")" == 600 ]] \
    || fail 'the kept coturn configuration holds the shared secret and must be private'
[[ "$(cat "$TURN_CERT_DIR/privkey.pem")" == key ]] || fail 'the relay must get a certificate copy'
assert_contains "$INSTALL_LOG" "-o 10001 -g 10001 -m 0400 $CERT_DIR/privkey.pem $TURN_CERT_DIR/privkey.pem"
assert_not_contains "$LOG_FILE" 'WARNING'

# Running it again (every later update does) changes nothing.
before=$(cksum < "$ENV_FILE")
migrate_coturn_relay
[[ "$(cksum < "$ENV_FILE")" == "$before" ]] || fail 'migrating an already migrated installation changed .env'

# An operator's own ports and realm are carried over. The relay port range is
# not (an old installer's 100-port range is too small for the rotating methods,
# and nothing outside the host reaches it any more), and neither is coturn's
# CPU limit: the app's stays where it is.
reset_install "${coturn_env/TURN_CPUS=0.50/TURN_CPUS=1.0}"
cat > "$coturn_config" <<'EOF'
# edited by hand
listening-port = 3479
tls-listening-port=5350   # behind an SNI router
realm=turn.example.net
min-port=49160
max-port=49200
EOF
printf 'allowed-peer-ip=203.0.113.7' >> "$coturn_config" # no trailing newline
migrate_coturn_relay
assert_env TURN_SERVER_PORT 3479 "an operator's coturn listen port is kept"
assert_env TURN_SERVER_TLS_PORT 5350 "an operator's coturn TLS port is kept"
assert_env TURN_SERVER_REALM turn.example.net "an operator's realm is kept"
assert_env TURN_SERVER_RELAY_PORT_MIN '' 'a narrow coturn relay range must not be carried over'
assert_env TURN_SERVER_RELAY_PORT_MAX '' 'a narrow coturn relay range must not be carried over'
assert_env SLOWMEET_CPUS 0.75 "coturn's CPU limit must not be added to the app's"

# A privileged coturn port cannot be bound by the unprivileged container; the
# installer says so instead of configuring a relay that cannot start.
reset_install "$coturn_env"
printf 'listening-port=3478\ntls-listening-port=443\n' > "$coturn_config"
migrate_coturn_relay
assert_env TURN_SERVER_TLS_PORT '' 'a privileged port must not be carried over'
assert_contains "$LOG_FILE" "WARNING: coturn's tls-listening-port=443 is a privileged port"

# Values the operator already set for the built-in relay win over coturn's.
reset_install "${coturn_env}TURN_SERVER_PORT=3500\nTURN_SERVER_REALM=chosen.example\nSLOWMEET_CPUS=2.0\nTURN_CPUS=1.0\n"
printf 'listening-port=3479\nrealm=turn.example.net\n' > "$coturn_config"
migrate_coturn_relay
assert_env TURN_SERVER_PORT 3500 "an operator's relay port is kept"
assert_env TURN_SERVER_REALM chosen.example "an operator's relay realm is kept"
assert_env SLOWMEET_CPUS 2.0 "an operator's app CPU limit is kept"

# An older installer mounted the proxy's root-owned certificate copy.
reset_install "${coturn_env/"TURN_CERT_DIR=$TURN_CERT_DIR"/TURN_CERT_DIR=$CERT_DIR}"
printf 'certificate\n' > "$CERT_DIR/fullchain.pem"
printf 'key\n' > "$CERT_DIR/privkey.pem"
migrate_coturn_relay
assert_env TURN_CERT_DIR "$TURN_CERT_DIR" 'the relay must mount its own certificate copy'
[[ -f "$TURN_CERT_DIR/fullchain.pem" ]] || fail 'the relay certificate copy was not created'

# Without HTTPS there is no certificate; the mount source still has to exist
# and belong to the container user.
reset_install "$coturn_env"
rm -rf "$CERT_DIR"
migrate_coturn_relay
[[ -d "$TURN_CERT_DIR" ]] || fail 'the certificate directory must exist for the bind mount'
assert_contains "$INSTALL_LOG" "-d -o 10001 -g 10001 -m 0700 $TURN_CERT_DIR"

# An operator's own certificate directory is left alone and pointed out.
reset_install "${coturn_env/"TURN_CERT_DIR=$TURN_CERT_DIR"/TURN_CERT_DIR=/srv/own-certs}"
migrate_coturn_relay
assert_env TURN_CERT_DIR /srv/own-certs "an operator's certificate directory is kept"
assert_contains "$LOG_FILE" 'TURN_CERT_DIR=/srv/own-certs is kept'
[[ ! -e "$TURN_CERT_DIR" ]] || fail "the installer's certificate directory must not be created for an operator's own"

# An installation without the coturn settings (already on the built-in relay,
# or with a deleted turnserver.conf) only gets the switch and the limits.
reset_install 'TURN_SHARED_SECRET=0123abcd\n'
migrate_coturn_relay
assert_env TURN_SERVER_ENABLED true 'the built-in relay must be switched on'
assert_env TURN_SERVER_REALM meet.example.com 'the realm defaults to the domain'
assert_env TURN_CERT_DIR "$TURN_CERT_DIR" 'the certificate directory is recorded'

# --- The former coturn container ---------------------------------------------

# It is not in the Compose project any more, so the installer removes it by
# its Compose labels before the relay binds the TURN ports.
reset_install ''
FAKE_CONTAINERS=$'abc123\ndef456\n' remove_coturn_container
assert_contains "$ENGINE_LOG" 'docker ps -aq --filter label=com.docker.compose.service=coturn --filter label=com.docker.compose.project=slowmeet'
assert_contains "$ENGINE_LOG" 'docker rm -f abc123 def456'
assert_contains "$LOG_FILE" 'Removed the former coturn container'

reset_install ''
remove_coturn_container
assert_not_contains "$ENGINE_LOG" ' rm '
assert_not_contains "$LOG_FILE" 'Removed'

reset_install 'COMPOSE_PROJECT_NAME=meet\n'
container_engine=podman
FAKE_CONTAINERS=$'abc123\n' remove_coturn_container
container_engine=docker
assert_contains "$ENGINE_LOG" 'podman ps -aq --filter label=com.docker.compose.service=coturn --filter label=com.docker.compose.project=meet'
assert_contains "$ENGINE_LOG" 'podman rm -f abc123'

# --- Installer flows ---------------------------------------------------------

# An update moves a coturn installation over before it starts the new
# containers. It builds the image while coturn still serves, and removes the
# coturn container only right before the swap, so TURN is not down for the
# length of a build.
update_path=$(sed -n '/Updating the existing SlowMeet checkout/,/wait_for_updated_service$/p' "$INSTALLER")
for expected in 'migrate_coturn_relay' 'enable_relay_compose_override' 'touch "$INSTALL_DIR/.turn-enabled"' \
    'if [[ -f "$CERT_HOOK" ]]; then' 'write_cert_hook' 'write_podman_service' 'compose build' \
    'remove_coturn_container' 'compose up -d'; do
    [[ -n "$(line_of "$update_path" "$expected")" ]] || fail "an update must run: $expected"
done
[[ -z "$(line_of "$update_path" 'compose up -d --build')" ]] \
    || fail 'an update must build before it removes the coturn container, not while starting'
[[ "$(line_of "$update_path" 'git -C "$INSTALL_DIR" checkout')" -lt "$(line_of "$update_path" 'migrate_coturn_relay')" ]] \
    || fail 'the checkout must be updated before the relay override it ships is used'
[[ "$(line_of "$update_path" 'enable_host_network_if_supported')" -lt "$(line_of "$update_path" 'enable_relay_compose_override')" ]] \
    || fail 'host networking must be chosen before the relay override is added'
[[ "$(line_of "$update_path" 'migrate_coturn_relay')" -lt "$(line_of "$update_path" 'compose build')" ]] \
    || fail 'the relay must be configured before the containers are built and started'
[[ "$(line_of "$update_path" 'compose build')" -lt "$(line_of "$update_path" 'remove_coturn_container')" ]] \
    || fail 'the image must be built while the coturn container still serves'
[[ "$(line_of "$update_path" 'remove_coturn_container')" -lt "$(line_of "$update_path" 'compose up -d')" ]] \
    || fail 'the coturn container must be removed before the relay binds the TURN ports'

# A fresh installation and an uninstall also clear a leftover coturn container.
[[ "$(grep -c '^remove_coturn_container$' "$INSTALLER")" == 1 ]] \
    || fail 'a fresh installation must remove a leftover coturn container before starting'
uninstall_path=$(sed -n '/^uninstall_existing_install() {/,/^}/p' "$INSTALLER")
[[ "$(line_of "$uninstall_path" 'remove_coturn_container')" -lt "$(line_of "$uninstall_path" 'compose down')" ]] \
    || fail 'an uninstall must remove a leftover coturn container'

# An installation is recognized as using TURN by the marker file, the relay
# switch, or (before either existed) a coturn configuration file.
legacy_detection=$(sed -n '/^load_legacy_install_settings() {/,/^}/p' "$INSTALLER")
for expected in '"$INSTALL_DIR/.turn-enabled"' '$(read_env_value TURN_SERVER_ENABLED)' 'read_env_value TURN_CONFIG_FILE'; do
    [[ -n "$(line_of "$legacy_detection" "$expected")" ]] || fail "TURN detection must check: $expected"
done

printf 'Installer TURN relay checks passed.\n'
