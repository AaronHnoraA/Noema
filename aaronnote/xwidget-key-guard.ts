import type { Editor } from "../src/lib.ts";
import type { VimLiteController } from "./vim-lite.ts";
import {
  runEditorDelete,
  runEditorEnter,
  runEditorSoftBreak,
  runEditorMovement,
  runEditorTab,
  type EditorMovementKey,
} from "../src/cm6/input-commands.ts";
import { normalizedEditorKey } from "../src/cm6/focus-quiescence.ts";
import { historyChordKind } from "../src/keymap/shortcut-router.ts";
import { hostInputFocusReleased, pageHasNativeKeyboard, releaseHostInputFocus } from "./host-input-focus.ts";
import { FRAME_KEY_RELAY_MESSAGE } from "../src/frame-key-relay.ts";

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

/**
 * Keep document commands on the persistent CM6 focus root.
 *
 * Structural Vim operations may remove the widget/line that owned the event.
 * Both native WebKit events and host-injected keys call this same guard after
 * a handled command. A real external control (find, menu, MathLive, input)
 * remains authoritative and is never stolen back.
 */
export function restoreEditorFocusAfterCommand(
  editor: Pick<Editor, "focus" | "view">,
): void {
  const recover = (): void => {
    if (!editor.view.dom.isConnected) return;
    const ownerDocument = editor.view.dom.ownerDocument;
    const active = ownerDocument.activeElement;
    if (active instanceof HTMLElement
      && active !== ownerDocument.body
      && active !== ownerDocument.documentElement
      && !editor.view.dom.contains(active)) return;
    editor.focus();
  };
  recover();
  queueMicrotask(recover);
}
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
const MODE_ENTRY_BEFOREINPUT_MS = 25;
let lastHandledKeydown: { editor: Editor; key: string; at: number; enteredInsert: boolean } | null = null;
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
  if (normalizedEditorKey(event) === " ") {
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

function noteHandledKeydown(editor: Editor, key: string, enteredInsert = false): void {
  lastHandledKeydown = { editor, key, at: nowMs(), enteredInsert };
}

function recentlyHandledKeydown(editor: Editor, key: string): boolean {
  return Boolean(
    lastHandledKeydown
      && lastHandledKeydown.editor === editor
      && lastHandledKeydown.key === key
      && nowMs() - lastHandledKeydown.at < DUPLICATE_BEFOREINPUT_MS,
  );
}

function recentlyEnteredInsertWithKey(editor: Editor, key: string): boolean {
  return Boolean(lastHandledKeydown?.enteredInsert
    && lastHandledKeydown.editor === editor
    && lastHandledKeydown.key === key
    && nowMs() - lastHandledKeydown.at < MODE_ENTRY_BEFOREINPUT_MS);
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
    const handled = shiftKey ? runEditorSoftBreak(context.editor.view) : runEditorEnter(context.editor.view);
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
  restoreEditorFocusAfterCommand(context.editor);
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
    // Emacs browser events and forwarded host keys cannot drift in serialization.
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
  restoreEditorFocusAfterCommand(context.editor);
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
  restoreEditorFocusAfterCommand(context.editor);
  return true;
}

export function handleXwidgetVimKeydown(event: KeyboardEvent, context: XwidgetKeyContext): boolean {
  if (!shouldHandleXwidgetVimKey(event, context)) return false;
  const key = normalizedEditorKey(event);
  const beforeMode = context.vim.mode();
  const handled = context.vim.handleKey({
    key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    isComposing: event.isComposing,
  });
  if (!handled) return false;

  hardStop(event);
  noteHandledKeydown(context.editor, key, beforeMode !== "insert" && context.vim.mode() === "insert");
  restoreEditorFocusAfterCommand(context.editor);
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
  restoreEditorFocusAfterCommand(context.editor);
  return true;
}

export function handleXwidgetSpecialBeforeInput(event: InputEvent, context: XwidgetKeyContext): boolean {
  const key = specialKeyFromInputEvent(event);
  if (!shouldHandleXwidgetSpecialEvent(event, context, key)) return false;
  if (key === "Tab") return false; // let CM6 insert \t naturally; snippet expansion happens in keydown
  hardStop(event);
  // WebKit reports Shift-Enter as a line break rather than a paragraph.
  if (!recentlyHandledKeydown(context.editor, key)) runEditorSpecialKey(key, context, event.inputType === "insertLineBreak");
  restoreEditorFocusAfterCommand(context.editor);
  return true;
}

export function handleXwidgetVimBeforeInput(event: InputEvent, context: XwidgetKeyContext): boolean {
  // WebKit can deliver the printable beforeinput paired with a consumed Vim
  // entry key after that key has already switched Normal to Insert. It still
  // belongs to the modal command; otherwise pressing `a` inserts a literal
  // "a" before the user has typed anything in Insert.
  if (context.vim.mode() === "insert"
      && event.inputType === "insertText"
      && typeof event.data === "string"
      && recentlyEnteredInsertWithKey(context.editor, event.data)
      && context.enabled !== false
      && !event.defaultPrevented
      && !event.isComposing
      && !isTextEditingTarget(event.target, context.editorHost)
      && !isTextEditingTarget(document.activeElement, context.editorHost)
      && eventOwnedByEditor(event, context.editorHost, context.allowDetachedTarget !== false)) {
    lastHandledKeydown = null;
    hardStop(event);
    return true;
  }
  if (!shouldHandleXwidgetVimKey(event, context)) return false;
  if (!event.inputType.startsWith("insert") || typeof event.data !== "string" || event.data.length === 0) return false;
  hardStop(event);
  if (event.data.length === 1) {
    if (recentlyHandledKeydown(context.editor, event.data)) lastHandledKeydown = null;
    else {
      context.vim.handleKey({ key: event.data });
      restoreEditorFocusAfterCommand(context.editor);
    }
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

const ARROW_KEYS: Record<string, string> = {
  ArrowLeft: "<left>",
  ArrowRight: "<right>",
  ArrowUp: "<up>",
  ArrowDown: "<down>",
};

function codeToBaseKey(code: string, shifted: boolean): string | null {
  // Arrows complete `C-x <left>` and form the Cmd+Arrow window chords.
  if (ARROW_KEYS[code]) return ARROW_KEYS[code];
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
 * Scope: Option(H-) host chords, C-x/C-c prefixes, C-g, selected Cmd(M-)
 * chords, and plain Cmd+Arrow, which Emacs binds to windmove so every Noema
 * pane moves between Emacs windows the same way.  Ordinary Ctrl keys stay in the shared renderer: CM6/Vim owns text
 * movement and deletion, Ctrl-Z/R/Y history, Ctrl-[ Escape, and Ctrl-Tab/0
 * visual zoom in both the CM6 page and Emacs. Sending those to the inert xwidget
 * placeholder would make the same editor behave differently by host.
 */
export function shouldForwardToEmacs(event: KeyboardEvent): boolean {
  if (event.isComposing) return false;
  // Option = Hyper: forward all H- chords
  if (event.altKey && !event.metaKey && !event.ctrlKey) {
    // Option+Arrow stays with the page (word movement); only letters/digits.
    return !ARROW_KEYS[event.code] && codeToBaseKey(event.code, event.shiftKey) !== null;
  }
  // Cmd+Arrow switches Emacs windows (windmove on M-<arrow>).  Shift+Cmd+Arrow
  // keeps its selection meaning in the page.
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && ARROW_KEYS[event.code]) {
    return true;
  }
  // M-x, M-w, M-W, M-q, and M-o/M-O (ace-window and window swap).
  if (event.metaKey && !event.ctrlKey && !event.altKey && event.code === "KeyO") return true;
  // M-W (Cmd-Shift-W) kills the buffer through Perspective; the page has no
  // Cmd-Shift-W of its own.
  if (event.metaKey && !event.ctrlKey && !event.altKey && event.shiftKey && event.code === "KeyW") return true;
  if (event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
    return event.code === "KeyX" || event.code === "KeyW" || event.code === "KeyQ";
  }
  // Only host-level Ctrl chords leave the renderer. Shift is ignored so
  // xwidget/browser variants such as C-X still become Emacs' C-x.
  if (event.ctrlKey && !event.metaKey && !event.altKey) {
    return event.code === "KeyX" || event.code === "KeyC" || event.code === "KeyG";
  }
  return false;
}

// ── Output frames ────────────────────────────────────────────────────────────
// Sandboxed output frames run `FRAME_KEY_RELAY_SOURCE` (src/frame-key-relay.ts),
// which mirrors the chord and prefix gates above; this side forwards what they
// relay.

type RelayedFrameKey = {
  key?: unknown; code?: unknown;
  ctrlKey?: unknown; metaKey?: unknown; altKey?: unknown; shiftKey?: unknown;
};

/**
 * Forward keys relayed by this page's output frames to Emacs.
 *
 * Only messages from an iframe in this document are accepted.  Each relayed
 * key runs through `handleXwidgetEmacsKeydown`, so a prefix typed in an
 * output and completed there follows the page's own rules.
 */
export function installFrameKeyRelay(options: EmacsKeyForwardOptions, target: Window = window): () => void {
  const controller = new AbortController();
  target.addEventListener("message", (event: MessageEvent) => {
    const data = event.data as (RelayedFrameKey & Record<string, unknown>) | null;
    if (!data || data[FRAME_KEY_RELAY_MESSAGE] !== true) return;
    const fromOwnFrame = Array.from(target.document.querySelectorAll("iframe"))
      .some((frame) => frame.contentWindow !== null && frame.contentWindow === event.source);
    if (!fromOwnFrame) return;
    handleXwidgetEmacsKeydown(new KeyboardEvent("keydown", {
      key: String(data.key ?? ""),
      code: String(data.code ?? ""),
      ctrlKey: data.ctrlKey === true,
      metaKey: data.metaKey === true,
      altKey: data.altKey === true,
      shiftKey: data.shiftKey === true,
      cancelable: true,
    }), options);
  }, { signal: controller.signal });
  return () => controller.abort();
}

/** True while a C-x / C-c prefix waits for its next key. */
export function xwidgetEmacsPrefixPending(): boolean {
  return pendingPrefix !== null;
}

/**
 * Whether the Emacs gate must see EVENT in the capture phase, before CM6.
 *
 * On macOS CM6's default keymap binds Emacs-style Ctrl-a/e/f/b/n/p/d/k/t/v/o
 * and Option-l/u/A.  In the bubble phase such a chord has already moved the
 * cursor (or selected a line) by the time it is forwarded, so `C-c C-e` ran
 * both CM6's line-end and the Emacs command, and `H-l`/`H-u` ran twice.  A
 * pending prefix always claims its next key.  A top-level chord is claimed
 * only from inside the CM6 editor (EDITOR), and never from a native widget
 * input or an active visual-math editor, which keep their own key ownership.
 */
export function claimsXwidgetEmacsKeyEarly(event: KeyboardEvent, editor: HTMLElement): boolean {
  if (pendingPrefix !== null) return true;
  if (!shouldForwardToEmacs(event)) return false;
  const target = targetElement(event.target);
  if (!target || !editor.contains(target)) return false;
  if (target.closest("[data-aaronnote-vim='native'], input, textarea, select")) return false;
  return !visualMathEditingTarget(event.target);
}

type EmacsKeyPayload = string | { key: string; text?: string; client?: string; hostOwned?: boolean };

function forwardEmacsKey(keyString: string, options?: EmacsKeyForwardOptions, hostOwned = false): void {
  const client = options?.client?.() || "";
  const payload: EmacsKeyPayload = client || hostOwned
    ? { key: keyString, ...(client ? { client } : {}), ...(hostOwned ? { hostOwned: true } : {}) }
    : keyString;
  void (window.aaronnoteApi as { emacs?: { key?: (k: EmacsKeyPayload) => unknown } })
    ?.emacs?.key?.(payload);
}

const HOST_OWNED_NAMED_KEYS: Record<string, string> = {
  Enter: "RET",
  Backspace: "DEL",
  Tab: "TAB",
  Escape: "<escape>",
  Delete: "<deletechar>",
  ArrowUp: "<up>",
  ArrowDown: "<down>",
  ArrowLeft: "<left>",
  ArrowRight: "<right>",
  Home: "<home>",
  End: "<end>",
  PageUp: "<prior>",
  PageDown: "<next>",
};

const MODIFIER_ONLY_KEYS = new Set([
  "Shift", "Control", "Alt", "Meta", "OS", "Super", "Hyper", "CapsLock",
  "Fn", "FnLock", "NumLock", "ScrollLock", "AltGraph", "Dead", "Process",
  "Unidentified", "Compose",
]);

type HostOwnedKey = { key: string } | { text: string };

/**
 * The Emacs spelling of the key that completes a `C-x`/`C-c` prefix.
 *
 * Letters, digits and arrows use the physical key, as the chord gate does;
 * every other key uses its named form or its character, so `C-x -`,
 * `C-x ^`, `C-c .`, `C-x RET` and `C-x SPC` all reach Emacs.
 */
function prefixFollowerFromEvent(event: KeyboardEvent): string | null {
  const physical = keyStringFromEvent(event);
  if (physical) return physical;
  const owned = hostOwnedKeyFromEvent(event);
  if (!owned) return null;
  if ("key" in owned) return owned.key;
  return owned.text === " " ? "SPC" : owned.text;
}

/** The Emacs form of EVENT for a host that owns the keyboard, or null. */
export function hostOwnedKeyFromEvent(event: KeyboardEvent): HostOwnedKey | null {
  if (event.isComposing || MODIFIER_ONLY_KEYS.has(event.key)) return null;
  const fkey = /^F(\d{1,2})$/u.exec(event.key);
  const named = HOST_OWNED_NAMED_KEYS[event.key] ?? (fkey ? `<f${fkey[1]}>` : undefined);
  const chord = event.ctrlKey || event.metaKey || event.altKey;
  const prefix = [
    event.ctrlKey ? "C-" : "",
    event.metaKey ? "M-" : "",
    event.altKey ? "H-" : "",
  ].join("");
  if (named) {
    return { key: prefix + (event.shiftKey ? "S-" : "") + named };
  }
  if (chord) {
    // Physical key, as the Emacs chord gate does: Option turns letters into
    // diacritics.  Other printable keys keep their character.
    const plainCtrl = event.ctrlKey && !event.metaKey && !event.altKey;
    const base = codeToBaseKey(event.code, event.shiftKey && !plainCtrl)
      ?? (event.key.length === 1 ? event.key : null);
    return base ? { key: prefix + (base === " " ? "SPC" : base) } : null;
  }
  // Plain text, including non-ASCII characters WebKit delivered as one key.
  return event.key && [...event.key].length === 1 ? { text: event.key } : null;
}

/**
 * Give Emacs a key WebKit received after Emacs took the keyboard.
 *
 * On macOS a clicked WKWebView stays the window's first responder: nothing
 * Emacs can do from Lisp takes the keyboard back, so once Emacs owns it (a
 * forwarded command opened vterm, an agent, the minibuffer...; see
 * `releaseHostInputFocus`) every key still arrives here.  Handled by the page
 * it would edit the note; instead it runs in Emacs' selected window.  Native
 * inputs inside the page (find, dialogs) keep their own keys.
 */
export function handleHostOwnedKey(event: KeyboardEvent, options?: EmacsKeyForwardOptions): boolean {
  if (!hostInputFocusReleased() || !event.isTrusted) return false;
  // Without native focus the page was only offered this key; Emacs gets it
  // natively once the page declines it (see `installNativeKeyboardYield`).
  if (!pageHasNativeKeyboard()) return false;
  const target = targetElement(event.target);
  if (target?.closest("input, textarea, select, [contenteditable='true']")) return false;
  const owned = hostOwnedKeyFromEvent(event);
  if (!owned) return false;
  hardStop(event);
  pendingPrefix = null;
  const client = options?.client?.() || "";
  void (window.aaronnoteApi as { emacs?: { key?: (k: EmacsKeyPayload) => unknown } })
    ?.emacs?.key?.({ ...owned, key: "key" in owned ? owned.key : "", ...(client ? { client } : {}), hostOwned: true });
  return true;
}

/** Compatibility name: navigation keys are a subset of host-owned keys. */
export const handleStrayHostNavigationKey = handleHostOwnedKey;

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
  releaseHostInputFocus();
  forwardEmacsKey(keyString, options);
}

// When the user presses C-x or C-c, we enter prefix mode and capture the
// NEXT keystroke before forwarding. Without this, C-x goes to Emacs but C-f
// still goes to WebKit (which holds OS focus), so "C-x C-f" would never work.
let pendingPrefix: { key: string; client: string } | null = null;

/**
 * Call at the top of the main keydown handler, before editing handlers.
 * Stops the event and forwards to Emacs if the chord matches the forward scope.
 * Prefix keys (C-x, C-c) accumulate the following key before forwarding.
 */
export function handleXwidgetEmacsKeydown(event: KeyboardEvent, options?: EmacsKeyForwardOptions): boolean {
  // A chord offered to a page without native focus belongs to Emacs, which
  // receives it natively: holding `C-x` here as a prefix while the next plain
  // key went straight to Emacs split one sequence across two paths.
  if (!pageHasNativeKeyboard()) {
    pendingPrefix = null;
    return false;
  }
  if (pendingPrefix !== null) {
    const client = options?.client?.() || "";
    // Prefix state belongs to the pane that received its first chord. A click
    // into another retained xwidget must not complete a sibling pane's C-x or
    // C-c sequence.
    if (pendingPrefix.client !== client) {
      pendingPrefix = null;
    } else {
      // C-g while in prefix mode: cancel prefix, forward C-g as keyboard-quit
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.code === "KeyG") {
        pendingPrefix = null;
        forwardEmacsKeyAndReleaseInput(event, "C-g", options);
        return true;
      }
      // Pressing Ctrl again for `C-x C-f`, or Shift for `C-x B`, is not the
      // next key; keep waiting for it.
      if (MODIFIER_ONLY_KEYS.has(event.key)) {
        hardStop(event);
        return true;
      }
      // Any other key completes the sequence: letters, digits, punctuation
      // (`C-x -`, `C-c .`), named keys (`C-x RET`, `C-x SPC`) and arrows.
      if (!event.isComposing) {
        const nextKey = prefixFollowerFromEvent(event);
        if (nextKey) {
          const fullKey = pendingPrefix.key + " " + nextKey;
          pendingPrefix = null;
          forwardEmacsKeyAndReleaseInput(event, fullKey, options);
          return true;
        }
      }
      // A key with no Emacs spelling (IME composition): cancel silently.
      pendingPrefix = null;
      return false;
    }
  }

  if (!shouldForwardToEmacs(event)) return false;
  const key = emacsKeyFromEvent(event);
  if (!key) return false;

  // C-x and C-c are prefix keys — accumulate the next keystroke
  if (key === "C-x" || key === "C-c") {
    hardStop(event);
    pendingPrefix = { key, client: options?.client?.() || "" };
    return true;
  }

  forwardEmacsKeyAndReleaseInput(event, key, options);
  return true;
}
