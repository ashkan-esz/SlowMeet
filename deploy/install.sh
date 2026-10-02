#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALL_DIR=/opt/slowmeet
readonly ENV_FILE="$INSTALL_DIR/.env"
readonly STATE_DIR=/var/lib/slowmeet-installer
readonly STATE_FILE="$STATE_DIR/state"
readonly CERT_DIR=/etc/slowmeet/certs
readonly CERT_HOOK=/etc/letsencrypt/renewal-hooks/deploy/slowmeet
readonly REPOSITORY=https://github.com/ashkan-esz/SlowMeet.git
readonly NGINX_SITE=/etc/nginx/conf.d/slowmeet-installer.conf
readonly PROXY_MODE_FILE=/etc/slowmeet/proxy-mode
readonly CONTAINER_ENGINE_FILE=/etc/slowmeet/container-engine
readonly CADDY_APT_SOURCE_FILE=/etc/apt/sources.list.d/caddy-stable.list
readonly PODMAN_SERVICE_FILE=/etc/systemd/system/slowmeet-podman.service
readonly CADDY_BEGIN_MARKER='# BEGIN SlowMeet installer managed site'
readonly CADDY_END_MARKER='# END SlowMeet installer managed site'
readonly CADDY_XRAY_BACKEND_PORT=9080
readonly COSIGN_VERSION=v3.0.2
readonly CADDY_BINARY_DIR=/usr/bin
readonly CADDY_UNIT_FILE=/etc/systemd/system/caddy.service

log() { printf '[slowmeet] %s\n' "$*"; }
fail() { printf '[slowmeet] ERROR: %s\n' "$*" >&2; exit 1; }

mark_https_unavailable() {
    caddy_tls_mode=http-only
    https_reason=$1
    log "HTTPS is unavailable; continuing with the HTTP site: $https_reason"
}

print_https_warning() {
    [[ "${caddy_tls_mode:-direct}" == http-only ]] || return 0
    printf '\nWARNING: SlowMeet was installed and its local app health check passed, but public HTTPS is unavailable.\n' >&2
    printf 'Reason: %s\n' "$https_reason" >&2
    printf 'The site is available at http://%s/; browsers may restrict meeting media features without HTTPS.\n' "$domain" >&2
}

report_unexpected_error() {
    local status=$? line=${BASH_LINENO[0]:-unknown}
    printf '[slowmeet] ERROR: command failed near line %s (exit %s).\n' "$line" "$status" >&2
    exit "$status"
}

trap report_unexpected_error ERR

compose() (
    cd "$INSTALL_DIR"
    case "$container_engine" in
        docker) docker compose -f "$INSTALL_DIR/docker-compose.yml" "$@" ;;
        podman) podman-compose -f "$INSTALL_DIR/podman-compose.yml" "$@" ;;
        *) fail "Unsupported container engine: ${container_engine:-unset}." ;;
    esac
)

enable_container_engine() {
    case "$container_engine" in
        docker) systemctl enable --now docker ;;
        podman)
            command -v podman-compose >/dev/null || fail 'podman-compose is required for the selected Podman engine.'
            if [[ -f "$PODMAN_SERVICE_FILE" ]]; then
                systemctl daemon-reload
            fi
            ;;
        *) fail "Unsupported container engine: ${container_engine:-unset}." ;;
    esac
}

write_podman_service() {
    [[ "$container_engine" == podman ]] || return 0
    local compose_bin profile_args=
    compose_bin=$(command -v podman-compose) || fail 'podman-compose is required for the selected Podman engine.'
    if [[ "$enable_turn" == yes ]]; then
        profile_args='--profile turn'
    fi
    cat > "$PODMAN_SERVICE_FILE" <<EOF
[Unit]
Description=SlowMeet containers (Podman Compose)
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=$INSTALL_DIR
ExecStart=$compose_bin -f $INSTALL_DIR/podman-compose.yml $profile_args up -d
ExecStop=$compose_bin -f $INSTALL_DIR/podman-compose.yml $profile_args down
TimeoutStartSec=0
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF
    chmod 0644 "$PODMAN_SERVICE_FILE"
    systemctl daemon-reload
}

write_install_state() {
    local status=$1 temp
    install -d -o root -g root -m 0700 "$STATE_DIR"
    temp=$(mktemp "$STATE_DIR/.state.XXXXXX")
    {
        printf 'version=7\n'
        printf 'status=%s\n' "$status"
        printf 'operation=%s\n' "$install_operation"
        printf 'domain=%s\n' "$domain"
        printf 'enable_turn=%s\n' "$enable_turn"
        printf 'enable_meeting_password=%s\n' "$enable_meeting_password"
        printf 'proxy_mode=%s\n' "$proxy_mode"
        printf 'caddy_tls_mode=%s\n' "${caddy_tls_mode:-direct}"
        printf 'https_reason=%s\n' "${https_reason:-}"
        printf 'xray_fallback_managed=%s\n' "${xray_fallback_managed:-no}"
        printf 'xray_alpn_added=%s\n' "${xray_alpn_added:-no}"
        printf 'app_port=%s\n' "$app_port"
        printf 'container_engine=%s\n' "$container_engine"
        printf 'caddy_install_method=%s\n' "$caddy_install_method"
    } > "$temp"
    chmod 0600 "$temp"
    mv -f "$temp" "$STATE_FILE"
}

