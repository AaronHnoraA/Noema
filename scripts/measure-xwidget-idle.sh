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
FOCUS_PROBE="${NOEMA_IDLE_FOCUS_PROBE:-none}"
TRACE_ACTIVITY="${NOEMA_IDLE_TRACE_ACTIVITY:-0}"
SERVER="noema-idle-measure-$$"
EMACS_APP="${EMACS_APP:-Emacs}"
EMACS_PID=""
LAUNCHED_EMACS_PID=""
OWNED_PIDS=()
RUN_DIR="$(mktemp -d "/tmp/noema-idle-measure.XXXXXX")"
EMACS_LOG="$RUN_DIR/emacs.log"
SERVER_SOCKET="$RUN_DIR/$SERVER"
WEBKIT_BEFORE="$(ps -eo pid=,comm= | awk '/WebKit\.(WebContent|Networking|GPU)$/ { print $1 }' | tr '\n' ' ')"
EMACS_BEFORE="$(ps -eo pid=,command= | awk '$0 ~ /\/Emacs\.app\/Contents\/MacOS\/Emacs([[:space:]]|$)/ { print $1 }' | tr '\n' ' ')"

if [ -z "$NOTE" ]; then
  echo "usage: $0 <note.md> [settle-seconds] [sample-seconds] [foreground|background]" >&2
  exit 2
fi
case "$SCENE" in foreground|background) ;; *) echo "invalid scene: $SCENE" >&2; exit 2 ;; esac
case "$FOCUS_PROBE" in none|transparent|blur) ;; *) echo "invalid NOEMA_IDLE_FOCUS_PROBE: $FOCUS_PROBE" >&2; exit 2 ;; esac
case "$TRACE_ACTIVITY" in 0|1) ;; *) echo "invalid NOEMA_IDLE_TRACE_ACTIVITY: $TRACE_ACTIVITY" >&2; exit 2 ;; esac

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
    # Reap the exact GUI child before returning. Without this wait, a rapid
    # follow-up run can overlap macOS application teardown even though the old
    # server socket has already disappeared.
    wait "$EMACS_PID" 2>/dev/null || true
  fi
  # A force-stopped Emacs can orphan a child after it was reparented. Only
  # touch the exact descendants captured from this run, and re-check that their
  # command is one of Noema's owned processes before signalling it.
  local pid command
  # macOS Bash 3 treats an empty array expansion as unbound under `set -u`.
  for pid in ${OWNED_PIDS[*]-}; do
    kill -0 "$pid" 2>/dev/null || continue
    command="$(ps -o command= -p "$pid" 2>/dev/null)"
    case "$command" in
      *"/web-host.mjs"*|*"noema-kernel serve"*) kill -TERM "$pid" 2>/dev/null || true ;;
    esac
  done
  case "${RUN_DIR:-}" in
    /tmp/noema-idle-measure.*|/private/tmp/noema-idle-measure.*) /bin/rm -rf "$RUN_DIR" ;;
  esac
}
trap cleanup EXIT INT TERM

dump_failure_context() {
  local process_state="missing"
  if [ -n "$EMACS_PID" ]; then
    process_state="$(ps -o pid=,state=,etime=,command= -p "$EMACS_PID" 2>/dev/null | sed -e 's/^[[:space:]]*//' || true)"
  fi
  echo "measurement Emacs state: ${process_state:-missing}" >&2
  if [ -s "$EMACS_LOG" ]; then
    echo "measurement Emacs log tail:" >&2
    tail -120 "$EMACS_LOG" >&2
  fi
}

