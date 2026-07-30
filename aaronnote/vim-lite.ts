import type { Editor } from "../src/lib.ts";
import { EditorSelection, findClusterBreak, type Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  graphemeEndPosition,
  previousGraphemePosition,
} from "../src/cm6/text-boundaries.ts";
import { getBlockMathRanges } from "../src/cm6/math-ranges.ts";
import { getOrgEnvHeadingRanges } from "../src/cm6/extensions/visual/widgets/block-extras.ts";
import {
  applyVimJump,
  beginVimJump,
  clearVimJump,
  narrowVimJump,
  previewVimJump,
  type VimJumpDirection,
  type VimJumpSession,
} from "../src/cm6/vim-jump.ts";

export type VimLiteMode = "insert" | "normal" | "visual" | "visual-line";
export type VimLiteFoldAction = "close" | "open" | "toggle" | "close-all" | "open-all";

export type VimLiteKey = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  isComposing?: boolean;
};

export type VimLiteController = {
  mode(): VimLiteMode;
  setMode(mode: VimLiteMode): void;
  syncSelectionFromEditor(): void;
  handleKey(event: VimLiteKey): boolean;
  handleKeyDown(event: KeyboardEvent): boolean;
  destroy(): void;
};

type VimLiteOptions = {
  onModeChange?: (mode: VimLiteMode) => void;
  onUndo?: () => boolean;
  onRedo?: () => boolean;
  onIndent?: (direction: 1 | -1) => boolean;
  onFold?: (action: VimLiteFoldAction) => boolean;
  onFind?: () => boolean;
  jumpTimeoutMs?: number;
};

type VimRegisterKind = "linewise" | "characterwise";

type VimRegister = {
  text: string;
  kind: VimRegisterKind;
};

type LineInfo = {
  start: number;
  end: number;
  column: number;
};

type VimJumpInput = {
  direction: VimJumpDirection;
  needle: string;
  timer: number | null;
};

type VerticalGoal = {
  kind: "pixel" | "column";
  value: number;
};

const AVY_TIMEOUT_MS = 500;

function hasCommandModifier(event: VimLiteKey): boolean {
  return Boolean(event.metaKey || event.altKey || event.ctrlKey);
}

function isEscape(event: VimLiteKey): boolean {
  return event.key === "Escape" || Boolean(event.ctrlKey && event.key === "[");
}

function isUppercaseAsciiLetter(key: string): boolean {
  return /^[A-Z]$/.test(key);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function targetInEditor(host: HTMLElement, target: EventTarget | null): boolean {
  return target instanceof Node && host.contains(target);
}

function editableEventTarget(host: HTMLElement, target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Node) || !host.contains(target)) return null;
  const el = target instanceof Element ? target : target.parentElement;
  const editable = el?.closest<HTMLElement>("input, textarea, select, [contenteditable='true']");
  if (!editable) return null;
  if (editable.classList.contains("cm-content")) return null;
  return editable;
}

function targetUsesNativeInput(host: HTMLElement, target: EventTarget | null): boolean {
  if (!(target instanceof Node) || !host.contains(target)) return false;
  const element = target instanceof Element ? target : target.parentElement;
  return Boolean(element?.closest("[data-aaronnote-vim='native']"));
}

function selectionInEditable(editable: HTMLElement): Selection | null {
  const selection = editable.ownerDocument.getSelection?.() ?? window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const anchor = selection.anchorNode;
  const focus = selection.focusNode;
  if (!anchor || !focus || !editable.contains(anchor) || !editable.contains(focus)) return null;
  return selection;
}

function isRichEditable(editable: HTMLElement): boolean {
  return editable.isContentEditable
    || editable.contentEditable === "true"
    || editable.getAttribute("contenteditable") === "true";
}

function moveEditableSelection(
  editable: HTMLElement,
  direction: "forward" | "backward",
  granularity: "character" | "word" | "line" | "lineboundary",
): boolean {
  const selection = selectionInEditable(editable);
  const modify = (selection as (Selection & {
    modify?: (alter: "move", direction: "forward" | "backward", granularity: string) => void;
  }) | null)?.modify;
  if (typeof modify !== "function" || !selection) return false;
  modify.call(selection, "move", direction, granularity);
  return true;
}

function doc(editor: Editor): Text {
  return editor.view.state.doc;
}

function docLineInfo(text: Text, pos: number): LineInfo {
  const line = text.lineAt(clamp(pos, 0, text.length));
  return { start: line.from, end: line.to, column: clamp(pos, line.from, line.to) - line.from };
}

function docLineRange(text: Text, pos: number): { from: number; to: number; cursor: number } {
  const line = text.lineAt(clamp(pos, 0, text.length));
  const to = line.to < text.length ? line.to + 1 : line.to;
  return { from: line.from, to, cursor: line.from };
}

function docLineSelectionRange(text: Text, anchor: number, head: number): { from: number; to: number } {
  const a = docLineRange(text, anchor);
  const h = docLineRange(text, head);
  return {
    from: Math.min(a.from, h.from),
    to: Math.max(a.to, h.to),
  };
}

function visualCharEndPosition(text: Text, pos: number): number {
  const end = graphemeEndPosition(text, pos);
  // Vim's characterwise Visual mode can select the newline represented by an
  // empty screen line. Without this, `v` on a blank line creates an empty CM6
  // selection and appears to select nothing.
  if (end === pos && pos < text.length && text.sliceString(pos, pos + 1) === "\n") return pos + 1;
  return end;
}

