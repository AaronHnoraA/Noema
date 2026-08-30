import type { Editor } from "../src/lib.ts";
import { EditorSelection, findClusterBreak, type Text } from "@codemirror/state";
import {
  selectCharLeft,
  selectCharRight,
  selectLineDown,
  selectLineUp,
} from "@codemirror/commands";
import {
  graphemeEndPosition,
  isWordChar,
  previousGraphemePosition,
} from "../src/cm6/text-boundaries.ts";
import { markdownContinuationPrefix } from "../src/cm6/commands/index.ts";
import { scanCodeRanges } from "../src/cm6/code-ranges.ts";
import { writeSystemClipboard } from "../src/system-clipboard.ts";
import { getBlockMathRanges, rangeOverlapsAny } from "../src/cm6/math-ranges.ts";
import { scanInlineMathRanges } from "../src/inline-math.ts";
import { getOrgEnvHeadingRanges } from "../src/cm6/extensions/visual/widgets/block-extras.ts";
import { cancelPointerSelection } from "../src/cm6/extensions/visual/selection.ts";
import {
  activateBlockMath,
  formulaRangeAtWidgetPosition,
  formulaSourceRangeAtPosition,
  revealFormulaSource,
  activateInlineMath,
  activateInlineMathFromArrow,
  type FormulaWidgetRange,
} from "../src/cm6/extensions/visual/widgets/math.ts";
import {
  applyVimJump,
  beginVimJump,
  clearVimJump,
  narrowVimJump,
  previewVimJump,
  type VimJumpDirection,
  type VimJumpSession,
} from "../src/cm6/vim-jump.ts";
import {
  captureEditorPasteTarget,
  releaseEditorPasteTarget,
} from "../src/cm6/paste-target.ts";

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
  /**
   * A chord that Normal/Visual mode consumed as modal input but has no binding
   * for. Swallowing it silently is indistinguishable from a dropped keystroke,
   * which is the most disorienting thing a modal editor can do.
   */
  onUnhandledKey?: (sequence: string) => void;
  jumpTimeoutMs?: number;
};

type VimRegisterKind = "linewise" | "characterwise";

