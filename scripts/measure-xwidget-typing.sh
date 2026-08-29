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
# Set NOEMA_TYPING_ACTION=enter to drive real browser line-break input and
# verify that an active authored blank run keeps one stable measured height.
#
# Usage: scripts/measure-xwidget-typing.sh <note.md> [settle-seconds] [keystrokes] [interval-ms]
set -u

NOTE="${1:-}"
SETTLE="${2:-20}"
KEYS="${3:-300}"
INTERVAL_MS="${4:-120}"
TYPING_MODE="${NOEMA_TYPING_MODE:-visual}"
TYPING_ACTION="${NOEMA_TYPING_ACTION:-text}"
SERVER="noema-typing-measure-$$"
SERVER_SOCKET=""
EMACS_APP="${EMACS_APP:-Emacs}"
EMACS_PID=""
LAUNCHED_EMACS_PID=""
WORKDIR=""
EMACS_LOG=""
OWNED_PIDS=()
WEBKIT_BEFORE="$(ps -eo pid=,comm= | awk '/WebKit\.(WebContent|Networking|GPU)$/ { print $1 }' | tr '\n' ' ')"
EMACS_BEFORE="$(ps -eo pid=,command= | awk '$0 ~ /\/Emacs\.app\/Contents\/MacOS\/Emacs([[:space:]]|$)/ { print $1 }' | tr '\n' ' ')"

if [ -z "$NOTE" ]; then
  echo "usage: $0 <note.md> [settle-seconds] [keystrokes] [interval-ms]" >&2
  exit 2
fi
case "$KEYS" in ''|*[!0-9]*) echo "keystrokes must be a positive integer" >&2; exit 2 ;; esac
case "$INTERVAL_MS" in ''|*[!0-9]*) echo "interval-ms must be a positive integer" >&2; exit 2 ;; esac
case "$TYPING_MODE" in visual|source) ;; *) echo "invalid NOEMA_TYPING_MODE: $TYPING_MODE" >&2; exit 2 ;; esac
case "$TYPING_ACTION" in text|enter) ;; *) echo "invalid NOEMA_TYPING_ACTION: $TYPING_ACTION" >&2; exit 2 ;; esac
[ "$TYPING_ACTION" != enter ] || [ "$TYPING_MODE" = visual ] || {
  echo "NOEMA_TYPING_ACTION=enter requires NOEMA_TYPING_MODE=visual" >&2
  exit 2
}
[ "$KEYS" -gt 0 ] || { echo "keystrokes must be a positive integer" >&2; exit 2; }
if [ ! -f "$NOTE" ]; then
  echo "no such note: $NOTE" >&2
  exit 2
fi

# This measurement types into the document, and the editor autosaves. Never
# point the run at the original: copy it into a throwaway vault and drive that,
# so a measurement can never damage a real note.
# macOS AF_UNIX paths are short (roughly 104 bytes). $TMPDIR lives under a
# long /var/folders path, and server-start then silently failed before the
# benchmark could discover its private GUI. Keep only this socket workspace
# under the canonical short /tmp alias.
WORKDIR="$(mktemp -d "/tmp/noema-typing-measure.XXXXXX")"
EMACS_LOG="$WORKDIR/emacs.log"
SERVER_SOCKET="$WORKDIR/$SERVER"
SOURCE_NOTE="$NOTE"
NOTE="$WORKDIR/$(basename "$SOURCE_NOTE")"
cp "$SOURCE_NOTE" "$NOTE"
echo "measuring against a copy: $NOTE"

cpu_seconds() {
  ps -o time= -p "$1" 2>/dev/null | tr -d ' ' \
    | awk -F: 'NF==3 { print $1*3600+$2*60+$3 } NF==2 { print $1*60+$2 }'
}

client() { emacsclient -s "$SERVER_SOCKET" -e "$1" 2>&1; }

descendants_of() {
  local parent="$1" child
  for child in $(pgrep -P "$parent" 2>/dev/null); do
    printf '%s\n' "$child"
    descendants_of "$child"
  done
}