function docCluster(text: Text, pos: number): string {
  if (pos < 0 || pos >= text.length) return "";
  const end = graphemeEndPosition(text, pos);
  return end > pos ? text.sliceString(pos, end) : text.sliceString(pos, pos + 1);
}

function wordChar(ch: string): boolean {
  return /[\p{L}\p{N}_]/u.test(ch);
}

function wordCategory(ch: string, bigWord = false): "space" | "word" | "punctuation" {
  if (!ch || /\s/u.test(ch)) return "space";
  if (bigWord || wordChar(ch)) return "word";
  return "punctuation";
}

function wordMotionPosition(text: Text, start: number, dir: -1 | 1, bigWord = false): number {
  let pos = clamp(start, 0, text.length);
  if (dir > 0) {
    const initial = wordCategory(docCluster(text, pos), bigWord);
    if (initial !== "space") {
      while (pos < text.length && wordCategory(docCluster(text, pos), bigWord) === initial) {
        pos = Math.max(pos + 1, graphemeEndPosition(text, pos));
      }
    }
    while (pos < text.length && wordCategory(docCluster(text, pos), bigWord) === "space") {
      pos = Math.max(pos + 1, graphemeEndPosition(text, pos));
    }
    return pos;
  }

  pos = previousGraphemePosition(text, pos);
  while (pos > 0 && wordCategory(docCluster(text, pos), bigWord) === "space") {
    pos = previousGraphemePosition(text, pos);
  }
  const target = wordCategory(docCluster(text, pos), bigWord);
  while (pos > 0) {
    const previous = previousGraphemePosition(text, pos);
    if (wordCategory(docCluster(text, previous), bigWord) !== target) break;
    pos = previous;
  }
  return pos;
}

function selectionClusterCount(text: Text, from: number, to: number): number {
  let count = 0;
  let pos = clamp(from, 0, text.length);
  const end = clamp(to, pos, text.length);
  while (pos < end) {
    pos = Math.max(pos + 1, graphemeEndPosition(text, pos));
    count += 1;
  }
  return count;
}

function currentHead(editor: Editor): number {
  // The moving end of the selection (CM6 head), not the larger offset — visual
  // mode relies on this to extend a selection backward past its anchor.
  return editor.getMarkdownSelectionRange().head;
}

function setPos(editor: Editor, pos: number): void {
  editor.setMarkdownSelection(clamp(pos, 0, doc(editor).length));
}

function setSelection(editor: Editor, anchor: number, head: number): void {
  // Preserve direction: anchor stays fixed, head is the moving end. The
  // highlighted span is [min,max] either way, but keeping head distinct lets
  // subsequent motions pivot on the correct end.
  const length = doc(editor).length;
  editor.setMarkdownSelection(clamp(anchor, 0, length), clamp(head, 0, length));
}

function normalCharPosition(text: Text, pos: number): number {
  const line = text.lineAt(clamp(pos, 0, text.length));
  if (line.from === line.to) return line.from;
  const relative = clamp(pos - line.from, 0, line.text.length);
  if (relative >= line.text.length) {
    return line.from + findClusterBreak(line.text, line.text.length, false);
  }
  if (relative === 0) return line.from;
  // CM6 normally hands us grapheme boundaries already. Programmatic
  // selections can still land inside a surrogate pair or combining sequence,
  // so repair only those positions without moving a valid boundary left.
  const previous = findClusterBreak(line.text, relative, false);
  const previousEnd = findClusterBreak(line.text, previous, true);
  return line.from + (previousEnd > relative ? previous : relative);
}

function moveNormalCharPosition(text: Text, pos: number, dir: -1 | 1): number {
  const current = normalCharPosition(text, pos);
  const line = text.lineAt(current);
  if (line.from === line.to) return line.from;
  const relative = current - line.from;
  const moved = line.from + findClusterBreak(line.text, relative, dir > 0);
  if (dir > 0 && moved >= line.to) return current;
  return moved;
}

function setNormalPos(editor: Editor, pos: number): void {
  setPos(editor, normalCharPosition(doc(editor), pos));
}

function moveChar(editor: Editor, dir: -1 | 1): void {
  const text = doc(editor);
  const pos = currentHead(editor);
  setPos(editor, moveNormalCharPosition(text, pos, dir));
}

function moveDocumentLine(
  editor: Editor,
  dir: -1 | 1,
  goal: VerticalGoal | null,
  setTarget: (pos: number) => void = (pos) => setNormalPos(editor, pos),
  startPos = currentHead(editor),
): VerticalGoal {
  const text = doc(editor);
  const pos = normalCharPosition(text, startPos);
  const line = docLineInfo(text, pos);
  const desired = goal?.kind === "column" ? goal.value : line.column;
  if (dir < 0 && line.start > 0) {
    const previous = docLineInfo(text, line.start - 1);
    setTarget(Math.min(previous.start + desired, previous.end));
  } else if (dir > 0 && line.end < text.length) {
    const next = docLineInfo(text, line.end + 1);
    setTarget(Math.min(next.start + desired, next.end));
  }
  return { kind: "column", value: desired };
}

function nearestCrossedRange<T extends { from: number; to: number }>(
  ranges: readonly T[],
  start: number,
  target: number,
  dir: -1 | 1,
): T | null {
  let low = 0;
  let high = ranges.length;
  if (dir > 0) {
    // First range whose opening boundary is strictly below the current source
    // position.  Sorted, non-overlapping state fields make later candidates
    // farther away, so only this nearest one can be the next visual entry.
    while (low < high) {
      const mid = (low + high) >> 1;
      if (ranges[mid]!.from <= start) low = mid + 1;
      else high = mid;
    }
    const range = ranges[low];
    return range && target >= range.to ? range : null;
  }

  // Last range whose closing boundary is strictly above the current source
  // position.
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.to < start) low = mid + 1;
    else high = mid;
  }
  const range = ranges[low - 1];
  return range && target <= range.from ? range : null;
}

