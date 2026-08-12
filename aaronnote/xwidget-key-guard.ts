import type { Editor } from "../src/lib.ts";
import type { VimLiteController } from "./vim-lite.ts";
import {
  runEditorDelete,
  runEditorEnter,
  runEditorMovement,
  runEditorTab,
  type EditorMovementKey,
} from "../src/cm6/input-commands.ts";
import { historyChordKind } from "../src/keymap/shortcut-router.ts";

type XwidgetControlKey = "Escape" | "Delete" | "Backspace";
type XwidgetSpecialKey =
  | "Enter"
  | "Tab"
  | "ArrowLeft"
  | "ArrowRight"
  | "ArrowUp"
  | "ArrowDown"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown";
type XwidgetKeyContext = {
  editor: Editor;
  editorHost: HTMLElement;
  vim: Pick<VimLiteController, "handleKey" | "mode" | "setMode">;
  enabled?: boolean;
  /** Emacs/xwidget may report editor-owned keys on body instead of cm-content. */
  allowDetachedTarget?: boolean;
};
type EmacsKeyForwardOptions = {
  client?: () => string | null | undefined;
};

type MathHostKeyDetail = {
  key: string;
  code?: string;
  text?: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

const XWIDGET_CONTROL_KEYS = new Set<XwidgetControlKey>(["Escape", "Delete", "Backspace"]);
const XWIDGET_SPECIAL_KEYS = new Set<XwidgetSpecialKey>([
  "Enter",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);
const XWIDGET_SHIFT_TAB_KEYS = new Set(["Backtab", "ISO_Left_Tab", "Shift-Tab"]);
const DUPLICATE_BEFOREINPUT_MS = 80;
let lastHandledKeydown: { editor: Editor; key: string; at: number } | null = null;
type MathBeforeInputExpectation = {
  editor: Editor;
  at: number;
  kind: "key" | "text" | "modifier-leak";
  key?: string;
  data?: string;
  leakedData?: string[];
};
let lastHandledMathKeydown: MathBeforeInputExpectation | null = null;

function targetElement(target: EventTarget | null): Element | null {
  if (target instanceof Element) return target;
  if (target instanceof Node && target.parentElement) return target.parentElement;
  return null;
}

function visualMathEditingTarget(target: EventTarget | null): boolean {
  let element = targetElement(target);
  if (element?.closest("input, textarea, select, button")) return false;
  while (element) {
    if (element.closest("[data-cm-visual-math='active']")) return true;
    const root = element.getRootNode();
    element = root instanceof ShadowRoot ? root.host : null;
  }
  return false;
}

function dispatchMathHostKey(detail: MathHostKeyDetail): boolean {
  const routed = new CustomEvent<MathHostKeyDetail>("aaronnote:math-host-key", {
    cancelable: true,
    detail,
  });
  document.dispatchEvent(routed);
  return routed.defaultPrevented;
}

function isTextEditingTarget(target: EventTarget | null, editorHost: HTMLElement): boolean {
  const element = targetElement(target);
  if (!element) return false;
  if (element.closest("[data-aaronnote-vim='native']")) return true;
  if (element.closest("input, textarea, select")) return true;
  const editable = element.closest<HTMLElement>("[contenteditable]");
  if (!editable || editable.contentEditable === "false") return false;
  return !(editorHost.contains(editable) && editable.classList.contains("cm-content"));
}

function isInteractiveControlTarget(target: EventTarget | null, editorHost: HTMLElement): boolean {
  const element = targetElement(target);
  if (!element) return false;
  if (editorHost.contains(element) && element.closest(".cm-content")) return false;
  return Boolean(element.closest([
    "button",
    "a[href]",
    "summary",
    "input",
    "textarea",
    "select",
    "[contenteditable]:not([contenteditable='false'])",
    "[role='button']",
    "[role='menuitem']",
    "[role='option']",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",")));
}

function eventOwnedByEditor(
  event: KeyboardEvent | InputEvent,
  editorHost: HTMLElement,
  allowDetachedTarget: boolean,
): boolean {
  if (isInteractiveControlTarget(event.target, editorHost)
      || isInteractiveControlTarget(document.activeElement, editorHost)) return false;
  const target = targetElement(event.target);
  const active = targetElement(document.activeElement);
  if ((target && editorHost.contains(target)) || (active && editorHost.contains(active))) return true;
  return allowDetachedTarget;
}

function hardStop(event: Event): void {
  event.preventDefault();
  event.stopPropagation();
  event.stopImmediatePropagation();
}

function xwidgetControlText(text: string | null): boolean {
  return typeof text === "string" && /[\u0008\u001b\u007f]/u.test(text);
}

function controlKeyFromText(text: string | null): XwidgetControlKey | null {
  if (!xwidgetControlText(text)) return null;
  if (text!.includes("\u001b")) return "Escape";
  if (text!.includes("\u007f")) return "Delete";
  if (text!.includes("\u0008")) return "Backspace";
  return null;
}

function controlKeyFromKeyboardEvent(event: KeyboardEvent): XwidgetControlKey | null {
  if (XWIDGET_CONTROL_KEYS.has(event.key as XwidgetControlKey)) {
    return event.key as XwidgetControlKey;
  }
  if (event.key === "Del" || event.key === "DeleteForward") return "Delete";
  if (event.key === "Esc") return "Escape";
  return controlKeyFromText(event.key);
}

function controlKeyFromInputEvent(event: InputEvent): XwidgetControlKey | null {
  if (event.inputType === "deleteContentBackward") return "Backspace";
  if (event.inputType === "deleteContentForward") return "Delete";
  return controlKeyFromText(event.data);
}

function specialKeyFromKeyboardEvent(event: KeyboardEvent): XwidgetSpecialKey | null {
  if (XWIDGET_SHIFT_TAB_KEYS.has(event.key)) return "Tab";
  if (event.code === "NumpadEnter" || /^(?:Return|RET|CR|NumpadEnter)$/i.test(event.key)) {
    return "Enter";
  }
  return XWIDGET_SPECIAL_KEYS.has(event.key as XwidgetSpecialKey)
    ? event.key as XwidgetSpecialKey
    : null;
}

function printableMathKeyFromKeyboardEvent(event: KeyboardEvent): string {
  // Older xwidget WebKit reports physical Space as "Spacebar" (and some host
  // adapters use "Space"/"SPC") instead of the modern single-space key.
  if (event.code === "Space" || event.key === "Spacebar" || event.key === "Space" || event.key === "SPC") {
    return " ";
  }
  if (event.key === "\\" || /^backslash$/i.test(event.key)
    || (event.code === "Backslash" && !event.shiftKey && (!event.key || event.key === "Unidentified"))) {
    return "\\";
  }
  return event.key;
}

function shiftForSpecialKeyboardEvent(event: KeyboardEvent): boolean {
  return event.shiftKey || XWIDGET_SHIFT_TAB_KEYS.has(event.key);
}

function specialKeyFromInputEvent(event: InputEvent): XwidgetSpecialKey | null {
  if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") return "Enter";
  if (event.inputType === "insertText" && (event.data === "\n" || event.data === "\r")) return "Enter";
  if (event.inputType === "insertText" && event.data === "\t") return "Tab";
  return null;
}

function shouldHandleXwidgetControlEvent(
  event: KeyboardEvent | InputEvent,
  editorHost: HTMLElement,
  key: XwidgetControlKey | null,
  allowDetachedTarget = true,
): key is XwidgetControlKey {
  if (event.defaultPrevented || event.isComposing) return false;
  if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey || event.altKey)) return false;
  if (!key) return false;
  if (isTextEditingTarget(event.target, editorHost)) return false;
  if (isTextEditingTarget(document.activeElement, editorHost)) return false;
  return eventOwnedByEditor(event, editorHost, allowDetachedTarget);
}

