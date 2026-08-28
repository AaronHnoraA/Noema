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
# Usage: scripts/measure-xwidget-idle.sh <note.md> [settle-seconds] [sample-seconds] [foreground|background]
set -u

NOTE="${1:-}"
SETTLE="${2:-30}"
SAMPLE="${3:-60}"
SCENE="${4:-foreground}"
SERVER="noema-idle-measure-$$"
EMACS_BIN="${EMACS_BIN:-/Applications/Emacs.app/Contents/MacOS/Emacs}"
EMACS_PID=""
OWNED_PIDS=()
WEBKIT_BEFORE="$(ps -eo pid=,comm= | awk '/WebKit\.(WebContent|Networking|GPU)$/ { print $1 }' | tr '\n' ' ')"

if [ -z "$NOTE" ]; then
  echo "usage: $0 <note.md> [settle-seconds] [sample-seconds] [foreground|background]" >&2
  exit 2
fi
case "$SCENE" in foreground|background) ;; *) echo "invalid scene: $SCENE" >&2; exit 2 ;; esac

cpu_seconds() {
  ps -o time= -p "$1" 2>/dev/null | tr -d ' ' \
    | awk -F: 'NF==3 { print $1*3600+$2*60+$3 } NF==2 { print $1*60+$2 }'
}

client() { emacsclient -s "$SERVER" -e "$1" 2>&1; }

descendants_of() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    printf '%s\n' "$child"
    descendants_of "$child"
  done
}

cleanup() {
  trap - EXIT INT TERM
  if [ -n "$EMACS_PID" ] && kill -0 "$EMACS_PID" 2>/dev/null; then
    client '(progn (ignore-errors (my/noema-stop)) (kill-emacs))' >/dev/null 2>&1 &
    local closer=$!
    for _ in $(seq 1 20); do
      kill -0 "$EMACS_PID" 2>/dev/null || break
      sleep 0.25
    done
    kill "$closer" 2>/dev/null || true
    if kill -0 "$EMACS_PID" 2>/dev/null; then
      kill -TERM "$EMACS_PID" 2>/dev/null || true
      sleep 1
    fi
    if kill -0 "$EMACS_PID" 2>/dev/null; then
      kill -KILL "$EMACS_PID" 2>/dev/null || true
    fi
  fi
  # A force-stopped Emacs can orphan a child after it was reparented. Only
  # touch the exact descendants captured from this run, and re-check that their
  # command is one of Noema's owned processes before signalling it.
  local pid command
  for pid in "${OWNED_PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null || continue
    command="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$command" in
      *"/web-host.mjs"*|*"noema-kernel serve"*) kill -TERM "$pid" 2>/dev/null || true ;;
    esac
  done
}
trap cleanup EXIT INT TERM

echo "starting Emacs behind server socket '$SERVER'"
NOEMA_MEASURE_NOTE="$NOTE" \
"$EMACS_BIN" --eval "(progn (require 'server) (setq server-name \"$SERVER\") (server-start))" \
  >/dev/null 2>&1 &
EMACS_PID=$!

for _ in $(seq 1 60); do
  client '(emacs-version)' | grep -q GNU && break
  sleep 1
done
if ! client '(emacs-version)' | grep -q GNU; then
  echo "Emacs server never came up" >&2
  exit 1
fi

client '(let ((file (getenv "NOEMA_MEASURE_NOTE"))) (require '\''init-aaronnote) (setq my/noema-web-port 0) (find-file file) (my/noema-open-file file) "opened")' >/dev/null
for _ in $(seq 1 60); do
  ready="$(client '(and my/noema--ready (process-live-p my/noema--process) (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer (eq major-mode '\''xwidget-webkit-mode)))')"
  [ "$ready" = "t" ] && break
  sleep 1
done
if [ "${ready:-nil}" != "t" ]; then
  echo "Noema xwidget/core never became ready: $(client '(list :ready my/noema--ready :process (and my/noema--process (process-status my/noema--process)) :buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)))')" >&2
  exit 1
fi

if [ "$SCENE" = background ]; then
  client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (with-selected-window window (switch-to-buffer (get-buffer-create "*Noema measurement background*")))) (setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
else
  client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (select-frame-set-input-focus (window-frame window)) (select-window window)) (setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
fi
sleep 1
expected_activity="$(if [ "$SCENE" = background ]; then printf t; else printf nil; fi)"
actual_activity="$(client '(and (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer my/noema--activity-paused))')"
if [ "$actual_activity" != "$expected_activity" ]; then
  echo "Noema activity state mismatch for $SCENE: expected paused=$expected_activity, got $actual_activity" >&2
  exit 1
fi

echo "opened $NOTE in $SCENE scene; settling ${SETTLE}s"
sleep "$SETTLE"

if [ "$(client '(and my/noema--ready (process-live-p my/noema--process) (buffer-live-p my/noema--app-buffer))')" != "t" ]; then
  echo "Noema process chain died during settle: $(client '(list :ready my/noema--ready :process (and my/noema--process (process-status my/noema--process)) :buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)))')" >&2
  exit 1
fi
actual_activity="$(client '(with-current-buffer my/noema--app-buffer my/noema--activity-paused)')"
if [ "$actual_activity" != "$expected_activity" ]; then
  echo "Noema activity state drifted during settle: expected paused=$expected_activity, got $actual_activity" >&2
  exit 1
fi

NAMES=(emacs)
PIDS=("$EMACS_PID")
while IFS= read -r pid; do
  [ -n "$pid" ] || continue
  OWNED_PIDS+=("$pid")
  command="$(ps -o command= -p "$pid" 2>/dev/null)"
  case "$command" in
    *"/web-host.mjs"*) NAMES+=(web-host); PIDS+=("$pid") ;;
    *"noema-kernel serve"*) NAMES+=(go-kernel); PIDS+=("$pid") ;;
  esac
done < <(descendants_of "$EMACS_PID")
# WebKit XPC services are reparented to launchd. Attribute only processes that
# appeared after this run started; never signal them during cleanup because the
# OS, not this script, owns their lifecycle.
while read -r pid command; do
  [ -n "$pid" ] || continue
  case " $WEBKIT_BEFORE " in *" $pid "*) continue ;; esac
  case "$command" in
    *WebKit.WebContent) label=webkit-webcontent ;;
    *WebKit.Networking) label=webkit-networking ;;
    *WebKit.GPU) label=webkit-gpu ;;
    *) continue ;;
  esac
  NAMES+=("$label")
  PIDS+=("$pid")
done < <(ps -eo pid=,comm= | awk '/WebKit\.(WebContent|Networking|GPU)$/ { print $1, $2 }')

BEFORE=()
for pid in "${PIDS[@]}"; do BEFORE+=("$(cpu_seconds "$pid")"); done
printf 'sampling owned chain:'
for i in "${!PIDS[@]}"; do
  printf ' %s=%s' "${NAMES[$i]}" "${PIDS[$i]}"
done
printf '\n'
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
echo "stopping only Emacs PID $EMACS_PID and its captured Noema children"
