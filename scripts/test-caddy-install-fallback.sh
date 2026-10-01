#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALLER=deploy/install.sh
TEST_DIR=$(mktemp -d)
trap 'rm -rf "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/apt-get" <<'APT'
#!/usr/bin/env bash
[[ "$1" == update ]] || exit 90
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
chmod +x "$TEST_DIR/bin/apt-get"
export PATH="$TEST_DIR/bin:$PATH"

source <(sed -n '/^apt_failure_is_caddy_only() {/,/^read_env_value() {/p' "$INSTALLER" | sed '$d')
source <(sed -n '/^read_install_state() {/,/^apt_failure_is_caddy_only() {/p' "$INSTALLER" | sed '$d')

fail() {
    printf 'Caddy fallback test failed: %s\n' "$*" >&2
    exit 1
}

log() { :; }
write_install_state() { :; }

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
