#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALLER=deploy/install.sh
# Read by installer functions sourced dynamically below.
# shellcheck disable=SC2034
readonly CADDY_XRAY_BACKEND_PORT=9080
TEMP_DIR=$(mktemp -d)
readonly TEMP_DIR
trap 'rm -rf "$TEMP_DIR"' EXIT

fail() {
    printf 'installer config test failed: %s\n' "$*" >&2
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

mkdir -p "$TEMP_DIR/bin" "$TEMP_DIR/caddy"
for command_name in caddy chown chmod nginx systemctl; do
    cat > "$TEMP_DIR/bin/$command_name" <<'STUB'
#!/usr/bin/env bash
case "${0##*/}" in
    caddy) [[ "${FAIL_CADDY_VALIDATE:-no}" != yes ]] || exit 1 ;;
    chown) [[ "${FAIL_CHOWN:-no}" != yes ]] || exit 1 ;;
    chmod)
        [[ "${FAIL_CHMOD:-no}" != yes ]] || exit 1
        exec /bin/chmod "$@"
        ;;
    systemctl)
        case "$*" in
            'reload caddy')
                if [[ "${FAIL_CADDY_RELOAD_ONCE:-no}" == yes && ! -e "${RELOAD_COUNT_FILE:-}" ]]; then
                    : > "$RELOAD_COUNT_FILE"
                    exit 1
                fi
                ;;
            'reload nginx')
                if [[ "${FAIL_NGINX_RELOAD_ONCE:-no}" == yes && ! -e "${RELOAD_COUNT_FILE:-}" ]]; then
                    : > "$RELOAD_COUNT_FILE"
                    exit 1
                fi
                ;;
        esac
        ;;
esac
exit 0
STUB
    chmod +x "$TEMP_DIR/bin/$command_name"
done
export PATH="$TEMP_DIR/bin:$PATH"

readonly CADDY_BEGIN_MARKER='# BEGIN SlowMeet installer managed site'
# Read by installer functions sourced dynamically below.
# shellcheck disable=SC2034
readonly CADDY_END_MARKER='# END SlowMeet installer managed site'
# shellcheck disable=SC2034
domain=meet.example.com
# shellcheck disable=SC2034
app_port=8080
# shellcheck disable=SC2034
readonly CERT_DIR=/etc/slowmeet/certs

# shellcheck disable=SC1090
source <(sed -n '/^write_expected_caddyfile() {/,/^uninstall_existing_install() {/p' "$INSTALLER" | sed '$d')
# shellcheck disable=SC1090
source <(sed -n '/^detect_proxy_mode() {/,/^assert_nginx_domain_available() {/p' "$INSTALLER" | sed '$d')
# shellcheck disable=SC1090
source <(sed -n '/^mark_https_unavailable() {/,/^print_https_warning() {/p' "$INSTALLER" | sed '$d')
# shellcheck disable=SC1090
source <(sed -n '/^reload_caddy_after_config_change() {/,/^uninstall_existing_install() {/p' "$INSTALLER" | sed '$d')
# shellcheck disable=SC1090
source <(awk '/^write_nginx_site\(\) \{/ { copying=1 } copying { if (/^\[\[ -r \/etc\/os-release/) exit; print }' "$INSTALLER")

log() { :; }
caddy_https_port_conflicts() { printf '%s\n' "${HTTPS_CONFLICTS:-}"; }

caddyfile="$TEMP_DIR/caddy/Caddyfile"
cat > "$caddyfile" <<'CADDY'
{
    email admin@example.com
}

https://other.example.com {
    respond "existing site"
}
CADDY
chmod 0600 "$caddyfile"

write_caddy_site bootstrap "$caddyfile"
[[ $(stat -c '%a' "$caddyfile") == 640 ]] || fail 'expected merged Caddyfile mode 0640'
assert_contains "$caddyfile" 'email admin@example.com'
assert_contains "$caddyfile" 'respond "existing site"'
write_caddy_site final "$caddyfile"
[[ $(grep -Fc "$CADDY_BEGIN_MARKER" "$caddyfile") -eq 1 ]] || fail 'expected one managed Caddy block'
caddy_config_matches_install "$caddyfile" || fail 'expected managed Caddy block to be recognized'

cat >> "$caddyfile" <<'CADDY'

