#!/usr/bin/env bash
set -Eeuo pipefail

readonly INSTALLER=deploy/install.sh
TEST_DIR=$(mktemp -d)
readonly TEST_DIR
REAL_DPKG=$(command -v dpkg)
readonly REAL_DPKG
ORIGINAL_VERSION=1.7.28-3~test
readonly ORIGINAL_VERSION
export REAL_DPKG
trap 'rm -rf -- "$TEST_DIR"' EXIT

fail() {
    printf 'Docker LXC runtime fallback test failed: %s\n' "$*" >&2
    exit 1
}

mkdir -p "$TEST_DIR/bin"
export PATH="$TEST_DIR/bin:$PATH"
export CURRENT_VERSION_FILE="$TEST_DIR/installed-version"
export PACKAGE_HOLDS_FILE="$TEST_DIR/package-holds"
export COMMAND_LOG="$TEST_DIR/commands.log"
export DOCKER_COUNT_FILE="$TEST_DIR/docker-count"

cat > "$TEST_DIR/bin/docker" <<'DOCKER'
#!/usr/bin/env bash
[[ "$1" == run ]] || exit 90
count=0
[[ ! -f "$DOCKER_COUNT_FILE" ]] || count=$(<"$DOCKER_COUNT_FILE")
((count += 1))
printf '%s\n' "$count" > "$DOCKER_COUNT_FILE"
case "$DOCKER_SCENARIO:$count" in
    success:*|exact-then-success:2)
        printf '%s\n' 'Hello from Docker!'
        exit 0
        ;;
    exact:*|exact-then-success:1|exact-always:*)
        printf '%s\n' 'docker: Error response from daemon: failed to create task: OCI runtime create failed: runc create failed: unable to start container process: error during container init: open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied: unknown' >&2
        exit 125
        ;;
    unrelated:*)
        printf '%s\n' 'docker: failed to pull image: registry unavailable' >&2
        exit 125
        ;;
    *) exit 91 ;;
esac
DOCKER

cat > "$TEST_DIR/bin/apt-cache" <<'APTCACHE'
#!/usr/bin/env bash
[[ "$1" == madison && "$2" == containerd.io ]] || exit 90
case "$CANDIDATE_SET" in
    no-target)
        printf '%s\n' \
            'containerd.io | 1.7.27-1~test | test repo' \
            'containerd.io | 1.7.28-3~test | test repo'
        ;;
    only-1.2.7)
        printf '%s\n' \
            'containerd.io | 1.7.28-1~test | test repo' \
            'containerd.io | 1.7.28-3~test | test repo'
        ;;
    *)
        printf '%s\n' \
            'containerd.io | 1.7.28-1~test | test repo' \
            'containerd.io | 1.7.28-3~test | test repo' \
            'containerd.io | 1.7.28-2~test | test repo' \
            'containerd.io | 1.7.27-1~test | test repo'
        ;;
esac
APTCACHE

cat > "$TEST_DIR/bin/apt-get" <<'APTGET'
#!/usr/bin/env bash
printf 'apt-get:%s\n' "$*" >> "$COMMAND_LOG"
case "$1" in
    download)
        version=${2#containerd.io=}
        if [[ "$APT_SCENARIO" == package-unavailable && "$version" != "$ORIGINAL_VERSION" ]]; then
            exit 1
        fi
        : > "containerd.io_${version}_amd64.deb"
        ;;
    -s)
        version=${*: -1}
        version=${version#containerd.io=}
        printf 'Inst containerd.io [1.7.28-3~test] (%s test [amd64])\n' "$version"
        if [[ "$APT_SCENARIO" == simulation-incompatible ]]; then
            printf '%s\n' 'Inst docker-ce [5:28.5.2-1~ubuntu] (5:28.5.3-1~ubuntu test [amd64])'
        fi
        printf 'Conf containerd.io (%s test [amd64])\n' "$version"
        ;;
    install)
        version=${*: -1}
        version=${version#containerd.io=}
        if [[ "$APT_SCENARIO" == downgrade-fails && "$version" != "$ORIGINAL_VERSION" ]]; then
            exit 82
        fi
        printf '%s\n' "$version" > "$CURRENT_VERSION_FILE"
        ;;
    *) exit 90 ;;
esac
APTGET

cat > "$TEST_DIR/bin/dpkg" <<'DPKG'
#!/usr/bin/env bash
if [[ "$1" == --compare-versions ]]; then
    exec "$REAL_DPKG" "$@"