echo "starting Emacs behind server socket '$SERVER'"
NOEMA_MEASURE_NOTE="$NOTE" \
  /usr/bin/open -n -a "$EMACS_APP" --args \
  --eval "(progn (require 'server) (setq server-socket-dir \"$RUN_DIR\" server-name \"$SERVER\") (server-start))" \
  >"$EMACS_LOG" 2>&1

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
    emacs_status="exited"
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
    emacs_status="exited"
    echo "Measurement Emacs exited before Noema became ready (status=$emacs_status)" >&2
    dump_failure_context
    EMACS_PID=""
    tail -80 "$EMACS_LOG" >&2
    exit 1
  fi
  echo "Noema xwidget/core never became ready: $(client '(list :ready my/noema--ready :process (and my/noema--process (process-status my/noema--process)) :buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)) :callbacks (length my/noema--ready-callbacks) :watchdog (timerp my/noema--ready-watchdog) :last-port my/noema--last-port)')" >&2
  echo "Noema web-host log tail:" >&2
  client '(if-let* ((buffer (get-buffer " *Noema web host*"))) (with-current-buffer buffer (buffer-substring-no-properties (max (point-min) (- (point-max) 12000)) (point-max))) "(missing)")' >&2
  echo "Emacs messages tail:" >&2
  client '(if-let* ((buffer (get-buffer "*Messages*"))) (with-current-buffer buffer (buffer-substring-no-properties (max (point-min) (- (point-max) 12000)) (point-max))) "(missing)")' >&2
  tail -80 "$EMACS_LOG" >&2
  exit 1
fi

if [ "$SCENE" = background ]; then
  client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (with-selected-window window (switch-to-buffer (get-buffer-create "*Noema measurement background*")))) (setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
else
  client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (select-frame-set-input-focus (window-frame window)) (select-window window)) (setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
  osascript -e "tell application \"System Events\" to set frontmost of first application process whose unix id is $EMACS_PID to true" >/dev/null 2>&1 || true
fi
expected_activity="$(if [ "$SCENE" = background ]; then printf t; else printf nil; fi)"
actual_activity=""
for _ in $(seq 1 20); do
  client '(setq my/noema--last-activity-signature :unknown) (my/noema--update-activity)' >/dev/null
  sleep 0.2
  actual_activity="$(client '(and (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer my/noema--activity-paused))')"
  [ "$actual_activity" = "$expected_activity" ] && break
  if [ "$SCENE" = foreground ]; then
    client '(when-let* ((window (get-buffer-window my/noema--app-buffer t))) (select-frame-set-input-focus (window-frame window)) (select-window window))' >/dev/null
    osascript -e "tell application \"System Events\" to set frontmost of first application process whose unix id is $EMACS_PID to true" >/dev/null 2>&1 || true
  fi
done
if [ "$actual_activity" != "$expected_activity" ]; then
  echo "Noema activity state mismatch for $SCENE: expected paused=$expected_activity, got $actual_activity" >&2
  echo "Emacs activity diagnostics: $(client '(list :selected-buffer (buffer-name (window-buffer (selected-window))) :app-buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)) :app-window (and (buffer-live-p my/noema--app-buffer) (get-buffer-window my/noema--app-buffer t)) :selected-frame-focus (frame-focus-state (selected-frame)) :selected-frame-visible (frame-visible-p (selected-frame)) :app-active (my/noema--app-buffer-visible-p) :snapshot (mapcar (lambda (entry) (cons (buffer-name (car entry)) (cdr entry))) (my/noema--activity-snapshot)) :paused (and (buffer-live-p my/noema--app-buffer) (with-current-buffer my/noema--app-buffer my/noema--activity-paused))))')" >&2
  echo "macOS frontmost process: $(osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true' 2>&1) pid=$(osascript -e 'tell application "System Events" to get unix id of first application process whose frontmost is true' 2>&1)" >&2
  exit 1
fi

if [ "$TRACE_ACTIVITY" = 1 ]; then
  read -r -d '' TRACE_ACTIVITY_JS <<'JS' || true
(() => {
  const types = [
    'keydown', 'beforeinput', 'input', 'compositionstart', 'compositionend',
    'focusin', 'pointerdown', 'pointerup', 'pointercancel', 'mouseup',
    'touchstart', 'wheel', 'paste', 'drop',
  ];
  const trace = { startedAt: performance.now(), events: [], classes: [] };
  const record = (list, value) => {
    if (list.length < 120) list.push({ at: Math.round(performance.now() - trace.startedAt), ...value });
  };
  for (const type of types) document.addEventListener(type, (event) => {
    const target = event.target;
    record(trace.events, {
      type,
      target: target instanceof Element
        ? `${target.tagName}.${String(target.className || '').slice(0, 100)}`
        : String(target),
      trusted: event.isTrusted,
    });
  }, true);
  new MutationObserver(() => record(trace.classes, {
    value: document.documentElement.className,
  })).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  window.__noemaIdleTrace = trace;
})()
JS
  client "(with-current-buffer my/noema--app-buffer (xwidget-webkit-execute-script (xwidget-webkit-current-session) $(printf '%s' "$TRACE_ACTIVITY_JS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')))" >/dev/null
fi

echo "opened $NOTE in $SCENE scene; settling ${SETTLE}s"
sleep "$SETTLE"

if [ "$(client '(and my/noema--ready (process-live-p my/noema--process) (buffer-live-p my/noema--app-buffer))')" != "t" ]; then
  echo "Noema process chain died during settle: $(client '(list :ready my/noema--ready :process (and my/noema--process (process-status my/noema--process)) :buffer (and (buffer-live-p my/noema--app-buffer) (buffer-name my/noema--app-buffer)))')" >&2
  dump_failure_context
  exit 1
fi
actual_activity="$(client '(with-current-buffer my/noema--app-buffer my/noema--activity-paused)')"
if [ "$actual_activity" != "$expected_activity" ]; then
  echo "Noema activity state drifted during settle: expected paused=$expected_activity, got $actual_activity" >&2
  exit 1
fi

case "$FOCUS_PROBE" in
  transparent) FOCUS_PROBE_JS="document.querySelector('[data-editor] .cm-content')?.style.setProperty('caret-color','transparent','important')" ;;
  blur) FOCUS_PROBE_JS="document.querySelector('[data-editor] .cm-content')?.blur()" ;;
  *) FOCUS_PROBE_JS="void 0" ;;