https://later.example.com {
    respond "added later"
}
CADDY
remove_caddy_site "$caddyfile"
assert_contains "$caddyfile" 'email admin@example.com'
assert_contains "$caddyfile" 'respond "existing site"'
assert_contains "$caddyfile" 'respond "added later"'
assert_not_contains "$caddyfile" "$CADDY_BEGIN_MARKER"
assert_not_contains "$caddyfile" 'https://meet.example.com'
[[ $(stat -c '%a' "$caddyfile") == 640 ]] || fail 'expected remaining Caddyfile mode 0640'

write_caddy_site final "$caddyfile"
sed 's/reverse_proxy 127.0.0.1:8080/reverse_proxy 127.0.0.1:9000/' "$caddyfile" > "$TEMP_DIR/caddy/edited"
if (remove_caddy_site "$TEMP_DIR/caddy/edited") 2>/dev/null; then
    fail 'uninstall accepted a modified managed Caddy block'
fi
assert_contains "$TEMP_DIR/caddy/edited" 'reverse_proxy 127.0.0.1:9000'

assert_no_caddy_staging_files() {
    if compgen -G "$TEMP_DIR/caddy/.Caddyfile.slowmeet.*" >/dev/null; then
        fail 'Caddy operation left staging files behind'
    fi
}

assert_caddy_failure_is_atomic() {
    local failure_name=$1 snapshot="$TEMP_DIR/caddy/before-failure"
    cp "$caddyfile" "$snapshot"
    case "$failure_name" in
        FAIL_CADDY_VALIDATE)
            if FAIL_CADDY_VALIDATE=yes write_caddy_site final "$caddyfile" 2>/dev/null; then
                fail "Caddy write unexpectedly succeeded with $failure_name"
            fi
            ;;
        FAIL_CHOWN)
            if FAIL_CHOWN=yes write_caddy_site final "$caddyfile" 2>/dev/null; then
                fail "Caddy write unexpectedly succeeded with $failure_name"
            fi
            ;;
        FAIL_CHMOD)
            if FAIL_CHMOD=yes write_caddy_site final "$caddyfile" 2>/dev/null; then
                fail "Caddy write unexpectedly succeeded with $failure_name"
            fi
            ;;
    esac
    cmp -s "$snapshot" "$caddyfile" || fail "Caddy write changed the active file after $failure_name failed"
    rm -f "$snapshot"
    assert_no_caddy_staging_files
}

assert_caddy_failure_is_atomic FAIL_CADDY_VALIDATE
assert_caddy_failure_is_atomic FAIL_CHOWN
assert_caddy_failure_is_atomic FAIL_CHMOD

cp "$caddyfile" "$TEMP_DIR/caddy/before-remove-failure"
if FAIL_CADDY_VALIDATE=yes remove_caddy_site "$caddyfile" 2>/dev/null; then
    fail 'Caddy removal unexpectedly succeeded when validation failed'
fi
cmp -s "$TEMP_DIR/caddy/before-remove-failure" "$caddyfile" \
    || fail 'Caddy removal changed the active file after validation failed'
rm -f "$TEMP_DIR/caddy/before-remove-failure"
assert_no_caddy_staging_files

cp "$caddyfile" "$TEMP_DIR/caddy/before-reload-failure"
if FAIL_CADDY_RELOAD_ONCE=yes RELOAD_COUNT_FILE="$TEMP_DIR/caddy/reload-failed" \
    remove_caddy_site "$caddyfile" 2>/dev/null; then
    fail 'Caddy removal unexpectedly succeeded when its reload failed'
fi
cmp -s "$TEMP_DIR/caddy/before-reload-failure" "$caddyfile" \
    || fail 'Caddy removal did not restore the original file after reload failure'
caddy_config_matches_install "$caddyfile" \
    || fail 'Caddy config was not recognized after reload rollback'
rm -f "$TEMP_DIR/caddy/before-reload-failure" "$TEMP_DIR/caddy/reload-failed"
assert_no_caddy_staging_files
remove_caddy_site "$caddyfile"
assert_not_contains "$caddyfile" "$CADDY_BEGIN_MARKER"

write_expected_caddyfile final yes > "$TEMP_DIR/caddy/legacy"
caddy_config_matches_install "$TEMP_DIR/caddy/legacy" || fail 'legacy Caddy configuration was not recognized'
remove_caddy_site "$TEMP_DIR/caddy/legacy"
assert_contains "$TEMP_DIR/caddy/legacy" 'respond 404'

