/**
 * The Emacs keyboard contract shared by every Noema page hosted in Emacs.
 *
 * On macOS a WKWebView keeps the keyboard once clicked, so each page, not
 * Emacs, decides where a key goes.  Every page therefore needs the same three
 * rules, and this module is the only place they are installed:
 *
 * 1. Emacs host chords (Option/H-, C-x/C-c prefixes, C-g, the forwarded Cmd
 *    chords and Cmd+Arrow window moves) go to Emacs.
 * 2. After Emacs takes the keyboard (`host-owns-keyboard`), every key WebKit
 *    still receives runs in Emacs' selected window instead of the page.
 * 3. A real press in the page, or the host's `focus` command, gives the
 *    keyboard back to the page.
 *
 * The CM6 editor page (`main.ts`) composes the same primitives into its own
 * capture/bubble pipeline because CM6 and Vim own many keys first; every other
 * page calls `installHostKeyboardBridge` once at startup.  A test enumerates
 * the page entries so a new page cannot silently skip it.
 */
import { handleHostOwnedKey, handleXwidgetEmacsKeydown, installFrameKeyRelay } from "./xwidget-key-guard.ts";
import {
  installNativeKeyboardYield,
  reclaimHostInputFocus,
  releaseHostInputFocus,
} from "./host-input-focus.ts";
import { hostCommandTargetsClient } from "./host-command-target.ts";

export type HostKeyboardOptions = {
  /** This page's Emacs client id, from its URL. */
  client: () => string;
};

/** The page's client id as Emacs addresses it. */
export function pageClientFromLocation(location: Pick<Location, "search"> = window.location): string {
  return new URLSearchParams(location.search).get("client")?.trim() ?? "";
}

type RecoveredKey = {
  key?: unknown; code?: unknown;
  metaKey?: unknown; ctrlKey?: unknown; altKey?: unknown; shiftKey?: unknown;
};

/**
 * Replay a key Emacs received for this page while it lacked native focus.
 *
 * Emacs cannot type into a WKWebView on macOS, so a pane entered from the
 * keyboard gets its keys through the host `key` command.  The replay is an
 * ordinary keydown on the focused element, so each page's own handlers run.
 */
function replayRecoveredKey(detail: RecoveredKey): void {
  const key = String(detail.key ?? "");
  if (!key) return;
  const target = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", {
    key,
    code: String(detail.code ?? ""),
    metaKey: detail.metaKey === true,
    ctrlKey: detail.ctrlKey === true,
    altKey: detail.altKey === true,
    shiftKey: detail.shiftKey === true,
    bubbles: true,
    cancelable: true,
  }));
}

/** Run host keyboard COMMAND for this page; return whether it was one. */
export function runHostKeyboardCommand(command: string, detail: RecoveredKey = {}): boolean {
  switch (command) {
    case "host-owns-keyboard":
      releaseHostInputFocus();
      return true;
    case "focus":
      reclaimHostInputFocus();
      return true;
    case "key":
      replayRecoveredKey(detail);
      return true;
    default:
      return false;
  }
}

export function installHostKeyboardBridge(options: HostKeyboardOptions): () => void {
  const controller = new AbortController();
  const signal = controller.signal;
  const forward = { client: options.client };
  // First: a key offered to a page without native focus is Emacs'.
  const removeYield = installNativeKeyboardYield();
  signal.addEventListener("abort", removeYield);
  // Emacs keys typed inside a sandboxed output frame.
  const removeFrameRelay = installFrameKeyRelay(forward);
  signal.addEventListener("abort", removeFrameRelay);
  // Capture phase: a page's own shortcuts (arrows, Escape, Cmd-Enter...) must
  // not run for a key that belongs to Emacs.
  window.addEventListener("keydown", (event) => {
    if (handleHostOwnedKey(event, forward)) return;
    handleXwidgetEmacsKeydown(event, forward);
  }, { capture: true, signal });
  window.addEventListener("aaronnote:command", (event) => {
    const detail = (event as CustomEvent<RecoveredKey & { command?: unknown }>).detail;
    if (!detail || !hostCommandTargetsClient(detail, options.client())) return;
    runHostKeyboardCommand(String(detail.command ?? ""), detail);
  }, { signal });
  document.addEventListener("pointerdown", (event) => {
    if (event.isTrusted) reclaimHostInputFocus();
  }, { capture: true, signal });
  return () => controller.abort();
}
