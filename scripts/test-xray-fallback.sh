#!/usr/bin/env bash
set -Eeuo pipefail

readonly ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
readonly INSTALLER="$ROOT_DIR/deploy/install.sh"
readonly TEST_DIR=$(mktemp -d)
trap 'rm -rf -- "$TEST_DIR"' EXIT

mkdir -p "$TEST_DIR/bin"
cat > "$TEST_DIR/bin/xray" <<'XRAY'
#!/usr/bin/env bash
[[ "${XRAY_TEST_FAIL:-no}" != yes ]]
XRAY
cat > "$TEST_DIR/bin/systemctl" <<'SYSTEMCTL'
#!/usr/bin/env bash
if [[ "$*" == 'restart xray.service' ]]; then
    count=0
    [[ -f "$XRAY_RESTART_COUNT" ]] && count=$(<"$XRAY_RESTART_COUNT")
    ((count += 1))
    printf '%s\n' "$count" > "$XRAY_RESTART_COUNT"
    [[ ",${XRAY_RESTART_FAIL_ON:-}," != *",$count,"* ]]
    exit
fi
exit 0
SYSTEMCTL
chmod +x "$TEST_DIR/bin/xray" "$TEST_DIR/bin/systemctl"
export PATH="$TEST_DIR/bin:$PATH"
XRAY_RESTART_COUNT="$TEST_DIR/restart-count"
export XRAY_RESTART_COUNT

# shellcheck disable=SC1090
source <(sed -n '/^validate_xray_fallback_config() {/,/^xray_config_path() {/p' "$INSTALLER" | sed '$d')

fail() {
    printf 'Xray fallback test failed: %s\n' "$*" >&2
    exit 1
}

write_install_state() { :; }

config="$TEST_DIR/config.json"
cat > "$config" <<'JSON'
{
  "inbounds": [{
    "port": 443,
    "protocol": "vless",
    "settings": {
      "clients": [{"id": "fixture-client-id"}],
      "fallbacks": [{"dest": 8443}]
    },
    "streamSettings": {
      "network": "tcp",
      "security": "tls",
      "tlsSettings": {"alpn": ["h2"]}
    }
  }]
}
JSON
chmod 0600 "$config"

apply_xray_fallback_to_config "$config" meet.example.com 9080
jq -e '
  .inbounds[0].settings.clients[0].id == "fixture-client-id" and
  .inbounds[0].settings.fallbacks == [
    {"dest":8443}, {"name":"meet.example.com","dest":9080}
  ] and
  .inbounds[0].streamSettings.tlsSettings.alpn == ["h2","http/1.1"]
' "$config" >/dev/null || fail 'VLESS fallback did not preserve existing config and add the website route'
[[ $(stat -c '%a' "$config") == 600 ]] || fail 'Xray config file permissions changed'
[[ $(<"$XRAY_RESTART_COUNT") == 1 ]] || fail 'Xray was not restarted after adding its fallback'

apply_xray_fallback_to_config "$config" meet.example.com 9080
[[ $(jq '[.inbounds[0].settings.fallbacks[] | select(.name == "meet.example.com")] | length' "$config") == 1 ]] \
    || fail 'Repeated configuration added a duplicate website fallback'
[[ $(<"$XRAY_RESTART_COUNT") == 1 ]] || fail 'An unchanged Xray configuration triggered an unnecessary restart'

remove_xray_fallback_from_config "$config" meet.example.com 9080 yes yes
jq -e '
  .inbounds[0].settings.fallbacks == [{"dest":8443}] and
  .inbounds[0].streamSettings.tlsSettings.alpn == ["h2"]
' "$config" >/dev/null || fail 'Uninstall cleanup did not remove only installer-managed Xray settings'
[[ $(<"$XRAY_RESTART_COUNT") == 2 ]] || fail 'Removing the managed Xray fallback did not restart Xray'

unsupported="$TEST_DIR/reality.json"
cat > "$unsupported" <<'JSON'
{"inbounds":[{"port":443,"protocol":"vless","settings":{},"streamSettings":{"network":"tcp","security":"reality"}}]}
JSON
cp "$unsupported" "$TEST_DIR/reality.before"
if (apply_xray_fallback_to_config "$unsupported" meet.example.com 9080) >/dev/null 2>&1; then
    fail 'REALITY inbound was accepted for a TLS fallback'
fi
cmp -s "$unsupported" "$TEST_DIR/reality.before" || fail 'Unsupported inbound config was modified'

rollback="$TEST_DIR/rollback.json"
cat > "$rollback" <<'JSON'
{"inbounds":[{"port":443,"protocol":"trojan","settings":{},"streamSettings":{"network":"tcp","security":"tls","tlsSettings":{"alpn":["http/1.1"]}}}]}
JSON
cp "$rollback" "$TEST_DIR/rollback.before"
XRAY_RESTART_FAIL_ON=3
export XRAY_RESTART_FAIL_ON
if apply_xray_fallback_to_config "$rollback" meet.example.com 9080 >/dev/null 2>&1; then
    fail 'Failed Xray restart unexpectedly installed the fallback'
fi
unset XRAY_RESTART_FAIL_ON
cmp -s "$rollback" "$TEST_DIR/rollback.before" || fail 'Failed Xray restart did not restore the original config'
[[ $(<"$XRAY_RESTART_COUNT") == 4 ]] || fail 'Xray rollback did not recover the service'
[[ "$https_reason" == 'Xray rejected the fallback restart; the original configuration was restored and Xray restarted.' ]] \
    || fail 'A safely rolled back Xray restart failure did not provide an HTTPS warning reason'

XRAY_RESTART_FAIL_ON=5,6
export XRAY_RESTART_FAIL_ON
if (apply_xray_fallback_to_config "$rollback" meet.example.com 9080 >/dev/null 2>&1); then
    fail 'Xray fallback continued after its recovery restart failed'
fi
unset XRAY_RESTART_FAIL_ON
cmp -s "$rollback" "$TEST_DIR/rollback.before" || fail 'Unsafe Xray rollback changed the original config'

printf 'Xray fallback checks passed.\n'