function shouldHandleXwidgetSpecialEvent(
  event: KeyboardEvent | InputEvent,
  context: XwidgetKeyContext,
  key: XwidgetSpecialKey | null,
): key is XwidgetSpecialKey {
  if (context.enabled === false || context.vim.mode() !== "insert") return false;
  if (event.defaultPrevented || event.isComposing) return false;
  if (!key) return false;
  if (event instanceof KeyboardEvent && (event.ctrlKey || event.metaKey || event.altKey)) return false;
  if (isTextEditingTarget(event.target, context.editorHost)) return false;
  if (isTextEditingTarget(document.activeElement, context.editorHost)) return false;
  return eventOwnedByEditor(event, context.editorHost, context.allowDetachedTarget !== false);
}

function nowMs(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}

function noteHandledKeydown(editor: Editor, key: string): void {
  lastHandledKeydown = { editor, key, at: nowMs() };
}

function recentlyHandledKeydown(editor: Editor, key: string): boolean {
  return Boolean(
    lastHandledKeydown
      && lastHandledKeydown.editor === editor
      && lastHandledKeydown.key === key
      && nowMs() - lastHandledKeydown.at < DUPLICATE_BEFOREINPUT_MS,
  );
}

function recentMathBeforeInputExpectation(editor: Editor): MathBeforeInputExpectation | null {
  if (!lastHandledMathKeydown
      || lastHandledMathKeydown.editor !== editor
      || nowMs() - lastHandledMathKeydown.at >= DUPLICATE_BEFOREINPUT_MS) {
    lastHandledMathKeydown = null;
    return null;
  }
  return lastHandledMathKeydown;
}

