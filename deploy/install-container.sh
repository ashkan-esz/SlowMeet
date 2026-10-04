#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALL_DIR=/opt/slowmeet-container
readonly ENV_FILE="$INSTALL_DIR/.env"
readonly STATE_DIR=/var/lib/slowmeet-container-installer
readonly STATE_FILE="$STATE_DIR/state"
readonly CONTAINER_NAME=slowmeet-container
readonly VOLUME_NAME=slowmeet-container-data
readonly IMAGE_NAME=ghcr.io/ashkan-esz/slowmeet

log() { printf '[slowmeet-container] %s\n' "$*"; }
fail() { printf '[slowmeet-container] ERROR: %s\n' "$*" >&2; exit 1; }

report_unexpected_error() {
    local status=$? line=${BASH_LINENO[0]:-unknown}
    printf '[slowmeet-container] ERROR: command failed near line %s (exit %s).\n' "$line" "$status" >&2
    exit "$status"
}
trap report_unexpected_error ERR

prompt() {
    local label=$1 default=${2:-} answer
    if [[ -n "$default" ]]; then
        read -r -p "$label [$default]: " answer <&3
        printf '%s' "${answer:-$default}"
    else
        read -r -p "$label: " answer <&3
        printf '%s' "$answer"
    fi
}

yes_no() {
    local label=$1 default=${2:-no} answer
    while true; do
        read -r -p "$label [$([[ "$default" == yes ]] && printf Y/n || printf y/N)]: " answer <&3
        answer=${answer,,}
        case "$answer" in
            y|yes) return 0 ;;
            n|no) return 1 ;;
            '') [[ "$default" == yes ]] && return 0 || return 1 ;;
            *) printf 'Please answer yes or no.\n' >&2 ;;
        esac
    done
}

read_state_value() {
    local key=$1
    [[ -f "$STATE_FILE" ]] || return 0
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$STATE_FILE"
}

write_state() {
    local status=$1 operation=$2 engine=$3 image=$4 temp
    install -d -m 0700 "$STATE_DIR"
    temp=$(mktemp "$STATE_DIR/.state.XXXXXX")
    {
        printf 'status=%s\n' "$status"
        printf 'operation=%s\n' "$operation"
        printf 'engine=%s\n' "$engine"
        printf 'image=%s\n' "$image"
    } > "$temp"
    chmod 0600 "$temp"
    mv -f "$temp" "$STATE_FILE"
}

read_env_value() {
    local key=$1
    [[ -f "$ENV_FILE" ]] || return 0
    awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

require_supported_host() {
    [[ $EUID -eq 0 ]] || fail 'Run this script as root.'
    [[ -r /dev/tty ]] || fail 'An interactive terminal is required.'
    [[ -r /etc/os-release ]] || fail 'Cannot identify this operating system.'
    # shellcheck disable=SC1091
    source /etc/os-release
    case "${ID:-}" in
        ubuntu|debian) ;;
        *) fail "Supported systems are Ubuntu and Debian; found ${PRETTY_NAME:-unknown}." ;;
    esac
    command -v apt-get >/dev/null || fail 'This operating system does not provide apt-get.'
}

install_engine_if_missing() {
    case "$engine" in
        docker)
            if ! command -v docker >/dev/null; then
                log 'Installing Docker from the operating system package repository.'
                apt-get update
                DEBIAN_FRONTEND=noninteractive apt-get install -y docker.io
            fi
            systemctl enable --now docker
            ;;
        podman)
            if ! command -v podman >/dev/null; then
                log 'Installing Podman from the operating system package repository.'
                apt-get update
                DEBIAN_FRONTEND=noninteractive apt-get install -y podman
            fi
            if systemctl list-unit-files podman-restart.service --no-legend 2>/dev/null | grep -q podman-restart; then
                systemctl enable --now podman-restart.service
            else
                fail 'This Podman package does not provide podman-restart.service, which is needed to start the container after reboot.'
            fi
            ;;
        *) fail "Unsupported container engine: $engine" ;;
    esac
}

choose_engine() {
    local answer
    while true; do
        read -r -p 'Container engine [docker/podman] (docker): ' answer <&3
        answer=${answer,,}
        answer=${answer:-docker}
        case "$answer" in
            docker|podman) engine=$answer; return ;;
            *) printf 'Choose docker or podman.\n' >&2 ;;
        esac
    done
}