cleanup() {
  trap - EXIT INT TERM
  if [ -z "$EMACS_PID" ]; then EMACS_PID="$LAUNCHED_EMACS_PID"; fi
  local closer_command=""
  if [ -n "$EMACS_PID" ] && kill -0 "$EMACS_PID" 2>/dev/null; then
    client '(progn (ignore-errors (my/noema-stop)) (kill-emacs))' >/dev/null 2>&1 &
    local closer=$!
    for _ in $(seq 1 20); do
      kill -0 "$EMACS_PID" 2>/dev/null || break
      sleep 0.25
    done
    if kill -0 "$closer" 2>/dev/null; then
      closer_command="$(ps -o command= -p "$closer" 2>/dev/null)"
      case "$closer_command" in
        *"emacsclient -s $SERVER_SOCKET"*) kill -TERM "$closer" 2>/dev/null || true ;;
      esac
    fi
    wait "$closer" 2>/dev/null || true
    if kill -0 "$EMACS_PID" 2>/dev/null; then
      kill -TERM "$EMACS_PID" 2>/dev/null || true
      sleep 1
    fi
    if kill -0 "$EMACS_PID" 2>/dev/null; then
      kill -KILL "$EMACS_PID" 2>/dev/null || true
    fi
    # Reap the exact GUI child before returning so back-to-back benchmark runs
    # cannot overlap macOS application teardown.
    wait "$EMACS_PID" 2>/dev/null || true
  fi
  # Only the exact descendants captured from this run, re-checked by command
  # before signalling. Never a broad pattern match: a bare `pgrep -f noema-kernel`
  # also matches the kernel belonging to the user's own Emacs session.
  local pid command
  # macOS still ships Bash 3, where expanding an initialized-but-empty array
  # under `set -u` raises an unbound-variable error. PIDs contain no spaces, so
  # the defaulted scalar expansion is safe and keeps failed-start cleanup quiet.
  for pid in ${OWNED_PIDS[*]-}; do
    kill -0 "$pid" 2>/dev/null || continue
    command="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$command" in
      *"/web-host.mjs"*|*"noema-kernel serve"*) kill -TERM "$pid" 2>/dev/null || true ;;
    esac
  done
  # Only ever a directory this run created with mktemp -d.
  case "${WORKDIR:-}" in
    /tmp/noema-typing-measure.*|/private/tmp/noema-typing-measure.*) rm -rf "$WORKDIR" ;;
  esac
}
trap cleanup EXIT INT TERM

echo "starting Emacs behind server socket '$SERVER'"
NOEMA_MEASURE_NOTE="$NOTE" \
  /usr/bin/open -n -a "$EMACS_APP" --args \
  --eval "(progn (require 'server) (setq server-socket-dir \"$WORKDIR\" server-name \"$SERVER\") (server-start))" \
  >"$EMACS_LOG" 2>&1

# Remember the exact GUI process created by this `open -n` even if startup
# fails before server-start. Cleanup can then reap our process without ever
# matching an already-running user Emacs.
for _ in $(seq 1 20); do
  while read -r candidate_pid candidate_command; do
    [ -n "$candidate_pid" ] || continue
    case " $EMACS_BEFORE " in *" $candidate_pid "*) continue ;; esac
    case "$candidate_command" in
      *"/Emacs.app/Contents/MacOS/Emacs"*) LAUNCHED_EMACS_PID="$candidate_pid"; break ;;
    esac
  done < <(ps -eo pid=,command=)
  [ -n "$LAUNCHED_EMACS_PID" ] && break
  sleep 0.25
done

for _ in $(seq 1 60); do
  candidate_pid="$(client '(emacs-pid)' | tr -d '[:space:]')"
  case "$candidate_pid" in
    ''|*[!0-9]*) ;;
    *)
      if kill -0 "$candidate_pid" 2>/dev/null; then
        EMACS_PID="$candidate_pid"
        break
      fi
      ;;
  esac
  sleep 1
done
if [ -z "$EMACS_PID" ] || ! client '(emacs-version)' | grep -q GNU; then
  if [ -n "$EMACS_PID" ] && kill -0 "$EMACS_PID" 2>/dev/null; then
    echo "Emacs server never came up (process $EMACS_PID is still alive)" >&2
  elif [ -n "$EMACS_PID" ]; then
    wait "$EMACS_PID"
    emacs_status=$?
    EMACS_PID=""
    echo "Emacs exited before its server came up (status=$emacs_status)" >&2
  else
    echo "Isolated Emacs server never came up" >&2
  fi
  tail -80 "$EMACS_LOG" >&2
  exit 1
fi

open_result="$(client '(let ((file (getenv "NOEMA_MEASURE_NOTE"))) (require '\''init-aaronnote) (setq my/noema-web-port 0) (find-file file) (my/noema-open-file file) "opened")')"
case "$open_result" in
  *'"opened"'*) ;;
  *) echo "Noema open request failed: $open_result" >&2; exit 1 ;;
esac
for _ in $(seq 1 60); do
  ready="$(client '(and my/noema--ready (process-live-p my/noema--process) (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer (eq major-mode '\''xwidget-webkit-mode)))')"
  [ "$ready" = "t" ] && break
  kill -0 "$EMACS_PID" 2>/dev/null || break
  sleep 1