function modifierLeakExpectation(event: KeyboardEvent): Omit<MathBeforeInputExpectation, "editor" | "at"> | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const tokens = [event.code, event.key];
  const physical = tokens.some((token) => token === "BracketLeft" || token === "[")
    ? ["[", "{"]
    : tokens.some((token) => token === "BracketRight" || token === "]")
      ? ["]", "}", "\\"]
      : tokens.some((token) => token === "Slash" || token === "/")
        ? ["/", "?"]
        : null;
  if (!physical) return null;
  if (event.key.length === 1) physical.push(event.key);
  return { kind: "modifier-leak", leakedData: [...new Set(physical)] };
}

function handledMathKeyExpectation(
  event: KeyboardEvent,
  key: string,
): Omit<MathBeforeInputExpectation, "editor" | "at"> | null {
  const modifierLeak = modifierLeakExpectation(event);
  if (modifierLeak) return modifierLeak;
  const control = controlKeyFromKeyboardEvent(event);
  if (control) {
    const forwardBackspace = control === "Backspace"
      && ((event.shiftKey && !event.altKey && !event.metaKey) || (event.ctrlKey && event.shiftKey));
    return { kind: "key", key: forwardBackspace ? "Delete" : control };
  }
  const special = specialKeyFromKeyboardEvent(event);
  if (special === "Enter" || special === "Tab") return { kind: "key", key: special };
  if (!event.metaKey && !event.ctrlKey && !event.altKey && key.length === 1) {
    return { kind: "text", data: key };
  }
  return null;
}

function mathBeforeInputMatches(expectation: MathBeforeInputExpectation, event: InputEvent): boolean {
  if (expectation.kind === "modifier-leak") {
    return event.inputType === "insertText"
      && typeof event.data === "string"
      && Boolean(expectation.leakedData?.includes(event.data));
  }
  if (expectation.kind === "text") {
    return event.inputType === "insertText" && event.data === expectation.data;
  }
  if (expectation.key === "Backspace" && /^delete.*Backward$/u.test(event.inputType)) return true;
  if (expectation.key === "Delete" && /^delete.*Forward$/u.test(event.inputType)) return true;
  return controlKeyFromInputEvent(event) === expectation.key
    || specialKeyFromInputEvent(event) === expectation.key;
}