esac
client "(with-current-buffer my/noema--app-buffer (xwidget-webkit-execute-script (xwidget-webkit-current-session) $(printf '%s' "$FOCUS_PROBE_JS" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')))" >/dev/null
sleep 1

read -r -d '' IDLE_AUDIT <<'JS' || true
JSON.stringify((() => {
  const content = document.querySelector('[data-editor] .cm-content');
  const visible = (selector) => {
    const element = document.querySelector(selector);
    return Boolean(element && !element.hidden && getComputedStyle(element).display !== 'none');
  };
  const animations = typeof document.getAnimations === 'function'
    ? document.getAnimations()
      .filter((animation) => animation.playState === 'running')
      .slice(0, 30)
      .map((animation) => {
        const target = animation.effect && animation.effect.target;
        return {
          name: animation.animationName || '',
          target: target ? `${target.tagName || ''}.${String(target.className || '')}` : '',
        };
      })
    : [];
  return {
    hidden: document.hidden,
    paused: document.documentElement.classList.contains('aaronnote-paused'),
    quiescent: document.documentElement.classList.contains('aaronnote-quiescent'),
    editorFocused: document.activeElement === content,
    caretColor: content ? getComputedStyle(content).caretColor : '',
    cmCursorCount: document.querySelectorAll('[data-editor] .cm-cursor').length,
    mathPreviewVisible: visible('.aaronnote-math-preview'),
    snippetVisible: visible('.aaronnote-snippet-popup'),
    animations,
    imageCount: document.images.length,
    images: Array.from(document.images).filter((image) => image.currentSrc || image.src).map((image) => ({
      src: image.currentSrc || image.src,
      paused: image.classList.contains('noema-image-animation-paused'),
    })),
    playingMedia: Array.from(document.querySelectorAll('video, audio'))
      .filter((media) => !media.paused).length,
    idleTrace: window.__noemaIdleTrace || null,
  };
})())
JS
client "(with-current-buffer my/noema--app-buffer (xwidget-webkit-execute-script (xwidget-webkit-current-session) $(printf '%s' "$IDLE_AUDIT" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))') (lambda (result) (setq my/noema-idle-audit result))))" >/dev/null
sleep 0.3
if ! idle_audit="$(client 'my/noema-idle-audit')" \
    || ! kill -0 "$EMACS_PID" 2>/dev/null \
    || [[ "$idle_audit" == *"emacsclient:"* ]]; then
  echo "Measurement Emacs exited before the idle audit completed" >&2
  dump_failure_context
  exit 1
fi
echo "renderer idle audit: $idle_audit"

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
