#!/usr/bin/env bash
# SlowMeet VPS regression diagnostics — READ-ONLY captures, safe during a live call.
#
# Run ON THE VPS (as root or a user in the docker group):
#
#   ./scripts/diagnose-vps-regression.sh baseline    # step 1: snapshot limits/logs/CPU counters
#   ./scripts/diagnose-vps-regression.sh watch 180   # step 2: start this, then reproduce the
#                                                    #         Reconnecting cycle; captures a
#                                                    #         live filtered log timeline
#   SLOWMEET_ADMIN_PASSWORD=... ./scripts/diagnose-vps-regression.sh profile  # step 3: 30s CPU
#                                                    #         profile + heap + goroutine dump
#                                                    #         WHILE the repro is active
#   ./scripts/diagnose-vps-regression.sh summary     # step 4: deltas vs the baseline snapshot
#                                                    #         (throttling, sockets, restarts)
#
# Outputs land in /tmp/slowmeet-diag-<timestamp>/ — archive that directory and
# share it (it contains meeting IDs/names from logs; strip those if needed).
# Never put the admin password in shared output.

set -u

CONTAINER="${SLOWMEET_CONTAINER:-}"
HTTP_PORT="${HTTP_PUBLISH_PORT:-8080}"
ADMIN_PASSWORD="${SLOWMEET_ADMIN_PASSWORD:-}"
BASELINE_DIR="${SLOWMEET_DIAG_BASELINE_DIR:-}"
DURATION="${2:-180}"
EVENT_RE='webrtc_state_changed|webrtc_connected|network_degraded|webrtc_failed|ice_failure_teardown|participant_joined|participant_left|participant_disconnected|participant_reconnect_expired|media_publication_read_stopped|media_publication_replaced_track|ice_candidate_write_failed|video_keyframe_request_failed|sdp_offer_sent|sdp_answer_received|level=(ERROR|WARN)'

# localhost curls must bypass any ambient HTTP proxy (proxy env breaks 127.0.0.1).
export no_proxy="localhost,127.0.0.1" NO_PROXY="localhost,127.0.0.1"

find_container() {
  if [ -n "$CONTAINER" ]; then return 0; fi
  CONTAINER="$(docker ps --format '{{.Names}}' | grep -i slowmeet | head -1)"
  if [ -z "$CONTAINER" ]; then
    echo "error: no running container matching 'slowmeet' found (set SLOWMEET_CONTAINER)" >&2
    exit 1
  fi
}

outdir() {
  OUT="/tmp/slowmeet-diag-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$OUT"
}

cgroup_cpu_stat() {
  # cgroup v2 paths differ by driver: systemd creates docker-<id>.scope under
  # system.slice; cgroupfs driver uses docker/<id>. Try both, fall back to a
  # broad search.
  local id; id="$(docker inspect --format '{{.Id}}' "$CONTAINER")"
  for p in "/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.stat" \
           "/sys/fs/cgroup/docker/${id}/cpu.stat"; do
    if [ -r "$p" ]; then cat "$p"; return 0; fi
  done
  f="$(find /sys/fs/cgroup -maxdepth 4 -name cpu.stat -path "*${id:0:12}*" 2>/dev/null | head -1)"
  [ -n "$f" ] && cat "$f"
}

cgroup_cpu_pressure() {
  local id; id="$(docker inspect --format '{{.Id}}' "$CONTAINER")"
  for p in "/sys/fs/cgroup/system.slice/docker-${id}.scope/cpu.pressure" \
           "/sys/fs/cgroup/docker/${id}/cpu.pressure"; do
    if [ -r "$p" ]; then cat "$p"; return 0; fi
  done
  true
}

capture_limits() {
  docker inspect "$CONTAINER" >"$OUT/inspect.json"
  docker inspect --format 'started_at={{.State.StartedAt}} image={{.Image}} restarts={{.RestartCount}}' "$CONTAINER" | tee "$OUT/state.txt"
  docker inspect --format 'nano_cpus={{.HostConfig.NanoCpus}} cpu_quota={{.HostConfig.CpuQuota}} cpu_period={{.HostConfig.CpuPeriod}} memory={{.HostConfig.Memory}}' "$CONTAINER" | tee -a "$OUT/state.txt"
  docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$CONTAINER" | grep -E 'GOMEMLIMIT|GOMAXPROCS|GOGC' | tee -a "$OUT/state.txt"
  docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}} {{index .Config.Labels "org.opencontainers.image.version"}} {{index .Config.Labels "org.opencontainers.image.created"}}' "$CONTAINER" | tee -a "$OUT/state.txt"
  echo '--- runtime view from inside the container ---' >>"$OUT/state.txt"
  docker exec "$CONTAINER" sh -c 'cat /proc/cpuinfo | grep -c processor; cat /sys/fs/cgroup/cpu.max 2>/dev/null || true; cat /sys/fs/cgroup/memory.max 2>/dev/null || true' >>"$OUT/state.txt" 2>&1 || true
}