fi
if [[ "$1" == -i ]]; then
    package_file=$2
    version=${package_file##*/containerd.io_}
    version=${version%_amd64.deb}
    printf '%s\n' "$version" > "$CURRENT_VERSION_FILE"
    exit 0
fi
exit 90
DPKG

cat > "$TEST_DIR/bin/dpkg-query" <<'DPKGQUERY'
#!/usr/bin/env bash
[[ -f "$CURRENT_VERSION_FILE" ]] || exit 1
cat "$CURRENT_VERSION_FILE"
DPKGQUERY

cat > "$TEST_DIR/bin/dpkg-deb" <<'DPKGDEB'
#!/usr/bin/env bash
[[ "$1" == -x ]] || exit 90
package_file=$2
extract_dir=$3
version=${package_file##*/containerd.io_}
version=${version%_amd64.deb}
case "$version" in
    1.7.28-3~test) runc_version=1.3.3 ;;
    1.7.28-2~test) runc_version=1.3.2 ;;
    1.7.28-1~test) runc_version=1.2.7 ;;
    *) runc_version=1.2.6 ;;
esac
mkdir -p "$extract_dir/usr/bin"
cat > "$extract_dir/usr/bin/runc" <<EOF
#!/usr/bin/env bash
printf '%s\\n' 'runc version $runc_version'
EOF
chmod +x "$extract_dir/usr/bin/runc"
DPKGDEB

cat > "$TEST_DIR/bin/apt-mark" <<'APTMARK'
#!/usr/bin/env bash
case "$1" in
    showhold)
        [[ ! -f "$PACKAGE_HOLDS_FILE" ]] || cat "$PACKAGE_HOLDS_FILE"
        ;;
    hold)
        grep -Fxq "$2" "$PACKAGE_HOLDS_FILE" 2>/dev/null || printf '%s\n' "$2" >> "$PACKAGE_HOLDS_FILE"
        ;;
    unhold)
        if [[ -f "$PACKAGE_HOLDS_FILE" ]]; then
            awk -v package="$2" '$0 != package' "$PACKAGE_HOLDS_FILE" > "$PACKAGE_HOLDS_FILE.tmp"
            mv "$PACKAGE_HOLDS_FILE.tmp" "$PACKAGE_HOLDS_FILE"
        fi
        ;;
    *) exit 90 ;;
esac
APTMARK

chmod +x "$TEST_DIR/bin/"*

CONTAINERD_PACKAGE=containerd.io
DOCKER_RUNTIME_PROBE_IMAGE=hello-world:latest
# shellcheck disable=SC1090
source <(sed -n '/^docker_lxc_error_in_output() {/,/^enable_container_engine() {/p' "$INSTALLER" | sed '$d')
log() { printf '[test] %s\n' "$*" >&2; }

reset_case() {
    printf '%s\n' "$ORIGINAL_VERSION" > "$CURRENT_VERSION_FILE"
    printf '%s\n' unattended-upgrades > "$PACKAGE_HOLDS_FILE"
    : > "$COMMAND_LOG"
    : > "$DOCKER_COUNT_FILE"
    CANDIDATE_SET=all
    APT_SCENARIO=normal
    DOCKER_SCENARIO=success
    export CANDIDATE_SET APT_SCENARIO DOCKER_SCENARIO
}

assert_current_version() {
    local expected=$1 actual
    actual=$(<"$CURRENT_VERSION_FILE")
    [[ "$actual" == "$expected" ]] || fail "expected containerd.io $expected, found $actual"
}

error_log="$TEST_DIR/error.log"
printf '%s\n' 'open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: permission denied' > "$error_log"
docker_lxc_error_in_output "$error_log" || fail 'The exact LXC sysctl error was not recognized'
printf '%s\n' 'open sysctl net.ipv4.ip_unprivileged_port_start file: reopen fd 8: operation not permitted' > "$error_log"
if docker_lxc_error_in_output "$error_log"; then
    fail 'A near-match with a different failure was classified as the LXC error'
fi
printf '%s\n' 'open sysctl net.ipv4.ip_forward file: reopen fd 8: permission denied' > "$error_log"
if docker_lxc_error_in_output "$error_log"; then
    fail 'A different sysctl failure was classified as the LXC error'
fi

reset_case
DOCKER_SCENARIO=unrelated
export DOCKER_SCENARIO
if (ensure_docker_runtime_compatible) >"$TEST_DIR/unrelated.log" 2>&1; then
    fail 'An unrelated Docker probe failure was accepted'
fi
if rg -q '^apt-get:download ' "$COMMAND_LOG"; then
    fail 'An unrelated Docker failure triggered a package downgrade attempt'
fi
assert_current_version "$ORIGINAL_VERSION"

reset_case
DOCKER_SCENARIO=exact-then-success
export DOCKER_SCENARIO
if ! ensure_docker_runtime_compatible > "$TEST_DIR/success.log" 2>&1; then
    cat "$TEST_DIR/success.log" >&2
    fail 'The compatible runtime fallback did not complete successfully'
