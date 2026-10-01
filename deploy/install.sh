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
readonly PODMAN_SERVICE_FILE=/etc/systemd/system/slowmeet-podman.service

log() { printf '[slowmeet] %s\n' "$*"; }
fail() { printf '[slowmeet] ERROR: %s\n' "$*" >&2; exit 1; }

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
        printf 'version=4\n'
        printf 'status=%s\n' "$status"
        printf 'operation=%s\n' "$install_operation"
        printf 'domain=%s\n' "$domain"
        printf 'enable_turn=%s\n' "$enable_turn"
        printf 'enable_meeting_password=%s\n' "$enable_meeting_password"
        printf 'proxy_mode=%s\n' "$proxy_mode"
        printf 'app_port=%s\n' "$app_port"
        printf 'container_engine=%s\n' "$container_engine"
    } > "$temp"
    chmod 0600 "$temp"
    mv -f "$temp" "$STATE_FILE"
}

read_install_state() {
    local key value
    local seen_version= seen_status= seen_operation= seen_domain= seen_turn= seen_meeting_password= seen_proxy_mode= seen_app_port= seen_container_engine=
    state_version=
    state_status=
    install_operation=
    domain=
    enable_turn=
    enable_meeting_password=
    proxy_mode=
    app_port=
    container_engine=
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
            app_port) [[ -z "$seen_app_port" ]] || fail 'Installer state contains a duplicate app port.'; seen_app_port=yes; app_port=$value ;;
            container_engine) [[ -z "$seen_container_engine" ]] || fail 'Installer state contains a duplicate container engine.'; seen_container_engine=yes; container_engine=$value ;;
            *) fail "Installer state contains an unsupported field: $key" ;;
        esac
    done < "$STATE_FILE"
    [[ "$seen_version" == yes && ( "$state_version" == 1 || "$state_version" == 2 || "$state_version" == 3 || "$state_version" == 4 ) ]] || fail 'Installer state has a missing or unsupported version.'
    [[ "$seen_status" == yes && ( "$state_status" == incomplete || "$state_status" == complete ) ]] || fail 'Installer state has a missing or invalid status.'
    if [[ "$state_version" == 1 ]]; then
        [[ -z "$seen_operation" ]] || fail 'Version 1 installer state cannot contain an operation.'
        install_operation=install
    else
        [[ "$seen_operation" == yes && ( "$install_operation" == install || "$install_operation" == update ) ]] \
            || fail 'Installer state has a missing or invalid operation.'
    fi
    if [[ "$state_version" == 3 || "$state_version" == 4 ]]; then
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
    if [[ "$state_version" == 4 ]]; then
        [[ "$seen_container_engine" == yes && ( "$container_engine" == docker || "$container_engine" == podman ) ]] \
            || fail 'Installer state has a missing or invalid container engine.'
    else
        [[ -z "$seen_container_engine" ]] || fail 'Legacy installer state cannot contain a container engine.'
        container_engine=docker
    fi
    [[ "$seen_domain" == yes && "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail 'Installer state has a missing or invalid domain.'
    [[ "$seen_turn" == yes && ( "$enable_turn" == yes || "$enable_turn" == no ) ]] || fail 'Installer state has a missing or invalid TURN setting.'
    [[ "$seen_meeting_password" == yes && ( "$enable_meeting_password" == yes || "$enable_meeting_password" == no ) ]] || fail 'Installer state has a missing or invalid meeting-password setting.'
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
    curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null \
        || fail 'The local HTTPS health check failed.'
}

update_existing_install() {
    local existing_ice admin_password meeting_password turn_urls

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
    git -C "$INSTALL_DIR" diff --quiet && git -C "$INSTALL_DIR" diff --cached --quiet \
        || fail "$INSTALL_DIR has local tracked changes. Save or revert them before updating."

    existing_ice=$(read_env_value ICE_PUBLIC_IP)
if [[ -z "$public_ipv4" && -z "$existing_ice" ]]; then
        fail 'Could not discover this VPS public IPv4 address, and ICE_PUBLIC_IP is not configured.'
    fi

    write_install_state incomplete
    log "Updating the existing SlowMeet checkout behind $proxy_mode; preserving its environment, app port, certificates, data volume, and TURN configuration."
    enable_container_engine
    systemctl enable --now "$proxy_mode"
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
    wait_for_updated_service

    admin_password=$(read_env_value ADMIN_PASSWORD)
    meeting_password=$(read_env_value MEETING_PASSWORD)
    turn_urls=$(read_env_value TURN_URLS)
    printf '\nSlowMeet is updated and ready at https://%s/\nAdmin: https://%s/admin\n' "$domain" "$domain"
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
    write_install_state complete
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
    local config_dump
    assert_nginx_domain_available
    install -d -o root -g root -m 0755 /var/www/letsencrypt
    cat > "$NGINX_SITE" <<EOF
# Managed by SlowMeet installer
server {
    listen 80;
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
    cat > "$NGINX_SITE" <<EOF
# Managed by SlowMeet installer
map \$http_upgrade \$slowmeet_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
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
    chmod 0644 "$NGINX_SITE"
    nginx -t
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
apt-get install -y ca-certificates curl git gnupg iproute2 openssl certbot ufw
private_ipv4=$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}' || true)

if [[ "$container_engine" == docker ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
        "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" \
        > /etc/apt/sources.list.d/docker.list
fi

if [[ "$proxy_mode" == caddy ]]; then
    install -m 0755 -d /usr/share/keyrings
    curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
        | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    caddy_repo_id=debian
    [[ "$ID" == ubuntu ]] && caddy_repo_id=ubuntu
    curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/$caddy_repo_id.deb.txt" \
        -o /etc/apt/sources.list.d/caddy-stable.list
fi

apt-get update
runtime_packages=()
case "$container_engine" in
    docker) runtime_packages=(docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin) ;;
    podman) runtime_packages=(podman podman-compose) ;;
esac
if [[ "$proxy_mode" == caddy ]]; then
    runtime_packages+=(caddy)
fi
apt-get install -y "${runtime_packages[@]}"
enable_container_engine
if [[ "$proxy_mode" == caddy ]]; then
    systemctl stop caddy || true
fi

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
    cat > /etc/caddy/Caddyfile <<EOF
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
    caddy validate --config /etc/caddy/Caddyfile
    systemctl enable --now caddy
else
    write_nginx_acme_site
fi

log 'Requesting the HTTPS certificate.'
certbot certonly --webroot --webroot-path /var/www/letsencrypt --non-interactive --agree-tos \
    --register-unsafely-without-email --keep-until-expiring -d "$domain"

if [[ "$proxy_mode" == caddy ]]; then
    install -d -o root -g caddy -m 0750 "$CERT_DIR"
    install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$domain/fullchain.pem" "$CERT_DIR/fullchain.pem"
    install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$domain/privkey.pem" "$CERT_DIR/privkey.pem"
else
    install -d -o root -g root -m 0750 "$CERT_DIR"
    install -o root -g root -m 0640 "/etc/letsencrypt/live/$domain/fullchain.pem" "$CERT_DIR/fullchain.pem"
    install -o root -g root -m 0640 "/etc/letsencrypt/live/$domain/privkey.pem" "$CERT_DIR/privkey.pem"
fi

if [[ "$proxy_mode" == caddy ]]; then
    cat > /etc/caddy/Caddyfile <<EOF
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
else
    write_nginx_site
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
curl -fsS --max-time 10 --resolve "$domain:443:127.0.0.1" "https://$domain/health" >/dev/null \
    || fail 'The local HTTPS health check failed.'

printf '\nSlowMeet is ready at https://%s/\nAdmin: https://%s/admin\nAdmin password: %s\n' \
    "$domain" "$domain" "$admin_password"
if [[ "$enable_meeting_password" == yes ]]; then
    printf 'Meeting password: %s\n' "$meeting_password"
fi
if [[ "$enable_turn" == yes ]]; then
    printf 'TURN URLs: turn:%s:3478 (UDP/TCP), turns:%s:5349 (TLS/TCP)\n' "$domain" "$domain"
fi
printf '\nKeep these credentials somewhere safe.\n'
write_install_state complete
