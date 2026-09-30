#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALL_DIR=/opt/slowmeet
readonly ENV_FILE="$INSTALL_DIR/.env"
readonly STATE_DIR=/var/lib/slowmeet-installer
readonly STATE_FILE="$STATE_DIR/state"
readonly CERT_DIR=/etc/slowmeet/certs
readonly CERT_HOOK=/etc/letsencrypt/renewal-hooks/deploy/slowmeet
readonly REPOSITORY=https://github.com/ashkan-esz/SlowMeet.git

log() { printf '[slowmeet] %s\n' "$*"; }
fail() { printf '[slowmeet] ERROR: %s\n' "$*" >&2; exit 1; }

write_install_state() {
    local status=$1 temp
    install -d -o root -g root -m 0700 "$STATE_DIR"
    temp=$(mktemp "$STATE_DIR/.state.XXXXXX")
    {
        printf 'version=1\n'
        printf 'status=%s\n' "$status"
        printf 'domain=%s\n' "$domain"
        printf 'enable_turn=%s\n' "$enable_turn"
        printf 'enable_meeting_password=%s\n' "$enable_meeting_password"
    } > "$temp"
    chmod 0600 "$temp"
    mv -f "$temp" "$STATE_FILE"
}

read_install_state() {
    local key value
    local seen_version= seen_status= seen_domain= seen_turn= seen_meeting_password=
    state_version=
    state_status=
    domain=
    enable_turn=
    enable_meeting_password=
    [[ -f "$STATE_FILE" && ! -L "$STATE_FILE" ]] || fail "Installer state at $STATE_FILE is not a regular file."
    while IFS='=' read -r key value; do
        case "$key" in
            version) [[ -z "$seen_version" ]] || fail 'Installer state contains a duplicate version.'; seen_version=yes; state_version=$value ;;
            status) [[ -z "$seen_status" ]] || fail 'Installer state contains a duplicate status.'; seen_status=yes; state_status=$value ;;
            domain) [[ -z "$seen_domain" ]] || fail 'Installer state contains a duplicate domain.'; seen_domain=yes; domain=$value ;;
            enable_turn) [[ -z "$seen_turn" ]] || fail 'Installer state contains a duplicate TURN setting.'; seen_turn=yes; enable_turn=$value ;;
            enable_meeting_password) [[ -z "$seen_meeting_password" ]] || fail 'Installer state contains a duplicate meeting-password setting.'; seen_meeting_password=yes; enable_meeting_password=$value ;;
            *) fail "Installer state contains an unsupported field: $key" ;;
        esac
    done < "$STATE_FILE"
    [[ "$seen_version" == yes && "$state_version" == 1 ]] || fail 'Installer state has a missing or unsupported version.'
    [[ "$seen_status" == yes && ( "$state_status" == incomplete || "$state_status" == complete ) ]] || fail 'Installer state has a missing or invalid status.'
    [[ "$seen_domain" == yes && "$domain" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || fail 'Installer state has a missing or invalid domain.'
    [[ "$seen_turn" == yes && ( "$enable_turn" == yes || "$enable_turn" == no ) ]] || fail 'Installer state has a missing or invalid TURN setting.'
    [[ "$seen_meeting_password" == yes && ( "$enable_meeting_password" == yes || "$enable_meeting_password" == no ) ]] || fail 'Installer state has a missing or invalid meeting-password setting.'
}

read_env_value() {
    local key=$1
    [[ -f "$ENV_FILE" ]] || return 0
    awk -v key="$key" 'index($0, key "=") == 1 { value=substr($0, length(key) + 2); found=1 } END { if (found) print value }' "$ENV_FILE"
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

[[ -r /etc/os-release ]] || fail 'Could not identify this operating system.'
# shellcheck disable=SC1091
source /etc/os-release
case "${ID:-}" in
    ubuntu|debian) ;;
    *) fail "Supported systems are Ubuntu and Debian; found ${PRETTY_NAME:-unknown}." ;;
esac
command -v apt-get >/dev/null || fail 'This operating system does not provide apt-get.'

resume_install=no
if [[ -e "$STATE_FILE" || -L "$STATE_FILE" ]]; then
    read_install_state
    [[ "$state_status" == incomplete ]] || fail 'SlowMeet is already installed by this installer; refusing to run a fresh installation over it.'
    resume_install=yes
    log "Resuming the incomplete installation for $domain with its saved options."
elif [[ -e "$ENV_FILE" ]]; then
    fail "$ENV_FILE already exists without matching installer state. This command is for a fresh install; it will not overwrite an existing configuration."
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
fi