fi
assert_current_version 1.7.28-2~test
[[ $(<"$DOCKER_COUNT_FILE") == 2 ]] || fail 'The runtime probe was not retried after the downgrade'
grep -Fxq unattended-upgrades "$PACKAGE_HOLDS_FILE" || fail 'An unrelated APT hold was removed'
grep -Fxq containerd.io "$PACKAGE_HOLDS_FILE" || fail 'containerd.io was not held after the successful retry'
grep -Fq 'apt-get:install -y --allow-downgrades containerd.io=1.7.28-2~test' "$COMMAND_LOG" \
    || fail 'The newest compatible runc 1.3.2 package was not selected'
grep -Fq 'apt-mark unhold containerd.io' "$COMMAND_LOG" && fail 'An unheld containerd.io package was unnecessarily unheld'

reset_case
printf '%s\n' containerd.io unattended-upgrades > "$PACKAGE_HOLDS_FILE"
DOCKER_SCENARIO=exact-then-success
export DOCKER_SCENARIO
if ! ensure_docker_runtime_compatible > "$TEST_DIR/preheld-success.log" 2>&1; then
    cat "$TEST_DIR/preheld-success.log" >&2
    fail 'A pre-held containerd.io package did not complete the successful fallback'
fi
assert_current_version 1.7.28-2~test
grep -Fxq containerd.io "$PACKAGE_HOLDS_FILE" || fail 'A pre-existing containerd.io hold was not retained'

reset_case
CANDIDATE_SET=only-1.2.7
DOCKER_SCENARIO=exact-then-success
export CANDIDATE_SET DOCKER_SCENARIO
ensure_docker_runtime_compatible > "$TEST_DIR/fallback-1.2.7.log" 2>&1
assert_current_version 1.7.28-1~test
grep -Fq 'apt-get:install -y --allow-downgrades containerd.io=1.7.28-1~test' "$COMMAND_LOG" \
    || fail 'The runc 1.2.7 fallback package was not selected'

for scenario in package-unavailable simulation-incompatible; do
    reset_case
    APT_SCENARIO=$scenario
    DOCKER_SCENARIO=exact
    export APT_SCENARIO DOCKER_SCENARIO
    if (ensure_docker_runtime_compatible) >"$TEST_DIR/$scenario.log" 2>&1; then
        fail "$scenario package set was accepted"
    fi
    assert_current_version "$ORIGINAL_VERSION"
    grep -Fxq unattended-upgrades "$PACKAGE_HOLDS_FILE" || fail "$scenario changed unrelated APT holds"
    if grep -Fxq containerd.io "$PACKAGE_HOLDS_FILE"; then
        fail "$scenario left containerd.io held without a successful probe"
    fi
    if rg -q '^apt-get:install -y ' "$COMMAND_LOG"; then
        fail "$scenario changed the installed package set"
    fi
done

reset_case
DOCKER_SCENARIO=exact-always
export DOCKER_SCENARIO
if (ensure_docker_runtime_compatible) >"$TEST_DIR/probe-rollback.log" 2>&1; then
    fail 'A failed Docker retry was accepted'
fi
assert_current_version "$ORIGINAL_VERSION"
[[ $(<"$DOCKER_COUNT_FILE") == 2 ]] || fail 'The failed runtime probe was not retried'
grep -Fxq unattended-upgrades "$PACKAGE_HOLDS_FILE" || fail 'Rollback removed an unrelated APT hold'
if grep -Fxq containerd.io "$PACKAGE_HOLDS_FILE"; then
    fail 'Rollback left containerd.io held after the probe failed'
fi
grep -Fq 'Restored containerd.io 1.7.28-3~test' "$TEST_DIR/probe-rollback.log" \
    || fail 'A failed runtime probe did not report successful rollback'

reset_case
printf '%s\n' containerd.io unattended-upgrades > "$PACKAGE_HOLDS_FILE"
DOCKER_SCENARIO=exact-always
export DOCKER_SCENARIO
if (ensure_docker_runtime_compatible) >"$TEST_DIR/preheld-rollback.log" 2>&1; then
    fail 'A pre-held package with a failed retry was accepted'
fi
assert_current_version "$ORIGINAL_VERSION"
grep -Fxq containerd.io "$PACKAGE_HOLDS_FILE" || fail 'Rollback removed the original containerd.io hold'
grep -Fxq unattended-upgrades "$PACKAGE_HOLDS_FILE" || fail 'Rollback removed an unrelated APT hold'

reset_case
APT_SCENARIO=downgrade-fails
DOCKER_SCENARIO=exact
export APT_SCENARIO DOCKER_SCENARIO
if (ensure_docker_runtime_compatible) >"$TEST_DIR/downgrade-rollback.log" 2>&1; then
    fail 'A failed package downgrade was accepted'
fi
assert_current_version "$ORIGINAL_VERSION"
[[ $(<"$DOCKER_COUNT_FILE") == 1 ]] || fail 'Docker was probed again after package installation failed'
grep -Fxq unattended-upgrades "$PACKAGE_HOLDS_FILE" || fail 'Downgrade rollback removed an unrelated APT hold'

printf '%s\n' 'Docker LXC runtime fallback tests passed.'