function runEditorControlKey(key: XwidgetControlKey, context: XwidgetKeyContext): void {
  if (key === "Escape") {
    // Route through Vim so insert-mode Escape applies the same cursor
    // placement semantics as a native CM6 keydown (i/a/I/A differ here).
    context.vim.handleKey({ key: "Escape" });
    context.editor.focus();
    return;
  }

  if (context.vim.mode() === "insert") {
    runEditorDelete(context.editor.view, key === "Backspace" ? "backward" : "forward");
  } else {
    context.vim.handleKey({ key });
  }
  context.editor.focus();
}

function runEditorSpecialKey(key: XwidgetSpecialKey, context: XwidgetKeyContext, shiftKey = false): boolean {
  if (key === "Tab") {
    const handled = runXwidgetTabKey(context.editor, shiftKey);
    if (handled) context.editor.focus();
    return handled;
  }
  if (key === "Enter") {
    const handled = runEditorEnter(context.editor.view);
    if (handled) context.editor.focus();
    return handled;
  }
  const moved = runEditorMovement(context.editor.view, key as EditorMovementKey, shiftKey);
  // Refocusing after formula activation can commit a native math surface.
  if (moved === "cursor") context.editor.focus();
  return Boolean(moved);
}

function runXwidgetTabKey(editor: Editor, shiftKey: boolean): boolean {
  return runEditorTab(editor.view, shiftKey);
}

function shouldHandleXwidgetVimKey(event: KeyboardEvent | InputEvent, context: XwidgetKeyContext): boolean {
  if (context.enabled === false || context.vim.mode() === "insert") return false;
  if (event.defaultPrevented || event.isComposing) return false;
  if (isTextEditingTarget(event.target, context.editorHost)) return false;
  if (isTextEditingTarget(document.activeElement, context.editorHost)) return false;
  return eventOwnedByEditor(event, context.editorHost, context.allowDetachedTarget !== false);
}

function shouldHandleXwidgetHistoryKey(
  event: KeyboardEvent,
  context: XwidgetKeyContext,
  kind: "undo" | "redo" | null,
): kind is "undo" | "redo" {
  if (context.enabled === false) return false;
  if (!kind || event.defaultPrevented || event.isComposing) return false;
  if (isTextEditingTarget(event.target, context.editorHost)) return false;
  if (isTextEditingTarget(document.activeElement, context.editorHost)) return false;
  return eventOwnedByEditor(event, context.editorHost, context.allowDetachedTarget !== false);
}

export function handleXwidgetHistoryKeydown(event: KeyboardEvent, context: XwidgetKeyContext): boolean {
  const kind = historyChordKind(event);
  if (!shouldHandleXwidgetHistoryKey(event, context, kind)) return false;
  hardStop(event);
  if (kind === "undo") context.editor.undo();
  else context.editor.redo();
  context.editor.focus();
  return true;
}

/** Route native/xwidget events through the same adapter as host-injected keys. */
export function handleXwidgetMathKeydown(event: KeyboardEvent, context: XwidgetKeyContext): boolean {
  if (context.enabled === false || event.defaultPrevented || event.isComposing) return false;
  if (!visualMathEditingTarget(event.target) && !visualMathEditingTarget(document.activeElement)) {
    // A genuinely new key outside LiveTeX must not be mistaken for the delayed
    // beforeinput paired with the previous consumed math chord.
    lastHandledMathKeydown = null;
    return false;
  }
  const control = controlKeyFromKeyboardEvent(event);
  const special = specialKeyFromKeyboardEvent(event);
  const shiftTab = XWIDGET_SHIFT_TAB_KEYS.has(event.key);
  const key = control ?? special ?? printableMathKeyFromKeyboardEvent(event);
  // Any new key supersedes an unmatched paired-input expectation. Only keys
  // that can actually emit beforeinput below install a fresh one.
  lastHandledMathKeydown = null;
  const routed = dispatchMathHostKey({
    key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey || shiftTab,
  });
  if (!routed) {
    // The document layer may own this chord (notably Cmd-/). Remember that it
    // originated inside LiveTeX so a synthetic printable beforeinput cannot
    // leak into the formula or the just-restored Markdown editor.
    const expectation = modifierLeakExpectation(event);
    if (expectation) {
      lastHandledMathKeydown = {
        editor: context.editor,
        at: nowMs(),
        ...expectation,
      };
    }
    return false;
  }
  hardStop(event);
  noteHandledKeydown(context.editor, key);
  const expectation = handledMathKeyExpectation(event, key);
  if (expectation) {
    lastHandledMathKeydown = {
      editor: context.editor,
      at: nowMs(),
      ...expectation,
    };
  }
  return true;
}