choose_bind_address() {
    local answer
    while true; do
        read -r -p 'HTTP access [loopback/public] (loopback): ' answer <&3
        answer=${answer,,}
        case "${answer:-loopback}" in
            loopback) http_publish_address=127.0.0.1; return ;;
            public) http_publish_address=0.0.0.0; return ;;
            *) printf 'Choose loopback or public.\n' >&2 ;;
        esac
    done
}

image_for_tag() {
    local tag=$1
    [[ "$tag" =~ ^(latest|[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?)$ ]] \
        || fail 'Image tag must be latest or a published version such as 1.2.3.'
    [[ "$engine" != podman ]] || tag+="-podman"
    printf '%s:%s' "$IMAGE_NAME" "$tag"
}

choose_image() {
    local current_tag=${1:-latest} answer
    if [[ "$current_tag" == "$IMAGE_NAME:"* ]]; then
        current_tag=${current_tag#*:}
        [[ "$engine" != podman ]] || current_tag=${current_tag%-podman}
    fi
    answer=$(prompt 'Published image tag (latest or a release such as 1.2.3)' "${current_tag:-latest}")
    image=$(image_for_tag "$answer")
}

create_env_file() {
    local admin_password confirm_admin_password meeting_password ice_public_ip stun_servers turn_urls turn_username turn_password
    local http_publish_port
    http_publish_port=$(prompt 'HTTP host port' '8080')
    [[ "$http_publish_port" =~ ^[0-9]{1,5}$ ]] && (( http_publish_port >= 1 && http_publish_port <= 65535 )) \
        || fail 'HTTP host port must be between 1 and 65535.'

    IFS= read -r -s -p 'Admin password: ' admin_password <&3
    printf '\n' >&2
    [[ -n "$admin_password" ]] || fail 'Admin password cannot be empty.'
    IFS= read -r -s -p 'Confirm admin password: ' confirm_admin_password <&3
    printf '\n' >&2
    [[ "$admin_password" == "$confirm_admin_password" ]] || fail 'Admin password confirmation did not match.'

    meeting_password=$(prompt 'Meeting password (blank disables it)' '')
    ice_public_ip=$(prompt 'ICE public IP (blank for automatic discovery)' '')
    stun_servers=$(prompt 'STUN servers (comma-separated, optional)' '')
    turn_urls=$(prompt 'TURN URLs (comma-separated, optional)' '')
    turn_username=$(prompt 'TURN username (optional)' '')
    turn_password=$(prompt 'TURN password (optional)' '')

    install -d -m 0750 "$INSTALL_DIR"
    cat > "$ENV_FILE" <<EOF
APP_ENV=production
HTTP_ADDR=:8080
CONFIG_FILE=data/config.json
HTTP_PUBLISH_ADDRESS=$http_publish_address
HTTP_PUBLISH_PORT=$http_publish_port
ADMIN_PASSWORD=$admin_password
MEETING_PASSWORD=$meeting_password
ICE_UDP_PORT_MIN=50000
ICE_UDP_PORT_MAX=50100
ICE_PUBLIC_IP=$ice_public_ip
STUN_SERVERS=$stun_servers
TURN_URLS=$turn_urls
TURN_USERNAME=$turn_username
TURN_PASSWORD=$turn_password
EOF
    chmod 0600 "$ENV_FILE"
}

start_container() {
    local image_value address port udp_min udp_max restart_policy
    image_value=$(read_state_value image)
    address=$(read_env_value HTTP_PUBLISH_ADDRESS)
    port=$(read_env_value HTTP_PUBLISH_PORT)
    udp_min=$(read_env_value ICE_UDP_PORT_MIN)
    udp_max=$(read_env_value ICE_UDP_PORT_MAX)
    [[ -n "$image_value" && -n "$address" && -n "$port" ]] || fail 'Saved image or app settings are incomplete.'
    restart_policy=unless-stopped
    [[ "$engine" != podman ]] || restart_policy=always

    "$engine" pull "$image_value"
    "$engine" rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
    "$engine" volume create "$VOLUME_NAME" >/dev/null
    "$engine" run --detach \
        --name "$CONTAINER_NAME" \
        --restart "$restart_policy" \
        --init \
        --read-only \
        --tmpfs /tmp:size=16m,noexec,nosuid,nodev \
        --cap-drop ALL \
        --security-opt no-new-privileges:true \
        --env-file "$ENV_FILE" \
        --publish "$address:$port:8080" \
        --publish "$udp_min-$udp_max:$udp_min-$udp_max/udp" \
        --volume "$VOLUME_NAME:/app/data" \
        "$image_value" >/dev/null
}

wait_for_http() {
    local health attempt
    for attempt in {1..20}; do
        health=$("$engine" inspect --format '{{.State.Health.Status}}' "$CONTAINER_NAME" 2>/dev/null || true)
        [[ "$health" == healthy ]] && return 0
        [[ "$health" == unhealthy ]] && break
        sleep 1
    done
    log "Container health check did not pass; inspect with '$engine logs $CONTAINER_NAME'."
    return 1
}

install_or_update() {
    install_engine_if_missing
    write_state incomplete "$operation" "$engine" "$image"
    start_container
    wait_for_http
    write_state complete "$operation" "$engine" "$image"
    log "SlowMeet is running with $image at http://$(read_env_value HTTP_PUBLISH_ADDRESS):$(read_env_value HTTP_PUBLISH_PORT)/."
    log 'The host and cloud firewalls are unchanged; allow the configured HTTP port and UDP ports 50000-50100 as needed.'
    log 'This installer does not configure a reverse proxy or TLS. Configure those separately for public browser use.'
}

uninstall_installation() {
    local confirmation
    command -v "$engine" >/dev/null || fail "The saved container runtime '$engine' is required to uninstall this installation."
    read -r -p "Type uninstall to remove the SlowMeet container and its configuration: " confirmation <&3
    [[ "$confirmation" == uninstall ]] || { log 'Uninstall cancelled.'; return 0; }
    "$engine" rm --force "$CONTAINER_NAME" >/dev/null 2>&1 || true
    if yes_no 'Permanently delete the SlowMeet data volume?' no; then
        if "$engine" volume inspect "$VOLUME_NAME" >/dev/null 2>&1; then
            "$engine" volume rm "$VOLUME_NAME" >/dev/null
        fi
    fi
    rm -rf -- "$INSTALL_DIR" "$STATE_DIR"
    log 'SlowMeet container and installer files were removed.'
    log "The $VOLUME_NAME volume was retained unless you explicitly chose to delete it."
}

main() {
    local status saved_engine saved_operation saved_image action current_tag
    exec 3</dev/tty
    require_supported_host

    if [[ ! -e "$STATE_FILE" ]]; then
        [[ ! -e "$INSTALL_DIR" ]] || fail "$INSTALL_DIR already exists without installer state; refusing to overwrite it."
        operation=install
        choose_engine
        choose_bind_address
        choose_image latest
        create_env_file
        write_state incomplete install "$engine" "$image"
        install_or_update
        return
    fi

    status=$(read_state_value status)
    saved_operation=$(read_state_value operation)
    saved_engine=$(read_state_value engine)
    saved_image=$(read_state_value image)
    [[ "$status" == complete || "$status" == incomplete ]] || fail 'Installer state is invalid.'
    [[ "$saved_engine" == docker || "$saved_engine" == podman ]] || fail 'Installer state has an invalid container engine.'
    [[ -f "$ENV_FILE" ]] || fail 'Installer state exists but the environment file is missing.'
    engine=$saved_engine

    if [[ "$status" == incomplete ]]; then
        printf 'An incomplete %s was found.\n' "${saved_operation:-install}"
        action=$(prompt 'Choose resume, uninstall, or cancel' 'resume')
        case "${action,,}" in
            resume) operation=${saved_operation:-install}; image=$saved_image ;;
            uninstall) uninstall_installation; return ;;
            *) log 'No changes made.'; return ;;
        esac
    else
        printf 'A SlowMeet image installation was found.\n'
        action=$(prompt 'Choose update, uninstall, or cancel' 'update')
        case "${action,,}" in
            update)
                operation=update
                current_tag=$saved_image
                choose_image "$current_tag"
                write_state incomplete update "$engine" "$image"
                ;;
            uninstall) uninstall_installation; return ;;
            *) log 'No changes made.'; return ;;
        esac
    fi
    install_or_update
}

main "$@"