function crossedVisualEntry(
  editor: Editor,
  start: number,
  target: number,
  dir: -1 | 1,
  column: number,
): number | null {
  // Source mode has no collapsed block widgets.  Besides avoiding unnecessary
  // work, this guard ensures the cached Visual fields never fall back to a
  // document scan during ordinary source navigation.
  if (!editor.view.dom.classList.contains("aaronnote-visual-typography")) return null;

  const state = editor.view.state;
  const entries: Array<{ from: number; to: number; target: number }> = [];
  const mathRanges = getBlockMathRanges(state);

  const mathRange = nearestCrossedRange(mathRanges, start, target, dir);
  if (mathRange) {
    const contentPos = dir > 0
      ? mathRange.contentFrom
      : Math.max(mathRange.contentFrom, mathRange.contentTo - 1);
    const line = state.doc.lineAt(clamp(contentPos, mathRange.from, mathRange.to));
    entries.push({
      from: mathRange.from,
      to: mathRange.to,
      target: Math.min(line.from + column, line.to),
    });
  }

  const orgHeading = nearestCrossedRange(getOrgEnvHeadingRanges(state), start, target, dir);
  if (orgHeading) {
    entries.push({ from: orgHeading.from, to: orgHeading.to, target: orgHeading.anchor });
  }

  // A semantic block may absorb its adjacent blank line to zero visual height.
  // CM6's pixel motion can then cross that document line going down even though
  // the reverse motion happens to land on it.  Treat the first crossed blank as
  // an explicit visual entry in both directions.  Stop before the nearest
  // replacement widget so a large formula never turns this into a source scan.
  const startLine = state.doc.lineAt(start).number;
  const targetLine = state.doc.lineAt(target).number;
  const nearestReplacement = entries.length === 0
    ? null
    : entries.reduce((nearest, entry) => {
        if (!nearest) return entry;
        return dir > 0
          ? (entry.from < nearest.from ? entry : nearest)
          : (entry.to > nearest.to ? entry : nearest);
      }, null as { from: number; to: number; target: number } | null);
  const replacementLine = nearestReplacement == null
    ? null
    : state.doc.lineAt(dir > 0 ? nearestReplacement.from : nearestReplacement.to).number;
  const lastLine = dir > 0
    ? Math.min(targetLine, replacementLine == null ? targetLine : replacementLine - 1)
    : Math.max(targetLine, replacementLine == null ? targetLine : replacementLine + 1);

  for (
    let lineNumber = startLine + dir;
    dir > 0 ? lineNumber <= lastLine : lineNumber >= lastLine;
    lineNumber += dir
  ) {
    const line = state.doc.line(lineNumber);
    if (line.text.trim().length !== 0) continue;
    entries.push({ from: line.from, to: line.to, target: line.from });
    break;
  }

  if (entries.length === 0) return null;
  entries.sort((left, right) => dir > 0 ? left.from - right.from : right.to - left.to);
  return entries[0]!.target;
}

function moveScreenLine(editor: Editor, dir: -1 | 1, goal: VerticalGoal | null): VerticalGoal {
  const rect = editor.view.contentDOM.getBoundingClientRect();
  // A detached/hidden editor has no usable layout. Preserve keyboard access
  // with a logical-line fallback until CM6 can measure real screen rows.
  if (rect.width <= 0 || rect.height <= 0) return moveDocumentLine(editor, dir, goal);

  const text = doc(editor);
  const start = normalCharPosition(text, currentHead(editor));
  const coords = editor.view.coordsAtPos(start);
  const pixelGoal = goal?.kind === "pixel"
    ? goal.value
    : coords
      ? coords.left - rect.left
      : editor.view.defaultCharacterWidth * docLineInfo(text, start).column;
  const range = EditorSelection.cursor(
    start,
    0,
    undefined,
    pixelGoal,
  );
  const moved = editor.view.moveVertically(range, dir > 0);
  const entry = crossedVisualEntry(editor, start, moved.head, dir, docLineInfo(text, start).column);
  setNormalPos(editor, entry ?? moved.head);
  return { kind: "pixel", value: moved.goalColumn ?? pixelGoal };
}

function lineBoundary(editor: Editor, which: "start" | "end"): void {
  const text = doc(editor);
  const pos = normalCharPosition(text, currentHead(editor));
  const line = docLineInfo(text, pos);
  setNormalPos(editor, which === "start" ? line.start : line.end);
}

function lineEndInsertBoundary(editor: Editor): void {
  const text = doc(editor);
  const line = text.lineAt(clamp(currentHead(editor), 0, text.length));
  setPos(editor, line.to);
}

function lineFirstNonBlank(editor: Editor): number {
  const text = doc(editor);
  const line = text.lineAt(clamp(currentHead(editor), 0, text.length));
  const first = line.text.search(/\S/u);
  return first < 0 ? line.from : line.from + first;
}

function docBoundary(editor: Editor, which: "start" | "end"): void {
  setNormalPos(editor, which === "start" ? 0 : doc(editor).length);
}

function moveWord(editor: Editor, dir: -1 | 1, bigWord = false): void {
  const text = doc(editor);
  setNormalPos(editor, wordMotionPosition(text, currentHead(editor), dir, bigWord));
}