NGINX_SITE="$TEMP_DIR/nginx/slowmeet.conf"
mkdir -p "$(dirname "$NGINX_SITE")"
# Read by ensure_nginx_ipv6_listeners, sourced dynamically above.
# shellcheck disable=SC2034
proxy_mode=nginx
cat > "$NGINX_SITE" <<'NGINX'
# Managed by SlowMeet installer
server {
    listen 80;
    listen [::]:80;
    server_name unrelated.example.com;
}
server {
    listen 80;
    server_name untouched.example.com;
}
server {
    listen 80;
    server_name meet.example.com;
}
server {
    listen 443 ssl;
    server_name meet.example.com;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name another-unrelated.example.com;
}
NGINX
cp "$NGINX_SITE" "$TEMP_DIR/nginx/before-reload-failure.conf"
# Invoked by ensure_nginx_ipv6_listeners, sourced dynamically above.
# shellcheck disable=SC2317,SC2329
ipv6_stack_available() { return 0; }
if FAIL_NGINX_RELOAD_ONCE=yes RELOAD_COUNT_FILE="$TEMP_DIR/nginx/reload-failed" \
    ensure_nginx_ipv6_listeners 2>/dev/null; then
    fail 'Nginx IPv6 migration unexpectedly succeeded when its reload failed'
fi
cmp -s "$TEMP_DIR/nginx/before-reload-failure.conf" "$NGINX_SITE" \
    || fail 'Nginx migration did not restore the original file after reload failure'
if compgen -G "$TEMP_DIR/nginx/.slowmeet-nginx*" >/dev/null; then
    fail 'Nginx migration left temporary files after reload rollback'
fi
rm -f "$TEMP_DIR/nginx/reload-failed"
ensure_nginx_ipv6_listeners
cat > "$TEMP_DIR/nginx/expected.conf" <<'NGINX'
# Managed by SlowMeet installer
server {
    listen 80;
    listen [::]:80;
    server_name unrelated.example.com;
}
server {
    listen 80;
    server_name untouched.example.com;
}
server {
    listen 80;
    listen [::]:80;
    server_name meet.example.com;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name meet.example.com;
}
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name another-unrelated.example.com;
}
NGINX
cmp -s "$TEMP_DIR/nginx/expected.conf" "$NGINX_SITE" \
    || fail 'IPv6 migration did not target the SlowMeet HTTP and HTTPS blocks only'

cp "$NGINX_SITE" "$TEMP_DIR/nginx/with-ipv6.conf"
ipv6_stack_available() { return 1; }
ensure_nginx_ipv6_listeners
cmp -s "$NGINX_SITE" "$TEMP_DIR/nginx/with-ipv6.conf" || fail 'IPv6-disabled update changed the Nginx configuration'

caddy_tls_mode=http-only
write_nginx_site
assert_contains "$NGINX_SITE" 'proxy_pass http://127.0.0.1:8080;'
assert_contains "$NGINX_SITE" 'proxy_set_header X-Forwarded-Proto http;'
assert_not_contains "$NGINX_SITE" 'listen 443 ssl;'
assert_not_contains "$NGINX_SITE" 'return 301 https://'

sed -n '/^report_unexpected_error() {/,/^}/p' "$INSTALLER" > "$TEMP_DIR/error-trap.sh"
set +e
bash -c 'set -Eeuo pipefail; source "$1"; trap report_unexpected_error ERR; false' _ "$TEMP_DIR/error-trap.sh" \
    > "$TEMP_DIR/error-trap-output" 2>&1
trap_status=$?
set -e
[[ "$trap_status" -eq 1 ]] || fail "unexpected-error trap exited with $trap_status instead of 1"
grep -Eq 'command failed near line [0-9]+ \(exit 1\)\.' "$TEMP_DIR/error-trap-output" \
    || fail 'unexpected-error trap did not report the failing line and status'
assert_not_contains "$TEMP_DIR/error-trap-output" 'false'

caddy_tls_mode=xray
caddyfile="$TEMP_DIR/caddy/xray-Caddyfile"
write_caddy_site final "$caddyfile"
caddy_config_matches_install "$caddyfile" || fail 'expected Xray backend Caddy config to be recognized'
assert_contains "$caddyfile" 'http://meet.example.com:9080'
assert_contains "$caddyfile" 'bind 127.0.0.1'
assert_contains "$caddyfile" 'header_up X-Forwarded-Proto https'
assert_not_contains "$caddyfile" 'https://meet.example.com {'