done
if [ "${ready:-nil}" != "t" ]; then
  if ! kill -0 "$EMACS_PID" 2>/dev/null; then
    wait "$EMACS_PID"
    emacs_status=$?
    EMACS_PID=""
    echo "Measurement Emacs exited before Noema became ready (status=$emacs_status)" >&2
    tail -80 "$EMACS_LOG" >&2
    exit 1
  fi
  echo "Noema xwidget/core never became ready: $(client '(list :ready my/noema--ready :process (and my/noema--process (process-status my/noema--process)) :buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)) :mode (and (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer major-mode)) :frames (length (frame-list)) :callbacks (length my/noema--ready-callbacks) :watchdog (timerp my/noema--ready-watchdog) :last-port my/noema--last-port)')" >&2
  echo "Noema web-host log tail:" >&2
  client '(if-let* ((buffer (get-buffer " *Noema web host*"))) (with-current-buffer buffer (buffer-substring-no-properties (max (point-min) (- (point-max) 12000)) (point-max))) "(missing)")' >&2
  echo "Emacs messages tail:" >&2
  client '(if-let* ((buffer (get-buffer "*Messages*"))) (with-current-buffer buffer (buffer-substring-no-properties (max (point-min) (- (point-max) 12000)) (point-max))) "(missing)")' >&2
  tail -80 "$EMACS_LOG" >&2
  exit 1
fi

if [ "$TYPING_MODE" = source ]; then
  client '(with-current-buffer my/noema--app-buffer (xwidget-webkit-execute-script (xwidget-webkit-current-session) "window.dispatchEvent(new CustomEvent(\"aaronnote:command\",{detail:{command:\"toggle-source\"}}))"))' >/dev/null
  sleep 1
fi

# Typing only happens in a foreground pane, so make this one the active client
# and confirm the renderer agrees before attributing any cost to it.
client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (select-frame-set-input-focus (window-frame window)) (select-window window)) (setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
# Multiple Emacs instances share the same application name. Activate the exact
# measurement process so an existing user frame cannot accidentally receive
# the generic `tell application "Emacs" to activate` request.
osascript -e "tell application \"System Events\" to set frontmost of first application process whose unix id is $EMACS_PID to true" >/dev/null 2>&1 || true
typing_activity=""
for _ in $(seq 1 20); do
  client '(setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
  # Foreground resume is deliberately event-debounced by 120 ms. Read the
  # applied state after that boundary instead of repeatedly cancelling and
  # rescheduling it in the same emacsclient request.
  sleep 0.2
  typing_activity="$(client '(with-current-buffer my/noema--app-buffer my/noema--activity-paused)')"
  [ "$typing_activity" = "nil" ] && break
  client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (select-frame-set-input-focus (window-frame window)) (select-window window))' >/dev/null
  osascript -e "tell application \"System Events\" to set frontmost of first application process whose unix id is $EMACS_PID to true" >/dev/null 2>&1 || true
done
if [ "$typing_activity" != "nil" ]; then
  echo "Noema pane is not the active client; refusing to attribute typing cost to a paused renderer" >&2
  echo "Emacs activity diagnostics: $(client '(list :selected-buffer (buffer-name (window-buffer (selected-window))) :app-buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)) :app-window (and (buffer-live-p my/noema--app-buffer) (get-buffer-window my/noema--app-buffer t)) :selected-frame-focus (frame-focus-state (selected-frame)) :selected-frame-visible (frame-visible-p (selected-frame)) :app-active (my/noema--app-buffer-visible-p) :snapshot (mapcar (lambda (entry) (cons (buffer-name (car entry)) (cdr entry))) (my/noema--activity-snapshot)) :paused (and (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer my/noema--activity-paused))))')" >&2
  echo "macOS frontmost process: $(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>&1) pid=$(osascript -e 'tell application "System Events" to get unix id of first application process whose frontmost is true' 2>&1)" >&2
  echo "exact activation result: $(osascript -e "tell application \"System Events\" to set frontmost of first application process whose unix id is $EMACS_PID to true" 2>&1)" >&2
  exit 1
fi

echo "opened $NOTE in $TYPING_MODE mode; settling ${SETTLE}s"
sleep "$SETTLE"

