#!/usr/bin/env bash
# Extracted installer functions consume and assign these fixture globals.
# ShellCheck cannot follow the dynamically extracted source below.
# shellcheck disable=SC1090,SC2034,SC2154
set -Eeuo pipefail

readonly INSTALLER=deploy/install.sh
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/apt-get" <<'APT'
#!/usr/bin/env bash
printf 'apt-get %s\n' "$*" >> "$COMMAND_TRACE"
[[ "$1" == update ]] || [[ "$1" == install ]] || exit 90
if [[ "$1" == install ]]; then
    exit 0
fi
count=0
[[ ! -f "$APT_CALL_COUNT" ]] || count=$(<"$APT_CALL_COUNT")
((count += 1))
printf '%s\n' "$count" > "$APT_CALL_COUNT"
case "$APT_SCENARIO:$count" in
    caddy-only:1)
        printf '%s\n' \
            'Err:1 https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version InRelease' \
            'E: Failed to fetch https://dl.cloudsmith.io/public/caddy/stable/ubuntu/InRelease  Could not connect' \
            'E: Some index files failed to download. They have been ignored, or old ones used instead.'
        exit 100
        ;;
    unrelated:1)
        printf '%s\n' 'Err:1 https://archive.ubuntu.com/ubuntu noble InRelease' \
            'E: Failed to fetch https://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Could not connect'
        exit 100
        ;;
    signature:1)
        printf '%s\n' 'Err:1 https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version InRelease' \
            'W: GPG error: https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version InRelease: The following signatures could not be verified: BADSIG'
        exit 100
        ;;
esac
APT
cat > "$TEST_DIR/bin/ss" <<'SS'
#!/usr/bin/env bash
case "$SS_SCENARIO" in
    empty) ;;
    caddy) printf '%s\n' 'LISTEN 0 1024 *:443 *:* users:(("caddy",pid=334366,fd=3))' ;;
    xray) printf '%s\n' 'LISTEN 0 128 *:443 *:* users:(("xray",pid=912,fd=4))' ;;
    nginx) printf '%s\n' 'LISTEN 0 128 *:443 *:* users:(("nginx",pid=811,fd=4),("nginx",pid=812,fd=4))' ;;
    shared) printf '%s\n' 'LISTEN 0 128 *:443 *:* users:(("caddy",pid=334366,fd=3),("xray",pid=912,fd=4))' ;;
    unknown) printf '%s\n' 'LISTEN 0 128 *:443 *:*' ;;
    *) exit 91 ;;
esac
SS
cat > "$TEST_DIR/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
if [[ "$*" == 'show -p MainPID --value caddy' ]]; then
    printf '%s\n' "$CADDY_MAIN_PID"
elif [[ "$*" == 'show -p MainPID --value nginx' ]]; then
    printf '%s\n' "$NGINX_MAIN_PID"
fi
SYSTEMCTL
cat > "$TEST_DIR/bin/install" <<'INSTALL'
#!/usr/bin/env bash
printf 'install %s\n' "$*" >> "$COMMAND_TRACE"
INSTALL
cat > "$TEST_DIR/bin/curl" <<'CURL'
#!/usr/bin/env bash
if [[ " $* " == *' -o '* ]]; then
    destination=${*: -1}
    printf 'curl source %s\n' "$destination" >> "$COMMAND_TRACE"
    printf '%s\n' 'deb https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version main' > "$destination"
else
    printf 'curl key\n' >> "$COMMAND_TRACE"
    printf '%s\n' 'test signing key'
fi
CURL
cat > "$TEST_DIR/bin/gpg" <<'GPG'
#!/usr/bin/env bash
printf 'gpg %s\n' "$*" >> "$COMMAND_TRACE"
cat >/dev/null
GPG
cat > "$TEST_DIR/bin/chmod" <<'CHMOD'
#!/usr/bin/env bash
printf 'chmod %s\n' "$*" >> "$COMMAND_TRACE"
CHMOD
chmod +x "$TEST_DIR/bin/apt-get"
chmod +x "$TEST_DIR/bin/ss" "$TEST_DIR/bin/systemctl"
chmod +x "$TEST_DIR/bin/install" "$TEST_DIR/bin/curl" "$TEST_DIR/bin/gpg" "$TEST_DIR/bin/chmod"
export PATH="$TEST_DIR/bin:$PATH"

