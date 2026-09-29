/**
 * Detecting that this renderer, not its host, currently owns keyboard input.
 *
 * The Emacs adapter derives each pane's foreground state from Emacs' own
 * window and frame focus. On the macOS xwidget port a click that lands inside
 * the WebKit view can make that view first responder without Emacs selecting
 * the surrounding window, so Emacs keeps reporting the pane as background and
 * the renderer stays paused while the user types into it.
 *
 * A trusted input event is the page's own proof that it holds input focus, and
 * it outranks a stale host activity fact. Only events a background surface
 * cannot receive count: pointer and keyboard acquisition, not wheel or mouse
 * movement, which WKWebView has been observed to deliver to unfocused views.
 * Synthetic events are excluded so the renderer's own replayed keydowns (see
 * `replayEditorKeydown`) can never manufacture foreground state.
 */
const FOREGROUND_PROOF_EVENTS = new Set([
  "keydown",
  "beforeinput",
  "compositionstart",
  "pointerdown",
  "paste",
]);

/**
 * Whether the host has taken the keyboard from this page.
 *
 * Emacs says so when it runs a command forwarded from the page or otherwise
 * moves focus elsewhere.  On macOS WKWebView still receives some keys then
 * (arrows and other function keys are offered to it before Emacs), so while
 * released a keyboard event is not proof of focus: only a real pointer press
 * in the page, or the host's own `focus` command, takes the keyboard back.
 */
let keyboardReleased = false;
const recoveredKeyboardEvents = new WeakSet<KeyboardEvent>();

/** Let only keys explicitly replayed by the Emacs host through the focus gate. */
export function markRecoveredKeyboardEvent(event: KeyboardEvent): void {
  recoveredKeyboardEvents.add(event);
}

type NativeKeyboardHandler = { postMessage?: (message: string) => void };

/**
 * Give the native keyboard back to the Emacs view.
 *
 * Emacs' macOS xwidget (`nsxwidget.m`) installs a `keyDown` script message
 * handler whose "C-g" message runs `makeFirstResponder:` on the Emacs view
 * without relaying any key.  It is the only way to take the keyboard from a
 * clicked WKWebView, and afterwards every key reaches Emacs natively and in
 * order instead of being relayed through the page.  Other hosts lack the
 * handler; there the page keeps relaying host-owned keys.
 */
export function handOffNativeKeyboard(): boolean {
  const handler = (window as unknown as {
    webkit?: { messageHandlers?: { keyDown?: NativeKeyboardHandler } };
  }).webkit?.messageHandlers?.keyDown;
  if (typeof handler?.postMessage !== "function") return false;
  try {
    handler.postMessage("C-g");
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the page holds the native keyboard focus (WebKit is first responder).
 *
 * While it does not, macOS still offers the page key equivalents — Ctrl and
 * Cmd chords, arrows and other function keys — before the Emacs view that
 * owns the keyboard.  Such a key is Emacs', whatever it is.
 */
export function pageHasNativeKeyboard(): boolean {
  return typeof document.hasFocus !== "function" || document.hasFocus();
}

/**
 * Leave a key the page was only offered to Emacs.
 *
 * Installed first, in the capture phase, on every Noema page.  A key that
 * arrives while the page lacks native focus is stopped before any page
 * handler (CM6, Vim, the Emacs chord gate) can act on it, and is deliberately
 * not default-prevented, so WebKit declines it and Emacs handles it natively.
 * There is no list of keys: every key follows the native focus.
 */
export function installNativeKeyboardYield(target: Window = window): () => void {
  const controller = new AbortController();
  target.addEventListener("keydown", (event) => {
    if (pageHasNativeKeyboard() || recoveredKeyboardEvents.has(event)) return;
    event.stopImmediatePropagation();
  }, { capture: true, signal: controller.signal });
  return () => controller.abort();
}

export function releaseHostInputFocus(): void {
  keyboardReleased = true;
  handOffNativeKeyboard();
}

export function reclaimHostInputFocus(): void {
  keyboardReleased = false;
}

export function hostInputFocusReleased(): boolean {
  return keyboardReleased;
}

export function provesHostInputFocus(event: Pick<Event, "type" | "isTrusted">): boolean {
  if (event.isTrusted !== true || !FOREGROUND_PROOF_EVENTS.has(event.type)) return false;
  if (event.type === "pointerdown") return true;
  // A key only offered to an unfocused page proves nothing.
  return !keyboardReleased && pageHasNativeKeyboard();
}

export const hostInputFocusEventTypes: readonly string[] = [...FOREGROUND_PROOF_EVENTS];