caddy_tls_mode=direct
write_caddy_site final "$caddyfile"
caddy_config_matches_install "$caddyfile" || fail 'expected Xray-to-direct Caddy config migration to be recognized'
assert_contains "$caddyfile" 'https://meet.example.com {'
assert_not_contains "$caddyfile" 'http://meet.example.com:9080'

caddy_tls_mode=http-only
write_caddy_site final "$caddyfile"
assert_contains "$caddyfile" 'http://meet.example.com {'
assert_contains "$caddyfile" 'reverse_proxy 127.0.0.1:8080'
assert_not_contains "$caddyfile" 'https://meet.example.com {'
assert_not_contains "$caddyfile" 'redir https://'
caddy_config_matches_install "$caddyfile" || fail 'expected HTTP-only Caddy config to be recognized'

caddy_tls_mode=direct
https_reason=
HTTPS_CONFLICTS='nipovpn (PID 301)'
export HTTPS_CONFLICTS
FAIL_CADDY_RELOAD_ONCE=yes
RELOAD_COUNT_FILE="$TEMP_DIR/caddy/reload-failed"
export FAIL_CADDY_RELOAD_ONCE RELOAD_COUNT_FILE
activate_caddy_site final "$caddyfile"
[[ "$caddy_tls_mode" == http-only ]] || fail 'a Caddy 443 bind failure did not select HTTP-only mode'
[[ "$https_reason" == 'Caddy could not bind TCP port 443 because it is held by nipovpn (PID 301).' ]] \
    || fail 'a Caddy 443 bind failure did not retain its cause'
assert_not_contains "$caddyfile" 'redir https://'
unset FAIL_CADDY_RELOAD_ONCE RELOAD_COUNT_FILE HTTPS_CONFLICTS

caddy_tls_mode=direct
https_reason=
FAIL_CADDY_RELOAD_ONCE=yes
RELOAD_COUNT_FILE="$TEMP_DIR/caddy/unrelated-reload-failed"
export FAIL_CADDY_RELOAD_ONCE RELOAD_COUNT_FILE
if (HTTPS_CONFLICTS=; activate_caddy_site final "$caddyfile") >/dev/null 2>&1; then
    fail 'a Caddy activation failure without a 443 conflict was accepted'
fi
unset FAIL_CADDY_RELOAD_ONCE RELOAD_COUNT_FILE

# COMPOSE_FILE in the install directory's .env makes every installer Compose
# call use the operator's override files (e.g. host networking) without -f.
# shellcheck source=/dev/null
source <(sed -n '/^compose_file_is_configured() {/,/^wait_for_updated_service() {/p' "$INSTALLER" | sed '$d' \
    | awk '/^compose_file_is_configured\(\) \{/ { copying=1 } copying { print } copying && /^\)$/ { exit }')
INSTALL_DIR="$TEMP_DIR/install"
mkdir -p "$INSTALL_DIR"
cat > "$TEMP_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
printf '%s\n' "$*" > "$DOCKER_ARGS_FILE"
DOCKER
chmod +x "$TEMP_DIR/bin/docker"
export DOCKER_ARGS_FILE="$TEMP_DIR/docker-args"
container_engine=docker
: > "$INSTALL_DIR/.env"
PATH="$TEMP_DIR/bin:$PATH" compose up -d
assert_contains "$DOCKER_ARGS_FILE" "compose -f $INSTALL_DIR/docker-compose.yml up -d"
printf 'COMPOSE_FILE=\n' > "$INSTALL_DIR/.env"
PATH="$TEMP_DIR/bin:$PATH" compose up -d
assert_contains "$DOCKER_ARGS_FILE" "compose -f $INSTALL_DIR/docker-compose.yml up -d"
printf 'HTTP_PUBLISH_PORT=1111\nCOMPOSE_FILE=docker-compose.yml:deploy/compose.host-network.yml\n' > "$INSTALL_DIR/.env"
PATH="$TEMP_DIR/bin:$PATH" compose up -d --build
assert_not_contains "$DOCKER_ARGS_FILE" ' -f '
assert_contains "$DOCKER_ARGS_FILE" 'compose up -d --build'
grep -Fq 'HTTP_ADDR##*:' "$INSTALLER" \
    || fail 'the readiness check must use the port the app listens on, not a fixed 8080'