source <(sed -n '/^apt_failure_is_caddy_only() {/,/^read_env_value() {/p' "$INSTALLER" | sed '$d')
source <(sed -n '/^read_install_state() {/,/^apt_failure_is_caddy_only() {/p' "$INSTALLER" | sed '$d')
source <(sed -n '/^caddy_https_port_conflicts() {/,/^detect_proxy_mode() {/p' "$INSTALLER" | sed '$d')
source <(sed -n '/^prepare_install_apt_sources() {/,/^ipv6_stack_available() {/p' "$INSTALLER" | sed '$d')

fail() {
    printf 'Caddy fallback test failed: %s\n' "$*" >&2
    exit 1
}

assert_before() {
    local earlier=$1 later=$2 earlier_line later_line
    earlier_line=$(awk -v event="$earlier" '$0 == event {print NR; exit}' "$COMMAND_TRACE")
    later_line=$(awk -v event="$later" '$0 == event {print NR; exit}' "$COMMAND_TRACE")
    [[ -n "$earlier_line" && -n "$later_line" && "$earlier_line" -lt "$later_line" ]] \
        || fail "Expected '$earlier' before '$later'; trace: $(<"$COMMAND_TRACE")"
}

log() { :; }
write_install_state() { :; }
detect_caddy_tls_mode() { printf '%s\n' 'tls-preflight' >> "$COMMAND_TRACE"; }

COMMAND_TRACE="$TEST_DIR/command-trace"
APT_CALL_COUNT="$TEST_DIR/preflight-apt-calls"
APT_SCENARIO=normal
export COMMAND_TRACE APT_CALL_COUNT APT_SCENARIO
CADDY_APT_SOURCE_FILE="$TEST_DIR/preflight-caddy.list"
ID=ubuntu
VERSION_CODENAME=noble
container_engine=podman
proxy_mode=caddy
caddy_install_method=apt

https_required=yes
: > "$COMMAND_TRACE"
prepare_install_apt_sources
assert_before 'apt-get install -y ca-certificates curl git gnupg iproute2 jq openssl ufw certbot' 'tls-preflight'
assert_before 'tls-preflight' "install -m 0755 -d /usr/share/keyrings"
[[ -f "$CADDY_APT_SOURCE_FILE" ]] || fail 'HTTPS preflight did not continue to create the Caddy APT source'

https_required=no
COMMAND_TRACE="$TEST_DIR/command-trace-http-only"
export COMMAND_TRACE
CADDY_APT_SOURCE_FILE="$TEST_DIR/http-only-caddy.list"
: > "$COMMAND_TRACE"
prepare_install_apt_sources
[[ "$caddy_tls_mode" == http-only ]] || fail 'Disabling HTTPS did not select HTTP-only mode'
[[ "$https_reason" == 'HTTPS and TCP port 443 were disabled by user choice.' ]] || fail 'Disabling HTTPS did not retain its reason'
if awk '$0 == "tls-preflight" { found=1 } END { exit !found }' "$COMMAND_TRACE"; then
    fail 'HTTP-only preparation ran the HTTPS port preflight'
fi
if awk '$0 ~ /^apt-get install / && $0 ~ / certbot([[:space:]]|$)/ { found=1 } END { exit !found }' "$COMMAND_TRACE"; then
    fail 'HTTP-only preparation installed certbot'
fi
[[ -f "$CADDY_APT_SOURCE_FILE" ]] || fail 'HTTP-only preparation did not create the Caddy APT source'

SS_SCENARIO=empty
CADDY_MAIN_PID=0
export SS_SCENARIO CADDY_MAIN_PID
NGINX_MAIN_PID=811
export NGINX_MAIN_PID
[[ -z "$(caddy_https_port_conflicts)" ]] || fail 'An unused HTTPS port was reported as occupied'
if xray_https_port_443_is_active; then
    fail 'An unused HTTPS port was identified as an Xray listener'
fi

