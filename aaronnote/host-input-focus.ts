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

export function provesHostInputFocus(event: Pick<Event, "type" | "isTrusted">): boolean {
  return event.isTrusted === true && FOREGROUND_PROOF_EVENTS.has(event.type);
}

export const hostInputFocusEventTypes: readonly string[] = [...FOREGROUND_PROOF_EVENTS];