# The installer chooses host networking by itself only where it is safe, and
# records it as COMPOSE_FILE so later runs keep it.
# shellcheck source=/dev/null
source <(sed -n '/^read_env_value() {/,/^set_admin_password() {/p' "$INSTALLER" | sed '$d')
log() { :; }
for supported in 2.24.0 v2.24.5 2.39.1 5.0.2 v3.0.0; do
    compose_version_supports_reset "$supported" || fail "Compose $supported should support the override file"
done
for unsupported in 2.23.3 v2.9.0 1.29.2 '' unknown; do
    if compose_version_supports_reset "$unsupported"; then
        fail "Compose '$unsupported' must not be treated as supporting the override file"
    fi
done
ENV_FILE="$INSTALL_DIR/.env"
mkdir -p "$INSTALL_DIR/deploy"
: > "$INSTALL_DIR/deploy/compose.host-network.yml"
cat > "$TEMP_DIR/bin/ip" <<'IP'
#!/usr/bin/env bash
printf '2: eth0    inet 203.0.113.7/24 brd 203.0.113.255 scope global eth0\n'
printf '3: docker0    inet 172.17.0.1/16 scope global docker0\n'
IP
cat > "$TEMP_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
if [[ "$*" == "compose version --short" ]]; then printf '%s\n' "${FAKE_COMPOSE_VERSION:-2.39.1}"; fi
DOCKER
chmod +x "$TEMP_DIR/bin/ip" "$TEMP_DIR/bin/docker"
host_network_choice() {
    # $1: .env contents, $2: container engine, $3: Compose version
    printf '%b' "$1" > "$ENV_FILE"
    container_engine=$2
    PATH="$TEMP_DIR/bin:$PATH" FAKE_COMPOSE_VERSION=$3 enable_host_network_if_supported
    read_env_value COMPOSE_FILE
}
[[ "$(host_network_choice 'ICE_PUBLIC_IP=203.0.113.7\n' docker 2.39.1)" == docker-compose.yml:deploy/compose.host-network.yml ]] \
    || fail 'a Docker host that owns its public IPv4 should get host networking'
[[ -z "$(host_network_choice 'ICE_PUBLIC_IP=198.51.100.9\n' docker 2.39.1)" ]] \
    || fail 'a host behind NAT (public IPv4 not on an interface) must keep the bridge network'
[[ -z "$(host_network_choice 'ICE_PUBLIC_IP=203.0.113.7\n' docker 2.20.0)" ]] \
    || fail 'an old Docker Compose must keep the bridge network'
[[ -z "$(host_network_choice 'ICE_PUBLIC_IP=203.0.113.7\n' podman 2.39.1)" ]] \
    || fail 'Podman installs must keep their network setup'
[[ "$(host_network_choice 'ICE_PUBLIC_IP=203.0.113.7\nCOMPOSE_FILE=docker-compose.yml\n' docker 2.39.1)" == docker-compose.yml ]] \
    || fail "an operator's COMPOSE_FILE must never be overridden"
[[ -z "$(host_network_choice 'ICE_PUBLIC_IP=\n' docker 2.39.1)" ]] \
    || fail 'without a public IPv4 the bridge network stays'
grep -Fq 'max-port=49999' "$INSTALLER" && grep -Fq 'ufw allow 49152:49999/udp' "$INSTALLER" \
    || fail 'the coturn relay range and its firewall rule must match'

# coturn's CPU limit: .env starts as a copy of .env.example, whose shipped
# value must count as unset, while an operator's own value is kept.
turn_cpus_after() {
    printf '%b' "$1" > "$ENV_FILE"
    raise_turn_cpu_limit
    read_env_value TURN_CPUS
}
shipped_turn_cpus=$(sed -n 's/^TURN_CPUS=//p' .env.example)
[[ "$shipped_turn_cpus" == 0.20 ]] \
    || fail "the installer treats TURN_CPUS=0.20 as the shipped default, but .env.example ships '$shipped_turn_cpus'"
[[ "$(turn_cpus_after 'TURN_CPUS=0.20\n')" == 0.50 ]] || fail 'the shipped coturn CPU limit must be raised'
[[ "$(turn_cpus_after 'TURN_CPUS=\n')" == 0.50 ]] || fail 'an empty coturn CPU limit must be set'
[[ "$(turn_cpus_after 'OTHER=1\n')" == 0.50 ]] || fail 'a missing coturn CPU limit must be set'
[[ "$(turn_cpus_after 'TURN_CPUS=1.0\n')" == 1.0 ]] || fail "an operator's coturn CPU limit must be kept"
[[ "$(turn_cpus_after 'TURN_CPUS=0.10\n')" == 0.10 ]] || fail "an operator's lower coturn CPU limit must be kept"