SS_SCENARIO=caddy
CADDY_MAIN_PID=334366
[[ -z "$(caddy_https_port_conflicts)" ]] || fail 'The active Caddy service listener was not allowed'

SS_SCENARIO=shared
conflicts=$(caddy_https_port_conflicts)
[[ "$conflicts" == 'xray (PID 912)' ]] || fail "Expected the non-Caddy owner, got: $conflicts"
xray_https_port_443_is_active || fail 'The shared Caddy/Xray listener was not recognized as Xray-owned'
if (check_caddy_https_port_available; : > "$TEST_DIR/after-preflight") 2>/dev/null; then
    fail 'The Caddy preflight continued while Xray owned port 443'
fi
[[ ! -e "$TEST_DIR/after-preflight" ]] || fail 'The Caddy preflight ran later setup after detecting Xray'

SS_SCENARIO=unknown
CADDY_MAIN_PID=0
conflicts=$(caddy_https_port_conflicts)
[[ "$conflicts" == 'unknown process (PID unavailable)' ]] || fail "Expected an unidentified listener to block setup, got: $conflicts"
if xray_https_port_443_is_active; then
    fail 'An unidentified listener was accepted as an Xray listener'
fi

SS_SCENARIO=xray
xray_https_port_443_is_active || fail 'The active Xray listener was not detected'

SS_SCENARIO=nginx
[[ -z "$(caddy_https_port_conflicts nginx)" ]] || fail 'The active Nginx HTTPS listener was reported as a conflict'

STATE_FILE="$TEST_DIR/state"
cat > "$STATE_FILE" <<'STATE'
version=5
status=incomplete
operation=install
domain=meet.example.com
enable_turn=no
enable_meeting_password=no
proxy_mode=caddy
app_port=8080
container_engine=docker
caddy_install_method=binary
STATE
read_install_state
[[ "$caddy_install_method" == binary ]] || fail 'A resumed install did not retain the binary Caddy method'

cat > "$STATE_FILE" <<'STATE'
version=6
status=incomplete
operation=install
domain=meet.example.com
enable_turn=no
enable_meeting_password=no
proxy_mode=caddy
caddy_tls_mode=xray
xray_fallback_managed=yes
xray_alpn_added=yes
app_port=8080
container_engine=docker
caddy_install_method=binary
STATE
read_install_state
[[ "$caddy_tls_mode" == xray && "$xray_fallback_managed" == yes && "$xray_alpn_added" == yes ]] \
    || fail 'An interrupted Xray-mode install did not retain its fallback settings'

cat > "$STATE_FILE" <<'STATE'
version=7
status=complete
operation=install
domain=meet.example.com
enable_turn=no
enable_meeting_password=no
proxy_mode=caddy
caddy_tls_mode=http-only
xray_fallback_managed=no
xray_alpn_added=no
https_reason=TCP port 443 is held by nipovpn (PID 301).
app_port=8080
container_engine=docker
caddy_install_method=apt
STATE
read_install_state
[[ "$caddy_tls_mode" == http-only && "$https_reason" == 'TCP port 443 is held by nipovpn (PID 301).' ]] \
    || fail 'A completed HTTP-only install did not retain its HTTPS warning reason'

cat > "$STATE_FILE" <<'STATE'
version=4
status=complete
operation=install
domain=meet.example.com
enable_turn=no
enable_meeting_password=no
proxy_mode=caddy
app_port=8080
container_engine=docker
STATE
read_install_state
[[ "$caddy_install_method" == apt ]] || fail 'Legacy installer state did not default to the APT Caddy method'
cat > "$TEST_DIR/caddy-only.log" <<'APTLOG'
Err:1 https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version InRelease
E: Failed to fetch https://dl.cloudsmith.io/public/caddy/stable/ubuntu/InRelease  Could not connect
E: Some index files failed to download. They have been ignored, or old ones used instead.
APTLOG
apt_failure_is_caddy_only "$TEST_DIR/caddy-only.log" || fail 'Caddy-only repository failure was not recognized'

