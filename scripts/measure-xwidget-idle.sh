#!/bin/bash
# Measure what an idle Noema costs in the Emacs xwidget host.
#
# Starts a GUI Emacs with the real configuration behind its own server socket,
# opens one note in the xwidget through emacsclient, lets it settle, then samples
# CPU time for every process in the chain: Emacs itself (it repaints the xwidget
# through its own redisplay), the WebKit content/networking/GPU processes behind
# the WKWebView, the shared Node web host, and the Go kernel. The number that
# matters for battery is CPU-seconds per wall minute, so that is what it prints.
#
# Everything it starts, it stops.
#
# Usage: scripts/measure-xwidget-idle.sh <note.md> [settle-seconds] [sample-seconds]
set -u

NOTE="${1:-}"
SETTLE="${2:-30}"
SAMPLE="${3:-60}"
SERVER="noema-idle-measure"
EMACS_BIN="${EMACS_BIN:-/Applications/Emacs.app/Contents/MacOS/Emacs}"

if [ -z "$NOTE" ]; then
  echo "usage: $0 <note.md> [settle-seconds] [sample-seconds]" >&2
  exit 2
fi

cpu_seconds() {
  ps -o time= -p "$1" 2>/dev/null | tr -d ' ' \
    | awk -F: 'NF==3 { print $1*3600+$2*60+$3 } NF==2 { print $1*60+$2 }'
}

client() { emacsclient -s "$SERVER" -e "$1" 2>&1; }

echo "starting Emacs behind server socket '$SERVER'"
"$EMACS_BIN" --eval "(progn (require 'server) (setq server-name \"$SERVER\") (server-start))" \
  >/dev/null 2>&1 &
EMACS_PID=$!

for _ in $(seq 1 60); do
  client '(emacs-version)' | grep -q GNU && break
  sleep 1
done
if ! client '(emacs-version)' | grep -q GNU; then
  echo "Emacs server never came up" >&2
  kill "$EMACS_PID" 2>/dev/null
  exit 1
fi

client "(progn (require 'init-aaronnote) (find-file \"$NOTE\") (my/noema-open-file \"$NOTE\") \"opened\")" >/dev/null
echo "opened $NOTE; settling ${SETTLE}s"
sleep "$SETTLE"

NAMES=(emacs)
PIDS=("$EMACS_PID")
for pid in $(pgrep -f "node .*web-host.mjs" 2>/dev/null); do NAMES+=(web-host); PIDS+=("$pid"); done
for pid in $(pgrep -f "noema-kernel serve" 2>/dev/null); do NAMES+=(go-kernel); PIDS+=("$pid"); done
# WebKit's XPC services are reparented to launchd, so they cannot be found by
# parentage. The newest of each kind is the one this run just created; the
# iOSSupport copies belong to Catalyst apps, never to Emacs.
for kind in WebContent Networking GPU; do
  pid="$(ps -eo pid,lstart,comm | grep "WebKit\.$kind" | grep -v iOSSupport | tail -1 | awk '{ print $1 }')"
  [ -n "$pid" ] || continue
  label="$(printf '%s' "$kind" | tr '[:upper:]' '[:lower:]')"
  NAMES+=("webkit-$label")
  PIDS+=("$pid")
done

BEFORE=()
for pid in "${PIDS[@]}"; do BEFORE+=("$(cpu_seconds "$pid")"); done
sleep "$SAMPLE"

printf '\n%-18s %8s %13s %9s\n' process pid "cpu-s/${SAMPLE}s" rss-MB
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  after="$(cpu_seconds "$pid")"
  if [ -z "$after" ]; then
    printf '%-18s %8s %13s %9s\n' "${NAMES[$i]}" "$pid" "(exited)" -
    continue
  fi
  rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
  printf '%-18s %8s %13s %9s\n' "${NAMES[$i]}" "$pid" \
    "$(awk -v a="$after" -v b="${BEFORE[$i]:-0}" 'BEGIN { printf "%.2f", a-b }')" \
    "$(awk -v r="${rss:-0}" 'BEGIN { printf "%.0f", r/1024 }')"
done

echo
echo "stopping Emacs and the host it started"
client '(progn (ignore-errors (my/noema-stop)) (kill-emacs))' >/dev/null
for _ in $(seq 1 15); do kill -0 "$EMACS_PID" 2>/dev/null || break; sleep 1; done
kill -9 "$EMACS_PID" 2>/dev/null
sleep 2
pkill -f "node .*web-host.mjs" 2>/dev/null
sleep 1
pkill -f "noema-kernel serve" 2>/dev/null
sleep 1
echo "leftover: $(pgrep -f 'MacOS/Emacs|web-host.mjs|noema-kernel serve' | tr '\n' ' ')none"