export function handleXwidgetMathBeforeInput(event: InputEvent, context: XwidgetKeyContext): boolean {
  if (context.enabled === false || event.defaultPrevented || event.isComposing) return false;
  // WebKit/xwidget can emit printable input after a consumed modifier chord
  // (Cmd-], Cmd-/, keyboard-layout variants, etc.). The LiveTeX host may have
  // synchronously closed already, so deduplicate before checking its DOM target.
  const expectation = recentMathBeforeInputExpectation(context.editor);
  if (expectation) {
    if (mathBeforeInputMatches(expectation, event)) {
      hardStop(event);
      lastHandledMathKeydown = null;
      lastHandledKeydown = null;
      return true;
    }
    // Do not let a different input (notably paste, or beforeinput-only Space
    // after navigation) pay for the previous key's deduplication window.
    lastHandledMathKeydown = null;
  }
  if (!visualMathEditingTarget(event.target) && !visualMathEditingTarget(document.activeElement)) return false;
  const key = controlKeyFromInputEvent(event)
    ?? specialKeyFromInputEvent(event)
    // xwidget sometimes omits Space keydown entirely and emits only this
    // beforeinput. Route it through Noema's three-state math Space adapter so
    // Emacs and Noema.app cannot drift into different serialization.
    ?? (event.inputType === "insertText" && event.data === " " ? " " : null)
    // As with beforeinput-only Space, legacy xwidget may omit the physical
    // keydown. Route TeX's command introducer explicitly so it cannot become a
    // literal MathLive backslash atom.
    ?? (event.inputType === "insertText" && event.data === "\\" ? "\\" : null);
  if (!key) return false;
  // A handled keydown can still be followed by WebKit's synthetic beforeinput.
  // Always suppress its control byte, but never execute the operation twice.
  hardStop(event);
  if (!recentlyHandledKeydown(context.editor, key)) {
    dispatchMathHostKey({ key, text: event.data ?? undefined });
  }
  return true;
}

export function handleXwidgetSpecialKeydown(event: KeyboardEvent, context: XwidgetKeyContext): boolean {
  const key = specialKeyFromKeyboardEvent(event);
  if (!shouldHandleXwidgetSpecialEvent(event, context, key)) return false;
  if (!runEditorSpecialKey(key, context, shiftForSpecialKeyboardEvent(event))) return false;
  hardStop(event);
  noteHandledKeydown(context.editor, key);
  return true;
}

export function handleXwidgetControlKeydown(
  event: KeyboardEvent,
  context: XwidgetKeyContext,
): boolean {
  if (context.enabled === false) return false;
  const key = controlKeyFromKeyboardEvent(event);
  if (!shouldHandleXwidgetControlEvent(
    event,
    context.editorHost,
    key,
    context.allowDetachedTarget !== false,
  )) return false;

  hardStop(event);
  noteHandledKeydown(context.editor, key);
  runEditorControlKey(key, context);
  return true;
}

export function handleXwidgetVimKeydown(event: KeyboardEvent, context: XwidgetKeyContext): boolean {
  if (!shouldHandleXwidgetVimKey(event, context)) return false;
  const handled = context.vim.handleKey({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
  });
  if (!handled) return false;

  hardStop(event);
  noteHandledKeydown(context.editor, event.key);
  context.editor.focus();
  return true;
}

