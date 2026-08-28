#!/bin/bash
# Measure what continuous typing costs in the Emacs xwidget host.
#
# The companion script measure-xwidget-idle.sh answers "what does Noema cost
# when nobody is touching it". This one answers the question that browser
# profiling cannot: what one keystroke costs when Emacs, not Chrome, owns the
# surface. Emacs repaints the xwidget through its own redisplay, so the same
# renderer work is paid twice, and only a real xwidget shows the second half.
#
# It starts a GUI Emacs with the real configuration behind its own server
# socket, opens one note, settles, then drives a paced burst of single-character
# edits inside the page and samples CPU time for every process in the chain,
# split per process so the Emacs half and the WebKit half are visible
# separately. The number that matters is CPU-milliseconds per keystroke.
#
# What it does and does not exercise: the edits are driven inside the page with
# document.execCommand("insertText"), which goes through the browser's own
# editing pipeline and CM6's DOM observer — the same path a real key takes once
# WebKit has the character. It does not exercise the physical key delivery into
# WKWebView, because on the macOS port Emacs cannot replay a key into the widget
# at all (xwidget.c implements no nsxwidget_perform_lispy_event). So the result
# is a faithful measure of the edit-to-repaint chain, including Emacs redisplay,
# and a lower bound on the full key path.
#
# Everything it starts, it stops.
#
# Usage: scripts/measure-xwidget-typing.sh <note.md> [settle-seconds] [keystrokes] [interval-ms]
set -u

NOTE="${1:-}"
SETTLE="${2:-20}"
KEYS="${3:-300}"
INTERVAL_MS="${4:-120}"
SERVER="noema-typing-measure-$$"
EMACS_BIN="${EMACS_BIN:-/Applications/Emacs.app/Contents/MacOS/Emacs}"
EMACS_PID=""
WORKDIR=""
OWNED_PIDS=()
WEBKIT_BEFORE="$(ps -eo pid=,comm= | awk '/WebKit\.(WebContent|Networking|GPU)$/ { print $1 }' | tr '\n' ' ')"

if [ -z "$NOTE" ]; then
  echo "usage: $0 <note.md> [settle-seconds] [keystrokes] [interval-ms]" >&2
  exit 2
fi
case "$KEYS" in ''|*[!0-9]*) echo "keystrokes must be a positive integer" >&2; exit 2 ;; esac
case "$INTERVAL_MS" in ''|*[!0-9]*) echo "interval-ms must be a positive integer" >&2; exit 2 ;; esac
[ "$KEYS" -gt 0 ] || { echo "keystrokes must be a positive integer" >&2; exit 2; }
if [ ! -f "$NOTE" ]; then
  echo "no such note: $NOTE" >&2
  exit 2
fi

# This measurement types into the document, and the editor autosaves. Never
# point the run at the original: copy it into a throwaway vault and drive that,
# so a measurement can never damage a real note.
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/noema-typing-measure.XXXXXX")"
SOURCE_NOTE="$NOTE"
NOTE="$WORKDIR/$(basename "$SOURCE_NOTE")"
cp "$SOURCE_NOTE" "$NOTE"
echo "measuring against a copy: $NOTE"

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
  # Only the exact descendants captured from this run, re-checked by command
  # before signalling. Never a broad pattern match: a bare `pgrep -f noema-kernel`
  # also matches the kernel belonging to the user's own Emacs session.
  local pid command
  for pid in "${OWNED_PIDS[@]}"; do
    kill -0 "$pid" 2>/dev/null || continue
    command="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$command" in
      *"/web-host.mjs"*|*"noema-kernel serve"*) kill -TERM "$pid" 2>/dev/null || true ;;
    esac
  done
  # Only ever a directory this run created with mktemp -d.
  case "${WORKDIR:-}" in
    */noema-typing-measure.*) rm -rf "$WORKDIR" ;;
  esac
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
  echo "Noema xwidget/core never became ready: $(client '(list :ready my/noema--ready :process (and my/noema--process (process-status my/noema--process)) :buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)) :mode (and (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer major-mode)) :frames (length (frame-list)))')" >&2
  exit 1
fi

