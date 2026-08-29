#!/bin/bash
# Measure the shared Node/Go host with one connected SSE client and no UI.
# Everything is isolated under /tmp and every owned process is stopped.
#
# Usage: scripts/measure-host-idle.sh [settle-seconds] [sample-seconds]
set -u

SETTLE="${1:-10}"
SAMPLE="${2:-30}"
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NOTE_ROOT="${NOEMA_ROOT:-$HOME/Documents/Noema}"
RUN_DIR="$(mktemp -d /tmp/noema-host-idle.XXXXXX)"
HOST_LOG="$RUN_DIR/host.log"
HOST_PID=""
KERNEL_PID=""
SSE_PID=""

cpu_seconds() {
  ps -o time= -p "$1" 2>/dev/null | tr -d ' ' \
    | awk -F: 'NF==3 { print $1*3600+$2*60+$3 } NF==2 { print $1*60+$2 }'
}

cleanup() {
  trap - EXIT INT TERM
  [ -z "$SSE_PID" ] || kill -TERM "$SSE_PID" 2>/dev/null || true
  [ -z "$HOST_PID" ] || kill -TERM "$HOST_PID" 2>/dev/null || true
  [ -z "$HOST_PID" ] || wait "$HOST_PID" 2>/dev/null || true
  case "$RUN_DIR" in
    /tmp/noema-host-idle.*|/private/tmp/noema-host-idle.*) /bin/rm -rf "$RUN_DIR" ;;
  esac
}
trap cleanup EXIT INT TERM

cd "$PROJECT_ROOT" || exit 1
AARONNOTE_HOST_MODE=desktop \
NOEMA_ROOT="$NOTE_ROOT" \
AARONNOTE_STATE_DIR="$RUN_DIR/state" \
NOEMA_KERNEL_WORKSPACE="$RUN_DIR/kernel-workspace" \
NOEMA_KERNEL_CONFIG_DIR="$RUN_DIR/kernel-config" \
AARONNOTE_WEB_PORT=0 \
node web-host.mjs >"$HOST_LOG" 2>&1 &
HOST_PID=$!

ORIGIN=""
for _ in $(seq 1 120); do
  ORIGIN="$(sed -n 's/^\[aaronnote-web\] \(http:\/\/127\.0\.0\.1:[0-9][0-9]*\)$/\1/p' "$HOST_LOG" | tail -1)"
  [ -n "$ORIGIN" ] && break
  kill -0 "$HOST_PID" 2>/dev/null || break
  sleep 0.25
done
if [ -z "$ORIGIN" ]; then
  tail -120 "$HOST_LOG" >&2
  exit 1
fi

curl -sN "$ORIGIN/events" >/dev/null &
SSE_PID=$!
for _ in $(seq 1 40); do
  KERNEL_PID="$(pgrep -P "$HOST_PID" -f 'noema-kernel serve' | head -1)"
  [ -n "$KERNEL_PID" ] && break
  sleep 0.25
done
if [ -z "$KERNEL_PID" ]; then
  tail -120 "$HOST_LOG" >&2
  exit 1
fi

echo "connected idle client: host=$HOST_PID kernel=$KERNEL_PID origin=$ORIGIN"
sleep "$SETTLE"
HOST_BEFORE="$(cpu_seconds "$HOST_PID")"
KERNEL_BEFORE="$(cpu_seconds "$KERNEL_PID")"
sleep "$SAMPLE"
HOST_AFTER="$(cpu_seconds "$HOST_PID")"
KERNEL_AFTER="$(cpu_seconds "$KERNEL_PID")"

awk -v sample="$SAMPLE" \
  -v host_before="$HOST_BEFORE" -v host_after="$HOST_AFTER" \
  -v kernel_before="$KERNEL_BEFORE" -v kernel_after="$KERNEL_AFTER" \
  'BEGIN {
    printf "web-host cpu-s/%ss %.2f\n", sample, host_after-host_before
    printf "go-kernel cpu-s/%ss %.2f\n", sample, kernel_after-kernel_before
  }'
GIT_CHILDREN="$(ps -axo ppid=,comm= | awk -v host="$HOST_PID" -v kernel="$KERNEL_PID" \
  '$1 == host || $1 == kernel { if ($2 ~ /git$/) count++ } END { print count+0 }')"
echo "live git children after sample: $GIT_CHILDREN"