export function handleXwidgetControlBeforeInput(event: InputEvent, context: XwidgetKeyContext): boolean {
  if (context.enabled === false) return false;
  const key = controlKeyFromInputEvent(event);
  if (!shouldHandleXwidgetControlEvent(
    event,
    context.editorHost,
    key,
    context.allowDetachedTarget !== false,
  )) return false;
  hardStop(event);
  if (!recentlyHandledKeydown(context.editor, key)) runEditorControlKey(key, context);
  return true;
}

export function handleXwidgetSpecialBeforeInput(event: InputEvent, context: XwidgetKeyContext): boolean {
  const key = specialKeyFromInputEvent(event);
  if (!shouldHandleXwidgetSpecialEvent(event, context, key)) return false;
  if (key === "Tab") return false; // let CM6 insert \t naturally; snippet expansion happens in keydown
  hardStop(event);
  if (!recentlyHandledKeydown(context.editor, key)) runEditorSpecialKey(key, context);
  return true;
}

export function handleXwidgetVimBeforeInput(event: InputEvent, context: XwidgetKeyContext): boolean {
  if (!shouldHandleXwidgetVimKey(event, context)) return false;
  if (!event.inputType.startsWith("insert") || typeof event.data !== "string" || event.data.length === 0) return false;
  hardStop(event);
  if (event.data.length === 1 && !recentlyHandledKeydown(context.editor, event.data)) {
    context.vim.handleKey({ key: event.data });
    context.editor.focus();
  }
  return true;
}

export function shouldGuardXwidgetControlKeydown(event: KeyboardEvent, editorHost: HTMLElement): boolean {
  if (!shouldHandleXwidgetControlEvent(event, editorHost, controlKeyFromKeyboardEvent(event))) return false;
  return true;
}

export function guardXwidgetControlKeydown(event: KeyboardEvent, editorHost: HTMLElement): boolean {
  if (!shouldGuardXwidgetControlKeydown(event, editorHost)) return false;
  hardStop(event);
  return true;
}

export function guardXwidgetControlBeforeInput(event: InputEvent): boolean {
  if (!shouldHandleXwidgetControlEvent(event, document.body, controlKeyFromInputEvent(event))) return false;
  hardStop(event);
  return true;
}

// ── Emacs key forwarding ──────────────────────────────────────────────────────
// macOS modifier mapping from init-macos.el:
//   mac-option-modifier 'hyper  → Option/altKey  → H-
//   mac-command-modifier 'meta  → Cmd/metaKey    → M-
//   Ctrl stays Ctrl             → ctrlKey        → C-
// We use event.code (physical key) not event.key because Option turns letters
// into diacritics (Option+O → "œ").

function codeToBaseKey(code: string, shifted: boolean): string | null {
  const m = /^Key([A-Z])$/.exec(code);
  if (m) return shifted ? m[1].toUpperCase() : m[1].toLowerCase();
  const d = /^Digit(\d)$/.exec(code);
  if (d) return d[1];
  return null;
}

/**
 * Key string for any event — including bare keys (no modifiers).
 * Used to capture the second key of a C-x / C-c prefix sequence.
 */
function keyStringFromEvent(event: KeyboardEvent): string | null {
  const plainCtrl = event.ctrlKey && !event.metaKey && !event.altKey;
  const base = codeToBaseKey(event.code, event.shiftKey && !plainCtrl);
  if (!base) return null;
  const mods: string[] = [];
  if (event.altKey && !event.metaKey && !event.ctrlKey) mods.push("H");
  else if (event.metaKey && !event.ctrlKey && !event.altKey) mods.push("M");
  else if (event.ctrlKey && !event.metaKey && !event.altKey) mods.push("C");
  return mods.length ? mods.join("-") + "-" + base : base;
}

/** Build the Emacs key string for a top-level chord — requires at least one modifier. */
export function emacsKeyFromEvent(event: KeyboardEvent): string | null {
  const key = keyStringFromEvent(event);
  // Must have a modifier prefix to be a top-level forwarded chord
  if (!key || !key.includes("-")) return null;
  return key;
}

