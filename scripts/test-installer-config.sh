#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALLER=deploy/install.sh
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

printf 'Installer configuration checks passed.\n'