capture_cpu() {
  cgroup_cpu_stat >"$OUT/cpu.stat.$$" 2>/dev/null
  [ -s "$OUT/cpu.stat.$$" ] && mv "$OUT/cpu.stat.$$" "$1/cpu.stat" || rm -f "$OUT/cpu.stat.$$"
  cgroup_cpu_pressure >"$1/cpu.pressure" 2>/dev/null
  docker stats --no-stream --format '{{.Name}} cpu={{.CPUPerc}} mem={{.MemUsage}}' 2>/dev/null | grep -iE 'slowmeet|coturn' >"$1/docker-stats.txt"
  # UDP sockets in the ICE range, from inside the container (hex 50000=C350..50100=C374)
  docker exec "$CONTAINER" sh -c 'cat /proc/net/udp /proc/net/udp6 2>/dev/null' 2>/dev/null \
    | awk '{split($2,a,":"); port=strtonum("0x" a[2]); if (port>=50000 && port<=50100) n++} END {print "ice_udp_sockets=" n+0}' \
    >"$1/udp-sockets.txt" 2>/dev/null || echo 'ice_udp_sockets=unknown' >"$1/udp-sockets.txt"
}

capture_logs_recent() {
  docker logs -t --since "${LOG_HOURS:-6}h" "$CONTAINER" 2>&1 \
    | grep -E "$EVENT_RE" >"$OUT/logs-recent-filtered.txt" || true
  wc -l "$OUT/logs-recent-filtered.txt"
  for ev in webrtc_failed network_degraded webrtc_connected ice_failure_teardown \
            participant_reconnect_expired participant_disconnected \
            media_publication_read_stopped media_publication_replaced_track; do
    printf '%-40s %s\n' "$ev" "$(grep -c "$ev" "$OUT/logs-recent-filtered.txt" || true)"
  done | tee "$OUT/log-event-counts.txt"
}

case "${1:-}" in
  baseline)
    find_container; outdir
    echo "== container: $CONTAINER =="
    capture_limits
    capture_cpu "$OUT"
    capture_logs_recent
    echo "$OUT" > /tmp/slowmeet-diag-baseline-dir
    echo "baseline saved in $OUT (snapshot reference for 'summary')"
    ;;
  watch)
    find_container; outdir
    echo "== watching $CONTAINER logs for ${DURATION}s — reproduce the Reconnecting cycle NOW =="
    docker logs -f -t --since 1s "$CONTAINER" 2>&1 \
      | grep -E "$EVENT_RE" --line-buffered \
      | while IFS= read -r line; do echo "$line" | tee -a "$OUT/logs-during-repro.txt"; done &
    WATCH_PID=$!
    sleep 2
    capture_cpu "$OUT"
    sleep "$DURATION"
    kill $WATCH_PID 2>/dev/null
    capture_cpu "$OUT"
    echo "repro window captured: $OUT/logs-during-repro.txt ($(wc -l < "$OUT/logs-during-repro.txt" 2>/dev/null || echo 0) lines)"
    ;;
  profile)
    find_container; outdir
    if [ -z "$ADMIN_PASSWORD" ]; then
      echo "error: set SLOWMEET_ADMIN_PASSWORD (the app's admin password)" >&2; exit 1
    fi
    echo "== capturing 30s CPU profile — keep the repro active =="
    curl -s -H "X-Admin-Password: $ADMIN_PASSWORD" "http://127.0.0.1:${HTTP_PORT}/debug/pprof/profile?seconds=30" -o "$OUT/cpu-pprof.pb"
    curl -s -H "X-Admin-Password: $ADMIN_PASSWORD" "http://127.0.0.1:${HTTP_PORT}/debug/pprof/heap?seconds=1" -o "$OUT/heap-pprof.pb"
    curl -s -H "X-Admin-Password: $ADMIN_PASSWORD" "http://127.0.0.1:${HTTP_PORT}/debug/pprof/goroutine?debug=1" \
      | head -1 >"$OUT/goroutines.txt"
    cat "$OUT/goroutines.txt"
    echo "profiles saved in $OUT (analyze locally with: go tool pprof -http=:0 cpu-pprof.pb)"
    ;;
  summary)
    find_container; outdir
    if [ -z "$BASELINE_DIR" ] && [ -r /tmp/slowmeet-diag-baseline-dir ]; then
      BASELINE_DIR="$(cat /tmp/slowmeet-diag-baseline-dir)"
    fi
    if [ -z "$BASELINE_DIR" ] || [ ! -r "$BASELINE_DIR/cpu.stat" ]; then
      echo "error: no baseline found (run 'baseline' first, or set SLOWMEET_DIAG_BASELINE_DIR)" >&2; exit 1
    fi
    capture_cpu "$OUT"
    echo "== CPU throttling delta (baseline -> now) =="
    for metric in nr_periods nr_throttled throttled_usec usage_usec; do
      b="$(awk -v m="$metric" '$1==m {print $2}' "$BASELINE_DIR/cpu.stat")"
      n="$(awk -v m="$metric" '$1==m {print $2}' "$OUT/cpu.stat")"
      printf '%-15s %12s -> %-12s delta=%s\n' "$metric" "${b:-?}" "${n:-?}" "$(( ${n:-0} - ${b:-0} ))"
    done
    echo; echo "== sockets now =="; cat "$OUT/udp-sockets.txt"
    echo "== docker stats now =="; cat "$OUT/docker-stats.txt"
    echo; echo "== restarts check (container recreations reset RestartCount) =="
    docker inspect --format 'restarts={{.RestartCount}} started_at={{.State.StartedAt}}' "$CONTAINER"
    ;;
  *)
    sed -n '2,22p' "$0"; exit 2
    ;;
esac