cat > "$TEST_DIR/unrelated.log" <<'APTLOG'
Err:1 https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version InRelease
Err:2 https://archive.ubuntu.com/ubuntu noble InRelease
E: Failed to fetch https://dl.cloudsmith.io/public/caddy/stable/ubuntu/InRelease  Could not connect
E: Failed to fetch https://archive.ubuntu.com/ubuntu/dists/noble/InRelease  Could not connect
APTLOG
if apt_failure_is_caddy_only "$TEST_DIR/unrelated.log"; then
    fail 'A mixed Caddy and Ubuntu repository failure was accepted as Caddy-only'
fi

cat > "$TEST_DIR/signature.log" <<'APTLOG'
Err:1 https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version InRelease
W: GPG error: https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version InRelease: The following signatures could not be verified: BADSIG
APTLOG
if apt_failure_is_caddy_only "$TEST_DIR/signature.log"; then
    fail 'A Caddy repository signature failure was accepted for fallback'
fi

CADDY_APT_SOURCE_FILE="$TEST_DIR/caddy-stable.list"
disabled_source="$CADDY_APT_SOURCE_FILE.disabled"
APT_CALL_COUNT="$TEST_DIR/apt-calls"
APT_SCENARIO=normal
export APT_CALL_COUNT APT_SCENARIO
proxy_mode=caddy
caddy_install_method=apt
printf '%s\n' 'deb https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version main' > "$CADDY_APT_SOURCE_FILE"
install_verified_caddy_binary() { caddy_install_method=binary; }
apt_update_with_caddy_fallback
[[ "$caddy_install_method" == apt ]] || fail 'Successful APT update changed the Caddy install method'
[[ -f "$CADDY_APT_SOURCE_FILE" && ! -e "$disabled_source" ]] || fail 'Successful APT update modified the Caddy source'
[[ $(<"$APT_CALL_COUNT") == 1 ]] || fail 'Successful APT update was retried'

APT_CALL_COUNT="$TEST_DIR/fallback-apt-calls"
APT_SCENARIO=caddy-only
export APT_CALL_COUNT APT_SCENARIO
apt_update_with_caddy_fallback
[[ "$caddy_install_method" == binary ]] || fail 'Caddy-only fallback did not select the binary method'
[[ -f "$disabled_source" && ! -e "$CADDY_APT_SOURCE_FILE" ]] || fail 'Caddy source was not left disabled after fallback'
[[ $(<"$APT_CALL_COUNT") == 2 ]] || fail 'APT was not retried exactly once after Caddy-only failure'

CADDY_APT_SOURCE_FILE="$TEST_DIR/unrelated-caddy.list"
APT_CALL_COUNT="$TEST_DIR/unrelated-apt-calls"
APT_SCENARIO=unrelated
caddy_install_method=apt
printf '%s\n' 'deb https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version main' > "$CADDY_APT_SOURCE_FILE"
if (apt_update_with_caddy_fallback) >/dev/null 2>&1; then
    fail 'An unrelated repository failure did not abort the APT update'
fi
[[ -f "$CADDY_APT_SOURCE_FILE" && ! -e "$CADDY_APT_SOURCE_FILE.disabled" ]] || fail 'Unrelated failure modified the Caddy source'
[[ $(<"$APT_CALL_COUNT") == 1 ]] || fail 'Unrelated failure triggered an APT retry'

CADDY_APT_SOURCE_FILE="$TEST_DIR/signature-caddy.list"
APT_CALL_COUNT="$TEST_DIR/signature-apt-calls"
APT_SCENARIO=signature
caddy_install_method=apt
printf '%s\n' 'deb https://dl.cloudsmith.io/public/caddy/stable/ubuntu any-version main' > "$CADDY_APT_SOURCE_FILE"
if (apt_update_with_caddy_fallback) >/dev/null 2>&1; then
    fail 'A Caddy repository signature failure did not abort'
fi
[[ -f "$CADDY_APT_SOURCE_FILE" && ! -e "$CADDY_APT_SOURCE_FILE.disabled" ]] || fail 'Signature failure modified the Caddy source'
[[ $(<"$APT_CALL_COUNT") == 1 ]] || fail 'Signature failure triggered an APT retry'

printf 'Caddy APT fallback checks passed.\n'