# Typing only happens in a foreground pane, so make this one the active client
# and confirm the renderer agrees before attributing any cost to it.
client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (select-frame-set-input-focus (window-frame window)) (select-window window)) (setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
sleep 1
if [ "$(client '(with-current-buffer my/noema--app-buffer my/noema--activity-paused)')" != "nil" ]; then
  echo "Noema pane is not the active client; refusing to attribute typing cost to a paused renderer" >&2
  exit 1
fi

echo "opened $NOTE; settling ${SETTLE}s"
sleep "$SETTLE"

read -r -d '' DRIVER <<'JS' || true
(() => {
  const content = document.querySelector('.cm-content');
  if (!content) return 'no-editor';
  const probe = { done: false, typed: 0, path: '', error: '' };
  window.__noemaTypingProbe = probe;
  content.focus();
  const letters = 'the quick brown fox jumps over a lazy dog '.split('');
  let index = 0;
  const total = TOTAL_KEYS;
  const step = () => {
    if (index >= total) { probe.done = true; return; }
    try {
      const character = letters[index % letters.length];
      if (document.execCommand('insertText', false, character)) {
        probe.path = probe.path || 'execCommand';
      } else {
        // Fall back to a CM6 transaction. This skips the DOM observer, so the
        // result is reported with its path so the two are never conflated.
        const view = content.cmView && content.cmView.view;
        if (!view) { probe.error = 'no-view'; probe.done = true; return; }
        const at = view.state.selection.main.head;
        view.dispatch({ changes: { from: at, to: at, insert: character } });
        probe.path = probe.path || 'dispatch';
      }
      probe.typed = index + 1;
    } catch (err) {
      probe.error = String(err && err.message || err);
      probe.done = true;
      return;
    }
    index += 1;
    setTimeout(step, INTERVAL);
  };
  setTimeout(step, 0);
  return 'started';
})()
JS
DRIVER="${DRIVER//TOTAL_KEYS/$KEYS}"
DRIVER="${DRIVER//INTERVAL/$INTERVAL_MS}"

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
for i in "${!PIDS[@]}"; do printf ' %s=%s' "${NAMES[$i]}" "${PIDS[$i]}"; done
printf '\n'

started_at="$(date +%s)"
client "(with-current-buffer my/noema--app-buffer (xwidget-webkit-execute-script (xwidget-webkit-current-session) $(printf '%s' "$DRIVER" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')))" >/dev/null

budget=$(( (KEYS * INTERVAL_MS) / 1000 + 30 ))
typed=0
for _ in $(seq 1 "$budget"); do
  sleep 1
  client '(with-current-buffer my/noema--app-buffer (xwidget-webkit-execute-script (xwidget-webkit-current-session) "JSON.stringify(window.__noemaTypingProbe || {})" (lambda (result) (setq my/noema-measure-probe result))))' >/dev/null
  sleep 0.3
  probe="$(client 'my/noema-measure-probe')"
  case "$probe" in *'\"done\":true'*|*'"done":true'*) typed="$probe"; break ;; esac
done
elapsed=$(( $(date +%s) - started_at ))

probe="$(client 'my/noema-measure-probe')"
echo "driver probe: $probe"
echo "drive window: ${elapsed}s for ${KEYS} edits at ${INTERVAL_MS}ms"

printf '\n%-20s %8s %12s %18s %9s\n' process pid "cpu-s" "cpu-ms/keystroke" rss-MB
total_cpu=0
for i in "${!PIDS[@]}"; do
  pid="${PIDS[$i]}"
  after="$(cpu_seconds "$pid")"
  if [ -z "$after" ]; then
    printf '%-20s %8s %12s %18s %9s\n' "${NAMES[$i]}" "$pid" "(exited)" - -
    continue
  fi
  delta="$(awk -v a="$after" -v b="${BEFORE[$i]}" 'BEGIN { printf "%.2f", a-b }')"
  per_key="$(awk -v d="$delta" -v k="$KEYS" 'BEGIN { printf "%.3f", (d*1000)/k }')"
  rss="$(ps -o rss= -p "$pid" 2>/dev/null | tr -d ' ')"
  rss_mb="$(awk -v r="${rss:-0}" 'BEGIN { printf "%.1f", r/1024 }')"
  total_cpu="$(awk -v t="$total_cpu" -v d="$delta" 'BEGIN { printf "%.2f", t+d }')"
  printf '%-20s %8s %12s %18s %9s\n' "${NAMES[$i]}" "$pid" "$delta" "$per_key" "$rss_mb"
done
printf '%-20s %8s %12s %18s\n' TOTAL - "$total_cpu" \
  "$(awk -v t="$total_cpu" -v k="$KEYS" 'BEGIN { printf "%.3f", (t*1000)/k }')"
echo
echo "The emacs row is the half no browser profile can show: Emacs repaints the"
echo "xwidget through its own redisplay, so compare it against webkit-webcontent."