function deleteChar(editor: Editor): string {
  const text = doc(editor);
  const { from, to } = editor.getMarkdownSelection();
  const start = from === to ? normalCharPosition(text, from) : from;
  const line = text.lineAt(start);
  const end = from === to ? Math.min(graphemeEndPosition(text, start), line.to) : to;
  if (start >= end) return "";
  const deleted = text.sliceString(start, end);
  editor.replaceMarkdownRange(start, end, "", "start");
  return deleted;
}

function deleteCharBackward(editor: Editor): string {
  const text = doc(editor);
  const { from, to } = editor.getMarkdownSelection();
  if (from !== to) return deleteChar(editor);
  const pos = normalCharPosition(text, from);
  const line = text.lineAt(pos);
  if (pos <= line.from) return "";
  const start = previousGraphemePosition(text, pos);
  const deleted = text.sliceString(start, pos);
  editor.replaceMarkdownRange(start, pos, "", "start");
  return deleted;
}

function deleteLine(editor: Editor): string {
  const text = doc(editor);
  const { from, to } = editor.getMarkdownSelection();
  const range = to > from ? { from, to } : docLineRange(text, from);
  if (range.from >= range.to) return "";
  const deleted = text.sliceString(range.from, range.to);
  const fallbackPos = range.from > 0 && range.to >= text.length ? range.from - 1 : range.from;
  editor.replaceMarkdownRange(range.from, range.to, "", "start");
  setPos(editor, fallbackPos);
  return deleted;
}

function currentSelectionText(editor: Editor): string {
  const { from, to } = editor.getMarkdownSelection();
  return from < to ? doc(editor).sliceString(from, to) : "";
}

function replaceChar(editor: Editor, ch: string): number | null {
  const text = doc(editor);
  const { from, to } = editor.getMarkdownSelection();
  const start = from === to ? normalCharPosition(text, from) : from;
  const line = text.lineAt(start);
  const end = from === to ? Math.min(graphemeEndPosition(text, start), line.to) : to;
  if (start >= end) return null;
  editor.replaceMarkdownRange(start, end, ch.repeat(Math.max(1, selectionClusterCount(text, start, end))), "end");
  return start;
}

function openLine(editor: Editor, where: "above" | "below"): void {
  const text = doc(editor);
  const pos = editor.getMarkdownSelection().from;
  const line = docLineInfo(text, pos);
  const insertAt = where === "above" ? line.start : line.end;
  editor.replaceMarkdownRange(insertAt, insertAt, "\n", "end");
  setPos(editor, where === "above" ? insertAt : insertAt + 1);
}