/**
 * Returns true when this keystroke should be forwarded to Emacs.
 *
 * Scope: all Option(H-) and bare Ctrl chords, plus selected Cmd(M-) chords.
 * The editor's own Cmd shortcuts (S=save, B/I/K=format, Z/Y=undo) are not
 * captured here and continue to work normally.
 */
export function shouldForwardToEmacs(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  // Option = Hyper: forward all H- chords
  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    return codeToBaseKey(event.code, event.shiftKey) !== null;
  }
  // M-x (Cmd+X), M-w (kill-ring-save), and M-q (fill-paragraph).
  // Cmd+Arrow is deliberately left to CodeMirror/WebKit for native editing.
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    return event.code === "KeyX" || event.code === "KeyW" || event.code === "KeyQ";
  }
  // Bare Ctrl: Emacs-style chords. Shift is ignored for letter chords so
  // xwidget/browser variants such as C-X still become Emacs' C-x.
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return codeToBaseKey(event.code, false) !== null;
  }
  return false;
}

function forwardEmacsKey(keyString: string, options?: EmacsKeyForwardOptions): void {
  const client = options?.client?.() || "";
  const payload = client ? { key: keyString, client } : keyString;
  void (window.aaronnoteApi as { emacs?: { key?: (k: string | { key: string; client?: string }) => unknown } })
    ?.emacs?.key?.(payload);
}

function releaseWebInputFocus(): void {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    active.blur();
  }

  const body = document.body;
  if (!body || document.activeElement === body) return;
  const hadTabIndex = body.hasAttribute("tabindex");
  const previousTabIndex = body.getAttribute("tabindex");
  if (!hadTabIndex) body.setAttribute("tabindex", "-1");
  try {
    body.focus({ preventScroll: true });
  } catch (_) {
    body.focus();
  } finally {
    if (hadTabIndex) {
      body.setAttribute("tabindex", previousTabIndex ?? "");
    } else {
      body.removeAttribute("tabindex");
    }
  }
}

function forwardEmacsKeyAndReleaseInput(event: KeyboardEvent, keyString: string, options?: EmacsKeyForwardOptions): void {
  hardStop(event);
  releaseWebInputFocus();
  forwardEmacsKey(keyString, options);
}

// When the user presses C-x or C-c, we enter prefix mode and capture the
// NEXT keystroke before forwarding. Without this, C-x goes to Emacs but C-f
// still goes to WebKit (which holds OS focus), so "C-x C-f" would never work.
let pendingPrefix: string | null = null;

/**
 * Call at the top of the main keydown handler, before editing handlers.
 * Stops the event and forwards to Emacs if the chord matches the forward scope.
 * Prefix keys (C-x, C-c) accumulate the following key before forwarding.
 */
export function handleXwidgetEmacsKeydown(event: KeyboardEvent, options?: EmacsKeyForwardOptions): boolean {
  if (pendingPrefix !== null) {
    // C-g while in prefix mode: cancel prefix, forward C-g as keyboard-quit
    if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "KeyG") {
      pendingPrefix = null;
      forwardEmacsKeyAndReleaseInput(event, "C-g", options);
      return true;
    }
    // Any other key: complete the prefix sequence
    if (!event.isComposing) {
      const nextKey = keyStringFromEvent(event);
      if (nextKey) {
        const fullKey = pendingPrefix + " " + nextKey;
        pendingPrefix = null;
        forwardEmacsKeyAndReleaseInput(event, fullKey, options);
        return true;
      }
    }
    // Unmappable key (modifier-only, etc.): cancel prefix silently
    pendingPrefix = null;
    return false;
  }

  if (!shouldForwardToEmacs(event)) return false;
  const key = emacsKeyFromEvent(event);
  if (!key) return false;

  // C-x and C-c are prefix keys — accumulate the next keystroke
  if (key === "C-x" || key === "C-c") {
    hardStop(event);
    pendingPrefix = key;
    return true;
  }

  forwardEmacsKeyAndReleaseInput(event, key, options);
  return true;
}