public_ipv4=$(curl -4fsS --max-time 15 https://api.ipify.org) || fail 'Could not discover this VPS public IPv4 address.'
resolved_ipv4=$(getent ahostsv4 "$domain" | awk '{print $1}' | sort -u || true)
[[ -n "$resolved_ipv4" ]] || fail "$domain has no IPv4 DNS record yet. Point its A record to $public_ipv4, wait for DNS, then rerun."
if [[ "$resolved_ipv4" != "$public_ipv4" ]]; then
    fail "$domain resolves to $(tr '\n' ' ' <<<"$resolved_ipv4"), not this VPS IPv4 ($public_ipv4). Fix DNS and rerun."
fi
resolved_ipv6=$(getent ahostsv6 "$domain" | awk '{print $1}' | sort -u || true)
if [[ -n "$resolved_ipv6" ]]; then
    public_ipv6=$(curl -6fsS --max-time 15 https://api64.ipify.org || true)
    if [[ -z "$public_ipv6" ]] || [[ "$resolved_ipv6" != "$public_ipv6" ]]; then
        fail "$domain also has an AAAA record that does not match this VPS IPv6 address. Remove it or point it to this VPS, then rerun."
    fi
fi

if [[ "$resume_install" == no ]]; then
    write_install_state incomplete
fi

log "Installing prerequisites on ${PRETTY_NAME:-$ID}."
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git gnupg iproute2 openssl certbot ufw
private_ipv4=$(ip -4 route get 1.1.1.1 | awk '{for (i=1; i<=NF; i++) if ($i == "src") {print $(i+1); exit}}' || true)

install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
    "$(dpkg --print-architecture)" "$ID" "$VERSION_CODENAME" \
    > /etc/apt/sources.list.d/docker.list

install -m 0755 -d /usr/share/keyrings
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
caddy_repo_id=debian
[[ "$ID" == ubuntu ]] && caddy_repo_id=ubuntu
curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/$caddy_repo_id.deb.txt" \
    -o /etc/apt/sources.list.d/caddy-stable.list

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
systemctl enable --now docker
systemctl stop caddy || true

admin_password=$(read_env_value ADMIN_PASSWORD)
if [[ -z "$admin_password" ]]; then
    admin_password=$(openssl rand -hex 24 2>/dev/null || true)
fi
[[ "$admin_password" =~ ^[a-f0-9]{48}$ ]] || fail 'Could not generate a secure admin password.'
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

log 'Requesting the HTTPS certificate.'
certbot certonly --webroot --webroot-path /var/www/letsencrypt --non-interactive --agree-tos \
    --register-unsafely-without-email --keep-until-expiring -d "$domain"

install -d -o root -g caddy -m 0750 "$CERT_DIR"
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$domain/fullchain.pem" "$CERT_DIR/fullchain.pem"
install -o root -g caddy -m 0640 "/etc/letsencrypt/live/$domain/privkey.pem" "$CERT_DIR/privkey.pem"

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
            reverse_proxy 127.0.0.1:8080 {
                transport http {
                    keepalive 2m
                }
            }
        }
    }
}
EOF

if [[ -e "$ENV_FILE" ]]; then
    [[ "$resume_install" == yes && -f "$ENV_FILE" ]] || fail "$ENV_FILE appeared during installation; refusing to overwrite it."
    log 'Preserving the existing SlowMeet environment configuration and credentials.'
else
    install -m 0600 "$INSTALL_DIR/.env.example" "$ENV_FILE"
fi

set_env() {
    local key=$1 value=$2 temp
    temp=$(mktemp)
    awk -v key="$key" -v value="$value" '
        BEGIN { found=0 }
        index($0, key "=") == 1 { print key "=" value; found=1; next }
        { print }
        END { if (!found) print key "=" value }
    ' "$ENV_FILE" > "$temp"
    install -m 0600 "$temp" "$ENV_FILE"
    rm -f "$temp"
}

set_env ADMIN_PASSWORD "$admin_password"
set_env MEETING_PASSWORD "$meeting_password"
set_env HTTP_PUBLISH_ADDRESS 127.0.0.1
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

cat > "$CERT_HOOK" <<'HOOK'
#!/usr/bin/env bash
set -Eeuo pipefail
install -d -o root -g caddy -m 0750 /etc/slowmeet/certs
install -o root -g caddy -m 0640 "$RENEWED_LINEAGE/fullchain.pem" /etc/slowmeet/certs/fullchain.pem
install -o root -g caddy -m 0640 "$RENEWED_LINEAGE/privkey.pem" /etc/slowmeet/certs/privkey.pem
systemctl reload caddy
if [[ -f /opt/slowmeet/.turn-enabled ]]; then
    docker compose --project-directory /opt/slowmeet -f /opt/slowmeet/docker-compose.yml --profile turn restart coturn
fi
HOOK
chmod 0750 "$CERT_HOOK"

systemctl enable --now certbot.timer
systemctl enable --now caddy
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
cd "$INSTALL_DIR"
if [[ "$enable_turn" == yes ]]; then
    docker compose --profile turn up -d --build
else
    docker compose up -d --build
fi

log 'Waiting for SlowMeet to become healthy.'
healthy=no
for _ in $(seq 1 60); do
    if curl -fsS --max-time 2 http://127.0.0.1:8080/ready >/dev/null; then
        healthy=yes
        break
    fi
    sleep 2
done
[[ "$healthy" == yes ]] || {
    docker compose ps
    fail 'SlowMeet did not become ready. Review: docker compose logs --tail=100'
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