export function createVimLite(
  editor: Editor,
  host: HTMLElement,
  options: VimLiteOptions = {},
): VimLiteController {
  let mode: VimLiteMode = "insert";
  let goalColumn: VerticalGoal | null = null;
  let pending = "";
  let jumpInput: VimJumpInput | null = null;
  let jumpSession: VimJumpSession | null = null;
  let jumpLabelPrefix = "";
  let visualAnchor: number | null = null;
  let visualHead: number | null = null;
  let insertEntry: { doc: Text; boundary: number; returnPos: number } | null = null;
  let register: VimRegister = { text: "", kind: "characterwise" };
  let destroyed = false;
  let asyncEpoch = 0;
  const jumpTimeoutMs = Math.max(0, options.jumpTimeoutMs ?? AVY_TIMEOUT_MS);
  // Tracks the in-flight system clipboard write so paste() can wait for it
  // before reading back. Avoids the dd→p race where writeText is async.
  let pendingClipboardWrite: Promise<void> = Promise.resolve();

  function writeSystemClipboard(text: string): Promise<void> {
    if (typeof window !== "undefined" && window.location.protocol === "about:") {
      return Promise.resolve();
    }
    const hasHostBridge = typeof window !== "undefined"
      && Boolean((window as unknown as { aaronnoteApi?: unknown }).aaronnoteApi);
    const canUseHostClipboard = typeof window !== "undefined"
      && (window.location.hostname === "127.0.0.1" || hasHostBridge);
    const writeHostClipboard = (): Promise<void> => {
      if (!canUseHostClipboard) return Promise.resolve();
      return fetch("/api/clipboard", {
        method: "POST",
        headers: { "Content-Type": "text/plain; charset=utf-8" },
        body: text,
      }).then(() => {}).catch(() => {});
    };
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      return navigator.clipboard.writeText(text).catch(() => writeHostClipboard());
    }
    return writeHostClipboard();
  }

  function yank(text: string, kind: VimRegisterKind = "characterwise"): void {
    if (!text) return;
    const registerText = kind === "linewise" && !text.endsWith("\n") ? `${text}\n` : text;
    register = { text: registerText, kind };
    (window as unknown as Record<string, unknown>).__aaronoteVimRegister = register;
    pendingClipboardWrite = writeSystemClipboard(registerText);
  }

  function resetMotionMemory(): void {
    goalColumn = null;
  }

  function clearJumpInputTimer(): void {
    if (jumpInput?.timer != null) {
      window.clearTimeout(jumpInput.timer);
      jumpInput.timer = null;
    }
  }

  function cancelJump(): void {
    const hadJump = jumpInput !== null || jumpSession !== null;
    pending = "";
    clearJumpInputTimer();
    jumpInput = null;
    jumpSession = null;
    jumpLabelPrefix = "";
    if (hadJump) clearVimJump(editor.view);
  }

  function finishJumpInput(): boolean {
    const input = jumpInput;
    if (!input) return false;
    clearJumpInputTimer();
    jumpInput = null;
    if (!input.needle) {
      clearVimJump(editor.view);
      return true;
    }

    const session = beginVimJump(editor.view, input.needle, input.direction);
    if (session.candidates.length === 0) {
      clearVimJump(editor.view);
      return true;
    }
    if (session.candidates.length === 1) {
      applyVimJump(editor.view, session, session.candidates[0]!.label);
      return true;
    }
    jumpSession = session;
    return true;
  }

  function scheduleJumpInputTimeout(input: VimJumpInput): void {
    clearJumpInputTimer();
    if (!input.needle) return;
    input.timer = window.setTimeout(() => {
      if (jumpInput === input) finishJumpInput();
    }, jumpTimeoutMs);
  }

  function updateJumpInputPreview(input: VimJumpInput): void {
    if (!input.needle) {
      clearVimJump(editor.view);
      return;
    }
    previewVimJump(editor.view, input.needle, input.direction);
  }

  function startJumpInput(direction: VimJumpDirection): void {
    cancelJump();
    jumpInput = { direction, needle: "", timer: null };
    resetMotionMemory();
  }

  function handleJumpInputKey(key: string): boolean {
    const input = jumpInput;
    if (!input) return false;

    if (key === "Enter") return finishJumpInput();

    if (key === "Backspace" || key === "Delete" || key === "\b" || key === "\u007f") {
      input.needle = input.needle.slice(0, -1);
      updateJumpInputPreview(input);
      scheduleJumpInputTimeout(input);
      return true;
    }

    if (key.length !== 1) {
      cancelJump();
      return true;
    }

    if (isUppercaseAsciiLetter(key)) return true;

    input.needle += key;
    updateJumpInputPreview(input);
    scheduleJumpInputTimeout(input);
    return true;
  }

  function setMode(next: VimLiteMode): void {
    const previous = mode;
    const changed = mode !== next;
    const leavingVisual = previous === "visual" || previous === "visual-line";
    const exitHead = leavingVisual ? (visualHead ?? currentHead(editor)) : currentHead(editor);
    mode = next;
    cancelJump();
    visualAnchor = null;
    visualHead = null;
    if (next !== "insert" || previous !== "insert") insertEntry = null;
    resetMotionMemory();
    if (leavingVisual && next !== "visual" && next !== "visual-line") {
      if (next === "normal") setNormalPos(editor, exitHead);
      else setPos(editor, exitHead);
    } else if (previous === "insert" && next === "normal") {
      setNormalPos(editor, exitHead);
    }
    if (changed) options.onModeChange?.(mode);
  }

  function insertExitPosition(text: Text, pos: number): number {
    const cursor = clamp(pos, 0, text.length);
    const line = text.lineAt(cursor);
    if (line.from === line.to || cursor <= line.from) return line.from;
    return previousGraphemePosition(text, Math.min(cursor, line.to));
  }

  function enterInsert(returnPosWhenUnchanged: number | null = null): void {
    setMode("insert");
    insertEntry = returnPosWhenUnchanged == null
      ? null
      : {
          doc: doc(editor),
          boundary: currentHead(editor),
          returnPos: normalCharPosition(doc(editor), returnPosWhenUnchanged),
        };
  }

  function escapeToNormal(): void {
    if (mode !== "insert") {
      setMode("normal");
      return;
    }
    const text = doc(editor);
    const target = insertEntry?.doc === text && insertEntry.boundary === currentHead(editor)
      ? insertEntry.returnPos
      : insertExitPosition(text, currentHead(editor));
    setMode("normal");
    setNormalPos(editor, target);
  }

  // The tracked moving end of the visual selection. Prefer the local
  // visualHead (authoritative once visual mode is driving the selection) and
  // fall back to the editor's live head when first entering visual mode.
  function headPos(): number {
    return visualHead ?? currentHead(editor);
  }

  function setVisualHead(head: number): void {
    const text = doc(editor);
    if (visualAnchor == null) visualAnchor = normalCharPosition(text, currentHead(editor));
    visualHead = normalCharPosition(text, head);
    if (visualHead >= visualAnchor) {
      setSelection(editor, visualAnchor, visualCharEndPosition(text, visualHead));
    } else {
      setSelection(editor, visualCharEndPosition(text, visualAnchor), visualHead);
    }
  }

  function swapVisualEnds(): void {
    if (visualAnchor == null || visualHead == null) return;
    const previousAnchor = visualAnchor;
    visualAnchor = visualHead;
    setVisualHead(previousAnchor);
  }

  function switchToVisualLine(): void {
    const anchor = visualAnchor ?? currentHead(editor);
    const head = visualHead ?? currentHead(editor);
    const changed = mode !== "visual-line";
    mode = "visual-line";
    visualAnchor = anchor;
    visualHead = head;
    resetMotionMemory();
    const range = docLineSelectionRange(doc(editor), anchor, head);
    setSelection(editor, range.from, range.to);
    if (changed) options.onModeChange?.(mode);
  }

  function switchToVisualChar(): void {
    const anchor = normalCharPosition(doc(editor), visualAnchor ?? currentHead(editor));
    const head = normalCharPosition(doc(editor), visualHead ?? currentHead(editor));
    const changed = mode !== "visual";
    mode = "visual";
    visualAnchor = anchor;
    visualHead = head;
    resetMotionMemory();
    setVisualHead(head);
    if (changed) options.onModeChange?.(mode);
  }

  function enterVisual(): void {
    const head = normalCharPosition(doc(editor), currentHead(editor));
    setMode("visual");
    visualAnchor = head;
    setVisualHead(head);
  }

  function enterVisualLine(): void {
    const head = currentHead(editor);
    setMode("visual-line");
    visualAnchor = head;
    visualHead = head;
    const range = docLineSelectionRange(doc(editor), visualAnchor, visualHead);
    setSelection(editor, range.from, range.to);
  }

  function visualMoveChar(dir: -1 | 1): void {
    resetMotionMemory();
    setVisualHead(moveNormalCharPosition(doc(editor), headPos(), dir));
  }

  function visualMoveLine(dir: -1 | 1): void {
    const text = doc(editor);
    const start = normalCharPosition(text, headPos());
    const rect = editor.view.contentDOM.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      goalColumn = moveDocumentLine(editor, dir, goalColumn, setVisualHead, start);
      return;
    }
    const coords = editor.view.coordsAtPos(start);
    const pixelGoal = goalColumn?.kind === "pixel"
      ? goalColumn.value
      : coords
        ? coords.left - rect.left
        : editor.view.defaultCharacterWidth * docLineInfo(text, start).column;
    const range = EditorSelection.cursor(
      start,
      0,
      undefined,
      pixelGoal,
    );
    const moved = editor.view.moveVertically(range, dir > 0);
    goalColumn = { kind: "pixel", value: moved.goalColumn ?? pixelGoal };
    const entry = crossedVisualEntry(editor, start, moved.head, dir, docLineInfo(text, start).column);
    setVisualHead(entry ?? moved.head);
  }

  function visualLineMove(dir: -1 | 1): void {
    const text = doc(editor);
    const current = docLineRange(text, headPos());
    let nextPos = dir > 0 ? current.to : Math.max(0, current.from - 1);
    if (dir > 0 && current.to >= text.length) nextPos = current.cursor;
    const next = docLineRange(text, nextPos);
    visualHead = next.cursor;
    const range = docLineSelectionRange(text, visualAnchor ?? next.cursor, visualHead);
    setSelection(editor, range.from, range.to);
    editor.view.dispatch({ effects: EditorView.scrollIntoView(visualHead, { y: "nearest" }) });
  }

  function visualLineBoundary(which: "start" | "end"): void {
    resetMotionMemory();
    const line = docLineInfo(doc(editor), headPos());
    setVisualHead(which === "start" ? line.start : normalCharPosition(doc(editor), line.end));
  }

  function visualMoveWord(dir: -1 | 1, bigWord = false): void {
    resetMotionMemory();
    const text = doc(editor);
    setVisualHead(normalCharPosition(text, wordMotionPosition(text, headPos(), dir, bigWord)));
  }

  function syncSelectionFromEditor(): void {
    const text = doc(editor);
    const { anchor, head } = editor.getMarkdownSelectionRange();
    if (anchor === head) {
      if (mode === "visual" || mode === "visual-line") {
        visualHead = head;
        setMode("normal");
      }
      return;
    }

    cancelJump();
    const forward = head > anchor;
    visualAnchor = normalCharPosition(text, forward ? anchor : previousGraphemePosition(text, anchor));
    visualHead = normalCharPosition(text, forward ? previousGraphemePosition(text, head) : head);
    const changed = mode !== "visual";
    mode = "visual";
    resetMotionMemory();
    if (changed) options.onModeChange?.(mode);
  }

  function deleteLineCommand(): void {
    resetMotionMemory();
    yank(deleteLine(editor), "linewise");
    if (mode === "visual" || mode === "visual-line") visualHead = currentHead(editor);
    setMode("normal");
  }

  function yankSelection(kind: VimRegisterKind = "characterwise"): void {
    resetMotionMemory();
    const start = editor.getMarkdownSelection().from;
    yank(currentSelectionText(editor), kind);
    visualHead = start;
    setMode("normal");
  }

  function yankLine(): void {
    resetMotionMemory();
    const text = doc(editor);
    const range = docLineRange(text, editor.getMarkdownSelection().from);
    if (range.from < range.to) yank(text.sliceString(range.from, range.to), "linewise");
    setMode("normal");
  }

  function paste(where: "before" | "after"): void {
    resetMotionMemory();
    const placement = register.kind === "linewise"
      ? { kind: "line" as const, where }
      : { kind: "character" as const, where };
    // Capture the current register in case it changes before the async path runs.
    const localRegister = register;
    const pending = pendingClipboardWrite;
    const epoch = asyncEpoch;
    window.setTimeout(() => {
      if (destroyed || epoch !== asyncEpoch) return;
      void (async () => {
        // Wait for any in-flight clipboard write to land before reading back.
        // 400 ms guard prevents a stalled write from blocking paste indefinitely.
        await Promise.race([pending, new Promise<void>((r) => setTimeout(r, 400))]);
        if (destroyed || epoch !== asyncEpoch) return;
        const handled = await editor.pasteFromClipboard({ placement });
        if (!handled && localRegister.text) {
          editor.pastePlainText(localRegister.text, { placement });
        }
      })().finally(() => {
        if (!destroyed && epoch === asyncEpoch) setMode("normal");
      });
    }, 0);
  }

  function foldCommand(action: VimLiteFoldAction): boolean {
    resetMotionMemory();
    return options.onFold?.(action) ?? true;
  }

  function appendChar(): void {
    const text = doc(editor);
    const pos = normalCharPosition(text, currentHead(editor));
    const line = docLineInfo(text, pos);
    setPos(editor, Math.min(line.end, graphemeEndPosition(text, pos)));
    enterInsert();
  }

  function editableNormalCommand(key: string, editable: HTMLElement): boolean {
    if (!isRichEditable(editable)) {
      if (key === "i" || key === "a") {
        enterInsert();
        return true;
      }
      pending = "";
      return key.length === 1;
    }

    const move = (
      direction: "forward" | "backward",
      granularity: "character" | "word" | "line" | "lineboundary",
    ): boolean => {
      resetMotionMemory();
      return moveEditableSelection(editable, direction, granularity);
    };

    switch (key) {
      case "h":
      case "ArrowLeft":
      case "Backspace":
        move("backward", "character");
        return true;
      case "l":
      case "ArrowRight":
      case " ":
        move("forward", "character");
        return true;
      case "j":
        move("forward", "line");
        return true;
      case "k":
        move("backward", "line");
        return true;
      case "ArrowDown":
      case "ArrowUp":
        return false;
      case "0":
        move("backward", "lineboundary");
        return true;
      case "$":
        move("forward", "lineboundary");
        return true;
      case "w":
        move("forward", "word");
        return true;
      case "b":
        move("backward", "word");
        return true;
      case "i":
        enterInsert();
        return true;
      case "a":
        move("forward", "character");
        enterInsert();
        return true;
      case "Escape":
        setMode("normal");
        return true;
      default:
        pending = "";
        return key.length === 1;
    }
  }

  function normalCommand(key: string): boolean {
    if (jumpSession) {
      const session = jumpSession;
      if (key.length !== 1 || isUppercaseAsciiLetter(key)) {
        cancelJump();
        return true;
      }
      jumpLabelPrefix += key;
      const exact = session.candidates.find((candidate) => candidate.label === jumpLabelPrefix);
      if (exact) {
        jumpSession = null;
        jumpLabelPrefix = "";
        applyVimJump(editor.view, session, exact.label);
      } else {
        const candidates = narrowVimJump(editor.view, session, jumpLabelPrefix);
        if (candidates.length === 0) cancelJump();
      }
      return true;
    }
    if (jumpInput) return handleJumpInputKey(key);
    if (pending === "d") {
      pending = "";
      if (key === "d") {
        deleteLineCommand();
        return true;
      }
      return true;
    }
    if (pending === "y") {
      pending = "";
      if (key === "y") {
        yankLine();
        return true;
      }
      return true;
    }
    if (pending === "r") {
      pending = "";
      if (key.length === 1) {
        resetMotionMemory();
        const replacedFrom = replaceChar(editor, key);
        if (replacedFrom != null) setNormalPos(editor, replacedFrom);
        setMode("normal");
      }
      return true;
    }
    if (pending === "g") {
      pending = "";
      if (key === "g") {
        resetMotionMemory();
        docBoundary(editor, "start");
      }
      return true;
    }
    if (pending === "z") {
      pending = "";
      switch (key) {
        case "c":
          return foldCommand("close");
        case "o":
          return foldCommand("open");
        case "a":
          return foldCommand("toggle");
        case "M":
          return foldCommand("close-all");
        case "R":
          return foldCommand("open-all");
        default:
          return true;
      }
    }
    if (pending === ">") {
      pending = "";
      if (key === ">") {
        resetMotionMemory();
        options.onIndent?.(1);
      }
      return true;
    }
    if (pending === "<") {
      pending = "";
      if (key === "<") {
        resetMotionMemory();
        options.onIndent?.(-1);
      }
      return true;
    }
    switch (key) {
      case "h":
      case "ArrowLeft":
      case "Backspace":
        resetMotionMemory();
        moveChar(editor, -1);
        return true;
      case "l":
      case "ArrowRight":
      case " ":
        resetMotionMemory();
        moveChar(editor, 1);
        return true;
      case "j":
      case "ArrowDown":
        goalColumn = moveScreenLine(editor, 1, goalColumn);
        return true;
      case "k":
      case "ArrowUp":
        goalColumn = moveScreenLine(editor, -1, goalColumn);
        return true;
      case "0":
        resetMotionMemory();
        lineBoundary(editor, "start");
        return true;
      case "$":
        resetMotionMemory();
        lineBoundary(editor, "end");
        return true;
      case "w":
        resetMotionMemory();
        moveWord(editor, 1);
        return true;
      case "W":
        resetMotionMemory();
        moveWord(editor, 1, true);
        return true;
      case "b":
        resetMotionMemory();
        moveWord(editor, -1);
        return true;
      case "B":
        resetMotionMemory();
        moveWord(editor, -1, true);
        return true;
      case "u":
        return options.onUndo?.() ?? false;
      case "g":
        pending = "g";
        return true;
      case "z":
        pending = "z";
        return true;
      case "G":
        resetMotionMemory();
        docBoundary(editor, "end");
        return true;
      case "i":
        enterInsert(normalCharPosition(doc(editor), currentHead(editor)));
        return true;
      case "v":
        enterVisual();
        return true;
      case "V":
        enterVisualLine();
        return true;
      case "a":
        appendChar();
        return true;
      case "I":
        resetMotionMemory();
        setPos(editor, lineFirstNonBlank(editor));
        enterInsert(normalCharPosition(doc(editor), currentHead(editor)));
        return true;
      case "A":
        resetMotionMemory();
        lineEndInsertBoundary(editor);
        enterInsert();
        return true;
      case "o":
        resetMotionMemory();
        openLine(editor, "below");
        enterInsert();
        return true;
      case "O":
        resetMotionMemory();
        openLine(editor, "above");
        enterInsert();
        return true;
      case "x":
      case "Delete":
        resetMotionMemory();
        yank(deleteChar(editor));
        setNormalPos(editor, currentHead(editor));
        return true;
      case "X":
        resetMotionMemory();
        yank(deleteCharBackward(editor));
        setNormalPos(editor, currentHead(editor));
        return true;
      case "p":
        paste("after");
        return true;
      case "P":
        paste("before");
        return true;
      case "s":
      case "S":
        startJumpInput(key === "s" ? 1 : -1);
        return true;
      case "/":
        resetMotionMemory();
        return options.onFind?.() ?? false;
      case "r":
        pending = "r";
        return true;
      case "d":
        pending = "d";
        return true;
      case "y":
        pending = "y";
        return true;
      case ">":
        pending = ">";
        return true;
      case "<":
        pending = "<";
        return true;
      case "Escape":
        setMode("normal");
        return true;
      default:
        pending = "";
        return key.length === 1;
    }
  }

  function visualCommand(key: string): boolean {
    if (pending === "d") {
      pending = "";
      if (key === "d") {
        deleteLineCommand();
        return true;
      }
      return true;
    }
    if (pending === "r") {
      pending = "";
      if (key.length === 1) {
        resetMotionMemory();
        const replacedFrom = replaceChar(editor, key);
        if (replacedFrom != null) visualHead = replacedFrom;
      }
      setMode("normal");
      return true;
    }
    switch (key) {
      case "h":
      case "ArrowLeft":
      case "Backspace":
        visualMoveChar(-1);
        return true;
      case "l":
      case "ArrowRight":
      case " ":
        visualMoveChar(1);
        return true;
      case "j":
      case "ArrowDown":
        visualMoveLine(1);
        return true;
      case "k":
      case "ArrowUp":
        visualMoveLine(-1);
        return true;
      case "0":
        visualLineBoundary("start");
        return true;
      case "$":
        visualLineBoundary("end");
        return true;
      case "w":
        visualMoveWord(1);
        return true;
      case "W":
        visualMoveWord(1, true);
        return true;
      case "b":
        visualMoveWord(-1);
        return true;
      case "B":
        visualMoveWord(-1, true);
        return true;
      case "x":
      case "X":
      case "Delete":
      case "d":
        resetMotionMemory();
        yank(deleteChar(editor));
        visualHead = currentHead(editor);
        setMode("normal");
        return true;
      case "y":
        yankSelection();
        return true;
      case "o":
        swapVisualEnds();
        return true;
      case "V":
        switchToVisualLine();
        return true;
      case "r":
        pending = "r";
        return true;
      case "/":
        resetMotionMemory();
        return options.onFind?.() ?? false;
      case "v":
      case "Escape":
        setMode("normal");
        return true;
      default:
        pending = "";
        return key.length === 1;
    }
  }

  function visualLineCommand(key: string): boolean {
    switch (key) {
      case "j":
      case "ArrowDown":
        visualLineMove(1);
        return true;
      case "k":
      case "ArrowUp":
        visualLineMove(-1);
        return true;
      case "x":
      case "X":
      case "d":
      case "Delete":
        deleteLineCommand();
        return true;
      case "y":
        yankSelection("linewise");
        return true;
      case "v":
        switchToVisualChar();
        return true;
      case "/":
        resetMotionMemory();
        return options.onFind?.() ?? false;
      case "V":
      case "Escape":
        setMode("normal");
        return true;
      default:
        pending = "";
        return key.length === 1;
    }
  }

  return {
    mode: () => mode,
    setMode,
    syncSelectionFromEditor,
    handleKey(event: VimLiteKey): boolean {
      if (destroyed) return false;
      if (event.isComposing) return false;
      if (isEscape(event)) {
        cancelJump();
        escapeToNormal();
        return true;
      }

      if (mode === "insert") {
        // Let CM6's native cursor commands own insert-mode movement. They use
        // visual wrapped lines and preserve the pixel goal column.
        return false;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "r") {
        return options.onRedo?.() ?? false;
      }
      if (hasCommandModifier(event)) {
        cancelJump();
        return false;
      }

      const handled = mode === "visual-line"
        ? visualLineCommand(event.key)
        : mode === "visual"
          ? visualCommand(event.key)
          : normalCommand(event.key);
      return handled;
    },
    handleKeyDown(event: KeyboardEvent): boolean {
      if (destroyed) return false;
      if (!targetInEditor(host, event.target)) return false;
      if (event.isComposing) return false;
      // Some embedded editors intentionally use ordinary browser input even
      // while the document remains in Vim normal mode. Check this before
      // Escape and editableNormalCommand so their very first key is native.
      if (targetUsesNativeInput(host, event.target)) return false;
      if (isEscape(event)) {
        event.preventDefault();
        escapeToNormal();
        return true;
      }

      const editable = editableEventTarget(host, event.target);
      if (editable) {
        // Native editing shortcuts belong to the embedded control. In
        // particular, never reinterpret Cmd+Arrow as a Vim motion or consume
        // Cmd+A/C/V while a widget's own editor has focus.
        if (hasCommandModifier(event)) {
          cancelJump();
          return false;
        }
        if (mode === "insert") return false;
        if (mode === "normal") {
          const handled = editableNormalCommand(event.key, editable);
          if (handled) event.preventDefault();
          return handled;
        }
        return false;
      }

      const handled = this.handleKey(event);
      if (handled) event.preventDefault();
      return handled;
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      asyncEpoch += 1;
      cancelJump();
    },
  };
}