read_install_state() {
    local key value
    local seen_version= seen_status= seen_operation= seen_domain= seen_turn= seen_meeting_password= seen_proxy_mode= seen_caddy_tls_mode= seen_https_reason= seen_xray_fallback_managed= seen_xray_alpn_added= seen_app_port= seen_container_engine= seen_caddy_install_method=
    state_version=
    state_status=
    install_operation=
    domain=
    enable_turn=
    enable_meeting_password=
    proxy_mode=
    caddy_tls_mode=direct
    https_reason=
    xray_fallback_managed=no
    xray_alpn_added=no
    app_port=
    container_engine=
    caddy_install_method=apt
    [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || fail "Installer state at $STATE_FILE is not a regular file."
    while IFS='=' read -r key value; do
        case "$key" in
            version) [[ -z "$seen_version" ]] || fail 'Installer state contains a duplicate version.'; seen_version=yes; state_version=$value ;;
            status) [[ -z "$seen_status" ]] || fail 'Installer state contains a duplicate status.'; seen_status=yes; state_status=$value ;;
            operation) [[ -z "$seen_operation" ]] || fail 'Installer state contains a duplicate operation.'; seen_operation=yes; install_operation=$value ;;
            domain) [[ -z "$seen_domain" ]] || fail 'Installer state contains a duplicate domain.'; seen_domain=yes; domain=$value ;;
            enable_turn) [[ -z "$seen_turn" ]] || fail 'Installer state contains a duplicate TURN setting.'; seen_turn=yes; enable_turn=$value ;;
            enable_meeting_password) [[ -z "$seen_meeting_password" ]] || fail 'Installer state contains a duplicate meeting-password setting.'; seen_meeting_password=yes; enable_meeting_password=$value ;;
            proxy_mode) [[ -z "$seen_proxy_mode" ]] || fail 'Installer state contains a duplicate proxy mode.'; seen_proxy_mode=yes; proxy_mode=$value ;;
            caddy_tls_mode) [[ -z "$seen_caddy_tls_mode" ]] || fail 'Installer state contains a duplicate Caddy TLS mode.'; seen_caddy_tls_mode=yes; caddy_tls_mode=$value ;;
            https_reason) [[ -z "$seen_https_reason" ]] || fail 'Installer state contains a duplicate HTTPS warning reason.'; seen_https_reason=yes; https_reason=$value ;;
            xray_fallback_managed) [[ -z "$seen_xray_fallback_managed" ]] || fail 'Installer state contains a duplicate Xray fallback setting.'; seen_xray_fallback_managed=yes; xray_fallback_managed=$value ;;
            xray_alpn_added) [[ -z "$seen_xray_alpn_added" ]] || fail 'Installer state contains a duplicate Xray ALPN setting.'; seen_xray_alpn_added=yes; xray_alpn_added=$value ;;
            app_port) [[ -z "$seen_app_port" ]] || fail 'Installer state contains a duplicate app port.'; seen_app_port=yes; app_port=$value ;;
            container_engine) [[ -z "$seen_container_engine" ]] || fail 'Installer state contains a duplicate container engine.'; seen_container_engine=yes; container_engine=$value ;;
            caddy_install_method) [[ -z "$seen_caddy_install_method" ]] || fail 'Installer state contains a duplicate Caddy install method.'; seen_caddy_install_method=yes; caddy_install_method=$value ;;
            *) fail "Installer state contains an unsupported field: $key" ;;
        esac
    done < "$STATE_FILE"
    [[ "$seen_version" == yes && ( "$state_version" == 1 || "$state_version" == 2 || "$state_version" == 3 || "$state_version" == 4 || "$state_version" == 5 || "$state_version" == 6 || "$state_version" == 7 ) ]] || fail 'Installer state has a missing or unsupported version.'
    [[ "$seen_status" == yes && ( "$state_status" == incomplete || "$state_status" == complete ) ]] || fail 'Installer state has a missing or invalid status.'
    if [[ "$state_version" == 1 ]]; then
        [[ -z "$seen_operation" ]] || fail 'Version 1 installer state cannot contain an operation.'
        install_operation=install
    else
        [[ "$seen_operation" == yes && ( "$install_operation" == install || "$install_operation" == update ) ]] \
            || fail 'Installer state has a missing or invalid operation.'
    fi
    if [[ "$state_version" == 3 || "$state_version" == 4 || "$state_version" == 5 || "$state_version" == 6 || "$state_version" == 7 ]]; then
        [[ "$seen_proxy_mode" == yes && ( "$proxy_mode" == caddy || "$proxy_mode" == nginx ) ]] \
            || fail 'Installer state has a missing or invalid proxy mode.'
        [[ "$seen_app_port" == yes && "$app_port" =~ ^[0-9]{1,5}$ ]] \
            && ((10#$app_port >= 1024 && 10#$app_port <= 65535)) \
            || fail 'Installer state has a missing or invalid app port.'
    else
        [[ -z "$seen_proxy_mode" && -z "$seen_app_port" ]] || fail 'Legacy installer state cannot contain proxy settings.'
        proxy_mode=caddy
        app_port=8080
    fi
    if [[ "$state_version" == 6 || "$state_version" == 7 ]]; then
        [[ "$seen_caddy_tls_mode" == yes && ( "$caddy_tls_mode" == direct || "$caddy_tls_mode" == xray || ( "$state_version" == 7 && "$caddy_tls_mode" == http-only ) ) ]] \
            || fail 'Installer state has a missing or invalid Caddy TLS mode.'
        [[ "$seen_xray_fallback_managed" == yes && ( "$xray_fallback_managed" == yes || "$xray_fallback_managed" == no ) ]] \
            || fail 'Installer state has a missing or invalid Xray fallback ownership flag.'
        [[ "$seen_xray_alpn_added" == yes && ( "$xray_alpn_added" == yes || "$xray_alpn_added" == no ) ]] \
            || fail 'Installer state has a missing or invalid Xray ALPN ownership flag.'
        [[ "$proxy_mode" == caddy || "$caddy_tls_mode" == direct || ( "$state_version" == 7 && "$caddy_tls_mode" == http-only ) ]] \
            || fail 'Installer state has an invalid Xray TLS mode for the selected proxy.'
        if [[ "$state_version" == 7 ]]; then
            [[ "$seen_https_reason" == yes ]] || fail 'Installer state has a missing HTTPS warning reason.'
            if [[ "$caddy_tls_mode" == http-only ]]; then
                [[ -n "$https_reason" ]] || fail 'HTTP-only installer state has no HTTPS warning reason.'
            else
                [[ -z "$https_reason" ]] || fail 'HTTPS warning reason is set while HTTPS is enabled.'
            fi
        fi
    else
        [[ -z "$seen_caddy_tls_mode" && -z "$seen_https_reason" && -z "$seen_xray_fallback_managed" && -z "$seen_xray_alpn_added" ]] \
            || fail 'Legacy installer state cannot contain Xray proxy settings.'
        caddy_tls_mode=direct
    fi
    if [[ "$state_version" == 4 || "$state_version" == 5 || "$state_version" == 6 || "$state_version" == 7 ]]; then
        [[ "$seen_container_engine" == yes && ( "$container_engine" == docker || "$container_engine" == podman ) ]] \
            || fail 'Installer state has a missing or invalid container engine.'
    else
        [[ -z "$seen_container_engine" ]] || fail 'Legacy installer state cannot contain a container engine.'
        container_engine=docker
    fi
    if [[ "$state_version" == 5 || "$state_version" == 6 || "$state_version" == 7 ]]; then
        [[ "$seen_caddy_install_method" == yes && ( "$caddy_install_method" == apt || "$caddy_install_method" == binary ) ]] \
            || fail 'Installer state has a missing or invalid Caddy install method.'
        [[ "$proxy_mode" == caddy || "$caddy_install_method" == apt ]] \
            || fail 'Installer state selects a Caddy binary while Caddy is not the selected proxy.'
    else
        [[ -z "$seen_caddy_install_method" ]] || fail 'Legacy installer state cannot contain a Caddy install method.'
        caddy_install_method=apt
    fi
    [[ "$seen_domain" == yes && "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail 'Installer state has a missing or invalid domain.'
    [[ "$seen_turn" == yes && ( "$enable_turn" == yes || "$enable_turn" == no ) ]] || fail 'Installer state has a missing or invalid TURN setting.'
    [[ "$seen_meeting_password" == yes && ( "$enable_meeting_password" == yes || "$enable_meeting_password" == no ) ]] || fail 'Installer state has a missing or invalid meeting-password setting.'
}

apt_failure_is_caddy_only() {
    local output_file=$1
    ! grep -Eiq 'NO_PUBKEY|BADSIG|EXPKEYSIG|The following signatures couldn.t be verified|repository is not signed|not signed by' "$output_file" \
        || return 1
    awk '
        /^(Err:|W: Failed to fetch|E: Failed to fetch|E: The repository)/ {
            if (index($0, "https://dl.cloudsmith.io/public/caddy/stable") > 0) {
                caddy_errors++
            } else {
                other_errors++
            }
        }
        END { exit !(caddy_errors > 0 && other_errors == 0) }
    ' "$output_file"
}

install_verified_caddy_binary() {
    local cosign_arch caddy_arch temp_dir release_tag archive checksums checksum_line checksum

    case "$(dpkg --print-architecture)" in
        amd64) cosign_arch=amd64; caddy_arch=amd64 ;;
        arm64) cosign_arch=arm64; caddy_arch=arm64 ;;
        *) fail "The verified Caddy fallback does not support architecture $(dpkg --print-architecture)." ;;
    esac

    temp_dir=$(mktemp -d)
    trap 'rm -rf -- "$temp_dir"' EXIT
    curl -fsSL "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-$cosign_arch" \
        -o "$temp_dir/cosign"
    curl -fsSL "https://github.com/sigstore/cosign/releases/download/$COSIGN_VERSION/cosign-linux-$cosign_arch-kms.sigstore.json" \
        -o "$temp_dir/cosign.sigstore.json"

    cat > "$temp_dir/cosign-artifact.pub" <<'KEY'
-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEhyQCx0E9wQWSFI9ULGwy3BuRklnt
IqozONbbdbqz11hlRJy9c7SG+hdcFl9jE9uE/dwtuwU2MqU9T/cN0YkWww==
-----END PUBLIC KEY-----
KEY
    jq -er '.messageSignature.signature' "$temp_dir/cosign.sigstore.json" \
        | base64 -d > "$temp_dir/cosign.sig"
    openssl dgst -sha256 -verify "$temp_dir/cosign-artifact.pub" \
        -signature "$temp_dir/cosign.sig" "$temp_dir/cosign" >/dev/null \
        || fail 'Sigstore artifact-key verification failed for the pinned Cosign binary.'
    chmod 0700 "$temp_dir/cosign"

    release_tag=$(curl -fsSL https://api.github.com/repos/caddyserver/caddy/releases/latest | jq -er '.tag_name')
    [[ "$release_tag" =~ ^v2\.[0-9]+\.[0-9]+$ ]] || fail 'The latest official Caddy release tag was not a stable v2 release.'
    release_tag=${release_tag#v}
    archive="caddy_${release_tag}_linux_${caddy_arch}.tar.gz"
    checksums="caddy_${release_tag}_checksums.txt"
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$release_tag/$checksums" \
        -o "$temp_dir/$checksums"
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$release_tag/$checksums.sig" \
        -o "$temp_dir/$checksums.sig.b64"
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$release_tag/$checksums.pem" \
        -o "$temp_dir/$checksums.pem.b64"
    base64 -d "$temp_dir/$checksums.sig.b64" > "$temp_dir/$checksums.sig"
    base64 -d "$temp_dir/$checksums.pem.b64" > "$temp_dir/$checksums.pem"
    "$temp_dir/cosign" verify-blob "$temp_dir/$checksums" \
        --signature "$temp_dir/$checksums.sig" \
        --certificate "$temp_dir/$checksums.pem" \
        --certificate-identity "https://github.com/caddyserver/caddy/.github/workflows/release.yml@refs/tags/v$release_tag" \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        || fail 'Cosign could not verify the Caddy release checksum signature and signer identity.'

    checksum_line=$(awk -v archive="$archive" '$2 == archive || $2 == "*" archive { print; count++ } END { if (count != 1) exit 1 }' "$temp_dir/$checksums") \
        || fail "The signed Caddy checksum file does not contain exactly one entry for $archive."
    checksum=${checksum_line%% *}
    [[ "$checksum" =~ ^[[:xdigit:]]{64}$ ]] || fail 'The signed Caddy checksum entry is malformed.'
    printf '%s  %s\n' "$checksum" "$archive" > "$temp_dir/archive.sha256"
    curl -fsSL "https://github.com/caddyserver/caddy/releases/download/v$release_tag/$archive" \
        -o "$temp_dir/$archive"
    (cd "$temp_dir" && sha256sum --check --status archive.sha256) \
        || fail 'The downloaded Caddy release archive does not match its signed checksum.'
    tar -xzf "$temp_dir/$archive" -C "$temp_dir" caddy
    [[ -x "$temp_dir/caddy" ]] || fail 'The verified Caddy archive did not contain its executable.'
    "$temp_dir/caddy" version | grep -Eq "^v${release_tag}([[:space:]]|$)" \
        || fail 'The Caddy executable version does not match the signed release tag.'

    if ! getent group caddy >/dev/null; then
        groupadd --system caddy
    fi
    if ! id -u caddy >/dev/null 2>&1; then
        useradd --system --gid caddy --create-home --home-dir /var/lib/caddy \
            --shell /usr/sbin/nologin --comment 'Caddy web server' caddy
    elif [[ "$(id -gn caddy)" != caddy ]]; then
        fail 'The existing caddy user does not use the caddy group.'
    fi

    [[ ! -L "$CADDY_UNIT_FILE" ]] || fail "Caddy service unit at $CADDY_UNIT_FILE is a symlink; refusing to replace it."
    install -d -o root -g caddy -m 0750 /etc/caddy
    install -d -o caddy -g caddy -m 0750 /var/lib/caddy /var/log/caddy
    install -m 0755 "$temp_dir/caddy" "$CADDY_BINARY_DIR/caddy"
    cat > "$temp_dir/caddy.service" <<'UNIT'
[Unit]
Description=Caddy
Documentation=https://caddyserver.com/docs/
After=network-online.target
Wants=network-online.target

[Service]
User=caddy
Group=caddy
ExecStart=/usr/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=/usr/bin/caddy reload --config /etc/caddy/Caddyfile --force
TimeoutStopSec=5s
LimitNOFILE=1048576
PrivateTmp=true
ProtectSystem=full
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
Restart=on-failure

[Install]
WantedBy=multi-user.target
UNIT
    install -m 0644 "$temp_dir/caddy.service" "$CADDY_UNIT_FILE"
    systemctl daemon-reload
    caddy_install_method=binary
    write_install_state incomplete
    log "Installed Caddy v$release_tag from the verified static release."
    rm -rf -- "$temp_dir"
    trap - EXIT
}

apt_update_with_caddy_fallback() {
    local output_file disabled_source
    output_file=$(mktemp)
    if apt-get update > "$output_file" 2>&1; then
        cat "$output_file"
        rm -f "$output_file"
        return 0
    fi

    cat "$output_file" >&2
    if [[ "$proxy_mode" != caddy || "$caddy_install_method" != apt ]] \
        || ! apt_failure_is_caddy_only "$output_file"; then
        rm -f "$output_file"
        fail 'APT update failed for a source other than the installer-managed Caddy repository; no binary fallback was attempted.'
    fi
    rm -f "$output_file"

    [[ -f "$CADDY_APT_SOURCE_FILE" && ! -L "$CADDY_APT_SOURCE_FILE" ]] \
        || fail "The failing Caddy APT source at $CADDY_APT_SOURCE_FILE is missing or not a regular file."
    disabled_source="$CADDY_APT_SOURCE_FILE.disabled"
    [[ ! -e "$disabled_source" && ! -L "$disabled_source" ]] \
        || fail "Cannot disable the failing Caddy APT source because $disabled_source already exists."
    mv -- "$CADDY_APT_SOURCE_FILE" "$disabled_source"
    log 'The installer-managed Caddy APT repository was the only failing APT source; disabled it and retrying APT update.'
    apt-get update || fail 'APT update still fails after disabling the Caddy repository.'
    install_verified_caddy_binary
}

read_env_value() {
    local key=$1 value decoded char next i
    [[ -f "$ENV_FILE" ]] || return 0
    value=$(awk -v key="$key" 'index($0, key "=") == 1 { value=substr($0, length(key) + 2); found=1 } END { if (found) print value }' "$ENV_FILE")
    if [[ "$key" == ADMIN_PASSWORD && "$value" == \'*\' ]]; then
        value=${value:1:${#value}-2}
        decoded=
        for ((i = 0; i < ${#value}; i++)); do
            char=${value:i:1}
            if [[ "$char" == "\\" && $((i + 1)) -lt ${#value} ]]; then
                next=${value:i+1:1}
                if [[ "$next" == "'" ]]; then
                    char=$next
                    ((i += 1))
                fi
            fi
            decoded+=$char
        done
        value=$decoded
    fi
    printf '%s' "$value"
}

set_env() {
    local key=$1 value=$2 temp
    temp=$(mktemp)
    SLOWMEET_ENV_VALUE="$value" awk -v key="$key" '
        BEGIN { found=0 }
        index($0, key "=") == 1 { print key "=" ENVIRON["SLOWMEET_ENV_VALUE"]; found=1; next }
        { print }
        END { if (!found) print key "=" ENVIRON["SLOWMEET_ENV_VALUE"] }
    ' "$ENV_FILE" > "$temp"
    install -m 0600 "$temp" "$ENV_FILE"
    rm -f "$temp"
}

set_env_if_empty() {
    local key=$1 value=$2
    [[ -n "$(read_env_value "$key")" ]] || set_env "$key" "$value"
}

set_admin_password() {
    local value=$1 encoded= char i
    for ((i = 0; i < ${#value}; i++)); do
        char=${value:i:1}
        if [[ "$char" == "'" ]]; then
            encoded+="\\"
        fi
        encoded+=$char
    done
    set_env ADMIN_PASSWORD "'$encoded'"
}

is_canonical_install() {
    local origin
    [[ -d "$INSTALL_DIR/.git" && -f "$ENV_FILE" && -f "$INSTALL_DIR/docker-compose.yml" ]] || return 1
    [[ -f /etc/caddy/Caddyfile || -f "$NGINX_SITE" ]] || return 1
    origin=$(git -C "$INSTALL_DIR" config --get remote.origin.url 2>/dev/null) || return 1
    case "$origin" in
        "$REPOSITORY"|git@github.com:ashkan-esz/SlowMeet.git|https://github.com/ashkan-esz/SlowMeet) return 0 ;;
        *) return 1 ;;
    esac
}

is_known_slowmeet_checkout() {
    local origin
    [[ -d "$INSTALL_DIR/.git" && -f "$INSTALL_DIR/docker-compose.yml" ]] || return 1
    origin=$(git -C "$INSTALL_DIR" config --get remote.origin.url 2>/dev/null) || return 1
    case "$origin" in
        "$REPOSITORY"|git@github.com:ashkan-esz/SlowMeet.git|https://github.com/ashkan-esz/SlowMeet) return 0 ;;
        *) return 1 ;;
    esac
}

load_legacy_install_settings() {
    local turn_config env_port
    local -a proxy_domains
    if [[ -f "$NGINX_SITE" ]]; then
        proxy_mode=nginx
        mapfile -t proxy_domains < <(
            sed -nE 's/^[[:space:]]*server_name[[:space:]]+([^;]+);.*/\1/p' "$NGINX_SITE" \
                | tr '[:upper:]' '[:lower:]' | tr ' ' '\n' | sort -u
        )
        env_port=$(read_env_value HTTP_PUBLISH_PORT)
        app_port=${env_port:-$(sed -nE 's/.*proxy_pass[[:space:]]+http:\/\/127\.0\.0\.1:([0-9]+);.*/\1/p' "$NGINX_SITE" | head -n1)}
    else
        proxy_mode=caddy
        mapfile -t proxy_domains < <(
            sed -nE 's/^[[:space:]]*https?:\/\/([^[:space:]{]+)[[:space:]]*\{.*/\1/p' /etc/caddy/Caddyfile \
                | tr '[:upper:]' '[:lower:]' | sort -u
        )
        env_port=$(read_env_value HTTP_PUBLISH_PORT)
        app_port=${env_port:-$(sed -nE 's/.*reverse_proxy[[:space:]]+127\.0\.0\.1:([0-9]+).*/\1/p' /etc/caddy/Caddyfile | head -n1)}
    fi
    [[ "${#proxy_domains[@]}" -eq 1 ]] || fail 'Could not identify exactly one SlowMeet domain from the configured reverse proxy; refusing to update an ambiguous installation.'
    domain=${proxy_domains[0]}
    [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail "The configured proxy host '$domain' is not a valid SlowMeet domain."
    app_port=${app_port:-8080}
    [[ "$app_port" =~ ^[0-9]{1,5}$ ]] && ((10#$app_port >= 1024 && 10#$app_port <= 65535)) \
        || fail 'Could not identify a valid SlowMeet app port from the reverse proxy or environment.'

    enable_turn=no
    if [[ -f "$INSTALL_DIR/.turn-enabled" ]]; then
        enable_turn=yes
    else
        turn_config=$(read_env_value TURN_CONFIG_FILE)
        if [[ -n "$turn_config" ]]; then
            [[ "$turn_config" == /* ]] || turn_config="$INSTALL_DIR/${turn_config#./}"
            [[ -f "$turn_config" ]] && enable_turn=yes
        fi
    fi

    enable_meeting_password=no
    if [[ -n "$(read_env_value MEETING_PASSWORD)" ]]; then
        enable_meeting_password=yes
    fi
}

load_legacy_container_engine() {
    local saved_engine
    [[ -f "$CONTAINER_ENGINE_FILE" ]] || return 0
    saved_engine=$(<"$CONTAINER_ENGINE_FILE")
    case "$saved_engine" in
        docker|podman) container_engine=$saved_engine ;;
        *) fail "The saved container engine in $CONTAINER_ENGINE_FILE is invalid." ;;
    esac
}

wait_for_updated_service() {
    local healthy=no
    log 'Waiting for SlowMeet to become healthy.'
    for _ in $(seq 1 60); do
        if compose exec -T slowmeet wget -qO- http://127.0.0.1:8080/ready >/dev/null 2>&1; then
            healthy=yes
            break
        fi
        sleep 2
    done
    [[ "$healthy" == yes ]] || {
        compose ps
        fail 'SlowMeet did not become ready. Review the container logs with the selected Compose command.'
    }
    if [[ "${caddy_tls_mode:-direct}" != http-only ]]; then
        curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null \
            || fail 'The local HTTPS health check failed.'
    fi
}

update_existing_install() {
    local existing_ice admin_password meeting_password turn_urls previous_tls_mode

    command -v git >/dev/null || fail 'Git is required to update this existing installation.'
    case "$container_engine" in
        docker)
            command -v docker >/dev/null || fail 'Docker is required to update this existing installation.'
            docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required to update this existing installation.'
            ;;
        podman)
            command -v podman >/dev/null || fail 'Podman is required to update this existing installation.'
            command -v podman-compose >/dev/null || fail 'podman-compose is required to update this existing installation.'
            podman --version >/dev/null 2>&1 && podman-compose --version >/dev/null 2>&1 \
                || fail 'Podman and podman-compose must be available to update this existing installation.'
            ;;
    esac
    previous_tls_mode=${caddy_tls_mode:-direct}
    detect_caddy_tls_mode
    git -C "$INSTALL_DIR" diff --quiet && git -C "$INSTALL_DIR" diff --cached --quiet \
        || fail "$INSTALL_DIR has local tracked changes. Save or revert them before updating."

    existing_ice=$(read_env_value ICE_PUBLIC_IP)
if [[ -z "$public_ipv4" && -z "$existing_ice" ]]; then
        fail 'Could not discover this VPS public IPv4 address, and ICE_PUBLIC_IP is not configured.'
    fi

    write_install_state incomplete
    log "Updating the existing SlowMeet checkout behind $proxy_mode; preserving its environment, app port, certificates, data volume, and TURN configuration."
    if [[ "$proxy_mode" == caddy ]]; then
        activate_caddy_site final
    elif [[ "$previous_tls_mode" == http-only || "$caddy_tls_mode" == http-only ]]; then
        activate_nginx_site
    fi
    enable_container_engine
    systemctl enable --now "$proxy_mode"
    if [[ "$proxy_mode" == nginx ]]; then
        ensure_nginx_ipv6_listeners
    fi
    git -C "$INSTALL_DIR" fetch --depth=1 origin master
    git -C "$INSTALL_DIR" checkout -B master FETCH_HEAD

    set_env_if_empty HTTP_PUBLISH_ADDRESS 127.0.0.1
    set_env_if_empty HTTP_PUBLISH_PORT "$app_port"
    if [[ -z "$existing_ice" ]]; then
        set_env ICE_PUBLIC_IP "$public_ipv4"
    fi
    write_podman_service

    cd "$INSTALL_DIR"
    if [[ "$enable_turn" == yes ]]; then
        compose --profile turn up -d --build
    else
        compose up -d --build
    fi
    if [[ "$container_engine" == podman ]]; then
        systemctl enable --now slowmeet-podman.service
    fi
    if [[ "$caddy_tls_mode" == xray ]] && ! configure_xray_fallback; then
        mark_https_unavailable "$https_reason"
        activate_caddy_site final
    fi
    wait_for_updated_service

    admin_password=$(read_env_value ADMIN_PASSWORD)
    meeting_password=$(read_env_value MEETING_PASSWORD)
    turn_urls=$(read_env_value TURN_URLS)
    if [[ "$caddy_tls_mode" == http-only ]]; then
        printf '\nSlowMeet is updated and its local app health check passed.\n'
    else
        printf '\nSlowMeet is updated and ready at https://%s/\nAdmin: https://%s/admin\n' "$domain" "$domain"
    fi
    if [[ -n "$admin_password" ]]; then
        printf 'Admin password: %s\n' "$admin_password"
    else
        printf 'Admin access is disabled because ADMIN_PASSWORD is empty.\n'
    fi
    if [[ -n "$meeting_password" ]]; then
        printf 'Meeting password: %s\n' "$meeting_password"
    fi
    if [[ "$enable_turn" == yes && -n "$turn_urls" ]]; then
        printf 'TURN URLs: %s\n' "$turn_urls"
    fi
    printf '\nExisting credentials and application data were preserved.\n'
    if [[ "$proxy_mode" == caddy ]]; then
        log "Caddy installation method remains: $caddy_install_method."
    fi
    write_install_state complete
    print_https_warning
}

write_expected_caddyfile() {
    local phase=$1 include_marker=$2
    if [[ "$include_marker" == yes ]]; then
        printf '# Managed by SlowMeet installer\n\n'
    fi
    if [[ "$phase" == bootstrap && "${caddy_tls_mode:-direct}" == http-only ]]; then
        cat <<EOF
http://$domain {
    root * /var/www/letsencrypt
    route {
        handle /.well-known/acme-challenge/* {
            file_server
        }
        handle {
            respond "SlowMeet setup in progress" 503
        }
    }
}
EOF
        return
    fi
    if [[ "$phase" == bootstrap ]]; then
        cat <<EOF
http://$domain {
    root * /var/www/letsencrypt
    route {
        handle /.well-known/acme-challenge/* {
            file_server
        }
        redir https://{host}{uri} permanent
    }
}
EOF
        return
    fi
    if [[ "${caddy_tls_mode:-direct}" == http-only ]]; then
        cat <<EOF
http://$domain {
    root * /var/www/letsencrypt
    route {
        handle /.well-known/acme-challenge/* {
            file_server
        }
        handle {
            reverse_proxy 127.0.0.1:$app_port {
                transport http {
                    keepalive 2m
                }
            }
        }
    }
}
EOF
        return
    fi
    if [[ "${caddy_tls_mode:-direct}" == xray ]]; then
        cat <<EOF
http://$domain {
    root * /var/www/letsencrypt
    route {
        handle /.well-known/acme-challenge/* {
            file_server
        }
        redir https://{host}{uri} permanent
    }
}

http://$domain:$CADDY_XRAY_BACKEND_PORT {
    bind 127.0.0.1
    reverse_proxy 127.0.0.1:$app_port {
        transport http {
            keepalive 2m
        }
        header_up X-Forwarded-Proto https
    }
}
EOF
        return
    fi
    cat <<EOF
http://$domain {
    root * /var/www/letsencrypt
    route {
        handle /.well-known/acme-challenge/* {
            file_server
        }
        redir https://{host}{uri} permanent
    }
}

https://$domain {
    tls $CERT_DIR/fullchain.pem $CERT_DIR/privkey.pem
    route {
        handle /.well-known/acme-challenge/* {
            root * /var/www/letsencrypt
            file_server
        }
        handle {
            reverse_proxy 127.0.0.1:$app_port {
                transport http {
                    keepalive 2m
                }
            }
        }
    }
}
EOF
}

caddy_config_matches_install() {
    local caddyfile=${1:-/etc/caddy/Caddyfile} expected phase marker mode saved_mode=${caddy_tls_mode:-direct}
    [[ -f "$caddyfile" ]] || return 0
    [[ ! -L "$caddyfile" ]] || return 1

    if grep -Fxq "$CADDY_BEGIN_MARKER" "$caddyfile" \
        || grep -Fxq "$CADDY_END_MARKER" "$caddyfile"; then
        caddy_managed_block_matches_install "$caddyfile"
        return
    fi

    expected=$(mktemp)
    for mode in "$saved_mode" direct xray http-only; do
        caddy_tls_mode=$mode
        for phase in bootstrap final; do
            for marker in yes no; do
                write_expected_caddyfile "$phase" "$marker" > "$expected"
                if cmp -s "$expected" "$caddyfile"; then
                    caddy_tls_mode=$saved_mode
                    rm -f "$expected"
                    return 0
                fi
            done
        done
    done
    caddy_tls_mode=$saved_mode
    rm -f "$expected"
    return 1
}

write_caddy_managed_block() {
    local phase=$1
    printf '%s\n' "$CADDY_BEGIN_MARKER"
    write_expected_caddyfile "$phase" no
    printf '%s\n' "$CADDY_END_MARKER"
}

extract_caddy_managed_block() {
    local caddyfile=$1 output=$2
    awk -v begin="$CADDY_BEGIN_MARKER" -v end="$CADDY_END_MARKER" '
        $0 == begin {
            if (inside || seen) bad = 1
            inside = 1
            seen = 1
            print
            next
        }
        $0 == end {
            if (!inside) bad = 1
            inside = 0
            print
            next
        }
        inside { print }
        END { if (!seen || inside || bad) exit 1 }
    ' "$caddyfile" > "$output"
}

strip_caddy_managed_block() {
    local caddyfile=$1 output=$2
    awk -v begin="$CADDY_BEGIN_MARKER" -v end="$CADDY_END_MARKER" '
        $0 == begin {
            if (inside || seen) bad = 1
            inside = 1
            seen = 1
            next
        }
        $0 == end {
            if (!inside) bad = 1
            inside = 0
            next
        }
        !inside { print }
        END { if (!seen || inside || bad) exit 1 }
    ' "$caddyfile" > "$output"
}

caddy_managed_block_matches_install() {
    local caddyfile=$1 extracted expected phase mode matches=no saved_mode=${caddy_tls_mode:-direct}
    extracted=$(mktemp)
    expected=$(mktemp)
    if ! extract_caddy_managed_block "$caddyfile" "$extracted"; then
        rm -f "$extracted" "$expected"
        return 1
    fi
    for mode in "$saved_mode" direct xray http-only; do
        caddy_tls_mode=$mode
        for phase in bootstrap final; do
            write_caddy_managed_block "$phase" > "$expected"
            if cmp -s "$extracted" "$expected"; then
                matches=yes
                break 2
            fi
        done
    done
    caddy_tls_mode=$saved_mode
    rm -f "$extracted" "$expected"
    [[ "$matches" == yes ]]
}

legacy_caddy_config_matches_install() {
    local caddyfile=$1 expected phase marker mode matches=no saved_mode=${caddy_tls_mode:-direct}
    expected=$(mktemp)
    for mode in "$saved_mode" direct xray http-only; do
        caddy_tls_mode=$mode
        for phase in bootstrap final; do
            for marker in yes no; do
                write_expected_caddyfile "$phase" "$marker" > "$expected"
                if cmp -s "$expected" "$caddyfile"; then
                    matches=yes
                    break 3
                fi
            done
        done
    done
    caddy_tls_mode=$saved_mode
    rm -f "$expected"
    [[ "$matches" == yes ]]
}

write_caddy_site() (
    local phase=$1 caddyfile=${2:-/etc/caddy/Caddyfile} dir temp base block
    temp= base= block=
    trap 'cleanup_status=$?; trap - EXIT; rm -f -- "${temp:-}" "${base:-}" "${block:-}" || true; exit "$cleanup_status"' EXIT
    dir=$(dirname "$caddyfile")
    [[ ! -L "$caddyfile" && ( ! -e "$caddyfile" || -f "$caddyfile" ) ]] \
        || fail "Caddy configuration at $caddyfile is not a regular file; refusing to replace it."

    temp=$(mktemp "$dir/.Caddyfile.slowmeet.XXXXXX")
    base=$(mktemp "$dir/.Caddyfile.slowmeet.base.XXXXXX")
    block=$(mktemp "$dir/.Caddyfile.slowmeet.block.XXXXXX")
    write_caddy_managed_block "$phase" > "$block"

    if [[ -f "$caddyfile" ]]; then
        if grep -Fxq "$CADDY_BEGIN_MARKER" "$caddyfile" \
            || grep -Fxq "$CADDY_END_MARKER" "$caddyfile"; then
            caddy_managed_block_matches_install "$caddyfile" \
                || fail 'The managed SlowMeet block in the Caddyfile was modified; refusing to replace it.'
            strip_caddy_managed_block "$caddyfile" "$base" \
                || fail 'The managed SlowMeet block in the Caddyfile is malformed.'
        elif legacy_caddy_config_matches_install "$caddyfile"; then
            : > "$base"
        else
            cp -- "$caddyfile" "$base"
        fi
    else
        : > "$base"
    fi

    if [[ -s "$base" ]]; then
        cat "$base" > "$temp"
        printf '\n' >> "$temp"
    fi
    cat "$block" >> "$temp"
    if ! caddy validate --config "$temp" --adapter caddyfile; then
        rm -f "$temp" "$base" "$block"
        fail 'The merged Caddy configuration is invalid; the active configuration was left unchanged.'
    fi
    chown root:caddy "$temp" || fail 'Could not set ownership on the merged Caddy configuration.'
    chmod 0640 "$temp" || fail 'Could not set permissions on the merged Caddy configuration.'
    mv -f "$temp" "$caddyfile"
)

remove_caddy_site() (
    local caddyfile=${1:-/etc/caddy/Caddyfile} dir temp base fallback backup preserve_backup=no
    [[ -f "$caddyfile" ]] || return 0
    temp= base= fallback= backup=
    trap 'cleanup_status=$?; trap - EXIT; rm -f -- "${temp:-}" "${base:-}" "${fallback:-}" || true; if [[ "${preserve_backup:-no}" != yes ]]; then rm -f -- "${backup:-}" || true; fi; exit "$cleanup_status"' EXIT
    [[ ! -L "$caddyfile" ]] || fail "Caddy configuration at $caddyfile is a symlink; refusing to modify it."

    dir=$(dirname "$caddyfile")
    temp=$(mktemp "$dir/.Caddyfile.slowmeet.XXXXXX")
    base=$(mktemp "$dir/.Caddyfile.slowmeet.base.XXXXXX")
    fallback=$(mktemp "$dir/.Caddyfile.slowmeet.fallback.XXXXXX")
    if grep -Fxq "$CADDY_BEGIN_MARKER" "$caddyfile" \
        || grep -Fxq "$CADDY_END_MARKER" "$caddyfile"; then
        caddy_managed_block_matches_install "$caddyfile" \
            || fail 'The managed SlowMeet block in the Caddyfile was modified; refusing to remove it.'
        strip_caddy_managed_block "$caddyfile" "$base" \
            || fail 'The managed SlowMeet block in the Caddyfile is malformed.'
    elif legacy_caddy_config_matches_install "$caddyfile"; then
        : > "$base"
    else
        rm -f "$temp" "$base" "$fallback"
        fail 'The Caddyfile no longer contains the recognized SlowMeet configuration; refusing to modify it.'
    fi

    if [[ -s "$base" ]]; then
        cp -- "$base" "$temp"
    else
        cat > "$fallback" <<'EOF'
:80 {
    respond 404
}
EOF
        cp -- "$fallback" "$temp"
    fi
    if ! caddy validate --config "$temp" --adapter caddyfile; then
        rm -f "$temp" "$base" "$fallback"
        fail 'The remaining Caddy configuration is invalid; the active configuration was left unchanged.'
    fi
    chown root:caddy "$temp" || fail 'Could not set ownership on the remaining Caddy configuration.'
    chmod 0640 "$temp" || fail 'Could not set permissions on the remaining Caddy configuration.'
    backup=$(mktemp "$dir/.Caddyfile.slowmeet.backup.XXXXXX")
    cp -p -- "$caddyfile" "$backup"
    mv -f "$temp" "$caddyfile"
    if ! reload_caddy_after_config_change; then
        if ! mv -f "$backup" "$caddyfile"; then
            preserve_backup=yes
            fail "Caddy reload failed and the previous configuration could not be restored; backup remains at $backup."
        fi
        backup=
        if caddy validate --config "$caddyfile" --adapter caddyfile \
            && reload_caddy_after_config_change; then
            fail 'Caddy reload failed; the previous Caddyfile was restored and reloaded. Retry the uninstall.'
        fi
        fail 'Caddy reload failed; the previous Caddyfile was restored, but its validation or recovery reload also failed. Retry the uninstall.'
    fi
    rm -f -- "$backup"
    backup=
)

reload_caddy_after_config_change() {
    if systemctl is-active --quiet caddy; then
        systemctl reload caddy
    else
        systemctl enable --now caddy
    fi
}

activate_caddy_site() {
    local phase=$1 caddyfile=${2:-/etc/caddy/Caddyfile} conflicts
    write_caddy_site "$phase" "$caddyfile"
    if reload_caddy_after_config_change; then
        return 0
    fi
    [[ "${caddy_tls_mode:-direct}" != http-only ]] \
        || fail 'Caddy could not start its HTTP-only configuration; the port 80 proxy is unavailable.'
    if ! conflicts=$(caddy_https_port_conflicts); then
        fail 'Caddy failed to activate, and TCP port 443 could not be inspected to identify a TLS bind conflict.'
    fi
    [[ -n "$conflicts" ]] \
        || fail 'Caddy failed to activate for a reason other than a TCP port 443 conflict.'
    mark_https_unavailable "Caddy could not bind TCP port 443 because it is held by $conflicts."
    write_caddy_site "$phase" "$caddyfile"
    reload_caddy_after_config_change \
        || fail 'Caddy could not activate its HTTP-only configuration after the HTTPS bind conflict.'
}

activate_nginx_site() {
    local conflicts
    if write_nginx_site; then
        return 0
    fi
    [[ "${caddy_tls_mode:-direct}" != http-only ]] \
        || fail 'Nginx could not activate its HTTP-only configuration.'
    if ! conflicts=$(caddy_https_port_conflicts nginx); then
        fail 'Nginx failed to activate, and TCP port 443 could not be inspected to identify a TLS bind conflict.'
    fi
    [[ -n "$conflicts" ]] \
        || fail 'Nginx failed to activate for a reason other than a TCP port 443 conflict.'
    mark_https_unavailable "Nginx could not bind TCP port 443 because it is held by $conflicts."
    write_nginx_site
}

uninstall_existing_install() {
    local remove_data=no compose_available=no

    [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
        || fail 'Could not identify a valid SlowMeet domain; refusing to uninstall an ambiguous installation.'
    [[ ! -L "$CERT_DIR" ]] \
        || fail "Certificate directory $CERT_DIR is a symlink; refusing to remove files outside the SlowMeet directory."
    if [[ -d "$INSTALL_DIR" ]]; then
        is_known_slowmeet_checkout \
            || fail "$INSTALL_DIR is not a recognized SlowMeet checkout; refusing to remove it."
        case "$container_engine" in
            docker)
                command -v docker >/dev/null && docker compose version >/dev/null 2>&1 \
                    || fail 'Docker Compose v2 is required to remove the SlowMeet containers.'
                ;;
            podman)
                command -v podman >/dev/null && command -v podman-compose >/dev/null \
                    && podman-compose --version >/dev/null 2>&1 \
                    || fail 'Podman and podman-compose are required to remove the SlowMeet containers.'
                ;;
            *) fail "Unsupported saved container engine: ${container_engine:-unset}." ;;
        esac
        compose_available=yes
    fi

    if [[ "$proxy_mode" == nginx && -e "$NGINX_SITE" ]]; then
        command -v nginx >/dev/null || fail 'Nginx is required to remove the installer-managed Nginx configuration.'
        grep -Fxq '# Managed by SlowMeet installer' "$NGINX_SITE" \
            || fail "The Nginx configuration at $NGINX_SITE is not recognized as installer-managed; refusing to remove it."
        awk -v domain="$domain" '$1 == "server_name" && $2 == domain ";" { found = 1 } END { exit !found }' "$NGINX_SITE" \
            || fail "The Nginx configuration at $NGINX_SITE does not match $domain; refusing to remove it."
    elif [[ "$proxy_mode" == caddy ]]; then
        caddy_config_matches_install \
            || fail 'The Caddyfile differs from the installer-managed SlowMeet configuration; refusing to modify shared proxy settings.'
        if [[ -f /etc/caddy/Caddyfile ]]; then
            command -v caddy >/dev/null || fail 'Caddy is required to remove the installer-managed Caddy configuration.'
            getent group caddy >/dev/null || fail 'The caddy group is required to write the remaining Caddy configuration.'
        fi
    else
        [[ "$proxy_mode" == caddy || "$proxy_mode" == nginx ]] \
            || fail "Unsupported saved proxy mode: ${proxy_mode:-unset}."
    fi

    printf 'This will remove the SlowMeet service and its installer-managed configuration for %s.\n' "$domain"
    printf 'The persistent application data volume will be kept unless you separately choose to purge it.\n'
    local confirmation
    read -r -p "Type $domain to confirm uninstall: " confirmation <&3
    [[ "$confirmation" == "$domain" ]] || {
        log 'Uninstall cancelled; no changes were made.'
        return 0
    }
    if yes_no 'Permanently delete the SlowMeet application data volume?' no; then
        remove_data=yes
    fi

    if [[ "$caddy_tls_mode" == xray && ( "$xray_fallback_managed" == yes || "$xray_alpn_added" == yes ) ]]; then
        local xray_config
        xray_config=$(xray_config_path)
        remove_xray_fallback_from_config "$xray_config" "$domain" "$CADDY_XRAY_BACKEND_PORT" \
            "$xray_fallback_managed" "$xray_alpn_added"
    fi

    if [[ "$container_engine" == podman ]] && systemctl cat slowmeet-podman.service >/dev/null 2>&1; then
        systemctl disable --now slowmeet-podman.service
    fi
    if [[ "$compose_available" == yes ]]; then
        if [[ "$enable_turn" == yes ]]; then
            if [[ "$remove_data" == yes ]]; then
                compose --profile turn down --volumes
            else
                compose --profile turn down
            fi
        elif [[ "$remove_data" == yes ]]; then
            compose down --volumes
        else
            compose down
        fi
    fi

    if [[ "$container_engine" == podman ]]; then
        rm -f "$PODMAN_SERVICE_FILE"
        systemctl daemon-reload
    fi

    if [[ "$proxy_mode" == nginx && -e "$NGINX_SITE" ]]; then
        rm -f "$NGINX_SITE"
        if systemctl is-active --quiet nginx; then
            nginx -t
            systemctl reload nginx
        fi
    elif [[ "$proxy_mode" == caddy && -f /etc/caddy/Caddyfile ]]; then
        remove_caddy_site
    fi

    rm -f "$CERT_HOOK"
    rm -f "$CERT_DIR/fullchain.pem" "$CERT_DIR/privkey.pem"
    rmdir "$CERT_DIR" 2>/dev/null || true
    rm -f "$PROXY_MODE_FILE" "$CONTAINER_ENGINE_FILE"
    rmdir /etc/slowmeet 2>/dev/null || true
    rm -rf "$INSTALL_DIR"
    rm -f "$STATE_FILE"
    rmdir "$STATE_DIR" 2>/dev/null || true

    printf '\nSlowMeet was uninstalled from %s.\n' "$domain"
    if [[ "$remove_data" == yes ]]; then
        printf 'The application data volume was permanently deleted.\n'
    else
        printf 'The application data volume was preserved.\n'
    fi
    printf 'Shared container and proxy packages, host firewall rules, and Let’s Encrypt certificates were left in place.\n'
}

choose_existing_install_action() {
    local answer action_default action_label
    if [[ "$install_mode" == fresh-resume ]]; then
        action_default=resume
        action_label='Existing incomplete installation (resume/uninstall)'
    else
        action_default=update
        action_label='Existing installation (update/uninstall)'
    fi
    while true; do
        answer=$(prompt "$action_label" "$action_default")
        case "${answer,,}" in
            "$action_default") return 0 ;;
            uninstall|delete|remove)
                uninstall_existing_install
                exit 0
                ;;
            *) log "Enter $action_default or uninstall." ;;
        esac
    done
}

[[ "$(id -u)" -eq 0 ]] || fail 'Run this installer as root, for example through the README one-line command.'
[[ -e /dev/tty ]] || fail 'This installer needs an interactive terminal.'

exec 3<>/dev/tty || fail 'Could not open the interactive terminal.'

prompt() {
    local label=$1 default=$2 answer
    read -r -p "$label [$default]: " answer <&3
    printf '%s' "${answer:-$default}"
}

yes_no() {
    local label=$1 default=$2 answer
    while true; do
        answer=$(prompt "$label (yes/no)" "$default")
        case "${answer,,}" in
            yes|y) return 0 ;;
            no|n) return 1 ;;
            *) log 'Enter yes or no.' ;;
        esac
    done
}

prompt_container_engine() {
    local answer
    while true; do
        answer=$(prompt 'Container engine (docker/podman)' "${container_engine:-docker}")
        case "${answer,,}" in
            docker) container_engine=docker; return ;;
            podman) container_engine=podman; return ;;
            *) log 'Enter docker or podman.' ;;
        esac
    done
}

prompt_app_port() {
    local answer
    while true; do
        answer=$(prompt 'Local app port for the reverse proxy' "${app_port:-8080}")
        if [[ "$answer" =~ ^[0-9]{1,5}$ ]] && ((10#$answer >= 1024 && 10#$answer <= 65535)); then
            app_port=$((10#$answer))
            return
        fi
        log 'Enter a TCP port from 1024 through 65535.'
    done
}

check_app_port_available() {
    local running_slowmeet
    command -v ss >/dev/null || fail 'The ss command is required to check the selected local app port.'
    if [[ "$install_mode" == fresh-resume && -f "$ENV_FILE" ]] \
        && running_slowmeet=$(compose ps -q 2>/dev/null) && [[ -n "$running_slowmeet" ]]; then
        log "The saved app port $app_port is already used by the running SlowMeet container; keeping it while resuming."
        return
    fi
    while [[ -n "$(ss -H -ltn "sport = :$app_port")" ]]; do
        log "TCP port $app_port is already in use on this VPS."
        prompt_app_port
        write_install_state incomplete
    done
}

prompt_admin_password() {
    local first second
    while true; do
        IFS= read -r -s -p 'Admin password (leave blank to generate): ' first <&3
        printf '\n' >&3
        if [[ -z "$first" ]]; then
            admin_password=$(openssl rand -hex 24 2>/dev/null || true)
            [[ "$admin_password" =~ ^[a-f0-9]{48}$ ]] || fail 'Could not generate a secure admin password.'
            return
        else
            IFS= read -r -s -p 'Confirm admin password: ' second <&3
            printf '\n' >&3
            if [[ "$first" == "$second" && ${#first} -ge 12 && ${#first} -le 128 && "$first" != *$'\n'* && "$first" != *$'\r'* ]]; then
                admin_password=$first
                return
            fi
        fi
        log 'Passwords must match and contain 12 to 128 characters; try again.'
    done
}

caddy_https_port_conflicts() {
    local service=${1:-caddy} listener_output service_main_pid line owner_data process_name process_pid found_owner
    local -a conflicts=()
    local owner_regex='\(?\("([^"]+)",pid=([0-9]+)'

    command -v ss >/dev/null || return 1
    listener_output=$(ss -H -ltnp 'sport = :443') || return 1
    [[ -n "$listener_output" ]] || return 0
    service_main_pid=$(systemctl show -p MainPID --value "$service" 2>/dev/null || true)

    while IFS= read -r line; do
        owner_data=${line#*users:}
        if [[ "$owner_data" == "$line" ]]; then
            conflicts+=("unknown process (PID unavailable)")
            continue
        fi

        found_owner=no
        while [[ "$owner_data" =~ $owner_regex ]]; do
            found_owner=yes
            process_name=${BASH_REMATCH[1]}
            process_pid=${BASH_REMATCH[2]}
            if [[ "$process_name" != "$service" || ( "$service" != nginx && "$process_pid" != "$service_main_pid" ) ]]; then
                conflicts+=("$process_name (PID $process_pid)")
            fi
            owner_data=${owner_data#*"pid=$process_pid"}
        done
        [[ "$found_owner" == yes ]] || conflicts+=("unknown process (PID unavailable)")
    done <<< "$listener_output"

    if (( ${#conflicts[@]} > 0 )); then
        local joined=${conflicts[0]}
        for process_name in "${conflicts[@]:1}"; do
            [[ ",$joined," == *",$process_name,"* ]] || joined+=", $process_name"
        done
        printf '%s\n' "$joined"
    fi
}

check_caddy_https_port_available() {
    local conflicts
    if ! conflicts=$(caddy_https_port_conflicts); then
        fail 'Could not inspect TCP port 443 before configuring Caddy.'
    fi
    [[ -z "$conflicts" ]] || fail "TCP port 443 is already in use by $conflicts. Caddy cannot load the SlowMeet HTTPS listener; the existing service was left untouched."
}

xray_https_port_443_is_active() {
    local listeners line owner_data process_name process_pid caddy_main_pid found_owner found_xray=no
    local owner_regex='\(?\("([^"]+)",pid=([0-9]+)'
    command -v ss >/dev/null || return 1
    listeners=$(ss -H -ltnp 'sport = :443') || return 1
    [[ -n "$listeners" ]] || return 1
    caddy_main_pid=$(systemctl show -p MainPID --value caddy 2>/dev/null || true)
    while IFS= read -r line; do
        owner_data=${line#*users:}
        [[ "$owner_data" != "$line" ]] || return 1
        found_owner=no
        while [[ "$owner_data" =~ $owner_regex ]]; do
            found_owner=yes
            process_name=${BASH_REMATCH[1]}
            process_pid=${BASH_REMATCH[2]}
            case "$process_name" in
                xray) found_xray=yes ;;
                caddy) [[ "$process_pid" == "$caddy_main_pid" ]] || return 1 ;;
                *) return 1 ;;
            esac
            owner_data=${owner_data#*"pid=$process_pid"}
        done
        [[ "$found_owner" == yes ]] || return 1
    done <<< "$listeners"
    [[ "$found_xray" == yes ]]
}

validate_xray_fallback_config() {
    local config=$1 domain=$2 backend_port=$3
    [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] \
        && [[ "$backend_port" =~ ^[0-9]{1,5}$ ]] \
        && ((10#$backend_port >= 1024 && 10#$backend_port <= 65535)) \
        || fail 'The Xray fallback domain or backend port is invalid.'
    jq -e '
        if (.inbounds | type) != "array" then false
        else
            [.inbounds[] | select(.port == 443 or .port == "443")] as $https |
            ($https | length) == 1 and
            ($https[0].protocol == "vless" or $https[0].protocol == "trojan") and
            $https[0].streamSettings.network == "tcp" and
            $https[0].streamSettings.security == "tls" and
            ($https[0].settings | type) == "object" and
            ($https[0].streamSettings | type) == "object" and
            (($https[0].streamSettings.tlsSettings // {}) | type) == "object" and
            (($https[0].streamSettings.tlsSettings.alpn // []) | type) == "array" and
            (($https[0].settings.fallbacks // []) | type) == "array"
        end
    ' "$config" >/dev/null 2>&1 \
        || fail 'Xray must have exactly one VLESS or Trojan TCP+TLS inbound on port 443 with valid fallback and ALPN settings.'
}

apply_xray_fallback_to_config() {
    local config=$1 domain=$2 backend_port=$3 temp backup existing_route has_alpn
    if [[ ! -f "$config" || -L "$config" ]]; then
        https_reason="Xray config at $config is not a regular file; it was left unchanged."
        return 1
    fi
    if [[ ! "$backend_port" =~ ^[0-9]{1,5}$ ]] || ((10#$backend_port < 1024 || 10#$backend_port > 65535)); then
        https_reason='The Xray fallback backend port is invalid; its config was left unchanged.'
        return 1
    fi
    if ! reason=$(validate_xray_fallback_config "$config" "$domain" "$backend_port" 2>&1); then
        https_reason=${reason#\[slowmeet\] ERROR: }
        return 1
    fi
    existing_route=$(jq -r --arg domain "$domain" '
        [.inbounds[] | select(.port == 443 or .port == "443") | .settings.fallbacks[]? |
            select((.name // "") == $domain and (.path // "") == "" and (.alpn // "") == "")]
        | if length == 0 then "none" elif length == 1 then (.[0].dest | tostring) else "multiple" end
    ' "$config")
    if [[ "$existing_route" == multiple ]]; then
        https_reason="Xray has multiple general fallbacks for $domain; its config was left unchanged."
        return 1
    fi
    if [[ "$existing_route" != none && "$existing_route" != "$backend_port" ]]; then
        https_reason="Xray already has a general fallback for $domain pointing elsewhere; its config was left unchanged."
        return 1
    fi
    if [[ "$existing_route" == none ]]; then
        xray_fallback_managed=yes
    fi
    has_alpn=$(jq -r '
        [.inbounds[] | select(.port == 443 or .port == "443")][0].streamSettings.tlsSettings.alpn // []
        | if index("http/1.1") == null then "no" else "yes" end
    ' "$config")
    if [[ "$has_alpn" == no ]]; then
        xray_alpn_added=yes
    fi
    if declare -F write_install_state >/dev/null; then
        write_install_state incomplete
    fi

    temp=$(mktemp "$(dirname "$config")/.xray-slowmeet.XXXXXX")
    backup=
    trap 'rm -f -- "${temp:-}" "${backup:-}"' RETURN
    jq --arg domain "$domain" --argjson backend_port "$backend_port" '
        .inbounds |= map(
            if (.port == 443 or .port == "443") then
                .streamSettings.tlsSettings = (.streamSettings.tlsSettings // {})
                |
                .settings.fallbacks = (
                    (.settings.fallbacks // [])
                    | if any(.[]; (.name // "") == $domain and (.path // "") == "" and (.alpn // "") == "") then
                        map(if (.name // "") == $domain and (.path // "") == "" and (.alpn // "") == "" then .dest = $backend_port else . end)
                      else . + [{"name":$domain,"dest":$backend_port}]
                      end
                )
                | .streamSettings.tlsSettings.alpn = (
                    (.streamSettings.tlsSettings.alpn // [])
                    | if index("http/1.1") == null then . + ["http/1.1"] else . end
                )
            else . end
        )
    ' "$config" > "$temp" || { https_reason='Could not prepare the Xray fallback config; the active config was left unchanged.'; return 1; }
    chmod --reference="$config" "$temp" \
        || { https_reason='Could not preserve Xray config permissions; the active config was left unchanged.'; return 1; }
    chown --reference="$config" "$temp" \
        || { https_reason='Could not preserve Xray config ownership; the active config was left unchanged.'; return 1; }
    if cmp -s "$config" "$temp"; then
        rm -f -- "$temp"
        temp=
        trap - RETURN
        return 0
    fi

    if ! command -v xray >/dev/null; then
        https_reason='The Xray executable is unavailable for fallback validation; its active config was left unchanged.'
        return 1
    fi
    if ! xray run -test -config "$temp" >/dev/null; then
        https_reason='Xray rejected the proposed fallback config; its active config was left unchanged.'
        return 1
    fi

    backup=$(mktemp "$(dirname "$config")/.xray-slowmeet.backup.XXXXXX")
    cp -p -- "$config" "$backup"
    mv -f -- "$temp" "$config"
    temp=
    if ! systemctl restart xray.service; then
        mv -f -- "$backup" "$config" \
            || fail "Xray restart failed and the original configuration could not be restored; backup remains at $backup."
        backup=
        systemctl restart xray.service \
            || fail 'Xray restart and recovery restart failed after restoring the previous configuration; inspect xray.service immediately.'
        https_reason='Xray rejected the fallback restart; the original configuration was restored and Xray restarted.'
        trap - RETURN
        return 1
    fi
    rm -f -- "$backup"
    backup=
    trap - RETURN
}

remove_xray_fallback_from_config() {
    local config=$1 domain=$2 backend_port=$3 remove_route=$4 remove_alpn=$5 temp backup
    [[ "$remove_route" == yes || "$remove_alpn" == yes ]] || return 0
    [[ -f "$config" && ! -L "$config" ]] \
        || fail "Xray config at $config is not a regular file; refusing to modify it."
    temp=$(mktemp "$(dirname "$config")/.xray-slowmeet.remove.XXXXXX")
    backup=
    trap 'rm -f -- "${temp:-}" "${backup:-}"' RETURN
    jq --arg domain "$domain" --argjson backend_port "$backend_port" \
        --arg remove_route "$remove_route" --arg remove_alpn "$remove_alpn" '
        .inbounds |= map(
            if (.port == 443 or .port == "443") then
                if $remove_route == "yes" then
                    .settings.fallbacks = ((.settings.fallbacks // []) | map(
                        select(
                            (.name // "") != $domain or
                            (.path // "") != "" or
                            (.alpn // "") != "" or
                            ((.dest | tostring) != ($backend_port | tostring))
                        )
                    ))
                else . end
                | if $remove_alpn == "yes" then
                    .streamSettings.tlsSettings.alpn = ((.streamSettings.tlsSettings.alpn // []) | map(select(. != "http/1.1")))
                  else . end
            else . end
        )
    ' "$config" > "$temp" || fail 'Could not prepare the Xray fallback removal.'
    chmod --reference="$config" "$temp"
    chown --reference="$config" "$temp"
    if cmp -s "$config" "$temp"; then
        rm -f -- "$temp"
        temp=
        trap - RETURN
        return 0
    fi
    command -v xray >/dev/null || fail 'The xray executable is required to validate fallback removal.'
    xray run -test -config "$temp" >/dev/null \
        || fail 'Xray rejected the proposed fallback removal; its active config was left unchanged.'
    backup=$(mktemp "$(dirname "$config")/.xray-slowmeet.backup.XXXXXX")
    cp -p -- "$config" "$backup"
    mv -f -- "$temp" "$config"
    temp=
    if ! systemctl restart xray.service; then
        mv -f -- "$backup" "$config" \
            || fail "Xray restart failed and the original configuration could not be restored; backup remains at $backup."
        backup=
        systemctl restart xray.service \
            || log 'Xray restart also failed after restoring its previous configuration; inspect xray.service immediately.'
        fail 'Xray restart failed; the previous configuration was restored.'
    fi
    rm -f -- "$backup"
    backup=
    trap - RETURN
}

xray_config_path() {
    local pid arg next config= count=0 i
    local -a args=()
    pid=$(systemctl show -p MainPID --value xray.service 2>/dev/null) \
        || fail 'Could not identify the running Xray service process.'
    [[ "$pid" =~ ^[1-9][0-9]*$ && -r "/proc/$pid/cmdline" ]] \
        || fail 'Xray must be running so its active configuration path can be identified safely.'
    mapfile -d '' -t args < "/proc/$pid/cmdline"
    for ((i = 0; i < ${#args[@]}; i++)); do
        arg=${args[i]}
        case "$arg" in
            -confdir|-confdir=*) fail 'Xray config directories are not supported; use one JSON config file.' ;;
            -config|-c)
                ((i + 1 < ${#args[@]})) || fail 'Xray command line has a config flag without a path.'
                next=${args[i + 1]}
                config=$next
                ((count += 1))
                ((i += 1))
                ;;
            -config=*|-c=*) config=${arg#*=}; ((count += 1)) ;;
        esac
    done
    [[ "$count" -eq 1 && "$config" == /* && -f "$config" && ! -L "$config" ]] \
        || fail 'Could not identify exactly one regular Xray JSON config file from the running service command.'
    printf '%s\n' "$config"
}

configure_xray_fallback() {
    local config reason
    if ! config=$(xray_config_path 2>&1); then
        https_reason="Xray config path could not be confirmed: ${config#\[slowmeet\] ERROR: }"
        return 1
    fi
    if ! reason=$(validate_xray_fallback_config "$config" "$domain" "$CADDY_XRAY_BACKEND_PORT" 2>&1); then
        https_reason="Xray fallback is unsupported: ${reason#\[slowmeet\] ERROR: }"
        return 1
    fi
    apply_xray_fallback_to_config "$config" "$domain" "$CADDY_XRAY_BACKEND_PORT"
}

detect_proxy_mode() {
    if systemctl is-active --quiet nginx; then
        command -v nginx >/dev/null || fail 'Nginx is active but its nginx command was not found.'
        nginx -t >/dev/null 2>&1 || fail 'Nginx is active but its existing configuration is invalid; fix it before installing SlowMeet.'
        proxy_mode=nginx
        log 'Detected active Nginx; SlowMeet will be installed behind Nginx.'
    else
        proxy_mode=caddy
        log 'No active Nginx detected; SlowMeet will use Caddy.'
    fi
}

detect_caddy_tls_mode() {
    local config listeners caddy_main_pid reason conflicts
    https_reason=
    if [[ "$proxy_mode" != caddy ]]; then
        if xray_https_port_443_is_active; then
            mark_https_unavailable 'Xray owns TCP port 443, but the selected Nginx proxy cannot use the supported Caddy-to-Xray fallback.'
            return 0
        fi
        if ! conflicts=$(caddy_https_port_conflicts nginx); then
            mark_https_unavailable 'Could not inspect TCP port 443 for the selected Nginx proxy.'
            return 0
        fi
        if [[ -n "$conflicts" ]]; then
            mark_https_unavailable "TCP port 443 is already in use by $conflicts."
            return 0
        fi
        caddy_tls_mode=direct
        return 0
    fi
    if xray_https_port_443_is_active; then
        listeners=$(ss -H -ltnp "sport = :$CADDY_XRAY_BACKEND_PORT") \
            || { mark_https_unavailable 'Could not inspect the selected Caddy loopback backend port.'; return 0; }
        caddy_main_pid=$(systemctl show -p MainPID --value caddy 2>/dev/null || true)
        if [[ -n "$listeners" && ! "$listeners" == *"\"caddy\",pid=$caddy_main_pid,"* ]]; then
            mark_https_unavailable "Caddy fallback port $CADDY_XRAY_BACKEND_PORT is already in use; Xray and Caddy were left untouched."
            return 0
        fi
        if ! config=$(xray_config_path 2>&1); then
            reason=${config#\[slowmeet\] ERROR: }
            mark_https_unavailable "Xray fallback could not be configured: $reason"
            return 0
        fi
        if ! reason=$(validate_xray_fallback_config "$config" "$domain" "$CADDY_XRAY_BACKEND_PORT" 2>&1); then
            reason=${reason#\[slowmeet\] ERROR: }
            mark_https_unavailable "Xray fallback is unsupported: $reason"
            return 0
        fi
        caddy_tls_mode=xray
        log "Detected Xray on TCP port 443; SlowMeet will use a Caddy HTTP backend on 127.0.0.1:$CADDY_XRAY_BACKEND_PORT."
    else
        if ! conflicts=$(caddy_https_port_conflicts); then
            mark_https_unavailable 'Could not inspect TCP port 443 before activating the HTTPS proxy.'
        elif [[ -n "$conflicts" ]]; then
            mark_https_unavailable "TCP port 443 is already in use by $conflicts."
        else
            caddy_tls_mode=direct
        fi
    fi
}

ipv6_stack_available() {
    [[ -r /proc/net/if_inet6 && -s /proc/net/if_inet6 ]]
}

nginx_ipv6_listener_lines() {
    local port=$1 suffix=${2:-}
    ipv6_stack_available || return 0
    printf '    listen [::]:%s%s;\n' "$port" "$suffix"
}

restore_nginx_ipv6_backup() {
    local backup_file=$1
    mv -f -- "$backup_file" "$NGINX_SITE" || return 2
    nginx -t && systemctl reload nginx
}

ensure_nginx_ipv6_listeners() (
    local temp backup mode preserve_backup=no rollback_status
    [[ "$proxy_mode" == nginx && -f "$NGINX_SITE" ]] || return 0
    ipv6_stack_available || return 0
    grep -Fxq '# Managed by SlowMeet installer' "$NGINX_SITE" \
        || fail "The Nginx configuration at $NGINX_SITE is not recognized as installer-managed."

    temp= backup=
    trap 'cleanup_status=$?; trap - EXIT; rm -f -- "${temp:-}" || true; if [[ "${preserve_backup:-no}" != yes ]]; then rm -f -- "${backup:-}" || true; fi; exit "$cleanup_status"' EXIT
    temp=$(mktemp "$(dirname "$NGINX_SITE")/.slowmeet-nginx.XXXXXX")
    backup=$(mktemp "$(dirname "$NGINX_SITE")/.slowmeet-nginx-backup.XXXXXX")
    mode=$(stat -c '%a' "$NGINX_SITE")
    cp -p -- "$NGINX_SITE" "$backup"
    if ! awk -v domain="$domain" '
        function brace_delta(line, clean, opens, closes) {
            clean = line
            sub(/#.*/, "", clean)
            opens = gsub(/\{/, "", clean)
            closes = gsub(/\}/, "", clean)
            return opens - closes
        }
        function process_server(    i, line, has_http6, has_https6) {
            if (server_has_domain) {
                matched_domain = 1
                for (i = 1; i <= count; i++) {
                    line = server_lines[i]
                    if (line ~ /^[[:space:]]*listen[[:space:]]+\[::\]:80;[[:space:]]*$/) has_http6 = 1
                    if (line ~ /^[[:space:]]*listen[[:space:]]+\[::\]:443[[:space:]]+ssl;[[:space:]]*$/) has_https6 = 1
                }
                if (has_http6) target_http6 = 1
                if (has_https6) target_https6 = 1
                for (i = 1; i <= count; i++) {
                    line = server_lines[i]
                    print line
                    if (!has_http6 && line ~ /^[[:space:]]*listen[[:space:]]+80;[[:space:]]*$/) {
                        print "    listen [::]:80;"
                        added_http = 1
                    }
                    if (!has_https6 && line ~ /^[[:space:]]*listen[[:space:]]+443[[:space:]]+ssl;[[:space:]]*$/) {
                        print "    listen [::]:443 ssl;"
                        added_https = 1
                    }
                }
            } else {
                for (i = 1; i <= count; i++) print server_lines[i]
            }
            delete server_lines
            count = 0
            server_has_domain = 0
            in_server = 0
        }
        {
            if (!in_server && $0 ~ /^[[:space:]]*server[[:space:]]*\{/) {
                in_server = 1
                depth = 0
                count = 0
                server_has_domain = 0
            }
            if (in_server) {
                server_lines[++count] = $0
                clean = $0
                sub(/#.*/, "", clean)
                if (clean ~ /^[[:space:]]*server_name[[:space:]]/) {
                    sub(/^[[:space:]]*server_name[[:space:]]+/, "", clean)
                    gsub(/[;]/, "", clean)
                    n = split(clean, names, /[[:space:]]+/)
                    for (i = 1; i <= n; i++) if (names[i] == domain) server_has_domain = 1
                }
                depth += brace_delta($0)
                if (depth == 0) process_server()
                next
            }
            print
        }
        END {
            if (in_server) process_server()
            if (!matched_domain || (!added_http && !target_http6) || (!added_https && !target_https6)) exit 1
        }
    ' "$NGINX_SITE" > "$temp"; then
        rm -f "$temp" "$backup"
        fail 'Could not identify the SlowMeet HTTP and HTTPS server blocks for IPv6 migration.'
    fi
    if cmp -s "$NGINX_SITE" "$temp"; then
        rm -f "$temp" "$backup"
        return 0
    fi
    chmod "$mode" "$temp"
    mv -f "$temp" "$NGINX_SITE"
    if ! nginx -t; then
        rollback_status=0
        restore_nginx_ipv6_backup "$backup" || rollback_status=$?
        if [[ "$rollback_status" -eq 2 ]]; then
            preserve_backup=yes
            fail "Nginx rejected the IPv6 configuration and the previous file could not be restored; backup remains at $backup."
        fi
        backup=
        if [[ "$rollback_status" -eq 0 ]]; then
            fail 'Nginx rejected the IPv6 configuration; the previous configuration was restored and reloaded.'
        fi
        fail 'Nginx rejected the IPv6 configuration; the previous file was restored, but its validation or recovery reload also failed.'
    fi
    if ! systemctl reload nginx; then
        rollback_status=0
        restore_nginx_ipv6_backup "$backup" || rollback_status=$?
        if [[ "$rollback_status" -eq 2 ]]; then
            preserve_backup=yes
            fail "Nginx reload failed and the previous file could not be restored; backup remains at $backup."
        fi
        backup=
        if [[ "$rollback_status" -eq 0 ]]; then
            fail 'Nginx reload failed; the previous configuration was restored and reloaded.'
        fi
        fail 'Nginx reload failed; the previous file was restored, but its validation or recovery reload also failed.'
    fi
    rm -f -- "$backup"
    backup=
)

assert_nginx_domain_available() {
    local config_dump managed=no
    if [[ -e "$NGINX_SITE" || -L "$NGINX_SITE" ]]; then
        [[ -f "$NGINX_SITE" && ! -L "$NGINX_SITE" ]] \
            || fail "$NGINX_SITE is not a regular managed configuration file; refusing to replace it."
        grep -q '^# Managed by SlowMeet installer$' "$NGINX_SITE" \
            || fail "$NGINX_SITE already exists and is not managed by SlowMeet; refusing to overwrite it."
        managed=yes
    fi
    config_dump=$(nginx -T 2>/dev/null) || fail 'Could not inspect the active Nginx configuration.'
    awk '$1 == "include" && $2 == "/etc/nginx/conf.d/*.conf;" { found=1 } END { exit !found }' <<<"$config_dump" \
        || fail 'The active Nginx configuration does not include /etc/nginx/conf.d/*.conf; refusing to edit an inactive site file.'
    [[ "$managed" == yes ]] && return
    if awk -v domain="$domain" '$1 == "server_name" { for (i = 2; i <= NF; i++) { gsub(/;/, "", $i); if ($i == domain) found = 1 } } END { exit !found }' <<<"$config_dump"; then
        fail "Nginx already has a virtual host for $domain; refusing to change an existing site."
    fi
}

write_nginx_acme_site() {
    local config_dump ipv6_http
    assert_nginx_domain_available
    install -d -o root -g root -m 0755 /var/www/letsencrypt
    ipv6_http=$(nginx_ipv6_listener_lines 80)
    cat > "$NGINX_SITE" <<EOF
# Managed by SlowMeet installer
server {
    listen 80;
$ipv6_http
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / {
        return 404;
    }
}
EOF
    chmod 0644 "$NGINX_SITE"
    nginx -t
    config_dump=$(nginx -T 2>&1) || fail 'Could not inspect the updated Nginx configuration.'
    [[ "$config_dump" == *"$NGINX_SITE"* ]] \
        || fail "Nginx does not include $NGINX_SITE; refusing to continue with an inactive proxy config."
    systemctl enable --now nginx
    systemctl reload nginx
}

write_nginx_site() {
    local ipv6_http ipv6_https
    ipv6_http=$(nginx_ipv6_listener_lines 80)
    if [[ "${caddy_tls_mode:-direct}" == http-only ]]; then
        cat > "$NGINX_SITE" <<EOF
# Managed by SlowMeet installer
map \$http_upgrade \$slowmeet_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
$ipv6_http
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / {
        proxy_pass http://127.0.0.1:$app_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto http;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$slowmeet_connection_upgrade;
        proxy_read_timeout 2h;
        proxy_send_timeout 2h;
    }
}
EOF
        chmod 0644 "$NGINX_SITE" || return 1
        nginx -t || return 1
        systemctl reload nginx
        return
    fi
    ipv6_https=$(nginx_ipv6_listener_lines 443 ' ssl')
    cat > "$NGINX_SITE" <<EOF
# Managed by SlowMeet installer
map \$http_upgrade \$slowmeet_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
$ipv6_http
    server_name $domain;
    location ^~ /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location / {
        return 301 https://\$host\$request_uri;
    }
}

server {
    listen 443 ssl;
$ipv6_https
    server_name $domain;
    ssl_certificate /etc/letsencrypt/live/$domain/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$domain/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:$app_port;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$slowmeet_connection_upgrade;
        proxy_read_timeout 2h;
        proxy_send_timeout 2h;
    }
}
EOF
    chmod 0644 "$NGINX_SITE" || return 1
    nginx -t || return 1
    systemctl reload nginx
}

[[ -r /etc/os-release ]] || fail 'Could not identify this operating system.'
# shellcheck disable=SC1091
source /etc/os-release
case "${ID:-}" in
    ubuntu|debian) ;;
    *) fail "Supported systems are Ubuntu and Debian; found ${PRETTY_NAME:-unknown}." ;;
esac
command -v apt-get >/dev/null || fail 'This operating system does not provide apt-get.'

install_mode=fresh
install_operation=install
container_engine=docker
caddy_install_method=apt
caddy_tls_mode=direct
if [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]]; then
    read_install_state
    if [[ "$state_status" == incomplete && "$install_operation" == install ]]; then
        if [[ -e "$ENV_FILE" ]]; then
            is_canonical_install || fail "$ENV_FILE exists, but this is not a recognized SlowMeet installation. Refusing to resume it."
        fi
        install_mode=fresh-resume
        log "Resuming the incomplete installation for $domain with its saved options."
    elif [[ -e "$ENV_FILE" ]]; then
        is_canonical_install || fail "$ENV_FILE exists, but this is not a recognized SlowMeet installation. Refusing to update it."
        load_legacy_install_settings
        install_mode=update
        install_operation=update
        if [[ "$state_status" == incomplete ]]; then
            log "Resuming the interrupted update for $domain with its current options."
        else
            log "Updating the existing SlowMeet installation for $domain."
        fi
    elif [[ "$state_status" == complete ]]; then
        fail 'Installer state says SlowMeet is installed, but its environment file is missing. Refusing to overwrite the installation.'
    else
        fail 'Installer state marks an update incomplete, but the SlowMeet environment file is missing.'
    fi
elif [[ -e "$ENV_FILE" ]]; then
    is_canonical_install || fail "$ENV_FILE exists, but this is not a recognized SlowMeet installation. Refusing to update it."
    load_legacy_install_settings
    load_legacy_container_engine
    install_mode=update
    install_operation=update
    log "Detected a legacy SlowMeet installation for $domain; its existing options will be preserved."
else
    domain=$(prompt 'Domain for SlowMeet (for example, meet.example.com)' '')
    domain=${domain,,}
    domain=${domain%.}
    [[ "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail 'Enter a valid fully qualified domain name.'

    enable_turn=no
    if yes_no 'Enable TURN relay support for restrictive networks?' no; then
        enable_turn=yes
    fi

    enable_meeting_password=no
    if yes_no 'Require a password to join the meeting?' no; then
        enable_meeting_password=yes
    fi
    prompt_container_engine
    detect_proxy_mode
    app_port=8080
    prompt_app_port
fi

if [[ "$install_mode" == update || "$install_mode" == fresh-resume ]]; then
    choose_existing_install_action
fi

if [[ "$install_mode" == update ]]; then
    public_ipv4=$(curl -4fsS --max-time 15 https://api.ipify.org || true)
else
    public_ipv4=$(curl -4fsS --max-time 15 https://api.ipify.org) || fail 'Could not discover this VPS public IPv4 address.'
    resolved_ipv4=$(getent ahostsv4 "$domain" | awk '{print $1}' | sort -u || true)
    [[ -n "$resolved_ipv4" ]] || fail "$domain has no IPv4 DNS record yet. Point its A record to $public_ipv4, wait for DNS, then rerun."
    if [[ "$resolved_ipv4" != "$public_ipv4" ]]; then
        fail "$domain resolves to $(tr '\n' ' ' <<<"$resolved_ipv4"), not this VPS IPv4 ($public_ipv4). Fix DNS and rerun."
    fi
    resolved_ipv6=$(getent ahostsv6 "$domain" | awk 'tolower($1) !~ /^::ffff:/ {print $1}' | sort -u || true)
    if [[ -n "$resolved_ipv6" ]]; then
        public_ipv6=$(curl -6fsS --max-time 15 https://api64.ipify.org || true)
        if [[ -z "$public_ipv6" ]] || [[ "$resolved_ipv6" != "$public_ipv6" ]]; then
            fail "$domain also has an AAAA record that does not match this VPS IPv6 address. Remove it or point it to this VPS, then rerun."
        fi
    fi
fi

if [[ "$install_mode" == update ]]; then
    update_existing_install
    exit 0
fi

if [[ "$install_mode" == fresh ]]; then
    write_install_state incomplete
fi

log "Installing prerequisites on ${PRETTY_NAME:-$ID}."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg iproute2 jq openssl certbot ufw
detect_caddy_tls_mode
write_install_state incomplete
private_ipv4=$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}' || true)

if [[ "$container_engine" == docker ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
        "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" \
        > /etc/apt/sources.list.d/docker.list
fi

if [[ "$proxy_mode" == caddy && "$caddy_install_method" == apt ]]; then
    install -m 0755 -d /usr/share/keyrings
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    caddy_repo_id=debian
    [[ "$ID" == ubuntu ]] && caddy_repo_id=ubuntu
    curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/$caddy_repo_id.deb.txt" \
        -o "$CADDY_APT_SOURCE_FILE"
fi

apt_update_with_caddy_fallback
runtime_packages=()
case "$container_engine" in
    docker) runtime_packages=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin) ;;
    podman) runtime_packages=(podman podman-compose) ;;
esac
if [[ "$proxy_mode" == caddy && "$caddy_install_method" == apt ]]; then
    runtime_packages+=(caddy)
fi
apt-get install -y "${runtime_packages[@]}"
enable_container_engine

meeting_password=$(read_env_value MEETING_PASSWORD)
if [[ "$enable_meeting_password" == yes ]]; then
    if [[ -z "$meeting_password" ]]; then
        meeting_password=$(openssl rand -hex 16 2>/dev/null || true)
    fi
    [[ "$meeting_password" =~ ^[a-f0-9]{32}$ ]] || fail 'Could not generate a secure meeting password.'
fi
turn_secret=$(read_env_value TURN_SHARED_SECRET)
if [[ "$enable_turn" == yes ]]; then
    if [[ -z "$turn_secret" ]]; then
        turn_secret=$(openssl rand -hex 32 2>/dev/null || true)
    fi
    [[ "$turn_secret" =~ ^[a-f0-9]{64}$ ]] || fail 'Could not generate a secure TURN secret.'
fi
private_ipv4=$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}')

if [[ -d "$INSTALL_DIR" && ! -d "$INSTALL_DIR/.git" ]]; then
    fail "$INSTALL_DIR exists and is not a SlowMeet checkout; move it before installing."
elif [[ -d "$INSTALL_DIR/.git" ]]; then
    git -C "$INSTALL_DIR" fetch --depth=1 origin master
    git -C "$INSTALL_DIR" checkout -B master FETCH_HEAD
else
    git clone --depth=1 --branch master "$REPOSITORY" "$INSTALL_DIR"
fi
check_app_port_available

ssh_port=22
if command -v sshd >/dev/null; then
    detected_ssh_port=$(sshd -T 2>/dev/null | awk '$1 == "port" {print $2; exit}' || true)
    [[ "$detected_ssh_port" =~ ^[0-9]+$ ]] && ssh_port=$detected_ssh_port
fi
ufw allow "$ssh_port/tcp" comment 'SlowMeet installer SSH'
ufw allow 80/tcp comment 'SlowMeet ACME HTTP'
ufw allow 443/tcp comment 'SlowMeet HTTPS'
ufw allow 50000:50100/udp comment 'SlowMeet WebRTC media'
if [[ "$enable_turn" == yes ]]; then
    ufw allow 3478/udp comment 'SlowMeet TURN UDP'
    ufw allow 3478/tcp comment 'SlowMeet TURN TCP'
    ufw allow 5349/tcp comment 'SlowMeet TURN TLS'
    ufw allow 49152:49251/udp comment 'SlowMeet TURN relay'
fi
ufw --force enable

if [[ "$proxy_mode" == caddy ]]; then
    install -d -o root -g caddy -m 0755 /var/www/letsencrypt
    activate_caddy_site bootstrap
else
    write_nginx_acme_site
fi

if [[ "$caddy_tls_mode" != xray || "$proxy_mode" == nginx ]]; then
    log 'Requesting the HTTPS certificate.'
    certbot certonly --webroot --webroot-path /var/www/letsencrypt --non-interactive --agree-tos \
        --register-unsafely-without-email --keep-until-expiring -d "$domain"
else
    log 'Using the existing Xray TLS certificate; certificate renewal remains managed by Xray.'
fi

if [[ "$proxy_mode" == caddy && "$caddy_tls_mode" == direct ]]; then
    install -d -o root -g caddy -m 0750 "$CERT_DIR"
    install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$domain/fullchain.pem" "$CERT_DIR/fullchain.pem"
    install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$domain/privkey.pem" "$CERT_DIR/privkey.pem"
else
    install -d -o root -g root -m 0750 "$CERT_DIR"
    install -o root -g root -m 0640 "/etc/letsencrypt/live/$domain/fullchain.pem" "$CERT_DIR/fullchain.pem"
    install -o root -g root -m 0640 "/etc/letsencrypt/live/$domain/privkey.pem" "$CERT_DIR/privkey.pem"
fi

if [[ "$proxy_mode" == caddy ]]; then
    activate_caddy_site final
else
    activate_nginx_site
fi

if [[ -e "$ENV_FILE" ]]; then
    [[ "$install_mode" == fresh-resume && -f "$ENV_FILE" ]] \
        || fail "$ENV_FILE appeared during installation; refusing to overwrite it."
    log 'Preserving the environment and credentials created by the interrupted installation.'
else
    install -m 0600 "$INSTALL_DIR/.env.example" "$ENV_FILE"
fi

admin_password=$(read_env_value ADMIN_PASSWORD)
if [[ -z "$admin_password" ]]; then
    prompt_admin_password
fi
set_admin_password "$admin_password"
set_env MEETING_PASSWORD "$meeting_password"
set_env HTTP_PUBLISH_ADDRESS 127.0.0.1
set_env HTTP_PUBLISH_PORT "$app_port"
set_env ICE_PUBLIC_IP "$public_ipv4"
if [[ "$enable_turn" == yes ]]; then
    set_env TURN_URLS "turn:$domain:3478?transport=udp,turn:$domain:3478?transport=tcp,turns:$domain:5349?transport=tcp"
    set_env TURN_SHARED_SECRET "$turn_secret"
    set_env TURN_CONFIG_FILE "$INSTALL_DIR/deploy/coturn/turnserver.conf"
    set_env TURN_CERT_DIR "$CERT_DIR"
    cat > "$INSTALL_DIR/deploy/coturn/turnserver.conf" <<EOF
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=$turn_secret
realm=$domain
cert=/etc/letsencrypt/fullchain.pem
pkey=/etc/letsencrypt/privkey.pem
min-port=49152
max-port=49251
EOF
    if [[ -n "$private_ipv4" && "$private_ipv4" != "$public_ipv4" ]]; then
        printf 'external-ip=%s/%s\n' "$public_ipv4" "$private_ipv4" >> "$INSTALL_DIR/deploy/coturn/turnserver.conf"
    fi
    touch "$INSTALL_DIR/.turn-enabled"
fi
chmod 0600 "$ENV_FILE"

install -d -o root -g root -m 0750 /etc/slowmeet
printf '%s\n' "$proxy_mode" > "$PROXY_MODE_FILE"
chmod 0644 "$PROXY_MODE_FILE"
printf '%s\n' "$container_engine" > "$CONTAINER_ENGINE_FILE"
chmod 0644 "$CONTAINER_ENGINE_FILE"

write_podman_service

cat > "$CERT_HOOK" <<'HOOK'
#!/usr/bin/env bash
set -Eeuo pipefail
proxy_mode=$(cat /etc/slowmeet/proxy-mode)
container_engine=$(cat /etc/slowmeet/container-engine)
if [[ "$proxy_mode" == caddy ]]; then
    install -d -o root -g caddy -m 0750 /etc/slowmeet/certs
    install -o root -g caddy -m 0640 "$RENEWED_LINEAGE/fullchain.pem" /etc/slowmeet/certs/fullchain.pem
    install -o root -g caddy -m 0640 "$RENEWED_LINEAGE/privkey.pem" /etc/slowmeet/certs/privkey.pem
else
    install -d -o root -g root -m 0750 /etc/slowmeet/certs
    install -o root -g root -m 0640 "$RENEWED_LINEAGE/fullchain.pem" /etc/slowmeet/certs/fullchain.pem
    install -o root -g root -m 0640 "$RENEWED_LINEAGE/privkey.pem" /etc/slowmeet/certs/privkey.pem
fi
systemctl reload "$proxy_mode"
if [[ -f /opt/slowmeet/.turn-enabled ]]; then
    cd /opt/slowmeet
    case "$container_engine" in
        docker) docker compose -f docker-compose.yml --profile turn restart coturn ;;
        podman) podman-compose -f podman-compose.yml --profile turn restart coturn ;;
        *) printf '[slowmeet] ERROR: Unknown saved container engine.\n' >&2; exit 1 ;;
    esac
fi
HOOK
chmod 0750 "$CERT_HOOK"

systemctl enable --now certbot.timer
systemctl enable --now "$proxy_mode"
if [[ "$proxy_mode" == caddy ]]; then
    caddy validate --config /etc/caddy/Caddyfile
else
    nginx -t
fi
systemctl reload "$proxy_mode"
cd "$INSTALL_DIR"
if [[ "$enable_turn" == yes ]]; then
    compose --profile turn up -d --build
else
    compose up -d --build
fi
if [[ "$container_engine" == podman ]]; then
    systemctl enable --now slowmeet-podman.service
fi

if [[ "$caddy_tls_mode" == xray ]] && ! configure_xray_fallback; then
    mark_https_unavailable "$https_reason"
    activate_caddy_site final
fi

log 'Waiting for SlowMeet to become healthy.'
healthy=no
for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 "http://127.0.0.1:$app_port/ready" >/dev/null; then
        healthy=yes
        break
    fi
    sleep 2
done
[[ "$healthy" == yes ]] || {
    compose ps
    fail 'SlowMeet did not become ready. Review the container logs with the selected Compose command.'
}
if [[ "$caddy_tls_mode" != http-only ]]; then
    curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null \
        || fail 'The local HTTPS health check failed.'
fi

if [[ "$caddy_tls_mode" == http-only ]]; then
    printf '\nSlowMeet is installed and its local app health check passed.\nAdmin password: %s\n' "$admin_password"
else
    printf '\nSlowMeet is ready at https://%s/\nAdmin: https://%s/admin\nAdmin password: %s\n' \
        "$domain" "$domain" "$admin_password"
fi
if [[ "$enable_meeting_password" == yes ]]; then
    printf 'Meeting password: %s\n' "$meeting_password"
fi
if [[ "$enable_turn" == yes ]]; then
    printf 'TURN URLs: turn:%s:3478 (UDP/TCP), turns:%s:5349 (TLS/TCP)\n' "$domain" "$domain"
fi
printf '\nKeep these credentials somewhere safe.\n'
if [[ "$proxy_mode" == caddy ]]; then
    log "Caddy installation method: $caddy_install_method."
fi
write_install_state complete
print_https_warning