# coturn may relay only to the SFU on this host.
mkdir -p "$INSTALL_DIR/deploy/coturn"
coturn_config="$INSTALL_DIR/deploy/coturn/turnserver.conf"
write_coturn_config 0123abcd meet.example.com 203.0.113.7 203.0.113.7
for expected in 'static-auth-secret=0123abcd' 'realm=meet.example.com' 'no-multicast-peers' 'no-tcp-relay' \
    'denied-peer-ip=0.0.0.0-255.255.255.255' 'denied-peer-ip=::-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff' \
    'allowed-peer-ip=203.0.113.7' 'min-port=49152'; do
    assert_contains "$coturn_config" "$expected"
done
assert_not_contains "$coturn_config" 'external-ip='
[[ "$(grep -c '^allowed-peer-ip=' "$coturn_config")" == 1 ]] \
    || fail 'a directly addressed host allows exactly one relay peer'
write_coturn_config 0123abcd meet.example.com 203.0.113.7 10.0.0.5
assert_contains "$coturn_config" 'allowed-peer-ip=203.0.113.7'
assert_contains "$coturn_config" 'allowed-peer-ip=10.0.0.5'
assert_contains "$coturn_config" 'external-ip=203.0.113.7/10.0.0.5'
write_coturn_config 0123abcd meet.example.com 203.0.113.7 ''
assert_not_contains "$coturn_config" 'external-ip='

# coturn runs as nobody and needs its own readable certificate copy, on a
# fresh install, on an update of an older install, and after every renewal.
# The patterns are literal installer source text.
# shellcheck disable=SC2016
{
    grep -Fq 'set_env TURN_CERT_DIR "$TURN_CERT_DIR"' "$INSTALLER" \
        || fail 'coturn must mount its own certificate directory'
    if grep -Fq 'set_env TURN_CERT_DIR "$CERT_DIR"' "$INSTALLER"; then
        fail "coturn must not mount the proxy's root-owned certificate directory"
    fi
    grep -Fq 'install_turn_certs "/etc/letsencrypt/live/$domain"' "$INSTALLER" \
        || fail 'a fresh install must give coturn a readable certificate copy'
    grep -Fq 'install_turn_certs "$CERT_DIR"' "$INSTALLER" \
        || fail 'an update must migrate an older install to the coturn certificate copy'
    grep -Fq 'install -o 65534 -g 65533 -m 0400 "$RENEWED_LINEAGE/privkey.pem" /etc/slowmeet/turn-certs/privkey.pem' "$INSTALLER" \
        || fail 'the renewal hook must refresh the coturn certificate copy'
}

# A renewal must not drop relayed calls: coturn reloads its certificate on
# SIGUSR2, and the hook restarts it only when the signal cannot be delivered.
# The generated hook must also be valid shell.
CERT_HOOK="$TEMP_DIR/cert-hook"
write_cert_hook
bash -n "$CERT_HOOK" || fail 'the generated renewal hook is not valid shell'
assert_contains "$CERT_HOOK" 'docker compose -f docker-compose.yml --profile turn kill -s SIGUSR2 coturn'
assert_contains "$CERT_HOOK" '|| docker compose -f docker-compose.yml --profile turn restart coturn'
assert_contains "$CERT_HOOK" 'podman-compose -f podman-compose.yml --profile turn kill -s SIGUSR2 coturn'
assert_contains "$CERT_HOOK" '|| podman-compose -f podman-compose.yml --profile turn restart coturn'
[[ "$(grep -c 'restart coturn' "$CERT_HOOK")" == 2 ]] \
    || fail 'coturn may only be restarted as the fallback of a failed reload signal'
[[ -x "$CERT_HOOK" ]] || fail 'the renewal hook must be executable'
# An update refreshes an existing hook whether or not TURN certificates move.
update_path=$(sed -n '/Updating the existing SlowMeet checkout/,/write_podman_service/p' "$INSTALLER")
# shellcheck disable=SC2016
if ! grep -Fq 'if [[ -f "$CERT_HOOK" ]]; then' <<<"$update_path" || ! grep -Fq 'write_cert_hook' <<<"$update_path"; then
    fail 'an update must refresh an existing renewal hook'
fi

printf 'Installer configuration checks passed.\n'