read -r -d '' DRIVER <<'JS' || true
(() => {
  const content = document.querySelector('[data-editor] .cm-content[contenteditable="true"]');
  const host = document.querySelector('[data-editor]');
  if (!content) return 'no-editor';
  const action = 'TYPING_ACTION';
  const probe = {
    done: false,
    typed: 0,
    path: '',
    error: '',
    activeBlankCount: 0,
    blankClassConflicts: 0,
    activeHeightSpreadMaxPx: 0,
    scrollBacktracks: 0,
    scrollBacktrackMaxPx: 0,
  };
  window.__noemaTypingProbe = probe;
  content.focus();
  let previousScrollTop = 0;
  const placeCaretNearViewportEnd = () => {
    const selection = document.getSelection();
    if (!selection) return;
    const mountedLines = Array.from(content.querySelectorAll('.cm-line'));
    const target = mountedLines[Math.max(0, mountedLines.length - 3)] || content;
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  const sampleBlankLayout = () => {
    if (action !== 'enter') return;
    const active = Array.from(content.querySelectorAll('.cm-line.cm-prose-blank-active'));
    probe.activeBlankCount = active.length;
    const heights = active.map((line) => line.getBoundingClientRect().height);
    if (heights.length > 1) {
      const spread = Math.max(...heights) - Math.min(...heights);
      probe.activeHeightSpreadMaxPx = Math.max(probe.activeHeightSpreadMaxPx, spread);
    }
    probe.blankClassConflicts += active.filter((line) => (
      line.classList.contains('cm-prose-paragraph-gap')
      || line.classList.contains('cm-prose-blank-collapsed')
      || line.classList.contains('cm-prose-blank-absorbed')
    )).length;
    if (host) {
      const current = host.scrollTop;
      if (current + 0.5 < previousScrollTop) {
        probe.scrollBacktracks += 1;
        probe.scrollBacktrackMaxPx = Math.max(probe.scrollBacktrackMaxPx, previousScrollTop - current);
      }
      previousScrollTop = current;
    }
  };
  const letters = 'the quick brown fox jumps over a lazy dog '.split('');
  let index = 0;
  const total = TOTAL_KEYS;
  const step = () => {
    if (index >= total) {
      setTimeout(() => { sampleBlankLayout(); probe.done = true; }, 160);
      return;
    }
    try {
      const command = action === 'enter' ? 'insertLineBreak' : 'insertText';
      const value = action === 'enter' ? null : letters[index % letters.length];
      if (document.execCommand(command, false, value)) {
        probe.path = probe.path || (action === 'enter' ? 'execCommand-insertLineBreak' : 'execCommand');
      } else {
        // A CM6 transaction fallback would silently skip the browser editing
        // and DOM-observer path this benchmark exists to measure. Fail closed
        // instead of printing a deceptively cheap result.
        probe.error = `execCommand-false:editable=${content.isContentEditable}:active=${document.activeElement === content}`;
        probe.done = true;
        return;
      }
      probe.typed = index + 1;
    } catch (err) {
      probe.error = String(err && err.message || err);
      probe.done = true;
      return;
    }
    index += 1;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      sampleBlankLayout();
      setTimeout(step, INTERVAL);
    }));
  };
  setTimeout(() => {
    placeCaretNearViewportEnd();
    // DOM selection is observed asynchronously by CM6. Establish the scroll
    // baseline only after that selection transaction and its measured writes
    // have settled, otherwise the probe would report its own setup movement
    // as an Enter backtrack.
    setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(() => {
      previousScrollTop = host ? host.scrollTop : 0;
      step();
    })), 240);
  }, 200);
  return 'started';
})()
JS
DRIVER="${DRIVER//TOTAL_KEYS/$KEYS}"
DRIVER="${DRIVER//INTERVAL/$INTERVAL_MS}"
DRIVER="${DRIVER//TYPING_ACTION/$TYPING_ACTION}"

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
for _ in $(seq 1 "$budget"); do
  sleep 1
  client '(with-current-buffer my/noema--app-buffer (xwidget-webkit-execute-script (xwidget-webkit-current-session) "JSON.stringify(window.__noemaTypingProbe || {})" (lambda (result) (setq my/noema-measure-probe result))))' >/dev/null
  sleep 0.3
  probe="$(client 'my/noema-measure-probe')"
  case "$probe" in *'\"done\":true'*|*'"done":true'*) break ;; esac
done
elapsed=$(( $(date +%s) - started_at ))

probe="$(client 'my/noema-measure-probe')"
echo "driver probe: $probe"
if ! printf '%s' "$probe" | NOEMA_EXPECTED_KEYS="$KEYS" NOEMA_EXPECTED_ACTION="$TYPING_ACTION" python3 -c '
import ast
import json
import os
import sys

try:
    payload = json.loads(ast.literal_eval(sys.stdin.read().strip()))
except Exception:
    raise SystemExit(1)
expected = int(os.environ["NOEMA_EXPECTED_KEYS"])
action = os.environ["NOEMA_EXPECTED_ACTION"]
expected_path = "execCommand-insertLineBreak" if action == "enter" else "execCommand"
valid = (
    payload.get("done") is True
    and payload.get("typed") == expected
    and payload.get("path") == expected_path
    and payload.get("error") == ""
    and (action != "enter" or (
        payload.get("activeBlankCount") == 1
        and payload.get("blankClassConflicts") == 0
        and payload.get("activeHeightSpreadMaxPx", 999) <= 0.5
        and payload.get("scrollBacktracks") == 0
    ))
)
raise SystemExit(0 if valid else 1)
'; then
  echo "typing driver failed; refusing to report a partial or non-DOM benchmark" >&2
  exit 1
fi
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