type VimRegister = {
  text: string;
  kind: VimRegisterKind;
  fragments: readonly string[];
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

type VimLogicalLine = {
  /** Text owned by the logical line, excluding its terminating newline. */
  from: number;
  to: number;
  /** Half-open range used by Visual-line/yank. */
  selectionFrom: number;
  selectionTo: number;
  /** Range removed by a linewise delete. May borrow the preceding newline. */
  deleteFrom: number;
  deleteTo: number;
  cursor: number;
  registerText: string;
  formulaScope: { from: number; to: number } | null;
};

const AVY_TIMEOUT_MS = 500;
const MAX_VIM_COUNT = 10_000;

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

function revealedFormulaAt(editor: Editor, pos: number): FormulaWidgetRange | null {
  const source = formulaSourceRangeAtPosition(editor.view, pos);
  if (!source) return null;
  return formulaRangeAtWidgetPosition(editor.view.state, pos)
    ?? formulaRangeAtWidgetPosition(editor.view.state, source.from);
}

function restoreRevealedFormula(editor: Editor, previous: FormulaWidgetRange | null): void {
  if (!previous || editor.view.state.selection.ranges.length !== 1) return;
  const head = currentHead(editor);
  const current = formulaRangeAtWidgetPosition(editor.view.state, head);
  if (!current || current.display !== previous.display) return;
  revealFormulaSource(
    editor.view,
    current.from,
    current.to,
    clamp(head - current.contentFrom, 0, Math.max(0, current.contentTo - current.contentFrom)),
  );
}

function boundedLogicalLine(
  text: Text,
  pos: number,
  boundaryFrom: number,
  boundaryTo: number,
  formulaScope: { from: number; to: number } | null,
): VimLogicalLine {
  const empty = boundaryFrom >= boundaryTo;
  const safePos = empty
    ? boundaryFrom
    : clamp(pos, boundaryFrom, Math.max(boundaryFrom, boundaryTo - 1));
  const line = text.lineAt(safePos);
  const from = Math.max(boundaryFrom, line.from);
  const to = Math.min(boundaryTo, line.to);
  const hasFollowingNewline = to < boundaryTo && text.sliceString(to, to + 1) === "\n";
  const selectionTo = hasFollowingNewline ? to + 1 : to;
  const deleteFrom = !hasFollowingNewline && from > boundaryFrom
    && text.sliceString(from - 1, from) === "\n"
    ? from - 1
    : from;
  const raw = text.sliceString(from, to);
  return {
    from,
    to,
    selectionFrom: from,
    selectionTo,
    deleteFrom,
    deleteTo: selectionTo,
    cursor: from,
    registerText: `${raw}\n`,
    formulaScope,
  };
}

/**
 * Vim's line is a visual/logical object, not always a raw Markdown source line.
 * A collapsed display formula is one line; a revealed formula owns only its
 * TeX body lines, so linewise commands can never eat `\(`/`\)` or `\[`/`\]`.
 */
function logicalLineAt(editor: Editor, pos: number): VimLogicalLine {
  const text = doc(editor);
  const revealed = revealedFormulaAt(editor, pos);
  if (revealed) {
    return boundedLogicalLine(
      text,
      pos,
      revealed.contentFrom,
      revealed.contentTo,
      { from: revealed.contentFrom, to: revealed.contentTo },
    );
  }

  const object = staticMathObjectAtPosition(editor, pos);
  const formula = object
    ? formulaRangeAtWidgetPosition(editor.view.state, object.from)
    : null;
  if (object && formula?.display) {
    const hasFollowingNewline = object.to < text.length
      && text.sliceString(object.to, object.to + 1) === "\n";
    const selectionTo = hasFollowingNewline ? object.to + 1 : object.to;
    const deleteFrom = !hasFollowingNewline && object.from > 0
      && text.sliceString(object.from - 1, object.from) === "\n"
      ? object.from - 1
      : object.from;
    return {
      from: object.from,
      to: object.to,
      selectionFrom: object.from,
      selectionTo,
      deleteFrom,
      deleteTo: selectionTo,
      cursor: object.from,
      registerText: `${text.sliceString(object.from, object.to)}\n`,
      formulaScope: null,
    };
  }

  return boundedLogicalLine(text, pos, 0, text.length, null);
}

function logicalLineSelectionRange(
  editor: Editor,
  anchor: number,
  head: number,
  scope: { from: number; to: number } | null = null,
): { from: number; to: number } {
  const text = doc(editor);
  const a = scope
    ? boundedLogicalLine(text, anchor, scope.from, scope.to, scope)
    : logicalLineAt(editor, anchor);
  const h = scope
    ? boundedLogicalLine(text, head, scope.from, scope.to, scope)
    : logicalLineAt(editor, head);
  return {
    from: Math.min(a.selectionFrom, h.selectionFrom),
    to: Math.max(a.selectionTo, h.selectionTo),
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

function staticMathObjectAtPosition(
  editor: Editor,
  pos: number,
): { from: number; to: number } | null {
  if (!editor.view.dom.classList.contains("aaronnote-visual-typography")) return null;
  const state = editor.view.state;
  const safePos = clamp(pos, 0, state.doc.length);
  if (formulaSourceRangeAtPosition(editor.view, safePos)) return null;
  const blockRanges = getBlockMathRanges(state);
  const block = blockRanges.find((range) => safePos >= range.from && safePos < range.to);
  if (block) return block;
  const line = state.doc.lineAt(safePos);
  const codeRanges = scanCodeRanges(state, [{ from: line.from, to: line.to }]);
  return scanInlineMathRanges(line.text, line.from).find((range) => (
    safePos >= range.from
      && safePos < range.to
      && !rangeOverlapsAny(range.from, range.to, blockRanges)
      && !rangeOverlapsAny(range.from, range.to, codeRanges)
  )) ?? null;
}

function visualObjectEndPosition(editor: Editor, pos: number): number {
  const object = staticMathObjectAtPosition(editor, pos);
  return object?.from === pos ? object.to : visualCharEndPosition(doc(editor), pos);
}

function enterStaticMathObject(
  editor: Editor,
  entry: "start" | "end",
): boolean {
  const object = staticMathObjectAtPosition(editor, currentHead(editor));
  if (!object) return false;
  const visualEntry = { kind: entry } as const;
  const block = getBlockMathRanges(editor.view.state)
    .find((range) => range.from === object.from && range.to === object.to);
  return block
    ? activateBlockMath(editor.view, block.from, block.to, visualEntry)
    : activateInlineMath(editor.view, object.from, object.to, visualEntry);
}

function snapStaticMathMotion(
  editor: Editor,
  start: number,
  target: number,
  dir: -1 | 1,
): number {
  const object = staticMathObjectAtPosition(editor, target);
  if (!object) return target;
  if (dir > 0 && start < object.from) return object.from;
  return dir > 0 ? object.to : object.from;
}

function docCluster(text: Text, pos: number): string {
  if (pos < 0 || pos >= text.length) return "";
  const end = graphemeEndPosition(text, pos);
  return end > pos ? text.sliceString(pos, end) : text.sliceString(pos, pos + 1);
}

function wordCategory(ch: string, bigWord = false): "space" | "word" | "punctuation" {
  if (!ch || /\s/u.test(ch)) return "space";
  if (bigWord || isWordChar(ch)) return "word";
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

/**
 * Vim's `e`/`E`: the last character of the current word, or of the next one
 * when the caret already sits on that last character. Unlike `w` this lands
 * *on* a character, so Normal mode never needs to clamp the result back.
 */
function wordEndPosition(text: Text, start: number, bigWord = false): number {
  const limit = text.length;
  let pos = clamp(start, 0, limit);
  const advance = (from: number): number => Math.max(from + 1, graphemeEndPosition(text, from));

  pos = advance(pos);
  while (pos < limit && wordCategory(docCluster(text, pos), bigWord) === "space") pos = advance(pos);
  if (pos >= limit) return previousGraphemePosition(text, limit);
  const category = wordCategory(docCluster(text, pos), bigWord);
  let end = pos;
  while (true) {
    const next = advance(end);
    if (next >= limit || wordCategory(docCluster(text, next), bigWord) !== category) break;
    end = next;
  }
  return end;
}

function isFindKind(value: string): value is VimFindKind {
  return value === "f" || value === "F" || value === "t" || value === "T";
}

function lineIsBlank(text: Text, lineNumber: number): boolean {
  return text.line(lineNumber).text.trim().length === 0;
}

/**
 * Vim's `{`/`}`: the nearest blank line in DIR, skipping any blank run the
 * caret is already inside. The first and last lines act as the outer bounds.
 */
function paragraphPosition(text: Text, start: number, dir: -1 | 1): number {
  let lineNumber = text.lineAt(clamp(start, 0, text.length)).number;
  const bound = dir > 0 ? text.lines : 1;
  // Step off a blank run the caret is already inside, so a paragraph gap of any
  // width counts as one stop rather than one stop per blank line.
  while (lineNumber !== bound && lineIsBlank(text, lineNumber)) lineNumber += dir;
  while (lineNumber !== bound) {
    lineNumber += dir;
    if (lineIsBlank(text, lineNumber)) return text.line(lineNumber).from;
  }
  return dir > 0 ? text.length : 0;
}

function firstNonBlankPosition(text: Text, pos: number): number {
  const line = text.lineAt(clamp(pos, 0, text.length));
  const first = line.text.search(/\S/u);
  return first < 0 ? line.from : line.from + first;
}

export type VimFindKind = "f" | "F" | "t" | "T";

/**
 * Vim's `f`/`F`/`t`/`T`: search only within the caret's own line. `t`/`T` stop
 * one character short of the target, which is what makes `dt,` useful.
 */
function findCharPosition(
  text: Text,
  start: number,
  kind: VimFindKind,
  target: string,
  count: number,
  skipAdjacent = false,
): number | null {
  const line = text.lineAt(clamp(start, 0, text.length));
  const forward = kind === "f" || kind === "t";
  let index = clamp(start, line.from, line.to) - line.from;
  for (let hit = 0; hit < count; hit++) {
    // A repeated `t`/`T` already sits beside its target, so it must start one
    // character further out or it would match the same neighbour forever.
    const step = hit === 0 && skipAdjacent ? 2 : 1;
    const from = forward ? index + step : index - step;
    if (from < 0 || from > line.text.length) return null;
    const found = forward ? line.text.indexOf(target, from) : line.text.lastIndexOf(target, from);
    if (found < 0) return null;
    index = found;
  }
  const offset = kind === "t" ? index - 1 : kind === "T" ? index + 1 : index;
  if (offset < 0 || offset > line.text.length) return null;
  return line.from + offset;
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

function normalEditorPosition(editor: Editor, pos: number): number {
  const text = doc(editor);
  const revealed = revealedFormulaAt(editor, pos);
  if (revealed) {
    if (revealed.contentFrom >= revealed.contentTo) return revealed.contentFrom;
    const bounded = clamp(pos, revealed.contentFrom, revealed.contentTo);
    const contentPos = bounded >= revealed.contentTo
      ? previousGraphemePosition(text, revealed.contentTo)
      : bounded;
    return normalCharPosition(text, Math.max(revealed.contentFrom, contentPos));
  }
  const normalized = normalCharPosition(text, pos);
  return staticMathObjectAtPosition(editor, normalized)?.from ?? normalized;
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

function setNormalCursorPositions(
  editor: Editor,
  positions: readonly number[],
  sourceMainIndex = editor.view.state.selection.mainIndex,
): void {
  const candidates = positions.map((position, index) => ({
    position: normalEditorPosition(editor, position),
    main: index === sourceMainIndex,
  })).sort((left, right) => left.position - right.position);
  const unique = candidates.filter((candidate, index) => (
    index === 0 || candidate.position !== candidates[index - 1]!.position
  ));
  if (unique.length === 0) return;
  let mainIndex = unique.findIndex((candidate) => candidate.main);
  if (mainIndex < 0) mainIndex = Math.min(sourceMainIndex, unique.length - 1);
  editor.view.dispatch({
    selection: EditorSelection.create(
      unique.map((candidate) => EditorSelection.cursor(candidate.position)),
      mainIndex,
    ),
    scrollIntoView: true,
  });
}

function setCursorPositions(editor: Editor, positions: readonly number[]): void {
  const state = editor.view.state;
  const candidates = positions.map((position, index) => ({
    position: clamp(position, 0, state.doc.length),
    main: index === state.selection.mainIndex,
  })).sort((left, right) => left.position - right.position);
  const unique = candidates.filter((candidate, index) => (
    index === 0 || candidate.position !== candidates[index - 1]!.position
  ));
  if (unique.length === 0) return;
  let mainIndex = unique.findIndex((candidate) => candidate.main);
  if (mainIndex < 0) mainIndex = Math.min(state.selection.mainIndex, unique.length - 1);
  editor.view.dispatch({
    selection: EditorSelection.create(
      unique.map((candidate) => EditorSelection.cursor(candidate.position)),
      mainIndex,
    ),
    scrollIntoView: true,
  });
}

function moveChar(editor: Editor, dir: -1 | 1): void {
  const text = doc(editor);
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map((range) => {
    const pos = range.head;
    const target = moveNormalCharPosition(text, pos, dir);
    return snapStaticMathMotion(editor, pos, target, dir);
  }));
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

/**
 * Where a vertical motion should land when it steps over something the Visual
 * layer collapses — a display formula, an org-env heading, or a blank line a
 * semantic block absorbed to zero height.
 *
 * Exported for testing: this runs only on `moveScreenLine`'s pixel path, which
 * needs real layout and so never executes under a headless DOM. The function
 * itself measures nothing, so it can be exercised directly with an explicit
 * start and target.
 */
export function crossedVisualEntry(
  editor: Editor,
  start: number,
  target: number,
  dir: -1 | 1,
): number | null {
  // Source mode has no collapsed block widgets.  Besides avoiding unnecessary
  // work, this guard ensures the cached Visual fields never fall back to a
  // document scan during ordinary source navigation.
  if (!editor.view.dom.classList.contains("aaronnote-visual-typography")) return null;

  const state = editor.view.state;
  const entries: Array<{ from: number; to: number; target: number }> = [];
  const mathRanges = getBlockMathRanges(state).filter((range) => (
    !formulaSourceRangeAtPosition(editor.view, range.from)
  ));

  const mathRange = nearestCrossedRange(mathRanges, start, target, dir);
  if (mathRange) {
    entries.push({
      from: mathRange.from,
      to: mathRange.to,
      target: mathRange.from,
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

function moveScreenLine(
  editor: Editor,
  dir: -1 | 1,
  goals: readonly (VerticalGoal | null)[] | null,
): VerticalGoal[] {
  const selections = editor.view.state.selection.ranges;
  const rect = editor.view.contentDOM.getBoundingClientRect();
  // A detached/hidden editor has no usable layout. Preserve keyboard access
  // with a logical-line fallback until CM6 can measure real screen rows.
  if (rect.width <= 0 || rect.height <= 0) {
    const text = doc(editor);
    const nextGoals: VerticalGoal[] = [];
    const targets = selections.map((range, index) => {
      const line = docLineInfo(text, normalCharPosition(text, range.head));
      const goal = goals?.[index];
      const desired = goal?.kind === "column" ? goal.value : line.column;
      nextGoals.push({ kind: "column", value: desired });
      if (dir < 0 && line.start > 0) {
        const previous = docLineInfo(text, line.start - 1);
        return Math.min(previous.start + desired, previous.end);
      }
      if (dir > 0 && line.end < text.length) {
        const next = docLineInfo(text, line.end + 1);
        return Math.min(next.start + desired, next.end);
      }
      return range.head;
    });
    setNormalCursorPositions(editor, targets);
    return nextGoals;
  }

  const text = doc(editor);
  const nextGoals: VerticalGoal[] = [];
  const targets = selections.map((selection, index) => {
    const start = normalCharPosition(text, selection.head);
    const coords = editor.view.coordsAtPos(start);
    const goal = goals?.[index];
    const pixelGoal = goal?.kind === "pixel"
      ? goal.value
      : coords
        ? coords.left - rect.left
        : editor.view.defaultCharacterWidth * docLineInfo(text, start).column;
    const moved = editor.view.moveVertically(
      EditorSelection.cursor(start, 0, undefined, pixelGoal),
      dir > 0,
    );
    nextGoals.push({ kind: "pixel", value: moved.goalColumn ?? pixelGoal });
    return crossedVisualEntry(editor, start, moved.head, dir) ?? moved.head;
  });
  setNormalCursorPositions(editor, targets);
  return nextGoals;
}

/**
 * Boundary of the *visual* row rather than the source line.
 *
 * `j`/`k` already move by wrapped row (`moveScreenLine`), and Insert mode's
 * Home/End already resolve against CodeMirror's visual line boundaries. Having
 * `0`/`$` use the source line made those three disagree in the single most
 * common Markdown case: inside a wrapped paragraph `j` stepped one row while
 * `$` jumped to the end of the entire paragraph, and `Home` and `0` landed in
 * different places. A detached editor has no layout to measure, so fall back
 * to the source line there.
 */
function visualRowBoundary(editor: Editor, pos: number, which: "start" | "end"): number {
  const rect = editor.view.contentDOM.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    const line = docLineInfo(doc(editor), pos);
    return which === "start" ? line.start : line.end;
  }
  return editor.view.moveToLineBoundary(EditorSelection.cursor(pos), which === "end").head;
}

function lineBoundary(editor: Editor, which: "start" | "end"): void {
  const text = doc(editor);
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map((range) => (
    visualRowBoundary(editor, normalCharPosition(text, range.head), which)
  )));
}

function lineEndInsertBoundary(editor: Editor): void {
  const text = doc(editor);
  setCursorPositions(editor, editor.view.state.selection.ranges.map((range) => (
    text.lineAt(clamp(range.head, 0, text.length)).to
  )));
}

function lineFirstNonBlankPositions(editor: Editor): number[] {
  const text = doc(editor);
  return editor.view.state.selection.ranges.map((range) => {
    const line = text.lineAt(clamp(range.head, 0, text.length));
    const first = line.text.search(/\S/u);
    return first < 0 ? line.from : line.from + first;
  });
}

function docBoundary(editor: Editor, which: "start" | "end"): void {
  const target = which === "start" ? 0 : doc(editor).length;
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map(() => target));
}

function moveWord(editor: Editor, dir: -1 | 1, bigWord = false): void {
  const text = doc(editor);
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map((range) => {
    const start = range.head;
    const target = wordMotionPosition(text, start, dir, bigWord);
    return snapStaticMathMotion(editor, start, target, dir);
  }));
}

function moveWordEnd(editor: Editor, bigWord: boolean, count: number): void {
  const text = doc(editor);
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map((range) => {
    let target = range.head;
    for (let step = 0; step < count; step++) target = wordEndPosition(text, target, bigWord);
    return snapStaticMathMotion(editor, range.head, target, 1);
  }));
}

function moveParagraph(editor: Editor, dir: -1 | 1, count: number): void {
  const text = doc(editor);
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map((range) => {
    let target = range.head;
    for (let step = 0; step < count; step++) target = paragraphPosition(text, target, dir);
    return target;
  }));
}

function moveFirstNonBlank(editor: Editor): void {
  const text = doc(editor);
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map((range) => (
    firstNonBlankPosition(text, range.head)
  )));
}

function moveToLine(editor: Editor, lineNumber: number): void {
  const text = doc(editor);
  const line = text.line(clamp(lineNumber, 1, text.lines));
  setNormalCursorPositions(
    editor,
    editor.view.state.selection.ranges.map(() => firstNonBlankPosition(text, line.from)),
  );
}

/** Returns false when no cursor found the target, so the caller can report it. */
function moveFindChar(
  editor: Editor,
  kind: VimFindKind,
  target: string,
  count: number,
  skipAdjacent = false,
): boolean {
  const text = doc(editor);
  let found = false;
  setNormalCursorPositions(editor, editor.view.state.selection.ranges.map((range) => {
    const hit = findCharPosition(text, range.head, kind, target, count, skipAdjacent);
    if (hit == null) return range.head;
    found = true;
    return hit;
  }));
  return found;
}

function characterRangeAt(
  editor: Editor,
  from: number,
  to: number,
  backward = false,
): { from: number; to: number } | null {
  const text = doc(editor);
  if (from !== to) return { from, to };
  const start = from === to ? normalCharPosition(text, from) : from;
  const line = text.lineAt(start);
  if (backward) {
    if (start <= line.from) return null;
    const previousObject = staticMathObjectAtPosition(editor, Math.max(line.from, start - 1));
    return {
      from: previousObject?.to === start
        ? previousObject.from
        : previousGraphemePosition(text, start),
      to: start,
    };
  }
  const object = staticMathObjectAtPosition(editor, start);
  const end = object?.from === start ? object.to : Math.min(graphemeEndPosition(text, start), line.to);
  return start < end ? { from: start, to: end } : null;
}

function uniqueRanges(ranges: readonly { from: number; to: number }[]): Array<{ from: number; to: number }> {
  const sorted = [...ranges]
    .filter((range) => range.from < range.to)
    .sort((left, right) => left.from - right.from || left.to - right.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to);
    else merged.push({ ...range });
  }
  return merged;
}

function deleteChars(editor: Editor, backward = false): string[] {
  const state = editor.view.state;
  const text = doc(editor);
  const revealed = state.selection.ranges.length === 1
    ? revealedFormulaAt(editor, state.selection.main.head)
    : null;
  const ranges = uniqueRanges(state.selection.ranges.flatMap((selection) => {
    const range = characterRangeAt(editor, selection.from, selection.to, backward);
    return range ? [range] : [];
  }));
  if (ranges.length === 0) return [];
  const fragments = ranges.map((range) => text.sliceString(range.from, range.to));
  const changes = state.changes(ranges.map(({ from, to }) => ({ from, to })));
  const cursors = ranges.map((range) => EditorSelection.cursor(changes.mapPos(range.from, -1)));
  editor.view.dispatch(state.update({
    changes,
    selection: EditorSelection.create(cursors, Math.min(state.selection.mainIndex, cursors.length - 1)),
    scrollIntoView: true,
  }));
  restoreRevealedFormula(editor, revealed);
  return fragments;
}

/**
 * End of the word the caret is standing in, without first stepping off it —
 * which is what separates `cw` (this) from `e` (wordEndPosition).
 */
function currentWordEnd(text: Text, pos: number, bigWord: boolean): number {
  const category = wordCategory(docCluster(text, pos), bigWord);
  if (category === "space") return pos;
  let end = pos;
  while (end < text.length) {
    const next = graphemeAfter(text, end);
    if (next === end || next >= text.length) break;
    if (wordCategory(docCluster(text, next), bigWord) !== category) break;
    end = next;
  }
  return end;
}

export type VimOperator = "d" | "c" | "y";

type OperatorMotionRange = { from: number; to: number; linewise: boolean };

function graphemeAfter(text: Text, pos: number): number {
  return Math.min(text.length, Math.max(pos + 1, graphemeEndPosition(text, pos)));
}

function wholeLineSpan(text: Text, from: number, to: number): OperatorMotionRange {
  const first = text.lineAt(clamp(Math.min(from, to), 0, text.length));
  const last = text.lineAt(clamp(Math.max(from, to), 0, text.length));
  const end = last.to < text.length ? last.to + 1 : last.to;
  return {
    // A span that runs to the end of the document has no trailing newline to
    // own, so it borrows the preceding one instead — otherwise a linewise
    // delete leaves the empty line its own newline used to terminate.
    from: end >= text.length && first.from > 0 ? first.from - 1 : first.from,
    to: end,
    linewise: true,
  };
}

/**
 * The text an operator acts on for one caret, or null when KEY is not a motion
 * this operator knows.
 *
 * Vim's exclusive/inclusive distinction is the whole game here: `dw` stops
 * before the next word while `de` eats the word's last character, and getting
 * that backwards is the difference between `dw` and a corrupted document.
 */
function operatorMotionRange(
  editor: Editor,
  operator: VimOperator,
  head: number,
  key: string,
  count: number,
  find: { kind: VimFindKind; target: string } | null,
): OperatorMotionRange | null {
  const text = doc(editor);
  const start = normalCharPosition(text, head);
  const line = text.lineAt(start);
  const charwise = (from: number, to: number): OperatorMotionRange => ({
    from: Math.min(from, to),
    to: Math.max(from, to),
    linewise: false,
  });

  switch (key) {
    case "h":
    case "ArrowLeft": {
      let to = start;
      for (let step = 0; step < count && to > line.from; step++) to = previousGraphemePosition(text, to);
      return charwise(to, start);
    }
    case "l":
    case " ":
    case "ArrowRight": {
      let to = start;
      for (let step = 0; step < count && to < line.to; step++) to = graphemeAfter(text, to);
      return charwise(start, Math.min(to, line.to));
    }
    case "w":
    case "W": {
      // `cw` is Vim's famous exception: on a non-blank it behaves like `ce`,
      // changing to the end of the word instead of up to the start of the next
      // one, so it never eats the space that separates them.
      if (operator === "c" && wordCategory(docCluster(text, start), key === "W") !== "space") {
        let end = currentWordEnd(text, start, key === "W");
        for (let step = 1; step < count; step++) end = wordEndPosition(text, end, key === "W");
        return charwise(start, graphemeAfter(text, end));
      }
      let to = start;
      for (let step = 0; step < count; step++) to = wordMotionPosition(text, to, 1, key === "W");
      // Stopping at the start of a later line would swallow the newline, which
      // Vim never does for `dw` on the last word of a line.
      const target = text.lineAt(to);
      if (target.number > line.number && to === target.from) {
        const previous = text.line(target.number - 1);
        return charwise(start, Math.max(start, previous.to));
      }
      return charwise(start, to);
    }
    case "b":
    case "B": {
      let to = start;
      for (let step = 0; step < count; step++) to = wordMotionPosition(text, to, -1, key === "B");
      return charwise(to, start);
    }
    case "e":
    case "E": {
      let to = start;
      for (let step = 0; step < count; step++) to = wordEndPosition(text, to, key === "E");
      return charwise(start, graphemeAfter(text, to));
    }
    case "$":
      return charwise(start, line.to);
    case "0":
      return charwise(line.from, start);
    case "^":
      return charwise(firstNonBlankPosition(text, start), start);
    case "{":
    case "}": {
      let to = start;
      const dir = key === "}" ? 1 : -1;
      for (let step = 0; step < count; step++) to = paragraphPosition(text, to, dir);
      return charwise(start, to);
    }
    case "f":
    case "F":
    case "t":
    case "T":
    case ";":
    case ",": {
      if (!find) return null;
      const hit = findCharPosition(
        text,
        start,
        find.kind,
        find.target,
        count,
        (key === ";" || key === ",") && (find.kind === "t" || find.kind === "T"),
      );
      if (hit == null) return null;
      // A forward find is inclusive of where it lands; a backward one stops
      // before the caret's own character.
      return find.kind === "f" || find.kind === "t"
        ? charwise(start, graphemeAfter(text, hit))
        : charwise(hit, start);
    }
    case "j":
    case "ArrowDown": {
      const last = text.line(Math.min(text.lines, line.number + count));
      return wholeLineSpan(text, line.from, last.from);
    }
    case "k":
    case "ArrowUp": {
      const first = text.line(Math.max(1, line.number - count));
      return wholeLineSpan(text, first.from, line.from);
    }
    case "G": {
      const target = text.line(clamp(count, 1, text.lines));
      return wholeLineSpan(text, line.from, target.from);
    }
    default:
      return null;
  }
}

/**
 * `3x` deletes three characters as one operation, so the register holds all
 * three — repeating `deleteChars` would leave only the last one behind.
 */
function deleteCharsCounted(editor: Editor, count: number, backward: boolean): string[] {
  if (count <= 1) return deleteChars(editor, backward);
  const carets = editor.view.state.selection.ranges.length;
  const fragments: string[] = new Array(carets).fill("");
  for (let step = 0; step < count; step++) {
    const deleted = deleteChars(editor, backward);
    // Once any caret stops producing a fragment the results no longer line up
    // with the carets, and guessing the mapping would put one caret's text in
    // another's register entry. Stopping early is the honest answer.
    if (deleted.length !== carets) break;
    for (let index = 0; index < carets; index++) {
      const piece = deleted[index] ?? "";
      fragments[index] = backward ? piece + fragments[index]! : fragments[index]! + piece;
    }
  }
  return fragments.filter(Boolean);
}

/**
 * The `D`/`C`/`Y` range: caret to end of line, honouring the same logical-line
 * bounds as `dd` so a revealed formula's `\[`/`\]` can never be swallowed.
 */
function lineTailRange(editor: Editor, head: number): { from: number; to: number } {
  const line = logicalLineAt(editor, head);
  return { from: clamp(head, line.from, line.to), to: line.to };
}

function deleteToLineEnd(editor: Editor, andEnterInsert: boolean): string[] {
  const state = editor.view.state;
  const text = doc(editor);
  const ranges = uniqueRanges(state.selection.ranges.map((range) => (
    range.empty ? lineTailRange(editor, range.head) : { from: range.from, to: range.to }
  ))).filter((range) => range.from < range.to);
  if (ranges.length === 0) return [];
  const fragments = ranges.map((range) => text.sliceString(range.from, range.to));
  const changes = state.changes(ranges.map(({ from, to }) => ({ from, to })));
  const emptied = changes.apply(state.doc);
  const cursors = ranges.map((range) => {
    const at = changes.mapPos(range.from, -1);
    // `D` leaves Normal mode on the new last character; `C` opens Insert where
    // the deleted text was, which is a legal Insert position past it.
    return EditorSelection.cursor(andEnterInsert ? at : normalCharPosition(emptied, at));
  });
  editor.view.dispatch(state.update({
    changes,
    selection: EditorSelection.create(cursors, Math.min(state.selection.mainIndex, cursors.length - 1)),
    scrollIntoView: true,
  }));
  return fragments;
}

function yankToLineEnd(editor: Editor): string[] {
  const text = doc(editor);
  return editor.view.state.selection.ranges.map((range) => {
    const tail = range.empty ? lineTailRange(editor, range.head) : { from: range.from, to: range.to };
    return text.sliceString(tail.from, tail.to);
  }).filter(Boolean);
}

/**
 * Vim's `J`: join the following line onto this one, collapsing its leading
 * indentation into a single separating space. No space is added when the
 * current line already ends in one, or when the next line is empty.
 */
function joinLines(editor: Editor, count: number): boolean {
  const state = editor.view.state;
  const text = state.doc;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const cursors: number[] = [];
  for (const range of state.selection.ranges) {
    let line = text.lineAt(clamp(range.head, 0, text.length));
    // Vim counts the lines involved, not the joins: `3J` makes two joins.
    const joins = Math.max(1, count - 1);
    const from = line.to;
    let insert = "";
    let joined = 0;
    for (let step = 0; step < joins && line.number < text.lines; step++) {
      const next = text.line(line.number + 1);
      const trimmed = next.text.replace(/^\s+/u, "");
      const separator = insert.endsWith(" ") || (step === 0 && /\s$/u.test(line.text)) || !trimmed
        ? ""
        : " ";
      insert += separator + trimmed;
      line = next;
      joined++;
    }
    if (joined === 0) continue;
    changes.push({ from, to: line.to, insert });
    cursors.push(from);
  }
  if (changes.length === 0) return false;
  const change = state.changes(changes);
  const applied = change.apply(state.doc);
  editor.view.dispatch(state.update({
    changes: change,
    selection: EditorSelection.create(
      cursors.map((pos) => EditorSelection.cursor(normalCharPosition(applied, change.mapPos(pos, -1)))),
      Math.min(state.selection.mainIndex, cursors.length - 1),
    ),
    scrollIntoView: true,
  }));
  return true;
}

function swapCase(value: string): string {
  return value.replace(/\p{L}/gu, (ch) => {
    const upper = ch.toUpperCase();
    return ch === upper ? ch.toLowerCase() : upper;
  });
}

/**
 * Vim's `~`: swap the case of COUNT characters and step past them. Applies to
 * the selection instead when one is active, which is what Visual `~` means.
 */
function toggleCaseForward(editor: Editor, count: number): boolean {
  const state = editor.view.state;
  const text = state.doc;
  const ranges = uniqueRanges(state.selection.ranges.map((range) => {
    if (!range.empty) return { from: range.from, to: range.to };
    const line = text.lineAt(clamp(range.head, 0, text.length));
    let to = clamp(range.head, line.from, line.to);
    for (let step = 0; step < count && to < line.to; step++) {
      to = Math.max(to + 1, graphemeEndPosition(text, to));
    }
    return { from: clamp(range.head, line.from, line.to), to: Math.min(to, line.to) };
  })).filter((range) => range.from < range.to);
  if (ranges.length === 0) return false;
  const specs = ranges.map((range) => ({
    from: range.from,
    to: range.to,
    insert: swapCase(text.sliceString(range.from, range.to)),
  }));
  if (specs.every((spec) => spec.insert === text.sliceString(spec.from, spec.to))) return false;
  const change = state.changes(specs);
  const applied = change.apply(state.doc);
  editor.view.dispatch(state.update({
    changes: change,
    selection: EditorSelection.create(
      specs.map((spec) => EditorSelection.cursor(
        normalCharPosition(applied, change.mapPos(spec.to, -1)),
      )),
      Math.min(state.selection.mainIndex, specs.length - 1),
    ),
    scrollIntoView: true,
  }));
  return true;
}

function selectedLogicalLine(
  editor: Editor,
  from: number,
  to: number,
): VimLogicalLine {
  const text = doc(editor);
  const line = logicalLineAt(editor, from);
  if (to <= from) return line;
  let deleteFrom = line.deleteFrom;
  let deleteTo = line.deleteTo;
  let registerText = line.registerText;
  registerText = text.sliceString(from, to);
  if (!registerText.endsWith("\n")) registerText += "\n";
  deleteFrom = from;
  deleteTo = to;
  // A final whole-line selection has no trailing newline to own. Borrow its
  // preceding newline for deletion while keeping the register linewise.
  if (to >= text.length && from > 0 && text.sliceString(from - 1, from) === "\n") {
    deleteFrom = from - 1;
  } else if (line.formulaScope && to >= line.formulaScope.to
      && from > line.formulaScope.from
      && text.sliceString(from - 1, from) === "\n") {
    deleteFrom = from - 1;
  }
  return { ...line, deleteFrom, deleteTo, registerText };
}

/**
 * Where Vim leaves the caret after a linewise delete: the first non-blank of
 * the line that moved up into the deleted one.
 *
 * Mapping the deleted range's start is not enough. When the delete borrowed the
 * *preceding* newline — which is what happens on the last line of the document —
 * the mapped position is the end of the surviving line, which Normal mode has
 * no legal cursor position for: `i` then opens Insert past the last character
 * and `x` deletes the wrong grapheme.
 */
function linewiseLandingPosition(text: Text, pos: number): number {
  const line = text.lineAt(clamp(pos, 0, text.length));
  const first = line.text.search(/\S/u);
  return first < 0 ? line.from : line.from + first;
}

/**
 * End of the COUNT-line span starting at FROM, including the trailing newline
 * the way Visual-line's own selection does — otherwise `3dd` in the middle of a
 * document would leave a stray empty line where the third line was.
 */
function countedLineSpanEnd(text: Text, from: number, count: number): number {
  const startLine = text.lineAt(clamp(from, 0, text.length)).number;
  const line = text.line(Math.min(text.lines, startLine + count - 1));
  return line.to < text.length ? line.to + 1 : line.to;
}

function deleteLines(editor: Editor, count = 1): string[] {
  const state = editor.view.state;
  const revealed = state.selection.ranges.length === 1
    ? revealedFormulaAt(editor, state.selection.main.head)
    : null;
  const logical = state.selection.ranges.map((range) => (
    selectedLogicalLine(
      editor,
      range.from,
      count > 1 && range.empty ? countedLineSpanEnd(state.doc, range.from, count) : range.to,
    )
  ));
  const keyed = new Map<string, VimLogicalLine>();
  for (const line of logical) keyed.set(`${line.deleteFrom}:${line.deleteTo}`, line);
  const lines = [...keyed.values()].sort((left, right) => left.deleteFrom - right.deleteFrom);
  const ranges = uniqueRanges(lines.map((line) => ({ from: line.deleteFrom, to: line.deleteTo })));
  if (ranges.length === 0) return [];
  const changes = state.changes(ranges.map(({ from, to }) => ({ from, to })));
  const deleted = changes.apply(state.doc);
  const cursors = ranges.map((range) => EditorSelection.cursor(
    linewiseLandingPosition(deleted, changes.mapPos(range.from, -1)),
  ));
  editor.view.dispatch(state.update({
    changes,
    selection: EditorSelection.create(cursors, Math.min(state.selection.mainIndex, cursors.length - 1)),
    scrollIntoView: true,
  }));
  restoreRevealedFormula(editor, revealed);
  return lines.map((line) => line.registerText);
}

function currentSelectionTexts(editor: Editor): string[] {
  const text = doc(editor);
  return editor.view.state.selection.ranges
    .filter((range) => range.from < range.to)
    .map((range) => text.sliceString(range.from, range.to));
}

/**
 * The span `r` replaces for one caret. `3rz` replaces three characters, and
 * Vim refuses outright when the line is too short rather than replacing what
 * fits.
 */
function countedCharacterRange(
  editor: Editor,
  selection: { from: number; to: number; empty: boolean },
  count: number,
): { from: number; to: number } | null {
  if (!selection.empty || count <= 1) {
    return characterRangeAt(editor, selection.from, selection.to);
  }
  const text = doc(editor);
  const start = normalCharPosition(text, selection.from);
  const line = text.lineAt(start);
  let to = start;
  for (let step = 0; step < count; step++) {
    if (to >= line.to) return null;
    to = Math.max(to + 1, graphemeEndPosition(text, to));
  }
  return { from: start, to: Math.min(to, line.to) };
}

function replaceChars(editor: Editor, ch: string, count = 1): number | null {
  const state = editor.view.state;
  const text = doc(editor);
  const revealed = state.selection.ranges.length === 1
    ? revealedFormulaAt(editor, state.selection.main.head)
    : null;
  const ranges = uniqueRanges(state.selection.ranges.flatMap((selection) => {
    const range = countedCharacterRange(editor, selection, count);
    return range ? [range] : [];
  }));
  if (ranges.length === 0) return null;
  const specs = ranges.map((range) => {
    const object = staticMathObjectAtPosition(editor, range.from);
    const replacingObject = Boolean(object?.from === range.from && object.to === range.to);
    return {
      from: range.from,
      to: range.to,
      insert: ch.repeat(replacingObject ? 1 : Math.max(1, selectionClusterCount(text, range.from, range.to))),
    };
  });
  const changes = state.changes(specs);
  // Vim leaves Normal cursors on the replaced character, not after it — and on
  // the *last* one when a count replaced several. Stepping one grapheme back
  // from the mapped end covers both, since a single replacement's end is one
  // grapheme past its start.
  const replaced = changes.apply(state.doc);
  const replacedPositions = specs.map((range) => (
    previousGraphemePosition(replaced, changes.mapPos(range.to, -1))
  ));
  const cursors = replacedPositions.map((position) => EditorSelection.cursor(position));
  editor.view.dispatch(state.update({
    changes,
    selection: EditorSelection.create(cursors, Math.min(state.selection.mainIndex, cursors.length - 1)),
    scrollIntoView: true,
  }));
  restoreRevealedFormula(editor, revealed);
  return replacedPositions[Math.min(state.selection.mainIndex, replacedPositions.length - 1)]
    ?? replacedPositions[0]!;
}

function openLine(editor: Editor, where: "above" | "below"): void {
  const state = editor.view.state;
  const text = state.doc;
  const revealed = state.selection.ranges.length === 1
    ? revealedFormulaAt(editor, state.selection.main.head)
    : null;
  const candidates = state.selection.ranges.map((selection, index) => {
    const line = logicalLineAt(editor, selection.head);
    const raw = text.sliceString(line.from, line.to);
    // `o` opens a line the way Enter would, so it continues a list, task or
    // quote rather than only copying the indentation.
    const prefix = markdownContinuationPrefix(raw);
    return {
      from: where === "above" ? line.from : line.to,
      insert: where === "above" ? `${prefix}\n` : `\n${prefix}`,
      indentLength: prefix.length,
      main: index === state.selection.mainIndex,
    };
  }).sort((left, right) => left.from - right.from);
  const unique = candidates.filter((candidate, index) => (
    index === 0 || candidate.from !== candidates[index - 1]!.from
  ));
  if (unique.length === 0) return;
  const changes = state.changes(unique.map(({ from, insert }) => ({ from, insert })));
  const ranges = unique.map((candidate) => {
    const mapped = changes.mapPos(candidate.from, where === "above" ? -1 : 1);
    return EditorSelection.cursor(
      where === "above" ? mapped + candidate.indentLength : mapped,
    );
  });
  let mainIndex = unique.findIndex((candidate) => candidate.main);
  if (mainIndex < 0) mainIndex = Math.min(state.selection.mainIndex, unique.length - 1);
  editor.view.dispatch(state.update({
    changes,
    selection: EditorSelection.create(ranges, mainIndex),
    scrollIntoView: true,
  }));
  restoreRevealedFormula(editor, revealed);
}

export function createVimLite(
  editor: Editor,
  host: HTMLElement,
  options: VimLiteOptions = {},
): VimLiteController {
  let mode: VimLiteMode = "insert";
  let normalGoalColumns: VerticalGoal[] | null = null;
  let visualGoalColumns: VerticalGoal[] | null = null;
  let pending = "";
  let countBuffer = "";
  /** Count captured when an operator key was pressed, replayed when it completes. */
  let pendingCount = 1;
  /** Operator waiting for its motion (`d`, `c`, `y`). */
  let pendingOperator: VimOperator | null = null;
  /** Set while an operator is waiting for a `g` motion's second key. */
  let pendingOperatorGoto: number | null = null;
  /** Find chord waiting for its target character. */
  let pendingFindKind: VimFindKind | null = null;
  /** Last `f`/`F`/`t`/`T` target, replayed by `;` and reversed by `,`. */
  let lastFind: { kind: VimFindKind; target: string } | null = null;
  let jumpInput: VimJumpInput | null = null;
  let jumpSession: VimJumpSession | null = null;
  let jumpLabelPrefix = "";
  let visualAnchor: number | null = null;
  let visualHead: number | null = null;
  let visualLineStates: VisualLineState[] | null = null;
  let insertEntry: { doc: Text; boundary: number; returnPos: number } | null = null;
  let register: VimRegister = { text: "", kind: "characterwise", fragments: [] };
  let destroyed = false;
  let asyncEpoch = 0;
  const jumpTimeoutMs = Math.max(0, options.jumpTimeoutMs ?? AVY_TIMEOUT_MS);
  // Tracks the in-flight system clipboard write so paste() can wait for it
  // before reading back. Avoids the dd→p race where writeText is async.
  let pendingClipboardWrite: Promise<void> = Promise.resolve();

  function yankToSystemClipboard(text: string): Promise<void> {
    if (typeof window !== "undefined" && window.location.protocol === "about:") {
      return Promise.resolve();
    }
    return writeSystemClipboard(text).then(() => {}, () => {});
  }

  function yank(text: string | readonly string[], kind: VimRegisterKind = "characterwise"): void {
    const values = (Array.isArray(text) ? text : [text])
      .filter((value): value is string => Boolean(value));
    if (values.length === 0) return;
    const fragments = values.map((value) => (
      kind === "linewise" && !value.endsWith("\n") ? `${value}\n` : value
    ));
    const registerText = fragments.join(kind === "linewise" ? "" : "\n");
    register = { text: registerText, kind, fragments };
    (window as unknown as Record<string, unknown>).__aaronoteVimRegister = register;
    pendingClipboardWrite = yankToSystemClipboard(registerText);
  }

  /**
   * Consume the pending count prefix, defaulting to Vim's implicit 1.
   *
   * Capped because a count drives real work per repetition: an accidental
   * `999999999j` from a stuck key must not freeze the editor. The cap is far
   * above any document a person navigates by counting lines.
   */
  function takeCount(): number {
    const raw = countBuffer;
    countBuffer = "";
    if (!raw) return 1;
    return clamp(Number.parseInt(raw, 10) || 1, 1, MAX_VIM_COUNT);
  }

  /**
   * Total repetitions for an operator chord. Vim multiplies the count typed
   * before the operator by the one typed before its motion: `2d3d` is 6 lines.
   */
  function operatorCount(): number {
    const banked = pendingCount;
    pendingCount = 1;
    return clamp(banked * takeCount(), 1, MAX_VIM_COUNT);
  }

  /** Chords whose next key is a literal argument, never a count digit. */
  function pendingTakesLiteralKey(): boolean {
    return pending === "r" || pendingFindKind !== null;
  }

  /**
   * Run OPERATOR over the range each caret's MOTION selects.
   *
   * Returns false when KEY is not a motion, so the caller can report the chord
   * instead of silently eating it.
   */
  function applyOperatorMotion(
    operator: VimOperator,
    key: string,
    count: number,
    find: { kind: VimFindKind; target: string } | null,
  ): boolean {
    const state = editor.view.state;
    const text = state.doc;
    const resolved = state.selection.ranges.map((range) => (
      operatorMotionRange(editor, operator, range.head, key, count, find)
    ));
    if (resolved.some((range) => range == null)) return false;
    const found = resolved as OperatorMotionRange[];
    const linewise = found.some((range) => range.linewise);
    const ranges = uniqueRanges(found.map(({ from, to }) => ({ from, to })))
      .filter((range) => range.from < range.to);

    resetMotionMemory();
    if (ranges.length === 0) {
      // A motion that selects nothing is still a completed command; `c` still
      // opens Insert where Vim would, the others simply do nothing.
      if (operator === "c") enterInsert();
      return true;
    }

    const fragments = ranges.map((range) => {
      const value = text.sliceString(range.from, range.to);
      return linewise && !value.endsWith("\n") ? `${value}\n` : value;
    });
    yank(fragments, linewise ? "linewise" : "characterwise");
    if (operator === "y") {
      // Vim parks the caret at the start of what it yanked.
      setNormalCursorPositions(editor, ranges.map((range) => range.from));
      return true;
    }

    const changes = state.changes(ranges.map(({ from, to }) => ({ from, to })));
    const applied = changes.apply(state.doc);
    const cursors = ranges.map((range) => {
      const at = changes.mapPos(range.from, -1);
      if (operator === "c") return EditorSelection.cursor(at);
      return EditorSelection.cursor(
        linewise ? linewiseLandingPosition(applied, at) : normalCharPosition(applied, at),
      );
    });
    editor.view.dispatch(state.update({
      changes,
      selection: EditorSelection.create(cursors, Math.min(state.selection.mainIndex, cursors.length - 1)),
      scrollIntoView: true,
    }));
    if (operator === "c") enterInsert();
    return true;
  }

  /**
   * Feed KEY to a waiting operator. Handles the doubled form (`dd`), the find
   * chords that need one more key (`dt,`), and every plain motion.
   */
  function continueOperator(operator: VimOperator, key: string): boolean {
    if (isFindKind(key)) {
      pendingOperator = operator;
      pendingFindKind = key;
      pendingCount = clamp(pendingCount * takeCount(), 1, MAX_VIM_COUNT);
      return true;
    }
    if (key === operator) {
      const count = operatorCount();
      if (operator === "y") yankLine(count);
      else if (operator === "d") deleteLineCommand(count);
      else {
        // `cc` clears the line's text but keeps the line and its indentation,
        // which is what Vim does with autoindent on.
        resetMotionMemory();
        setCursorPositions(editor, lineFirstNonBlankPositions(editor));
        yank(deleteToLineEnd(editor, true), "characterwise");
        enterInsert();
      }
      return true;
    }
    const explicitCount = countBuffer.length > 0 || pendingCount > 1;
    const count = operatorCount();
    if (key === "g") {
      // Only `gg` is a motion here; bank the count for it.
      pendingOperator = operator;
      pendingOperatorGoto = count;
      return true;
    }
    if (key === "G") {
      // Bare `dG` reaches the last line; `d5G` reaches line 5.
      const line = explicitCount ? count : doc(editor).lines;
      return applyOperatorMotion(operator, "G", line, null);
    }
    if (applyOperatorMotion(operator, key, count, lastFind)) return true;
    if (key !== "Escape") reportUnhandled(`${operator}${key}`);
    return true;
  }

  /** Accumulate a count digit. `0` is a motion until a count is already open. */
  function consumeCountDigit(key: string): boolean {
    if (pendingTakesLiteralKey()) return false;
    if (!/^[0-9]$/u.test(key)) return false;
    if (key === "0" && !countBuffer) return false;
    // Keep the buffer short; takeCount() clamps the value anyway.
    if (countBuffer.length < 9) countBuffer += key;
    return true;
  }

  function applyFindChar(kind: VimFindKind, target: string, count: number): boolean {
    resetMotionMemory();
    lastFind = { kind, target };
    return moveFindChar(editor, kind, target, count);
  }

  /** `;` repeats the last find; `,` runs its mirror image. */
  function repeatFindChar(reverse: boolean, count: number): boolean {
    if (!lastFind) return false;
    const mirrored: Record<VimFindKind, VimFindKind> = { f: "F", F: "f", t: "T", T: "t" };
    const kind = reverse ? mirrored[lastFind.kind] : lastFind.kind;
    resetMotionMemory();
    return moveFindChar(editor, kind, lastFind.target, count, kind === "t" || kind === "T");
  }

  function reportUnhandled(sequence: string): void {
    if (sequence) options.onUnhandledKey?.(sequence);
  }

  function resetMotionMemory(): void {
    normalGoalColumns = null;
    visualGoalColumns = null;
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
    countBuffer = "";
    pendingOperator = null;
    pendingOperatorGoto = null;
    pendingFindKind = null;
    pendingCount = 1;
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

  function normalizeNormalSelections(
    collapse: boolean,
    mainOverride: number | null = null,
    fromInsert = false,
  ): void {
    const state = editor.view.state;
    const candidates = state.selection.ranges.map((range, index) => {
      const overridden = index === state.selection.mainIndex && mainOverride != null;
      let position = overridden
        ? mainOverride
        : range.head;
      if (collapse && !range.empty && !overridden) {
        // `!overridden` matters: leaving Visual after `y` asks for the caret at
        // the start of the yank, but the selection is still the whole yanked
        // range, so collapsing it to `head - 1` silently threw that away and
        // parked the caret at the far end instead.
        position = range.head > range.anchor
          ? previousGraphemePosition(state.doc, range.head)
          : range.head;
      } else if (fromInsert && range.empty && !overridden) {
        position = insertExitPosition(state.doc, range.head);
      }
      return {
        position: normalEditorPosition(editor, position),
        main: index === state.selection.mainIndex,
      };
    }).sort((left, right) => left.position - right.position);
    const unique = candidates.filter((candidate, index) => (
      index === 0 || candidate.position !== candidates[index - 1]!.position
    ));
    if (unique.length === 0) return;
    let mainIndex = unique.findIndex((candidate) => candidate.main);
    if (mainIndex < 0) mainIndex = Math.min(state.selection.mainIndex, unique.length - 1);
    const selection = EditorSelection.create(
      unique.map((candidate) => EditorSelection.cursor(candidate.position)),
      mainIndex,
    );
    const current = state.selection;
    const same = current.ranges.length === selection.ranges.length
      && current.mainIndex === selection.mainIndex
      && current.ranges.every((range, index) => (
        range.anchor === selection.ranges[index]?.anchor
        && range.head === selection.ranges[index]?.head
      ));
    if (!same) editor.view.dispatch({ selection, scrollIntoView: true });
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
    visualLineStates = null;
    if (next !== "insert" || previous !== "insert") insertEntry = null;
    resetMotionMemory();
    if (leavingVisual && next !== "visual" && next !== "visual-line") {
      if (next === "normal") normalizeNormalSelections(true, exitHead);
      else setPos(editor, exitHead);
    } else if (previous === "insert" && next === "normal") {
      // Programmatic mode changes only reinterpret the existing cursor.  The
      // Vim one-character-left Escape rule is applied by escapeToNormal(),
      // where we can also preserve a revealed formula's content boundary.
      normalizeNormalSelections(false);
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
    const leavingInsert = mode === "insert";
    const visualExitPositions = mode === "visual-line"
      ? visualLineStates?.map((state) => state.head) ?? null
      : mode === "visual"
        ? currentVisualCharStates().map((state) => state.head)
        : null;
    const visualExitMainIndex = editor.view.state.selection.mainIndex;
    let target = currentHead(editor);
    if (mode === "insert") {
      const text = doc(editor);
      const source = formulaSourceRangeAtPosition(editor.view, currentHead(editor));
      if (source) {
        const formula = formulaRangeAtWidgetPosition(editor.view.state, currentHead(editor))
          ?? formulaRangeAtWidgetPosition(editor.view.state, source.from);
        const contentFrom = formula?.contentFrom ?? source.from;
        const contentTo = formula?.contentTo ?? source.to;
        const candidate = insertExitPosition(text, currentHead(editor));
        // Esc is a Vim mode transition, not a request to commit/collapse the
        // locally revealed TeX source. Keep the Normal cursor on formula
        // content (never on a \( / \[ fence), including display math whose
        // closing fence begins on the next line.
        target = candidate >= contentTo && contentTo > contentFrom
          ? previousGraphemePosition(text, contentTo)
          : clamp(candidate, contentFrom, contentTo);
      } else {
        target = insertEntry?.doc === text && insertEntry.boundary === currentHead(editor)
          ? insertEntry.returnPos
          : insertExitPosition(text, currentHead(editor));
      }
    } else if (mode === "visual" || mode === "visual-line") {
      target = visualHead ?? target;
    }
    setMode("normal");
    // End the pointer lifecycle and enforce the collapsed CM6 selection in
    // one final transaction. This remains correct when a host mouseup missed
    // Vim-mode synchronization or when a linewise selection owns a newline.
    cancelPointerSelection(editor.view);
    if (visualExitPositions) {
      setNormalCursorPositions(editor, visualExitPositions, visualExitMainIndex);
    } else {
      normalizeNormalSelections(false, target, leavingInsert);
    }
  }

  type VisualCharState = { anchor: number; head: number };
  type VisualLineState = VisualCharState & {
    scope: { from: number; to: number } | null;
  };

  function currentVisualCharStates(): VisualCharState[] {
    const text = doc(editor);
    return editor.view.state.selection.ranges.map((range) => {
      if (range.empty) {
        const pos = normalEditorPosition(editor, range.head);
        return { anchor: pos, head: pos };
      }
      const forward = range.head > range.anchor;
      const rawAnchor = normalCharPosition(
        text,
        forward ? range.anchor : previousGraphemePosition(text, range.anchor),
      );
      const rawHead = normalCharPosition(
        text,
        forward ? previousGraphemePosition(text, range.head) : range.head,
      );
      return {
        anchor: staticMathObjectAtPosition(editor, rawAnchor)?.from ?? rawAnchor,
        head: staticMathObjectAtPosition(editor, rawHead)?.from ?? rawHead,
      };
    });
  }

  /**
   * Publish a Visual selection without re-announcing one that is already live.
   *
   * Reading a rendered selection back is lossy: an endpoint that was snapped to
   * a formula's start renders as the formula's *end*, and reading that end
   * returns the start again. A selection-change listener that re-renders what
   * it just read therefore never reaches a fixed point, and because the whole
   * cycle runs in microtasks it never yields either — the page freezes. Sending
   * the scroll without the (identical) selection breaks that loop at its source.
   */
  function dispatchVisualSelection(selection: EditorSelection): void {
    editor.view.dispatch(selection.eq(editor.view.state.selection)
      ? { scrollIntoView: true }
      : { selection, scrollIntoView: true });
  }

  function renderVisualCharStates(states: readonly VisualCharState[]): void {
    if (states.length === 0) return;
    const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
    const main = states[mainIndex]!;
    visualAnchor = main.anchor;
    visualHead = main.head;
    dispatchVisualSelection(EditorSelection.create(states.map((state) => (
      state.head >= state.anchor
        ? EditorSelection.range(state.anchor, visualObjectEndPosition(editor, state.head))
        : EditorSelection.range(visualObjectEndPosition(editor, state.anchor), state.head)
    )), mainIndex));
  }

  function setVisualHead(head: number): void {
    const states = currentVisualCharStates();
    const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
    const normalized = normalCharPosition(doc(editor), head);
    states[mainIndex] = {
      anchor: states[mainIndex]?.anchor ?? normalized,
      head: staticMathObjectAtPosition(editor, normalized)?.from ?? normalized,
    };
    renderVisualCharStates(states);
  }

  function swapVisualEnds(): void {
    renderVisualCharStates(currentVisualCharStates().map((state) => ({
      anchor: state.head,
      head: state.anchor,
    })));
  }

  function renderVisualLineStates(states: readonly VisualLineState[]): void {
    if (states.length === 0) return;
    const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
    const selection = EditorSelection.create(states.map((state) => {
      const range = logicalLineSelectionRange(editor, state.anchor, state.head, state.scope);
      return state.head >= state.anchor
        ? EditorSelection.range(range.from, range.to)
        : EditorSelection.range(range.to, range.from);
    }), mainIndex);
    const text = doc(editor);
    // CM6 merges overlapping ranges. Rebuild our motion state from that
    // normalized selection so cursors that meet stay merged instead of
    // mysteriously reappearing on the next j/k.
    visualLineStates = selection.ranges.map((range) => {
      const forward = range.head >= range.anchor;
      const anchorPos = forward
        ? range.from
        : previousGraphemePosition(text, range.to);
      const headPos = forward
        ? previousGraphemePosition(text, range.to)
        : range.from;
      const anchor = logicalLineAt(editor, anchorPos).cursor;
      const headLine = logicalLineAt(editor, headPos);
      return { anchor, head: headLine.cursor, scope: headLine.formulaScope };
    });
    const normalizedMainIndex = selection.mainIndex;
    const main = visualLineStates[normalizedMainIndex]!;
    visualAnchor = main.anchor;
    visualHead = main.head;
    dispatchVisualSelection(selection);
  }

  function lineStatesFromCharStates(states: readonly VisualCharState[]): VisualLineState[] {
    return states.map((state) => ({
      ...state,
      scope: logicalLineAt(editor, state.head).formulaScope,
    }));
  }

  function switchToVisualLine(): void {
    const states = lineStatesFromCharStates(currentVisualCharStates());
    const changed = mode !== "visual-line";
    mode = "visual-line";
    resetMotionMemory();
    renderVisualLineStates(states);
    if (changed) options.onModeChange?.(mode);
  }

  function switchToVisualChar(): void {
    const states = visualLineStates?.map(({ anchor, head }) => ({
      anchor: normalCharPosition(doc(editor), anchor),
      head: normalCharPosition(doc(editor), head),
    })) ?? currentVisualCharStates();
    const changed = mode !== "visual";
    mode = "visual";
    visualLineStates = null;
    resetMotionMemory();
    renderVisualCharStates(states);
    if (changed) options.onModeChange?.(mode);
  }

  function enterVisual(): void {
    const states = currentVisualCharStates();
    const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
    const formula = revealedFormulaAt(editor, states[mainIndex]?.head ?? currentHead(editor));
    // There is no character to own in an empty formula. Selecting the closing
    // fence made `v` look active while a later delete corrupted the formula.
    if (formula && formula.contentFrom >= formula.contentTo) return;
    setMode("visual");
    renderVisualCharStates(states);
  }

  function enterVisualLine(): void {
    const states = currentVisualCharStates().map((state) => {
      const line = logicalLineAt(editor, state.head);
      return { anchor: line.cursor, head: line.cursor, scope: line.formulaScope };
    });
    setMode("visual-line");
    renderVisualLineStates(states);
  }

  function visualMoveChar(dir: -1 | 1): void {
    resetMotionMemory();
    const text = doc(editor);
    renderVisualCharStates(currentVisualCharStates().map((state) => {
      const target = moveNormalCharPosition(text, state.head, dir);
      return { ...state, head: snapStaticMathMotion(editor, state.head, target, dir) };
    }));
  }

  function visualMoveLine(dir: -1 | 1): void {
    const text = doc(editor);
    const states = currentVisualCharStates();
    const rect = editor.view.contentDOM.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      const nextGoals: VerticalGoal[] = [];
      const next = states.map((state, index) => {
        const line = docLineInfo(text, normalCharPosition(text, state.head));
        const goal = visualGoalColumns?.[index];
        const desired = goal?.kind === "column" ? goal.value : line.column;
        nextGoals.push({ kind: "column", value: desired });
        if (dir < 0 && line.start > 0) {
          const previous = docLineInfo(text, line.start - 1);
          return { ...state, head: Math.min(previous.start + desired, previous.end) };
        }
        if (dir > 0 && line.end < text.length) {
          const following = docLineInfo(text, line.end + 1);
          return { ...state, head: Math.min(following.start + desired, following.end) };
        }
        return state;
      });
      visualGoalColumns = nextGoals;
      renderVisualCharStates(next);
      return;
    }
    const nextGoals: VerticalGoal[] = [];
    const next = states.map((state, index) => {
      const start = normalCharPosition(text, state.head);
      const coords = editor.view.coordsAtPos(start);
      const goal = visualGoalColumns?.[index];
      const pixelGoal = goal?.kind === "pixel"
        ? goal.value
        : coords
          ? coords.left - rect.left
          : editor.view.defaultCharacterWidth * docLineInfo(text, start).column;
      const moved = editor.view.moveVertically(
        EditorSelection.cursor(start, 0, undefined, pixelGoal),
        dir > 0,
      );
      nextGoals.push({ kind: "pixel", value: moved.goalColumn ?? pixelGoal });
      return { ...state, head: crossedVisualEntry(editor, start, moved.head, dir) ?? moved.head };
    });
    visualGoalColumns = nextGoals;
    renderVisualCharStates(next);
  }

  function visualLineMove(dir: -1 | 1): void {
    const text = doc(editor);
    const states = visualLineStates ?? lineStatesFromCharStates(currentVisualCharStates());
    renderVisualLineStates(states.map((state) => {
      const current = state.scope
        ? boundedLogicalLine(text, state.head, state.scope.from, state.scope.to, state.scope)
        : logicalLineAt(editor, state.head);
      let nextPos = dir > 0 ? current.selectionTo : current.selectionFrom - 1;
      if (state.scope) {
        if (dir > 0 && nextPos >= state.scope.to) return state;
        if (dir < 0 && nextPos < state.scope.from) return state;
      } else if ((dir > 0 && nextPos >= text.length) || (dir < 0 && nextPos < 0)) {
        return state;
      }
      nextPos = clamp(nextPos, state.scope?.from ?? 0, state.scope?.to ?? text.length);
      const next = state.scope
        ? boundedLogicalLine(text, nextPos, state.scope.from, state.scope.to, state.scope)
        : logicalLineAt(editor, nextPos);
      return { ...state, head: next.cursor };
    }));
  }

  function visualLineBoundary(which: "start" | "end"): void {
    resetMotionMemory();
    const text = doc(editor);
    renderVisualCharStates(currentVisualCharStates().map((state) => ({
      ...state,
      head: normalCharPosition(text, visualRowBoundary(editor, state.head, which)),
    })));
  }

  function visualDocumentBoundary(which: "start" | "end"): void {
    resetMotionMemory();
    const target = which === "start" ? 0 : doc(editor).length;
    renderVisualCharStates(currentVisualCharStates().map((state) => ({ ...state, head: target })));
  }

  function visualLineDocumentBoundary(which: "start" | "end"): void {
    resetMotionMemory();
    const text = doc(editor);
    const states = visualLineStates ?? lineStatesFromCharStates(currentVisualCharStates());
    renderVisualLineStates(states.map((state) => {
      const boundary = state.scope
        ? which === "start" ? state.scope.from : state.scope.to
        : which === "start" ? 0 : text.length;
      const target = state.scope && which === "end" && boundary > state.scope.from
        ? boundary - 1
        : boundary;
      const head = (state.scope
        ? boundedLogicalLine(text, target, state.scope.from, state.scope.to, state.scope)
        : logicalLineAt(editor, target)).cursor;
      return { ...state, head };
    }));
  }

  function visualMoveWord(dir: -1 | 1, bigWord = false): void {
    resetMotionMemory();
    const text = doc(editor);
    renderVisualCharStates(currentVisualCharStates().map((state) => {
      const target = wordMotionPosition(text, state.head, dir, bigWord);
      return {
        ...state,
        head: normalCharPosition(text, snapStaticMathMotion(editor, state.head, target, dir)),
      };
    }));
  }

  function visualMoveWordEnd(bigWord: boolean, count: number): void {
    resetMotionMemory();
    const text = doc(editor);
    renderVisualCharStates(currentVisualCharStates().map((state) => {
      let target = state.head;
      for (let step = 0; step < count; step++) target = wordEndPosition(text, target, bigWord);
      return {
        ...state,
        head: normalCharPosition(text, snapStaticMathMotion(editor, state.head, target, 1)),
      };
    }));
  }

  function visualMoveParagraph(dir: -1 | 1, count: number): void {
    resetMotionMemory();
    const text = doc(editor);
    renderVisualCharStates(currentVisualCharStates().map((state) => {
      let target = state.head;
      for (let step = 0; step < count; step++) target = paragraphPosition(text, target, dir);
      return { ...state, head: normalCharPosition(text, target) };
    }));
  }

  function visualMoveFirstNonBlank(): void {
    resetMotionMemory();
    const text = doc(editor);
    renderVisualCharStates(currentVisualCharStates().map((state) => ({
      ...state,
      head: firstNonBlankPosition(text, state.head),
    })));
  }

  function visualFindChar(
    kind: VimFindKind,
    target: string,
    count: number,
    skipAdjacent = false,
  ): boolean {
    resetMotionMemory();
    const text = doc(editor);
    let found = false;
    renderVisualCharStates(currentVisualCharStates().map((state) => {
      const hit = findCharPosition(text, state.head, kind, target, count, skipAdjacent);
      if (hit == null) return state;
      found = true;
      return { ...state, head: hit };
    }));
    return found;
  }

  function syncSelectionFromEditor(): void {
    const text = doc(editor);
    const { anchor, head } = editor.getMarkdownSelectionRange();
    if (anchor === head) {
      if (mode === "visual" || mode === "visual-line") {
        visualHead = head;
        setMode("normal");
      } else if (mode === "normal") {
        normalizeNormalSelections(false);
      }
      return;
    }

    cancelJump();
    const forward = head > anchor;
    const rawAnchor = normalCharPosition(text, forward ? anchor : previousGraphemePosition(text, anchor));
    const rawHead = normalCharPosition(text, forward ? previousGraphemePosition(text, head) : head);
    visualAnchor = staticMathObjectAtPosition(editor, rawAnchor)?.from ?? rawAnchor;
    visualHead = staticMathObjectAtPosition(editor, rawHead)?.from ?? rawHead;
    const changed = mode !== "visual";
    mode = "visual";
    resetMotionMemory();
    if (changed) options.onModeChange?.(mode);
    if (visualAnchor !== rawAnchor || visualHead !== rawHead) setVisualHead(visualHead);
  }

  function deleteLineCommand(count = 1): void {
    resetMotionMemory();
    const revealed = editor.view.state.selection.ranges.length === 1
      ? revealedFormulaAt(editor, currentHead(editor))
      : null;
    yank(deleteLines(editor, count), "linewise");
    if (mode === "visual" || mode === "visual-line") visualHead = currentHead(editor);
    setMode("normal");
    restoreRevealedFormula(editor, revealed);
  }

  function yankSelection(kind: VimRegisterKind = "characterwise"): void {
    resetMotionMemory();
    const start = editor.getMarkdownSelection().from;
    yank(currentSelectionTexts(editor), kind);
    visualHead = start;
    setMode("normal");
  }

  function yankLine(count = 1): void {
    resetMotionMemory();
    const text = doc(editor);
    const ranges = new Map<string, VimLogicalLine>();
    for (const selection of editor.view.state.selection.ranges) {
      const range = count > 1
        ? selectedLogicalLine(editor, selection.from, countedLineSpanEnd(text, selection.from, count))
        : logicalLineAt(editor, selection.from);
      ranges.set(`${range.selectionFrom}:${range.selectionTo}`, range);
    }
    yank(
      [...ranges.values()]
        .sort((left, right) => left.selectionFrom - right.selectionFrom)
        .map((range) => range.registerText),
      "linewise",
    );
    setMode("normal");
  }

  function paste(where: "before" | "after"): void {
    resetMotionMemory();
    const replacingVisual = mode === "visual" || mode === "visual-line";
    const selectedRanges = editor.view.state.selection.ranges.map((range) => {
      if (replacingVisual || register.kind === "linewise") {
        return { from: range.from, to: range.to };
      }
      return {
        from: range.from,
        to: range.empty ? visualObjectEndPosition(editor, range.from) : range.to,
      };
    });
    const placement = replacingVisual
      ? { kind: "selection" as const }
      : register.kind === "linewise"
        ? { kind: "line" as const, where }
        : { kind: "character" as const, where };
    // Visual paste is a command completion, so leave Visual immediately.  The
    // captured range remains mapped while the clipboard read is pending.
    if (replacingVisual) setMode("normal");
    const target = captureEditorPasteTarget(editor.view, selectedRanges, {
      fragments: register.fragments.length > 0 ? register.fragments : [register.text],
      clipboardText: register.text,
    });
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
        const handled = await editor.pasteFromClipboard({ placement, target });
        if (!handled && localRegister.text) {
          editor.pastePlainText(localRegister.text, { placement, target });
        }
        // Paste APIs naturally leave insertion-boundary carets. If the user
        // has not switched modes while the clipboard was pending, restore
        // legal Normal positions for every cursor without stealing a later
        // Insert-mode selection.
        if (mode === "normal") normalizeNormalSelections(false);
      })().finally(() => {
        if (!destroyed && epoch === asyncEpoch) releaseEditorPasteTarget(editor.view, target);
      });
    }, 0);
  }

  /**
   * `3>>` indents three lines, not the current line three levels. The host's
   * indent command works on the selection, so a count is expressed by widening
   * the selection over those lines and restoring a Normal caret afterwards —
   * on the first non-blank of the first line, where Vim leaves it.
   */
  function indentLines(direction: 1 | -1, count: number): boolean {
    resetMotionMemory();
    if (count <= 1) return options.onIndent?.(direction) ?? true;
    const text = doc(editor);
    const first = text.lineAt(clamp(currentHead(editor), 0, text.length));
    const last = text.line(Math.min(text.lines, first.number + count - 1));
    const lineStart = first.from;
    editor.view.dispatch({ selection: EditorSelection.single(lineStart, last.to) });
    const handled = options.onIndent?.(direction) ?? true;
    setNormalCursorPositions(editor, [firstNonBlankPosition(doc(editor), lineStart)]);
    return handled;
  }

  function foldCommand(action: VimLiteFoldAction): boolean {
    resetMotionMemory();
    return options.onFold?.(action) ?? true;
  }

  function appendChar(): void {
    const text = doc(editor);
    setCursorPositions(editor, editor.view.state.selection.ranges.map((range) => {
      const pos = normalCharPosition(text, range.head);
      const object = staticMathObjectAtPosition(editor, pos);
      if (object?.from === pos) return object.to;
      const line = docLineInfo(text, pos);
      return Math.min(line.end, graphemeEndPosition(text, pos));
    }));
    enterInsert();
  }

  function editableNormalCommand(key: string, editable: HTMLElement): boolean {
    if (!isRichEditable(editable)) {
      if (key === "i" || key === "a") {
        enterInsert();
        return true;
      }
      pending = "";
      // Normal mode must not destroy text. Printable keys are already
      // swallowed by the length check below, but Backspace and Delete are not
      // printable and would reach the control natively — so an embedded input
      // lost a character to a key Vim treats as a plain leftward motion, and
      // the rich-editable branch below already treats that way.
      if (key === "Backspace" || key === "Delete") return true;
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
        if (key.length !== 1) return false;
        reportUnhandled(key);
        return true;
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
    // Before the chord table so `3dd`, `d3d` and `3d3d` all count, but after
    // the jump reader, whose labels may themselves be digits.
    if (consumeCountDigit(key)) return true;
    if (pendingFindKind) {
      const kind = pendingFindKind;
      const operator = pendingOperator;
      const count = pendingCount;
      pendingFindKind = null;
      pendingOperator = null;
      pendingCount = 1;
      if (key.length !== 1) {
        if (key !== "Escape") reportUnhandled(`${operator ?? ""}${kind}${key}`);
        return true;
      }
      lastFind = { kind, target: key };
      const done = operator
        ? applyOperatorMotion(operator, kind, count, lastFind)
        : applyFindChar(kind, key, count);
      if (!done) reportUnhandled(`${operator ?? ""}${kind}${key}`);
      return true;
    }
    if (pendingOperator && pendingOperatorGoto != null) {
      const operator = pendingOperator;
      const banked = pendingOperatorGoto;
      pendingOperator = null;
      pendingOperatorGoto = null;
      if (key === "g") {
        // `dgg` / `ygg`: linewise from here to line `banked` (line 1 by default).
        applyOperatorMotion(operator, "G", banked, null);
      } else if (key !== "Escape") {
        reportUnhandled(`${operator}g${key}`);
      }
      return true;
    }
    if (pendingOperator) {
      const operator = pendingOperator;
      pendingOperator = null;
      return continueOperator(operator, key);
    }
    if (pending === "r") {
      const banked = pendingCount;
      pendingCount = 1;
      pending = "";
      if (key.length === 1) {
        resetMotionMemory();
        replaceChars(editor, key, banked);
        setMode("normal");
      } else if (key !== "Escape") {
        reportUnhandled(`r${key}`);
      }
      return true;
    }
    if (pending === "g") {
      const banked = pendingCount;
      pendingCount = 1;
      pending = "";
      if (key === "g") {
        resetMotionMemory();
        if (banked > 1) moveToLine(editor, banked);
        else docBoundary(editor, "start");
      } else {
        reportUnhandled(`g${key}`);
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
          reportUnhandled(`z${key}`);
          return true;
      }
    }
    if (pending === ">" || pending === "<") {
      const direction = pending === ">" ? 1 : -1;
      const chord = pending;
      const banked = pendingCount;
      pendingCount = 1;
      pending = "";
      if (key === chord) {
        indentLines(direction, banked);
      } else if (key !== "Escape") {
        reportUnhandled(`${chord}${key}`);
      }
      return true;
    }
    const hadCount = countBuffer.length > 0;
    const count = takeCount();
    switch (key) {
      case "h":
      case "ArrowLeft":
      case "Backspace":
        resetMotionMemory();
        for (let step = 0; step < count; step++) moveChar(editor, -1);
        return true;
      case "l":
      case "ArrowRight":
      case " ":
        resetMotionMemory();
        for (let step = 0; step < count; step++) moveChar(editor, 1);
        return true;
      case "j":
      case "ArrowDown":
        for (let step = 0; step < count; step++) {
          normalGoalColumns = moveScreenLine(editor, 1, normalGoalColumns);
        }
        return true;
      case "k":
      case "ArrowUp":
        for (let step = 0; step < count; step++) {
          normalGoalColumns = moveScreenLine(editor, -1, normalGoalColumns);
        }
        return true;
      case "0":
        resetMotionMemory();
        lineBoundary(editor, "start");
        return true;
      case "^":
        resetMotionMemory();
        moveFirstNonBlank(editor);
        return true;
      case "$":
        resetMotionMemory();
        lineBoundary(editor, "end");
        return true;
      case "w":
        resetMotionMemory();
        for (let step = 0; step < count; step++) moveWord(editor, 1);
        return true;
      case "W":
        resetMotionMemory();
        for (let step = 0; step < count; step++) moveWord(editor, 1, true);
        return true;
      case "b":
        resetMotionMemory();
        for (let step = 0; step < count; step++) moveWord(editor, -1);
        return true;
      case "B":
        resetMotionMemory();
        for (let step = 0; step < count; step++) moveWord(editor, -1, true);
        return true;
      case "e":
        resetMotionMemory();
        moveWordEnd(editor, false, count);
        return true;
      case "E":
        resetMotionMemory();
        moveWordEnd(editor, true, count);
        return true;
      case "{":
        resetMotionMemory();
        moveParagraph(editor, -1, count);
        return true;
      case "}":
        resetMotionMemory();
        moveParagraph(editor, 1, count);
        return true;
      case "f":
      case "F":
      case "t":
      case "T":
        pendingCount = count;
        pendingFindKind = key;
        return true;
      case ";":
        if (!repeatFindChar(false, count)) reportUnhandled(key);
        return true;
      case ",":
        if (!repeatFindChar(true, count)) reportUnhandled(key);
        return true;
      case "u":
        options.onUndo?.();
        return true;
      case "g":
        pendingCount = count;
        pending = "g";
        return true;
      case "z":
        pending = "z";
        return true;
      case "G":
        resetMotionMemory();
        // A count turns `G` into "go to line N", which is why it cannot just
        // repeat the document-end motion.
        if (hadCount) moveToLine(editor, count);
        else docBoundary(editor, "end");
        return true;
      case "i":
        {
          const returnPos = staticMathObjectAtPosition(editor, currentHead(editor))?.from
            ?? normalCharPosition(doc(editor), currentHead(editor));
          enterInsert(returnPos);
          if (enterStaticMathObject(editor, "start")) {
            insertEntry = {
              doc: doc(editor),
              boundary: currentHead(editor),
              returnPos,
            };
          }
        }
        return true;
      case "v":
        enterVisual();
        return true;
      case "V":
        enterVisualLine();
        return true;
      case "a":
        if (staticMathObjectAtPosition(editor, currentHead(editor))) {
          const returnPos = staticMathObjectAtPosition(editor, currentHead(editor))!.from;
          enterInsert(returnPos);
          if (enterStaticMathObject(editor, "end")) {
            insertEntry = { doc: doc(editor), boundary: currentHead(editor), returnPos };
          }
        } else appendChar();
        return true;
      case "I":
        resetMotionMemory();
        setCursorPositions(editor, lineFirstNonBlankPositions(editor));
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
        yank(deleteCharsCounted(editor, count, false));
        normalizeNormalSelections(false);
        return true;
      case "X":
        resetMotionMemory();
        yank(deleteCharsCounted(editor, count, true));
        normalizeNormalSelections(false);
        return true;
      case "D":
        resetMotionMemory();
        yank(deleteToLineEnd(editor, false));
        return true;
      case "C":
        resetMotionMemory();
        yank(deleteToLineEnd(editor, true));
        enterInsert();
        return true;
      case "Y":
        resetMotionMemory();
        yank(yankToLineEnd(editor));
        return true;
      case "J":
        resetMotionMemory();
        if (!joinLines(editor, count)) reportUnhandled(key);
        return true;
      case "~":
        resetMotionMemory();
        if (!toggleCaseForward(editor, count)) reportUnhandled(key);
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
        options.onFind?.();
        return true;
      case "r":
        pendingCount = count;
        pending = "r";
        return true;
      case "d":
      case "c":
      case "y":
        pendingCount = count;
        pendingOperator = key;
        return true;
      case ">":
      case "<":
        pendingCount = count;
        pending = key;
        return true;
      case "Escape":
        setMode("normal");
        return true;
      default:
        pending = "";
        countBuffer = "";
        pendingCount = 1;
        pendingOperator = null;
        pendingOperatorGoto = null;
        if (key.length !== 1) return false;
        reportUnhandled(key);
        return true;
    }
  }

  function visualCommand(key: string): boolean {
    if (consumeCountDigit(key)) return true;
    if (pendingFindKind) {
      const kind = pendingFindKind;
      const count = pendingCount;
      pendingFindKind = null;
      pendingCount = 1;
      if (key.length !== 1) {
        if (key !== "Escape") reportUnhandled(`${kind}${key}`);
        return true;
      }
      lastFind = { kind, target: key };
      if (!visualFindChar(kind, key, count, false)) reportUnhandled(`${kind}${key}`);
      return true;
    }
    if (pending === "d") {
      pending = "";
      if (key === "d") {
        deleteLineCommand();
        return true;
      }
      reportUnhandled(`d${key}`);
      return true;
    }
    if (pending === "r") {
      pending = "";
      if (key.length === 1) {
        resetMotionMemory();
        const replacedFrom = replaceChars(editor, key);
        if (replacedFrom != null) visualHead = replacedFrom;
      } else {
        reportUnhandled(`r${key}`);
      }
      setMode("normal");
      return true;
    }
    if (pending === "g") {
      pending = "";
      if (key === "g") visualDocumentBoundary("start");
      else reportUnhandled(`g${key}`);
      return true;
    }
    const count = takeCount();
    switch (key) {
      case "h":
      case "ArrowLeft":
      case "Backspace":
        for (let step = 0; step < count; step++) visualMoveChar(-1);
        return true;
      case "l":
      case "ArrowRight":
      case " ":
        for (let step = 0; step < count; step++) visualMoveChar(1);
        return true;
      case "j":
      case "ArrowDown":
        for (let step = 0; step < count; step++) visualMoveLine(1);
        return true;
      case "k":
      case "ArrowUp":
        for (let step = 0; step < count; step++) visualMoveLine(-1);
        return true;
      case "0":
        visualLineBoundary("start");
        return true;
      case "^":
        visualMoveFirstNonBlank();
        return true;
      case "$":
        visualLineBoundary("end");
        return true;
      case "g":
        pending = "g";
        return true;
      case "G":
        visualDocumentBoundary("end");
        return true;
      case "w":
        for (let step = 0; step < count; step++) visualMoveWord(1);
        return true;
      case "W":
        for (let step = 0; step < count; step++) visualMoveWord(1, true);
        return true;
      case "b":
        for (let step = 0; step < count; step++) visualMoveWord(-1);
        return true;
      case "B":
        for (let step = 0; step < count; step++) visualMoveWord(-1, true);
        return true;
      case "e":
        visualMoveWordEnd(false, count);
        return true;
      case "E":
        visualMoveWordEnd(true, count);
        return true;
      case "{":
        visualMoveParagraph(-1, count);
        return true;
      case "}":
        visualMoveParagraph(1, count);
        return true;
      case "f":
      case "F":
      case "t":
      case "T":
        pendingCount = count;
        pendingFindKind = key;
        return true;
      case ";":
      case ",": {
        if (!lastFind) { reportUnhandled(key); return true; }
        const mirrored: Record<VimFindKind, VimFindKind> = { f: "F", F: "f", t: "T", T: "t" };
        const kind = key === "," ? mirrored[lastFind.kind] : lastFind.kind;
        if (!visualFindChar(kind, lastFind.target, count, kind === "t" || kind === "T")) {
          reportUnhandled(key);
        }
        return true;
      }
      case "~":
        resetMotionMemory();
        toggleCaseForward(editor, 1);
        setMode("normal");
        return true;
      case "J":
        resetMotionMemory();
        joinLines(editor, count);
        setMode("normal");
        return true;
      case "x":
      case "X":
      case "Delete":
      case "d":
        resetMotionMemory();
        yank(deleteChars(editor));
        visualHead = currentHead(editor);
        setMode("normal");
        return true;
      case "y":
        yankSelection();
        return true;
      case "p":
        paste("after");
        return true;
      case "P":
        paste("before");
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
        options.onFind?.();
        return true;
      case "v":
      case "Escape":
        setMode("normal");
        return true;
      default:
        pending = "";
        countBuffer = "";
        pendingCount = 1;
        pendingOperator = null;
        pendingOperatorGoto = null;
        if (key.length !== 1) return false;
        reportUnhandled(key);
        return true;
    }
  }

  function visualLineCommand(key: string): boolean {
    if (consumeCountDigit(key)) return true;
    if (pending === "g") {
      pending = "";
      if (key === "g") visualLineDocumentBoundary("start");
      return true;
    }
    const count = takeCount();
    switch (key) {
      case "h":
      case "l":
      case "ArrowLeft":
      case "ArrowRight":
      case "Backspace":
      case " ":
      case "0":
      case "$":
        // Visual-line owns whole logical rows. Horizontal input must not fall
        // through to CM6 and collapse the selection behind Vim's back.
        return true;
      case "j":
      case "ArrowDown":
        for (let step = 0; step < count; step++) visualLineMove(1);
        return true;
      case "k":
      case "ArrowUp":
        for (let step = 0; step < count; step++) visualLineMove(-1);
        return true;
      case "x":
      case "X":
      case "d":
      case "Delete":
        deleteLineCommand();
        return true;
      case "J":
        resetMotionMemory();
        joinLines(editor, count);
        setMode("normal");
        return true;
      case "~":
        resetMotionMemory();
        toggleCaseForward(editor, 1);
        setMode("normal");
        return true;
      case "y":
        yankSelection("linewise");
        return true;
      case "p":
        paste("after");
        return true;
      case "P":
        paste("before");
        return true;
      case "g":
        pending = "g";
        return true;
      case "G":
        visualLineDocumentBoundary("end");
        return true;
      case "o":
        renderVisualLineStates((visualLineStates ?? []).map((state) => ({
          ...state,
          anchor: state.head,
          head: state.anchor,
        })));
        return true;
      case "v":
        switchToVisualChar();
        return true;
      case "/":
        resetMotionMemory();
        options.onFind?.();
        return true;
      case "V":
      case "Escape":
        setMode("normal");
        return true;
      default:
        pending = "";
        countBuffer = "";
        pendingCount = 1;
        pendingOperator = null;
        pendingOperatorGoto = null;
        if (key.length !== 1) return false;
        reportUnhandled(key);
        return true;
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
        if (!hasCommandModifier(event)
          && !event.shiftKey
          && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          return activateInlineMathFromArrow(editor.view, event.key);
        }
        return false;
      }
      if (mode === "normal"
          && event.shiftKey
          && !hasCommandModifier({ ...event, shiftKey: false })
          && /^Arrow(?:Left|Right|Up|Down)$/u.test(event.key)) {
        const command = event.key === "ArrowLeft" ? selectCharLeft
          : event.key === "ArrowRight" ? selectCharRight
            : event.key === "ArrowUp" ? selectLineUp
              : selectLineDown;
        if (command(editor.view)) syncSelectionFromEditor();
        // A boundary no-op is still a recognized modal command and must not
        // fall through to browser chrome.
        return true;
      }
      if (event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "r") {
        options.onRedo?.();
        return true;
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
