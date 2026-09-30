/**
 * Vim-lite: the modal layer of the Noema editor.
 *
 * Semantics follow Evil with `evil-respect-visual-line-mode`, which is how the
 * Emacs side of this configuration runs: Vim lines are the rows the reader
 * sees (`vim-rows.ts`), not raw Markdown source lines.  `j`/`k`, `0`/`^`/`$`,
 * `dd`/`yy`/`cc`, `V`, `D`/`C`/`Y`, `A`/`I`, `H`/`M`/`L` and `f`/`t` all act on
 * screen rows, and columns are pixel columns.  The `g` forms (`gj`, `gk`,
 * `g0`, `g^`, `g$`) and the line-number motions (`gg`, `G`, `+`, `-`, `_`)
 * keep their source-line meaning.  `docs/vim.md` is the user-facing contract;
 * keep it in step with this file.
 *
 * Key handling is one small parser shared by Normal, Visual and
 * operator-pending state: an optional count, an optional prefix (`g`, `z`,
 * `r`, `f`/`F`/`t`/`T`, `i`/`a`), then a token that names a motion, a text
 * object, an operator or a command.  Every motion is a pure position function
 * reused by all three states, so `dj`, `vj` and `j` can never disagree about
 * what a line is.
 */

import type { Editor } from "../src/lib.ts";
import { EditorSelection, findClusterBreak, type EditorState, type Text, type TransactionSpec } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { matchBrackets } from "@codemirror/language";
import { parser as markdownParser } from "@lezer/markdown";
import {
  isolateHistory,
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
import { getFencedCodeRanges, scanCodeRanges } from "../src/cm6/code-ranges.ts";
import { readImageTrailingAttrs } from "../src/image-attrs.ts";
import { writeSystemClipboard } from "../src/system-clipboard.ts";
import { getBlockMathRanges, rangeAtPosition, rangeOverlapsAny } from "../src/cm6/math-ranges.ts";
import { scanInlineMathRanges } from "../src/inline-math.ts";
import { getOrgEnvHeadingRanges, setTikzSourceEditing } from "../src/cm6/extensions/visual/widgets/block-extras.ts";
import { cancelPointerSelection } from "../src/cm6/extensions/visual/selection.ts";
import { refreshViewportDecorations } from "../src/cm6/viewport-refresh.ts";
import {
  formulaRangeAtWidgetPosition,
  formulaSourceRangeAtPosition,
  revealFormulaSource,
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
import {
  screenColumnAt,
  screenPosAtColumn,
  screenRowAt,
} from "./vim-rows.ts";
import {
  bracketObject,
  paragraphObject,
  quoteObject,
  wordObject,
  type TextObjectRange,
} from "./vim-text-objects.ts";

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
   * `n`/`N` after a `/` search: the start of the next match from FROM in
   * DIRECTION (wrapping), or null.  The host owns the find panel's query
   * syntax, so Vim asks rather than re-implementing it.
   */
  searchNext?: (from: number, direction: 1 | -1) => number | null;
  /**
   * A chord that Normal/Visual mode consumed as modal input but has no binding
   * for. Swallowing it silently is indistinguishable from a dropped keystroke,
   * which is the most disorienting thing a modal editor can do.
   */
  onUnhandledKey?: (sequence: string) => void;
  jumpTimeoutMs?: number;
};

export type VimOperator = "d" | "c" | "y" | ">" | "<" | "g~" | "gu" | "gU";
export type VimFindKind = "f" | "F" | "t" | "T";

type VimRegisterKind = "linewise" | "characterwise";

type VimRegister = {
  text: string;
  kind: VimRegisterKind;
  fragments: readonly string[];
};

type Scope = { from: number; to: number };
type RenderedObject = Scope & { block: boolean };

/**
 * One Vim line: a screen row, a source line (`logical`), or a whole collapsed
 * display formula.  `to` excludes the newline.  `lineStart`/`lineEnd` say
 * whether the row begins/ends its source line (or its formula scope), which is
 * what decides whether a linewise operation owns a newline.
 */
type VimRow = {
  from: number;
  to: number;
  lineStart: boolean;
  lineEnd: boolean;
  scope: Scope | null;
  logical: boolean;
};

/** Everything a linewise operator needs to know about a run of Vim lines. */
type LineSpan = {
  /** Half-open range shown by Visual-line and yanked by `yy`. */
  from: number;
  to: number;
  /** Range removed by `dd`; may borrow the preceding newline at the end of a scope. */
  deleteFrom: number;
  deleteTo: number;
  /** Range replaced by `cc`: keeps the indentation and the final newline. */
  changeFrom: number;
  changeTo: number;
  register: string;
  /** True when the span starts and ends on source-line boundaries. */
  wholeLines: boolean;
};

type OpRange =
  | { kind: "char"; from: number; to: number }
  | { kind: "line"; span: LineSpan };

type VerticalGoal =
  | { kind: "pixel"; value: number }
  | { kind: "column"; value: number }
  | { kind: "eol" };

type MotionKind = "exclusive" | "inclusive" | "linewise";

type MotionResult = {
  pos: number;
  kind: MotionKind;
  /** Linewise motions over source lines rather than screen rows. */
  logical?: boolean;
  /** Vertical motions carry their goal column to the next repetition. */
  goal?: VerticalGoal;
  /** Forward exclusive motions that obey Vim's `:h exclusive-linewise` rules. */
  exclusiveAdjust?: boolean;
};

type FindSpec = { kind: VimFindKind; target: string };

type SearchSpec =
  | { source: "word"; word: string; forward: boolean }
  | { source: "host"; forward: boolean };

type VimJumpInput = {
  direction: VimJumpDirection;
  needle: string;
  timer: number | null;
};

type VisualState = {
  anchor: number;
  head: number;
  scope: Scope | null;
  /** `w`/`W` keep the cursor at the next word start without selecting it. */
  exclusiveWordEnd?: boolean;
};

type InsertReplay = { deleteBefore: number; deleteAfter: number; text: string };

type LastChange = { keys: readonly string[]; insert: InsertReplay | null };

const AVY_TIMEOUT_MS = 500;
const MAX_VIM_COUNT = 10_000;
const OPERATOR_KEYS = new Set(["d", "c", "y", ">", "<"]);
const G_OPERATOR_KEYS = new Set(["~", "u", "U"]);
const BRACKET_OBJECTS: Record<string, [string, string]> = {
  "(": ["(", ")"], ")": ["(", ")"], b: ["(", ")"],
  "[": ["[", "]"], "]": ["[", "]"],
  "{": ["{", "}"], "}": ["{", "}"], B: ["{", "}"],
  "<": ["<", ">"], ">": ["<", ">"],
};
const QUOTE_OBJECTS = new Set(["\"", "'", "`"]);
/** Motions that keep (and `$` that sets) the goal column for the next `j`/`k`. */
const VERTICAL_TOKENS = new Set(["j", "k", "gj", "gk", "$", "g$"]);

/** Plain-key aliases; applied when a key becomes a token, never to count digits. */
const KEY_ALIASES: Record<string, string> = {
  ArrowLeft: "h",
  ArrowRight: "l",
  ArrowDown: "j",
  ArrowUp: "k",
  Backspace: "h",
  " ": "l",
  Home: "0",
  End: "$",
  Enter: "+",
};

function hasCommandModifier(event: VimLiteKey): boolean {
  return Boolean(event.metaKey || event.altKey || event.ctrlKey);
}

function isEscape(event: VimLiteKey): boolean {
  return event.key === "Escape" || Boolean(event.ctrlKey && event.key === "[");
}

function isUppercaseAsciiLetter(key: string): boolean {
  return /^[A-Z]$/.test(key);
}

/** KeyboardEvent.key may be a multi-code-unit emoji but still one Vim character. */
function isSingleGrapheme(key: string): boolean {
  return key.length > 0 && findClusterBreak(key, 0, true) === key.length;
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

/** Every Vim edit is its own undo step, however quickly the next one follows. */
function dispatchEdit(editor: Editor, spec: TransactionSpec): void {
  editor.view.dispatch({ ...spec, annotations: isolateHistory.of("full") });
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

function singleRevealedFormula(editor: Editor): FormulaWidgetRange | null {
  const state = editor.view.state;
  return state.selection.ranges.length === 1 ? revealedFormulaAt(editor, state.selection.main.head) : null;
}

function visualCharEndPosition(text: Text, pos: number): number {
  const end = graphemeEndPosition(text, pos);
  // Vim's characterwise Visual mode can select the newline represented by an
  // empty screen line. Without this, `v` on a blank line creates an empty CM6
  // selection and appears to select nothing.
  if (end === pos && pos < text.length && text.sliceString(pos, pos + 1) === "\n") return pos + 1;
  return end;
}

type FormulaIndex = {
  blocks: ReturnType<typeof getBlockMathRanges>;
  inlineByLine: Map<number, readonly Scope[]>;
};
const formulaIndexes = new WeakMap<EditorState, FormulaIndex>();

function formulaIndex(state: EditorState): FormulaIndex {
  let index = formulaIndexes.get(state);
  if (!index) {
    index = { blocks: getBlockMathRanges(state), inlineByLine: new Map() };
    formulaIndexes.set(state, index);
  }
  return index;
}

function staticMathObjectAtPosition(
  editor: Editor,
  pos: number,
): RenderedObject | null {
  if (!editor.view.dom.classList.contains("aaronnote-visual-typography")) return null;
  const state = editor.view.state;
  const safePos = clamp(pos, 0, state.doc.length);
  const index = formulaIndex(state);
  const block = rangeAtPosition(safePos, index.blocks);
  if (block) return formulaSourceRangeAtPosition(editor.view, safePos)
    ? null : { from: block.from, to: block.to, block: true };
  const line = state.doc.lineAt(safePos);
  let ranges = index.inlineByLine.get(line.from);
  if (!ranges) {
    const codeRanges = scanCodeRanges(state, [{ from: line.from, to: line.to }]);
    ranges = scanInlineMathRanges(line.text, line.from).filter((range) => (
      !rangeOverlapsAny(range.from, range.to, index.blocks)
      && !rangeOverlapsAny(range.from, range.to, codeRanges)
    ));
    index.inlineByLine.set(line.from, ranges);
  }
  const inline = ranges.find((range) => safePos >= range.from && safePos < range.to);
  return inline && !formulaSourceRangeAtPosition(editor.view, safePos)
    ? { from: inline.from, to: inline.to, block: false } : null;
}

type WidgetIndex = {
  state: EditorState;
  from: number;
  to: number;
  objects: RenderedObject[];
  maxTo: number[];
};
const widgetIndexes = new WeakMap<EditorView, WidgetIndex>();
const offscreenImageIndexes = new WeakMap<Text, Map<number, RenderedObject[]>>();

/** Resolve standard images on an unmounted line without parsing the whole note. */
function offscreenImageAtPosition(editor: Editor, pos: number): RenderedObject | null {
  const state = editor.view.state;
  const line = state.doc.lineAt(pos);
  let byLine = offscreenImageIndexes.get(state.doc);
  if (!byLine) {
    byLine = new Map();
    offscreenImageIndexes.set(state.doc, byLine);
  }
  let objects = byLine.get(line.from);
  if (!objects) {
    objects = [];
    if (line.text.includes("![")
        && !rangeAtPosition(line.from, getFencedCodeRanges(state))) {
      const tree = markdownParser.parse(line.text);
      tree.iterate({
        enter(node) {
          if (node.name !== "Image") return;
          const trailing = readImageTrailingAttrs(line.text.slice(node.to), 0);
          objects!.push({
            from: line.from + node.from,
            to: line.from + node.to + (trailing?.to ?? 0),
            block: false,
          });
        },
      });
    }
    if (byLine.size >= 128) byLine.delete(byLine.keys().next().value!);
    byLine.set(line.from, objects);
  }
  return objects.find((object) => pos >= object.from && pos < object.to) ?? null;
}

/** Whitelisted rendered objects: math and image widgets, not inline code. */
function renderedObjectAtPosition(editor: Editor, pos: number): RenderedObject | null {
  const formula = staticMathObjectAtPosition(editor, pos);
  if (formula) return formula;
  const view = editor.view;
  if (!view.dom.classList.contains("aaronnote-visual-typography")) return null;
  if (pos < view.viewport.from || pos >= view.viewport.to) {
    return offscreenImageAtPosition(editor, pos);
  }
  let index = widgetIndexes.get(view);
  if (!index || index.state !== view.state
    || index.from !== view.viewport.from || index.to !== view.viewport.to) {
    const objects: RenderedObject[] = [];
    for (const source of view.state.facet(EditorView.decorations)) {
      const decorations: DecorationSet = typeof source === "function" ? source(view) : source;
      decorations.between(view.viewport.from, view.viewport.to, (from, to, value) => {
        if (value.spec.vimAtomic === true) objects.push({ from, to, block: Boolean(value.spec.block) });
      });
    }
    objects.sort((left, right) => left.from - right.from || right.to - left.to);
    const maxTo: number[] = [];
    let maximum = 0;
    for (const object of objects) {
      maximum = Math.max(maximum, object.to);
      maxTo.push(maximum);
    }
    index = { state: view.state, from: view.viewport.from, to: view.viewport.to, objects, maxTo };
    widgetIndexes.set(view, index);
  }
  let low = 0;
  let high = index.objects.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (index.objects[middle]!.from <= pos) low = middle + 1;
    else high = middle;
  }
  let found: RenderedObject | null = null;
  for (let at = low - 1; at >= 0 && index.maxTo[at]! > pos; at--) {
    const object = index.objects[at]!;
    if (pos < object.to && (!found || object.to - object.from > found.to - found.from)) found = object;
  }
  return found;
}

function visualObjectEndPosition(editor: Editor, pos: number): number {
  const object = renderedObjectAtPosition(editor, pos);
  return object?.from === pos ? object.to : visualCharEndPosition(doc(editor), pos);
}

function snapRenderedObjectMotion(
  editor: Editor,
  start: number,
  target: number,
  dir: -1 | 1,
): number {
  const object = renderedObjectAtPosition(editor, target);
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

/** Vim treats an empty source line as one word for w/W/b/B. */
function emptyLineWordAt(text: Text, pos: number): boolean {
  const line = text.lineAt(pos);
  return line.from === line.to && pos === line.from;
}

function graphemeAfter(text: Text, pos: number): number {
  return Math.min(text.length, Math.max(pos + 1, graphemeEndPosition(text, pos)));
}

type WordObjectAt = (pos: number) => Scope | null;

function wordKindAt(text: Text, pos: number, bigWord: boolean, objectAt?: WordObjectAt): string {
  const object = objectAt?.(pos);
  return object ? `object:${object.from}` : wordCategory(docCluster(text, pos), bigWord);
}

function wordStepAfter(text: Text, pos: number, objectAt?: WordObjectAt): number {
  return objectAt?.(pos)?.to ?? graphemeAfter(text, pos);
}

function wordStepBefore(text: Text, pos: number, objectAt?: WordObjectAt): number {
  const previous = previousGraphemePosition(text, pos);
  return objectAt?.(previous)?.from ?? previous;
}

function wordMotionPosition(
  text: Text, start: number, dir: -1 | 1, bigWord = false, objectAt?: WordObjectAt,
): number {
  let pos = clamp(start, 0, text.length);
  if (dir > 0) {
    const initial = wordKindAt(text, pos, bigWord, objectAt);
    if (initial !== "space") {
      while (pos < text.length && wordKindAt(text, pos, bigWord, objectAt) === initial) {
        pos = wordStepAfter(text, pos, objectAt);
      }
    }
    while (pos < text.length && wordKindAt(text, pos, bigWord, objectAt) === "space") {
      if (pos > start && emptyLineWordAt(text, pos)) return pos;
      pos = wordStepAfter(text, pos, objectAt);
    }
    return pos;
  }

  pos = wordStepBefore(text, pos, objectAt);
  while (pos > 0 && wordKindAt(text, pos, bigWord, objectAt) === "space") {
    if (emptyLineWordAt(text, pos)) return pos;
    pos = wordStepBefore(text, pos, objectAt);
  }
  const target = wordKindAt(text, pos, bigWord, objectAt);
  while (pos > 0) {
    const previous = wordStepBefore(text, pos, objectAt);
    if (wordKindAt(text, previous, bigWord, objectAt) !== target) break;
    pos = previous;
  }
  return pos;
}

/**
 * Vim's `e`/`E`: the last character of the current word, or of the next one
 * when the caret already sits on that last character. Unlike `w` this lands
 * *on* a character, so Normal mode never needs to clamp the result back.
 */
function wordEndPosition(
  text: Text, start: number, bigWord = false, objectAt?: WordObjectAt,
): number {
  const limit = text.length;
  let pos = clamp(start, 0, limit);
  pos = wordStepAfter(text, pos, objectAt);
  while (pos < limit && wordKindAt(text, pos, bigWord, objectAt) === "space") {
    pos = wordStepAfter(text, pos, objectAt);
  }
  if (pos >= limit) return wordStepBefore(text, limit, objectAt);
  if (objectAt?.(pos)?.from === pos) return pos;
  const category = wordKindAt(text, pos, bigWord, objectAt);
  let end = pos;
  while (true) {
    const next = wordStepAfter(text, end, objectAt);
    if (next >= limit || wordKindAt(text, next, bigWord, objectAt) !== category) break;
    end = next;
  }
  return end;
}

/** Vim's `ge`/`gE`: the last character of the previous word. */
function wordEndBackwardPosition(text: Text, start: number, bigWord = false, objectAt?: WordObjectAt): number {
  let pos = clamp(start, 0, text.length);
  const category = wordKindAt(text, pos, bigWord, objectAt);
  if (category !== "space") {
    while (pos > 0) {
      const previous = wordStepBefore(text, pos, objectAt);
      if (wordKindAt(text, previous, bigWord, objectAt) !== category) break;
      pos = previous;
    }
  }
  if (pos === 0) return 0;
  pos = wordStepBefore(text, pos, objectAt);
  while (pos > 0 && wordKindAt(text, pos, bigWord, objectAt) === "space") {
    pos = wordStepBefore(text, pos, objectAt);
  }
  return pos;
}

/**
 * End of the word the caret is standing in, without first stepping off it —
 * which is what separates `cw` (this) from `e` (wordEndPosition).
 */
function currentWordEnd(text: Text, pos: number, bigWord: boolean, objectAt?: WordObjectAt): number {
  if (objectAt?.(pos)?.from === pos) return pos;
  const category = wordKindAt(text, pos, bigWord, objectAt);
  if (category === "space") return pos;
  let end = pos;
  while (end < text.length) {
    const next = wordStepAfter(text, end, objectAt);
    if (next === end || next >= text.length) break;
    if (wordKindAt(text, next, bigWord, objectAt) !== category) break;
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

/** First non-blank inside [FROM, TO), or TO when there is none. */
function firstNonBlankIn(text: Text, from: number, to: number): number {
  const first = text.sliceString(from, to).search(/\S/u);
  return first < 0 ? to : from + first;
}

/**
 * Vim's `f`/`F`/`t`/`T`: search only within BOUNDS — the caret's screen row.
 * `t`/`T` stop one character short of the target, which is what makes `dt,`
 * useful.
 */
function findCharPosition(
  text: Text,
  start: number,
  kind: VimFindKind,
  target: string,
  count: number,
  skipAdjacent: boolean,
  bounds: { from: number; to: number },
  objectAt?: WordObjectAt,
): number | null {
  const source = text.sliceString(bounds.from, bounds.to);
  const forward = kind === "f" || kind === "t";
  let index = clamp(start, bounds.from, bounds.to) - bounds.from;
  for (let hit = 0; hit < count; hit++) {
    // A repeated `t`/`T` already sits beside its target, so it must start one
    // character further out or it would match the same neighbour forever.
    const step = hit === 0 && skipAdjacent ? 2 : 1;
    const from = forward ? index + step : index - step;
    if (from < 0 || from > source.length) return null;
    let found = forward ? source.indexOf(target, from) : source.lastIndexOf(target, from);
    while (found >= 0 && objectAt?.(bounds.from + found)) {
      found = forward
        ? source.indexOf(target, found + target.length)
        : found > 0 ? source.lastIndexOf(target, found - 1) : -1;
    }
    if (found < 0) return null;
    index = found;
  }
  const targetPos = bounds.from + index;
  const pos = kind === "t" ? previousGraphemePosition(text, targetPos)
    : kind === "T" ? graphemeEndPosition(text, targetPos)
      : targetPos;
  if (pos < bounds.from || pos >= bounds.to) return null;
  return objectAt?.(pos)?.from ?? pos;
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
  return renderedObjectAtPosition(editor, normalized)?.from ?? normalized;
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

/** Insert-mode carets; ASSOC keeps a caret at a soft-wrap boundary on the earlier row. */
function setInsertCursors(
  editor: Editor,
  cursors: ReadonlyArray<{ pos: number; assoc?: -1 | 1 }>,
): void {
  const state = editor.view.state;
  const candidates = cursors.map((cursor, index) => ({
    position: clamp(cursor.pos, 0, state.doc.length),
    assoc: cursor.assoc ?? 1,
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
      unique.map((candidate) => EditorSelection.cursor(candidate.position, candidate.assoc)),
      mainIndex,
    ),
    scrollIntoView: true,
  });
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

function mainIndexFor(editor: Editor, length: number): number {
  return Math.min(editor.view.state.selection.mainIndex, Math.max(0, length - 1));
}

// ---------------------------------------------------------------------------
// Vim lines
// ---------------------------------------------------------------------------

function revealedScope(editor: Editor, pos: number): Scope | null {
  const revealed = revealedFormulaAt(editor, pos);
  return revealed ? { from: revealed.contentFrom, to: revealed.contentTo } : null;
}

/**
 * The Vim line holding POS.
 *
 * SCOPE bounds rows to a revealed formula's TeX body so linewise commands can
 * never eat `\(`/`\)` or `\[`/`\]`; `undefined` detects it from POS, `null`
 * ignores it (a vertical motion must be able to leave the formula).  LOGICAL
 * asks for the source line instead of the screen row.
 */
function vimRowAt(
  editor: Editor,
  pos: number,
  assoc: -1 | 1 = 1,
  options: { scope?: Scope | null; logical?: boolean } = {},
): VimRow {
  const text = doc(editor);
  const safe = clamp(pos, 0, text.length);
  const logical = Boolean(options.logical);
  const scope = options.scope !== undefined ? options.scope : revealedScope(editor, safe);
  if (scope) {
    const empty = scope.from >= scope.to;
    const at = empty ? scope.from : clamp(safe, scope.from, Math.max(scope.from, scope.to - 1));
    const line = text.lineAt(at);
    const lineFrom = Math.max(scope.from, line.from);
    const lineTo = Math.min(scope.to, line.to);
    let from = lineFrom;
    let to = lineTo;
    if (!logical && !empty) {
      const row = screenRowAt(editor.view, at, assoc);
      from = clamp(row.from, lineFrom, lineTo);
      to = clamp(row.to, from, lineTo);
    }
    return { from, to, lineStart: from === lineFrom, lineEnd: to === lineTo, scope, logical };
  }

  const line = text.lineAt(safe);
  const object = renderedObjectAtPosition(editor, assoc < 0 && safe > line.from ? safe - 1 : safe);
  if (object?.block) {
    return { from: object.from, to: object.to, lineStart: true, lineEnd: true, scope: null, logical };
  }
  const row = logical ? { from: line.from, to: line.to } : screenRowAt(editor.view, safe, assoc);
  return {
    from: row.from,
    to: row.to,
    lineStart: row.from === text.lineAt(row.from).from,
    lineEnd: row.to === text.lineAt(row.to).to,
    scope: null,
    logical,
  };
}

function nextVimRow(editor: Editor, row: VimRow): VimRow | null {
  const text = doc(editor);
  const ceiling = row.scope ? row.scope.to : text.length;
  if (row.to >= ceiling) return null;
  const start = row.lineEnd ? row.to + 1 : row.to;
  if (row.scope ? start >= row.scope.to : start > text.length) return null;
  let next = vimRowAt(editor, start, 1, { scope: row.scope, logical: row.logical });
  if (next.from <= row.from) {
    // A measuring failure must not trap a count loop on one row.
    if (row.logical) return null;
    next = vimRowAt(editor, start, 1, { scope: row.scope, logical: true });
    if (next.from <= row.from) return null;
  }
  return next;
}

function prevVimRow(editor: Editor, row: VimRow): VimRow | null {
  const floor = row.scope ? row.scope.from : 0;
  if (row.from <= floor) return null;
  const end = row.lineStart ? row.from - 1 : row.from;
  let previous = vimRowAt(editor, end, -1, { scope: row.scope, logical: row.logical });
  if (previous.from >= row.from) {
    if (row.logical) return null;
    previous = vimRowAt(editor, end, -1, { scope: row.scope, logical: true });
    if (previous.from >= row.from) return null;
  }
  return previous;
}

function stepRows(editor: Editor, row: VimRow, count: number, dir: -1 | 1): { row: VimRow; steps: number } {
  let current = row;
  let steps = 0;
  for (; steps < count; steps++) {
    const next = dir > 0 ? nextVimRow(editor, current) : prevVimRow(editor, current);
    if (!next) break;
    current = next;
  }
  return { row: current, steps };
}

function lastCharOfRow(text: Text, row: VimRow): number {
  return row.to > row.from ? Math.max(row.from, previousGraphemePosition(text, row.to)) : row.from;
}

/** `^` on a row: the first non-blank, or the row start when it is blank. */
function rowFirstNonBlank(text: Text, row: VimRow): number {
  const first = firstNonBlankIn(text, row.from, row.to);
  return first < row.to ? first : row.from;
}

function lineSpan(editor: Editor, first: VimRow, last: VimRow): LineSpan {
  const text = doc(editor);
  const scope = first.scope ?? last.scope;
  const floor = scope ? scope.from : 0;
  const ceiling = scope ? scope.to : text.length;
  const newlineAfter = last.lineEnd
    && last.to < ceiling
    && text.sliceString(last.to, last.to + 1) === "\n";
  const to = newlineAfter ? last.to + 1 : last.to;
  // The last line of a document or scope has no newline of its own to take,
  // so deleting it takes the preceding one instead — otherwise `dd` there
  // leaves the empty line that newline used to terminate.
  const deleteFrom = last.lineEnd && !newlineAfter && first.lineStart && first.from > floor
    && text.sliceString(first.from - 1, first.from) === "\n"
    ? first.from - 1
    : first.from;
  const raw = text.sliceString(first.from, to);
  return {
    from: first.from,
    to,
    deleteFrom,
    deleteTo: to,
    changeFrom: first.lineStart ? Math.min(firstNonBlankIn(text, first.from, first.to), last.to) : first.from,
    changeTo: last.to,
    register: raw.endsWith("\n") ? raw : `${raw}\n`,
    wholeLines: first.lineStart && last.lineEnd,
  };
}

function spanBetween(
  editor: Editor,
  a: number,
  b: number,
  options: { scope?: Scope | null; logical?: boolean } = {},
): LineSpan {
  const first = vimRowAt(editor, Math.min(a, b), 1, options);
  const last = vimRowAt(editor, Math.max(a, b), 1, { ...options, scope: options.scope ?? first.scope });
  return lineSpan(editor, first, last);
}

function countedSpan(editor: Editor, pos: number, count: number, logical = false): LineSpan {
  const first = vimRowAt(editor, pos, 1, { logical });
  const { row: last } = stepRows(editor, first, count - 1, 1);
  return lineSpan(editor, first, last);
}

/**
 * Where Vim leaves the caret after a linewise delete: the first non-blank of
 * the line that moved up into the deleted one.  When the delete borrowed the
 * *preceding* newline, the mapped start is the end of the surviving line, which
 * Normal mode has no legal cursor position for.
 */
function linewiseLandingPosition(text: Text, pos: number): number {
  return firstNonBlankPosition(text, pos);
}

// ---------------------------------------------------------------------------
// Editing primitives
// ---------------------------------------------------------------------------

/**
 * COUNT characters from HEAD for `x`/`X`/`dl`/`dh`: never past the caret's
 * source line, and a collapsed formula counts as one character.
 */
function characterSpan(
  editor: Editor,
  head: number,
  count: number,
  backward: boolean,
): { from: number; to: number } | null {
  const text = doc(editor);
  const start = normalCharPosition(text, head);
  const line = text.lineAt(start);
  if (backward) {
    let from = start;
    for (let step = 0; step < count && from > line.from; step++) {
      const previousObject = renderedObjectAtPosition(editor, Math.max(line.from, from - 1));
      from = previousObject?.to === from ? previousObject.from : previousGraphemePosition(text, from);
    }
    return from < start ? { from, to: start } : null;
  }
  let to = start;
  for (let step = 0; step < count && to < line.to; step++) {
    const object = renderedObjectAtPosition(editor, to);
    to = object?.from === to ? object.to : Math.min(graphemeAfter(text, to), line.to);
  }
  return to > start ? { from: start, to } : null;
}

/**
 * The span `r` replaces for one caret. `3rz` replaces three characters, and
 * Vim refuses outright when the line is too short rather than replacing what
 * fits.
 */
function countedCharacterRange(
  editor: Editor,
  head: number,
  count: number,
): { from: number; to: number } | null {
  const text = doc(editor);
  const start = normalCharPosition(text, head);
  const line = text.lineAt(start);
  let to = start;
  for (let step = 0; step < count; step++) {
    if (to >= line.to) return null;
    const object = renderedObjectAtPosition(editor, to);
    to = object?.from === to ? object.to : graphemeAfter(text, to);
  }
  return { from: start, to };
}

/** Replace every grapheme in RANGES with CH, keeping line breaks where they are. */
function replaceSpecs(
  editor: Editor,
  ranges: readonly { from: number; to: number }[],
  ch: string,
): Array<{ from: number; to: number; insert: string }> {
  const text = doc(editor);
  return uniqueRanges(ranges).map((range) => {
    let at = range.from;
    let insert = "";
    while (at < range.to) {
      const object = renderedObjectAtPosition(editor, at);
      if (object?.from === at && object.to <= range.to) {
        insert += ch;
        at = object.to;
      } else {
        insert += docCluster(text, at) === "\n" ? "\n" : ch;
        at = Math.min(range.to, graphemeAfter(text, at));
      }
    }
    return { from: range.from, to: range.to, insert };
  });
}

function swapCase(value: string): string {
  return value.replace(/\p{L}/gu, (ch) => {
    const upper = ch.toUpperCase();
    return ch === upper ? ch.toLowerCase() : upper;
  });
}

function transformCase(op: "g~" | "gu" | "gU", value: string): string {
  if (op === "gu") return value.toLowerCase();
  if (op === "gU") return value.toUpperCase();
  return swapCase(value);
}

/** Case commands skip the hidden Markdown backing a rendered Vim object. */
function caseChangeSpecs(
  editor: Editor,
  ranges: readonly { from: number; to: number }[],
  op: "g~" | "gu" | "gU",
): Array<{ from: number; to: number; insert: string }> {
  const text = doc(editor);
  const specs: Array<{ from: number; to: number; insert: string }> = [];
  const addPlain = (from: number, to: number) => {
    if (from >= to) return;
    const original = text.sliceString(from, to);
    const insert = transformCase(op, original);
    if (insert !== original) specs.push({ from, to, insert });
  };
  for (const range of uniqueRanges(ranges)) {
    let at = range.from;
    let plainFrom = at;
    while (at < range.to) {
      const object = renderedObjectAtPosition(editor, at);
      if (object && object.to > at) {
        addPlain(plainFrom, at);
        at = Math.min(range.to, object.to);
        plainFrom = at;
      } else {
        at = Math.min(range.to, graphemeAfter(text, at));
      }
    }
    addPlain(plainFrom, range.to);
  }
  return specs;
}

/**
 * Vim's `J`/`gJ`: join JOINS following lines onto the line at each position.
 * `J` collapses the next line's indentation into one separating space — none
 * when the current line already ends in whitespace or the next line is empty;
 * `gJ` joins the raw text.  The caret lands on the last join point.
 */
function joinLines(
  editor: Editor,
  specs: ReadonlyArray<{ pos: number; joins: number }>,
  spaces: boolean,
): boolean {
  const state = editor.view.state;
  const text = state.doc;
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  const cursors: number[] = [];
  const seen = new Set<number>();
  for (const spec of specs) {
    let line = text.lineAt(clamp(spec.pos, 0, text.length));
    if (seen.has(line.number)) continue;
    seen.add(line.number);
    const from = line.to;
    let insert = "";
    let joined = 0;
    let lastJoin = from;
    for (let step = 0; step < spec.joins && line.number < text.lines; step++) {
      const next = text.line(line.number + 1);
      if (spaces) {
        const trimmed = next.text.replace(/^\s+/u, "");
        const endsInSpace = insert ? /\s$/u.test(insert) : /\s$/u.test(line.text);
        const separator = endsInSpace || !trimmed || trimmed.startsWith(")") ? "" : " ";
        lastJoin = from + insert.length;
        insert += separator + trimmed;
      } else {
        lastJoin = from + insert.length;
        insert += next.text;
      }
      line = next;
      joined++;
    }
    if (joined === 0) continue;
    changes.push({ from, to: line.to, insert });
    cursors.push(lastJoin);
  }
  if (changes.length === 0) return false;
  const change = state.changes(changes);
  const applied = change.apply(state.doc);
  dispatchEdit(editor, {
    changes: change,
    selection: EditorSelection.create(
      cursors.map((pos) => EditorSelection.cursor(normalCharPosition(applied, change.mapPos(pos, 1)))),
      Math.min(state.selection.mainIndex, cursors.length - 1),
    ),
    scrollIntoView: true,
  });
  return true;
}

/**
 * Vim's `~`: swap the case of COUNT characters and step past them, never
 * beyond the caret's source line.
 */
function toggleCaseForward(editor: Editor, count: number): boolean {
  const state = editor.view.state;
  const ranges = uniqueRanges(state.selection.ranges.flatMap((range) => {
    const span = characterSpan(editor, range.head, count, false);
    return span ? [span] : [];
  }));
  if (ranges.length === 0) return false;
  const specs = caseChangeSpecs(editor, ranges, "g~");
  if (specs.length === 0) {
    setNormalCursorPositions(editor, ranges.map((range) => range.to));
    return true;
  }
  const change = state.changes(specs);
  const applied = change.apply(state.doc);
  dispatchEdit(editor, {
    changes: change,
    selection: EditorSelection.create(
      ranges.map((range) => EditorSelection.cursor(
        normalCharPosition(applied, change.mapPos(range.to, -1)),
      )),
      Math.min(state.selection.mainIndex, ranges.length - 1),
    ),
    scrollIntoView: true,
  });
  return true;
}

/** `o`/`O` open a source line, continuing a list, task or quote the way Enter would. */
function openLine(editor: Editor, where: "above" | "below"): void {
  const state = editor.view.state;
  const text = state.doc;
  const revealed = singleRevealedFormula(editor);
  const candidates = state.selection.ranges.map((selection, index) => {
    const line = vimRowAt(editor, selection.head, 1, { logical: true });
    const prefix = markdownContinuationPrefix(text.sliceString(line.from, line.to));
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
  dispatchEdit(editor, {
    changes,
    selection: EditorSelection.create(ranges, mainIndex),
    scrollIntoView: true,
  });
  restoreRevealedFormula(editor, revealed);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/** Word under or after the caret on its line, for `*`/`#`. */
function searchWordAt(text: Text, pos: number, objectAt?: WordObjectAt): string | null {
  const line = text.lineAt(pos);
  let at = clamp(pos, line.from, line.to);
  if (objectAt?.(at)) return null;
  while (at < line.to && !isWordChar(docCluster(text, at))) {
    at = objectAt?.(at)?.to ?? graphemeAfter(text, at);
  }
  if (at >= line.to) return null;
  const range = wordObject(text, at, 1, true, false);
  return range ? text.sliceString(range.from, range.to) : null;
}

const wordSearchCache = new WeakMap<Text, Map<string, number[]>>();

/** Start of the COUNT-th whole-word match of WORD from POS, wrapping around. */
function searchWord(
  text: Text, pos: number, word: string, forward: boolean, count: number,
  objectAt?: WordObjectAt,
): number | null {
  let words = wordSearchCache.get(text);
  if (!words) {
    words = new Map();
    wordSearchCache.set(text, words);
  }
  let rawStarts = words.get(word);
  if (!rawStarts) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(word)}(?![\\p{L}\\p{N}_])`, "gu");
    const source = text.toString();
    rawStarts = [];
    for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
      rawStarts.push(match.index);
    }
    if (words.size >= 8) words.delete(words.keys().next().value!);
    words.set(word, rawStarts);
  }
  const starts = objectAt ? rawStarts.filter((start) => !objectAt(start)) : rawStarts;
  if (starts.length === 0) return null;
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (starts[middle]! < pos || (forward && starts[middle] === pos)) low = middle + 1;
    else high = middle;
  }
  const length = starts.length;
  const index = forward
    ? (low + count - 1) % length
    : ((low - count) % length + length) % length;
  return starts[index]!;
}

export function createVimLite(
  editor: Editor,
  host: HTMLElement,
  options: VimLiteOptions = {},
): VimLiteController {
  let mode: VimLiteMode = "insert";
  editor.view.dom.dataset.vimMode = mode;
  /** Per-caret goal columns of the last vertical motion; cleared by any other motion. */
  let goals: VerticalGoal[] | null = null;
  let countBuffer = "";
  /** Second key a prefix is waiting for: `g`, `z`, `r`, a find, or a text object's `i`/`a`. */
  let prefix = "";
  let pendingOperator: { op: VimOperator; count: number; explicit: boolean } | null = null;
  /** Last `f`/`F`/`t`/`T` target, replayed by `;` and reversed by `,`. */
  let lastFind: FindSpec | null = null;
  let lastSearch: SearchSpec | null = null;
  let jumpInput: VimJumpInput | null = null;
  let jumpSession: VimJumpSession | null = null;
  let jumpLabelPrefix = "";
  let visualHead: number | null = null;
  /** Visual-word motions need a logical head beyond CM6's half-open selection. */
  let visualCharStates: VisualState[] | null = null;
  let visualCharSelection: EditorSelection | null = null;
  let visualCharDoc: Text | null = null;
  /** Authoritative Visual-line state: CM6 cannot encode a column in a whole-row range. */
  let visualLineStates: VisualState[] | null = null;
  let lastVisual: { mode: "visual" | "visual-line"; states: VisualState[] } | null = null;
  let insertEntry: { doc: Text; boundary: number; returnPos: number } | null = null;
  /** The Insert session a Normal command opened, for counts and `.`. */
  let insertSession: { doc: Text; head: number; count: number } | null = null;
  let register: VimRegister = { text: "", kind: "characterwise", fragments: [] };
  let recording: { keys: string[]; changed: boolean } | null = null;
  let pendingInsertChange: readonly string[] | null = null;
  let lastChange: LastChange | null = null;
  let replaying = false;
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

  function markChange(): void {
    if (recording) recording.changed = true;
  }

  // -------------------------------------------------------------------------
  // Count and parser state
  // -------------------------------------------------------------------------

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

  /** Accumulate a count digit. `0` is a motion until a count is already open. */
  function consumeCountDigit(key: string): boolean {
    if (prefix) return false;
    if (!/^[0-9]$/u.test(key)) return false;
    if (key === "0" && !countBuffer) return false;
    // Keep the buffer short; takeCount() clamps the value anyway.
    if (countBuffer.length < 9) countBuffer += key;
    return true;
  }

  function resetParser(): void {
    countBuffer = "";
    prefix = "";
    pendingOperator = null;
  }

  function parserIdle(): boolean {
    return !countBuffer && !prefix && !pendingOperator && !jumpInput && !jumpSession;
  }

  function reportUnhandled(sequence: string): void {
    if (sequence) options.onUnhandledKey?.(sequence);
  }

  function resetMotionMemory(): void {
    goals = null;
  }

  // -------------------------------------------------------------------------
  // s/S jump
  // -------------------------------------------------------------------------

  function clearJumpInputTimer(): void {
    if (jumpInput?.timer != null) {
      window.clearTimeout(jumpInput.timer);
      jumpInput.timer = null;
    }
  }

  function cancelJump(): void {
    const hadJump = jumpInput !== null || jumpSession !== null;
    resetParser();
    clearJumpInputTimer();
    jumpInput = null;
    jumpSession = null;
    jumpLabelPrefix = "";
    if (hadJump) clearVimJump(editor.view);
  }

  function jumpCursor(): number {
    return (mode === "visual" || mode === "visual-line")
      ? (visualHead ?? currentHead(editor)) : currentHead(editor);
  }

  function applyJumpSelection(session: VimJumpSession, label: string): boolean {
    if (mode !== "visual" && mode !== "visual-line") {
      return applyVimJump(editor.view, session, label);
    }
    const candidate = session.candidates.find((entry) => entry.label === label);
    clearVimJump(editor.view);
    if (!candidate || editor.view.state.doc !== session.doc) return false;
    const states = visualStates();
    const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
    states[mainIndex] = {
      ...states[mainIndex]!,
      head: normalEditorPosition(editor, candidate.from),
      scope: null,
      exclusiveWordEnd: false,
    };
    renderVisualStates(states);
    editor.view.focus();
    return true;
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

    const session = beginVimJump(editor.view, input.needle, input.direction, jumpCursor());
    if (session.candidates.length === 0) {
      clearVimJump(editor.view);
      return true;
    }
    if (session.candidates.length === 1) {
      applyJumpSelection(session, session.candidates[0]!.label);
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
    previewVimJump(editor.view, input.needle, input.direction, jumpCursor());
  }

  function startJumpInput(direction: VimJumpDirection): void {
    // A timed jump is navigation, not part of the next repeatable edit. Its
    // input may finish without another key, so keeping the current recording
    // open would accidentally prepend the jump to a later `x`/`d`/`c`.
    recording = null;
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

  function handleJumpSessionKey(key: string): boolean {
    const session = jumpSession!;
    if (key.length !== 1 || isUppercaseAsciiLetter(key)) {
      cancelJump();
      return true;
    }
    jumpLabelPrefix += key;
    const exact = session.candidates.find((candidate) => candidate.label === jumpLabelPrefix);
    if (exact) {
      jumpSession = null;
      jumpLabelPrefix = "";
      applyJumpSelection(session, exact.label);
    } else {
      const candidates = narrowVimJump(editor.view, session, jumpLabelPrefix);
      if (candidates.length === 0) cancelJump();
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Motions
  // -------------------------------------------------------------------------

  function verticalGoalFor(head: number, row: VimRow): VerticalGoal {
    if (!row.logical) {
      const x = screenColumnAt(editor.view, head);
      if (x != null) return { kind: "pixel", value: x };
    }
    return { kind: "column", value: Math.max(0, head - row.from) };
  }

  function positionAtGoal(row: VimRow, goal: VerticalGoal): number {
    const text = doc(editor);
    if (row.from >= row.to) return row.from;
    const last = lastCharOfRow(text, row);
    let pos: number;
    if (goal.kind === "eol") pos = last;
    else if (goal.kind === "pixel") pos = screenPosAtColumn(editor.view, row, goal.value);
    else pos = row.from + goal.value;
    return normalCharPosition(text, clamp(pos, row.from, last));
  }

  /**
   * An org-env heading's source line is replaced by its rendered title; a
   * vertical motion that lands in it belongs on the title anchor.
   */
  function snapVerticalLanding(pos: number): number {
    if (!editor.view.dom.classList.contains("aaronnote-visual-typography")) return pos;
    const heading = getOrgEnvHeadingRanges(editor.view.state)
      .find((range) => pos >= range.from && pos <= range.to);
    return heading ? heading.anchor : pos;
  }

  function verticalMotion(
    head: number,
    dir: -1 | 1,
    count: number,
    goal: VerticalGoal | null,
    logical: boolean,
    scope: Scope | null,
  ): MotionResult | null {
    const start = vimRowAt(editor, head, 1, { scope, logical });
    const resolved = goal ?? verticalGoalFor(head, start);
    let { row, steps } = stepRows(editor, start, count, dir);
    if (steps === 0) return null;
    let landing = snapVerticalLanding(positionAtGoal(row, resolved));
    let visible = normalEditorPosition(editor, landing);
    // A wrapped row can hit-test into the hidden source of an inline formula.
    // Normal mode snaps that position back to the formula's first character,
    // which may be exactly where this motion started. Continue past such rows
    // so j/k cannot become a permanent no-op at a rendered object.
    while (dir > 0 ? visible <= head : visible >= head) {
      const object = renderedObjectAtPosition(editor, landing);
      const beyond = dir > 0 && object?.from === visible && object.to > row.to
        ? vimRowAt(editor, object.to, 1, { scope, logical })
        : null;
      const next = beyond && beyond.from > row.from
        ? beyond
        : dir > 0 ? nextVimRow(editor, row) : prevVimRow(editor, row);
      if (!next) return null;
      row = next;
      landing = snapVerticalLanding(positionAtGoal(row, resolved));
      visible = normalEditorPosition(editor, landing);
    }
    return {
      pos: visible,
      kind: "linewise",
      logical,
      goal: resolved,
    };
  }

  /** H/M/L: a row of the visible viewport, or of the document without layout. */
  function viewportRow(which: "top" | "middle" | "bottom", count: number): VimRow | null {
    const view = editor.view;
    const text = doc(editor);
    const content = view.contentDOM.getBoundingClientRect();
    if (content.width <= 0 || content.height <= 0) {
      const number = which === "top"
        ? Math.min(count, text.lines)
        : which === "bottom"
          ? Math.max(1, text.lines - count + 1)
          : Math.floor((1 + text.lines) / 2);
      return vimRowAt(editor, text.line(number).from, 1, { scope: null });
    }
    const scroller = view.scrollDOM.getBoundingClientRect();
    const top = Math.max(scroller.top, content.top);
    const bottom = Math.min(scroller.bottom, content.bottom);
    if (bottom <= top) return null;
    const y = which === "top" ? top + 2 : which === "bottom" ? bottom - 2 : (top + bottom) / 2;
    const pos = view.posAtCoords({ x: content.left + 1, y }, false);
    const row = vimRowAt(editor, pos, 1, { scope: null });
    if (which === "middle") return row;
    return stepRows(editor, row, count - 1, which === "top" ? 1 : -1).row;
  }

  function rowLanding(row: VimRow): number {
    return row.lineStart ? rowFirstNonBlank(doc(editor), row) : row.from;
  }

  function lineNumberLanding(lineNumber: number): number {
    const text = doc(editor);
    return firstNonBlankPosition(text, text.line(clamp(lineNumber, 1, text.lines)).from);
  }

  function bracketMatch(head: number): number | null {
    const state = editor.view.state;
    const line = state.doc.lineAt(head);
    for (let at = head; at < line.to; at++) {
      const object = renderedObjectAtPosition(editor, at);
      if (object) {
        at = object.to - 1;
        continue;
      }
      const ch = state.doc.sliceString(at, at + 1);
      if (!"()[]{}".includes(ch)) continue;
      const opening = "([{".includes(ch);
      const match = opening ? matchBrackets(state, at, 1) : matchBrackets(state, at + 1, -1);
      if (!match?.matched || !match.end) return null;
      if (renderedObjectAtPosition(editor, match.end.from)) return null;
      return match.end.from;
    }
    return null;
  }

  function runSearch(head: number, forward: boolean, count: number): number | null {
    const spec = lastSearch;
    if (!spec) return null;
    const direction = spec.forward === forward;
    if (spec.source === "word") return searchWord(
      doc(editor), head, spec.word, direction, count,
      (at) => renderedObjectAtPosition(editor, at),
    );
    let pos: number | null = head;
    for (let step = 0; step < count && pos != null; step++) {
      pos = options.searchNext?.(pos, direction ? 1 : -1) ?? null;
    }
    return pos;
  }

  /**
   * The position TOKEN moves HEAD to, or null when the motion fails (`f` with
   * no target, `j` on the last row).  Returns undefined for a token that is not
   * a motion at all.
   */
  function motion(
    token: string,
    head: number,
    context: {
      count: number;
      explicit: boolean;
      goal: VerticalGoal | null;
      find: FindSpec | null;
      scope: Scope | null;
    },
  ): MotionResult | null | undefined {
    const text = doc(editor);
    const { count } = context;
    switch (token) {
      case "h": {
        let pos = head;
        for (let step = 0; step < count; step++) {
          const target = moveNormalCharPosition(text, pos, -1);
          pos = snapRenderedObjectMotion(editor, pos, target, -1);
        }
        return { pos, kind: "exclusive" };
      }
      case "l": {
        let pos = head;
        for (let step = 0; step < count; step++) {
          const target = moveNormalCharPosition(text, pos, 1);
          pos = snapRenderedObjectMotion(editor, pos, target, 1);
        }
        return { pos, kind: "exclusive" };
      }
      case "j":
      case "k":
        return verticalMotion(head, token === "j" ? 1 : -1, count, context.goal, false, context.scope);
      case "gj":
      case "gk":
        return verticalMotion(head, token === "gj" ? 1 : -1, count, context.goal, true, context.scope);
      case "0":
        return { pos: vimRowAt(editor, head, 1, { scope: context.scope }).from, kind: "exclusive" };
      case "g0":
        return { pos: vimRowAt(editor, head, 1, { scope: context.scope, logical: true }).from, kind: "exclusive" };
      case "^":
        return {
          pos: rowFirstNonBlank(text, vimRowAt(editor, head, 1, { scope: context.scope, logical: true })),
          kind: "exclusive",
        };
      case "g^":
        return {
          pos: rowFirstNonBlank(text, vimRowAt(editor, head, 1, { scope: context.scope })),
          kind: "exclusive",
        };
      case "$":
      case "g$": {
        const logical = token === "g$";
        const start = vimRowAt(editor, head, 1, { scope: context.scope, logical });
        const { row } = stepRows(editor, start, count - 1, 1);
        return { pos: lastCharOfRow(text, row), kind: "inclusive", goal: { kind: "eol" } };
      }
      case "w":
      case "W": {
        let pos = head;
        const objectAt = (at: number) => renderedObjectAtPosition(editor, at);
        for (let step = 0; step < count; step++) {
          const target = wordMotionPosition(text, pos, 1, token === "W", objectAt);
          pos = snapRenderedObjectMotion(editor, pos, target, 1);
        }
        return { pos, kind: "exclusive" };
      }
      case "b":
      case "B": {
        let pos = head;
        const objectAt = (at: number) => renderedObjectAtPosition(editor, at);
        for (let step = 0; step < count; step++) {
          const target = wordMotionPosition(text, pos, -1, token === "B", objectAt);
          pos = snapRenderedObjectMotion(editor, pos, target, -1);
        }
        return { pos, kind: "exclusive" };
      }
      case "e":
      case "E": {
        let pos = head;
        const objectAt = (at: number) => renderedObjectAtPosition(editor, at);
        for (let step = 0; step < count; step++) {
          pos = wordEndPosition(text, pos, token === "E", objectAt);
        }
        return { pos: snapRenderedObjectMotion(editor, head, pos, 1), kind: "inclusive" };
      }
      case "ge":
      case "gE": {
        let pos = head;
        const objectAt = (at: number) => renderedObjectAtPosition(editor, at);
        for (let step = 0; step < count; step++) {
          pos = wordEndBackwardPosition(text, pos, token === "gE", objectAt);
        }
        return { pos: snapRenderedObjectMotion(editor, head, pos, -1), kind: "inclusive" };
      }
      case "{":
      case "}": {
        let pos = head;
        for (let step = 0; step < count; step++) pos = paragraphPosition(text, pos, token === "}" ? 1 : -1);
        return { pos, kind: "exclusive", exclusiveAdjust: true };
      }
      case "gg":
        return { pos: lineNumberLanding(context.explicit ? count : 1), kind: "linewise", logical: true };
      case "G":
        return { pos: lineNumberLanding(context.explicit ? count : text.lines), kind: "linewise", logical: true };
      case "+":
      case "-": {
        const line = text.lineAt(head).number + (token === "+" ? count : -count);
        if (line < 1 || line > text.lines) return null;
        return { pos: lineNumberLanding(line), kind: "linewise", logical: true };
      }
      case "_": {
        const line = text.lineAt(head).number + count - 1;
        return { pos: lineNumberLanding(Math.min(line, text.lines)), kind: "linewise", logical: true };
      }
      case "H":
      case "M":
      case "L": {
        const row = viewportRow(token === "H" ? "top" : token === "L" ? "bottom" : "middle", count);
        return row ? { pos: rowLanding(row), kind: "linewise" } : null;
      }
      case "%": {
        if (context.explicit) {
          const line = Math.ceil((count * text.lines) / 100);
          return { pos: lineNumberLanding(clamp(line, 1, text.lines)), kind: "linewise", logical: true };
        }
        const pos = bracketMatch(head);
        return pos == null ? null : { pos, kind: "inclusive" };
      }
      case "f":
      case "F":
      case "t":
      case "T":
      case ";":
      case ",": {
        let find = context.find;
        let skipAdjacent = false;
        if (token === ";" || token === ",") {
          if (!lastFind) return null;
          const mirrored: Record<VimFindKind, VimFindKind> = { f: "F", F: "f", t: "T", T: "t" };
          find = { kind: token === "," ? mirrored[lastFind.kind] : lastFind.kind, target: lastFind.target };
          skipAdjacent = find.kind === "t" || find.kind === "T";
        }
        if (!find) return null;
        const row = vimRowAt(editor, head, 1, { scope: context.scope });
        const pos = findCharPosition(
          text, head, find.kind, find.target, count, skipAdjacent, row,
          (at) => renderedObjectAtPosition(editor, at),
        );
        if (pos == null) return null;
        return { pos, kind: find.kind === "f" || find.kind === "t" ? "inclusive" : "exclusive" };
      }
      case "n":
      case "N": {
        const pos = runSearch(head, token === "n", count);
        return pos == null ? null : { pos, kind: "exclusive", exclusiveAdjust: true };
      }
      case "*":
      case "#": {
        const objectAt = (at: number) => renderedObjectAtPosition(editor, at);
        const word = searchWordAt(text, head, objectAt);
        if (!word) return null;
        lastSearch = { source: "word", word, forward: token === "*" };
        const pos = searchWord(text, head, word, token === "*", count, objectAt);
        return pos == null ? null : { pos, kind: "exclusive", exclusiveAdjust: true };
      }
      default:
        return undefined;
    }
  }

  function textObject(token: string, head: number, count: number): TextObjectRange | null | undefined {
    if (token.length !== 2) return undefined;
    const kind = token[0];
    const object = token[1]!;
    if (kind !== "i" && kind !== "a") return undefined;
    const inner = kind === "i";
    const text = doc(editor);
    if (object === "w" || object === "W") {
      const rendered = renderedObjectAtPosition(editor, head);
      if (!rendered) return wordObject(text, head, count, inner, object === "W");
      const objectAt = (at: number) => renderedObjectAtPosition(editor, at);
      let to = rendered.to;
      for (let step = 1; step < count; step++) {
        const next = wordMotionPosition(text, to, 1, object === "W", objectAt);
        if (next <= to || next >= text.length) break;
        const nextObject = objectAt(next);
        to = nextObject?.to ?? visualCharEndPosition(text, currentWordEnd(text, next, object === "W", objectAt));
      }
      let from = rendered.from;
      if (!inner) {
        const trailing = to;
        while (to < text.length && /\s/u.test(docCluster(text, to))) to = graphemeAfter(text, to);
        if (to === trailing) {
          while (from > 0 && /\s/u.test(docCluster(text, previousGraphemePosition(text, from)))) {
            from = previousGraphemePosition(text, from);
          }
        }
      }
      return { from, to, linewise: false };
    }
    if (object === "p") return paragraphObject(text, head, count, inner);
    if (QUOTE_OBJECTS.has(object)) return quoteObject(text, head, object, inner);
    const brackets = BRACKET_OBJECTS[object];
    if (brackets) return bracketObject(text, head, brackets[0], brackets[1], inner, count);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // Operators
  // -------------------------------------------------------------------------

  /**
   * The range OPERATOR acts on for one caret after MOTION.  Vim's
   * exclusive/inclusive distinction is the whole game here: `dw` stops before
   * the next word while `de` eats the word's last character.
   */
  function operatorRange(
    op: VimOperator,
    token: string,
    head: number,
    result: MotionResult,
    count: number,
  ): OpRange {
    const text = doc(editor);
    const start = normalCharPosition(text, head);
    if (result.kind === "linewise" || op === ">" || op === "<") {
      return { kind: "line", span: spanBetween(editor, start, result.pos, { logical: result.logical, scope: null }) };
    }
    if (token === "l" || token === "h") {
      const span = characterSpan(editor, start, count, token === "h");
      return { kind: "char", from: span?.from ?? start, to: span?.to ?? start };
    }
    if (token === "w" || token === "W") {
      const big = token === "W";
      // `cw` is Vim's famous exception: on a non-blank it behaves like `ce`,
      // changing to the end of the word instead of up to the start of the next
      // one, so it never eats the space that separates them.
      if (op === "c" && wordCategory(docCluster(text, start), big) !== "space") {
        const objectAt = (at: number) => renderedObjectAtPosition(editor, at);
        let end = currentWordEnd(text, start, big, objectAt);
        for (let step = 1; step < count; step++) end = wordEndPosition(text, end, big, objectAt);
        return { kind: "char", from: start, to: visualObjectEndPosition(editor, end) };
      }
      // Stopping at the start of a later line would swallow the newline, which
      // Vim never does for `dw` on the last word of a line.
      const line = text.lineAt(start);
      const target = text.lineAt(result.pos);
      if (target.number > line.number && result.pos === target.from) {
        return { kind: "char", from: start, to: Math.max(start, text.line(target.number - 1).to) };
      }
      return { kind: "char", from: Math.min(start, result.pos), to: Math.max(start, result.pos) };
    }
    const from = Math.min(start, result.pos);
    const max = Math.max(start, result.pos);
    if (result.kind === "inclusive") {
      // An inclusive motion owns the character it lands on — but never the
      // newline of an empty line, which is how `d$` there keeps the line.
      const end = max < text.lineAt(max).to ? visualObjectEndPosition(editor, max) : max;
      return { kind: "char", from, to: end };
    }
    if (result.exclusiveAdjust && result.pos > start) {
      // `:h exclusive-linewise`: an exclusive motion ending in column 0 ends at
      // the previous line's end instead, and becomes linewise when it also
      // started at or before the first non-blank.
      const endLine = text.lineAt(result.pos);
      if (result.pos === endLine.from && endLine.number > text.lineAt(start).number) {
        const previous = text.line(endLine.number - 1);
        if (start <= firstNonBlankPosition(text, start)) {
          return { kind: "line", span: spanBetween(editor, start, previous.from, { logical: true, scope: null }) };
        }
        return { kind: "char", from, to: previous.to };
      }
    }
    return { kind: "char", from, to: max };
  }

  function textObjectRange(range: TextObjectRange): OpRange {
    if (range.linewise) {
      return { kind: "line", span: spanBetween(editor, range.from, range.to, { logical: true, scope: null }) };
    }
    return { kind: "char", from: range.from, to: range.to };
  }

  function mergeSpans(spans: readonly LineSpan[]): LineSpan[] {
    const text = doc(editor);
    const sorted = [...spans].sort((left, right) => left.deleteFrom - right.deleteFrom);
    const merged: LineSpan[] = [];
    for (const span of sorted) {
      const previous = merged[merged.length - 1];
      if (previous && span.deleteFrom < previous.deleteTo) {
        const from = Math.min(previous.from, span.from);
        const to = Math.max(previous.to, span.to);
        const raw = text.sliceString(from, to);
        merged[merged.length - 1] = {
          from,
          to,
          deleteFrom: Math.min(previous.deleteFrom, span.deleteFrom),
          deleteTo: Math.max(previous.deleteTo, span.deleteTo),
          changeFrom: Math.min(previous.changeFrom, span.changeFrom),
          changeTo: Math.max(previous.changeTo, span.changeTo),
          register: raw.endsWith("\n") ? raw : `${raw}\n`,
          wholeLines: previous.wholeLines && span.wholeLines,
        };
      } else {
        merged.push(span);
      }
    }
    return merged;
  }

  /**
   * Apply OP to RANGES (all charwise or all linewise).  HEADS are the carets
   * before the command, used where Vim leaves the cursor in place.
   */
  function applyOperator(
    op: VimOperator,
    ranges: readonly OpRange[],
    heads: readonly number[],
    count = 1,
  ): void {
    resetMotionMemory();
    const state = editor.view.state;
    const text = state.doc;
    const linewise = ranges.some((range) => range.kind === "line");
    const spans = linewise
      ? mergeSpans(ranges.flatMap((range) => range.kind === "line" ? [range.span] : []))
      : [];
    const chars = linewise
      ? []
      : uniqueRanges(ranges.flatMap((range) => range.kind === "char" ? [range] : []));
    const revealed = singleRevealedFormula(editor);

    if (op === ">" || op === "<") {
      const lineRanges = linewise
        ? spans.map((span) => ({ from: span.from, to: Math.max(span.from, span.to - (span.to > span.from && text.sliceString(span.to - 1, span.to) === "\n" ? 1 : 0)) }))
        : chars;
      if (lineRanges.length === 0) return;
      markChange();
      const firstLine = text.lineAt(lineRanges[0]!.from).from;
      editor.view.dispatch({
        selection: EditorSelection.create(lineRanges.map((range) => EditorSelection.range(
          text.lineAt(range.from).from,
          text.lineAt(Math.max(range.from, range.to)).to,
        ))),
      });
      for (let step = 0; step < count; step++) options.onIndent?.(op === ">" ? 1 : -1);
      setNormalCursorPositions(editor, [firstNonBlankPosition(doc(editor), firstLine)], 0);
      return;
    }

    if (op === "y") {
      if (linewise) {
        yank(spans.map((span) => span.register), "linewise");
        setNormalCursorPositions(editor, heads.map((head, index) => {
          const span = spans[Math.min(index, spans.length - 1)]!;
          return head >= span.from && head < Math.max(span.to, span.from + 1)
            ? head
            : firstNonBlankPosition(text, span.from);
        }));
      } else {
        yank(chars.map((range) => text.sliceString(range.from, range.to)));
        // Vim parks the caret at the start of what it yanked.
        if (chars.length > 0) setNormalCursorPositions(editor, chars.map((range) => range.from));
      }
      return;
    }

    if (op === "g~" || op === "gu" || op === "gU") {
      const targets = linewise ? spans.map((span) => ({ from: span.from, to: span.to })) : chars;
      if (targets.length === 0) return;
      const specs = caseChangeSpecs(editor, targets, op);
      if (specs.length === 0) return;
      markChange();
      const change = state.changes(specs);
      dispatchEdit(editor, {
        changes: change,
        selection: EditorSelection.create(
          targets.map((target, index) => {
            const head = heads[index] ?? target.from;
            const at = linewise && head >= target.from && head < target.to ? head : target.from;
            return EditorSelection.cursor(change.mapPos(at, -1));
          }),
          mainIndexFor(editor, targets.length),
        ),
      });
      normalizeNormalSelections(false);
      return;
    }

    // d and c
    if (linewise) {
      if (spans.length === 0) return;
      markChange();
      yank(spans.map((span) => span.register), "linewise");
      if (op === "c") {
        // A linewise change keeps one line — and its indentation — to type into.
        const change = state.changes(spans.map((span) => ({ from: span.changeFrom, to: span.changeTo })));
        dispatchEdit(editor, {
          changes: change,
          selection: EditorSelection.create(
            spans.map((span) => EditorSelection.cursor(change.mapPos(span.changeFrom, -1))),
            mainIndexFor(editor, spans.length),
          ),
          scrollIntoView: true,
        });
        restoreRevealedFormula(editor, revealed);
        enterInsert();
        return;
      }
      const change = state.changes(spans.map((span) => ({ from: span.deleteFrom, to: span.deleteTo })));
      const applied = change.apply(text);
      dispatchEdit(editor, {
        changes: change,
        selection: EditorSelection.create(
          spans.map((span) => {
            const at = change.mapPos(span.deleteFrom, -1);
            return EditorSelection.cursor(
              span.wholeLines ? linewiseLandingPosition(applied, at) : normalCharPosition(applied, at),
            );
          }),
          mainIndexFor(editor, spans.length),
        ),
        scrollIntoView: true,
      });
      restoreRevealedFormula(editor, revealed);
      return;
    }

    if (chars.length === 0) {
      // A motion that selects nothing is still a completed command; `c` still
      // opens Insert where Vim would, the others simply do nothing.
      if (op === "c") {
        markChange();
        enterInsert();
      }
      return;
    }
    markChange();
    yank(chars.map((range) => text.sliceString(range.from, range.to)));
    const change = state.changes(chars.map((range) => ({ from: range.from, to: range.to })));
    const applied = change.apply(text);
    dispatchEdit(editor, {
      changes: change,
      selection: EditorSelection.create(
        chars.map((range) => {
          const at = change.mapPos(range.from, -1);
          return EditorSelection.cursor(op === "c" ? at : normalCharPosition(applied, at));
        }),
        mainIndexFor(editor, chars.length),
      ),
      scrollIntoView: true,
    });
    restoreRevealedFormula(editor, revealed);
    if (op === "c") enterInsert();
  }

  function heads(): number[] {
    return editor.view.state.selection.ranges.map((range) => range.head);
  }

  function runOperatorMotion(
    operator: { op: VimOperator; count: number; explicit: boolean },
    token: string,
    find: FindSpec | null,
  ): void {
    const explicit = operator.explicit || countBuffer.length > 0;
    const count = clamp(operator.count * takeCount(), 1, MAX_VIM_COUNT);
    const sequence = `${operator.op}${token}${find ? find.target : ""}`;
    const doubled = token === operator.op
      || (operator.op.length === 2 && token === operator.op[1]);
    const carets = heads();
    if (doubled) {
      // `dd`, `3yy`, `cc`, `>>`, `guu`: COUNT Vim lines from each caret.
      applyOperator(
        operator.op,
        carets.map((head) => ({ kind: "line", span: countedSpan(editor, head, count) })),
        carets,
      );
      return;
    }

    const object = textObject(token, carets[0] ?? 0, count);
    if (object !== undefined) {
      const ranges = carets.map((head) => textObject(token, head, count));
      if (ranges.some((range) => range == null)) {
        reportUnhandled(sequence);
        return;
      }
      applyOperator(operator.op, (ranges as TextObjectRange[]).map(textObjectRange), carets);
      return;
    }

    const results = carets.map((head) => motion(token, head, {
      count,
      explicit,
      goal: null,
      find,
      scope: null,
    }));
    if (results[0] === undefined) {
      reportUnhandled(sequence);
      return;
    }
    if (results.some((result) => result == null)) {
      reportUnhandled(sequence);
      return;
    }
    applyOperator(
      operator.op,
      carets.map((head, index) => operatorRange(operator.op, token, head, results[index]!, count)),
      carets,
    );
  }

  // -------------------------------------------------------------------------
  // Mode transitions
  // -------------------------------------------------------------------------

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

  function rememberVisual(): void {
    if (mode === "visual-line" && visualLineStates) {
      lastVisual = { mode, states: visualLineStates.map((state) => ({ ...state })) };
    } else if (mode === "visual") {
      lastVisual = { mode, states: currentVisualCharStates().map((state) => ({ ...state, scope: null })) };
    }
  }

  function setMode(next: VimLiteMode): void {
    const previous = mode;
    const changed = mode !== next;
    const leavingVisual = previous === "visual" || previous === "visual-line";
    const exitHead = leavingVisual ? (visualHead ?? currentHead(editor)) : currentHead(editor);
    if (leavingVisual && next !== previous) rememberVisual();
    mode = next;
    editor.view.dom.dataset.vimMode = next;
    if (changed && (next === "insert" || previous === "insert")) {
      // Vim state is independent of the reader's Source/Markdown choice. The
      // local widgets still need one update when Insert changes whether the
      // object under the caret shows its editable Markdown source.
      editor.view.dispatch({ effects: [
        setTikzSourceEditing.of(next === "insert"),
        refreshViewportDecorations.of(editor.view.visibleRanges),
      ] });
    }
    cancelJump();
    visualHead = null;
    visualCharStates = null;
    visualCharSelection = null;
    visualCharDoc = null;
    visualLineStates = null;
    if (next !== "insert" || previous !== "insert") {
      insertEntry = null;
      insertSession = null;
      pendingInsertChange = null;
    }
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

  /**
   * Leave Visual for a command that sets its own carets: the selection is left
   * for the command's transaction to replace instead of being collapsed first.
   */
  function leaveVisualForCommand(): void {
    rememberVisual();
    const changed = mode !== "normal";
    mode = "normal";
    editor.view.dom.dataset.vimMode = mode;
    cancelJump();
    visualHead = null;
    visualCharStates = null;
    visualCharSelection = null;
    visualCharDoc = null;
    visualLineStates = null;
    resetMotionMemory();
    if (changed) options.onModeChange?.(mode);
  }

  function insertExitPosition(text: Text, pos: number): number {
    const cursor = clamp(pos, 0, text.length);
    const line = text.lineAt(cursor);
    if (line.from === line.to || cursor <= line.from) return line.from;
    return previousGraphemePosition(text, Math.min(cursor, line.to));
  }

  function enterInsert(returnPosWhenUnchanged: number | null = null, count = 1): void {
    setMode("insert");
    insertEntry = returnPosWhenUnchanged == null
      ? null
      : {
          doc: doc(editor),
          boundary: currentHead(editor),
          returnPos: normalCharPosition(doc(editor), returnPosWhenUnchanged),
        };
    insertSession = { doc: doc(editor), head: currentHead(editor), count };
  }

  /**
   * What the Insert session typed, as a replayable edit around the caret it
   * started at, or null when it cannot be expressed that way (the caret was
   * moved elsewhere and edited there).
   */
  function insertSessionEdit(): InsertReplay | null {
    const session = insertSession;
    if (!session) return null;
    const before = session.doc.toString();
    const after = doc(editor).toString();
    if (before === after) return { deleteBefore: 0, deleteAfter: 0, text: "" };
    const limit = Math.min(before.length, after.length);
    let prefixLength = 0;
    while (prefixLength < limit && before[prefixLength] === after[prefixLength]) prefixLength++;
    prefixLength = Math.min(prefixLength, session.head);
    let suffixLength = 0;
    const suffixLimit = limit - prefixLength;
    while (suffixLength < suffixLimit
        && before[before.length - 1 - suffixLength] === after[after.length - 1 - suffixLength]) {
      suffixLength++;
    }
    const removedTo = before.length - suffixLength;
    if (removedTo < session.head) return null;
    return {
      deleteBefore: session.head - prefixLength,
      deleteAfter: removedTo - session.head,
      text: after.slice(prefixLength, after.length - suffixLength),
    };
  }

  /** `3ifoo<Esc>` types `foo` three times. */
  function repeatInsertedText(edit: InsertReplay, times: number): void {
    if (times <= 0 || !edit.text || edit.deleteBefore || edit.deleteAfter) return;
    const state = editor.view.state;
    const insert = edit.text.repeat(times);
    dispatchEdit(editor, {
      changes: state.selection.ranges.map((range) => ({ from: range.head, insert })),
      selection: EditorSelection.create(
        state.selection.ranges.map((range, index) => EditorSelection.cursor(
          range.head + insert.length * (index + 1),
        )),
        state.selection.mainIndex,
      ),
    });
  }

  function escapeToNormal(): void {
    const leavingInsert = mode === "insert";
    if (leavingInsert && insertSession) {
      const edit = insertSessionEdit();
      if (edit && insertSession.count > 1) repeatInsertedText(edit, insertSession.count - 1);
      if (pendingInsertChange && edit) lastChange = { keys: pendingInsertChange, insert: edit };
    }
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
        // Keep the candidate inside TeX content. Returning to Normal restores
        // rendered mode and then snaps it onto the whole formula object.
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

  // -------------------------------------------------------------------------
  // Visual mode
  // -------------------------------------------------------------------------

  function currentVisualCharStates(): VisualState[] {
    if (mode === "visual" && visualCharStates && visualCharDoc === doc(editor)
        && visualCharSelection?.eq(editor.view.state.selection)) {
      return visualCharStates.map((state) => ({ ...state }));
    }
    visualCharStates = null;
    visualCharSelection = null;
    visualCharDoc = null;
    return readVisualCharStatesFromSelection();
  }

  function readVisualCharStatesFromSelection(): VisualState[] {
    const text = doc(editor);
    return editor.view.state.selection.ranges.map((range) => {
      if (range.empty) {
        const pos = normalEditorPosition(editor, range.head);
        return { anchor: pos, head: pos, scope: null };
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
        anchor: renderedObjectAtPosition(editor, rawAnchor)?.from ?? rawAnchor,
        head: renderedObjectAtPosition(editor, rawHead)?.from ?? rawHead,
        scope: null,
      };
    });
  }

  function visualStates(): VisualState[] {
    return mode === "visual-line" && visualLineStates
      ? visualLineStates.map((state) => ({ ...state }))
      : currentVisualCharStates();
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

  function renderVisualCharStates(states: readonly VisualState[]): void {
    if (states.length === 0) return;
    const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
    visualHead = states[mainIndex]!.head;
    const selection = EditorSelection.create(states.map((state) => {
      if (state.exclusiveWordEnd && state.head !== state.anchor) {
        return state.head > state.anchor
          ? EditorSelection.range(state.anchor, state.head)
          : EditorSelection.range(
            visualObjectEndPosition(editor, state.anchor),
            visualObjectEndPosition(editor, state.head),
          );
      }
      return state.head >= state.anchor
        ? EditorSelection.range(state.anchor, visualObjectEndPosition(editor, state.head))
        : EditorSelection.range(visualObjectEndPosition(editor, state.anchor), state.head);
    }), mainIndex);
    visualCharStates = states.map((state) => ({ ...state }));
    visualCharSelection = selection;
    visualCharDoc = doc(editor);
    dispatchVisualSelection(selection);
  }

  function renderVisualLineStates(states: readonly VisualState[]): void {
    if (states.length === 0) return;
    const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
    const spans = states.map((state) => spanBetween(editor, state.anchor, state.head, { scope: state.scope }));
    const selection = EditorSelection.create(states.map((state, index) => {
      const span = spans[index]!;
      return state.head >= state.anchor
        ? EditorSelection.range(span.from, span.to)
        : EditorSelection.range(span.to, span.from);
    }), mainIndex);
    // CM6 merges overlapping ranges. Keep the states of carets that met merged
    // too, or they would mysteriously reappear on the next j/k.
    let kept = [...states];
    if (selection.ranges.length < states.length) {
      kept = selection.ranges.map((range) => {
        const inside = states.filter((state) => state.head >= range.from && state.head <= range.to);
        const owner = inside[0] ?? states[0]!;
        const forward = range.head >= range.anchor;
        const all = inside.length > 0 ? inside : states;
        const low = Math.min(...all.map((state) => Math.min(state.anchor, state.head)));
        const high = Math.max(...all.map((state) => Math.max(state.anchor, state.head)));
        return forward
          ? { anchor: low, head: Math.max(owner.head, high), scope: owner.scope }
          : { anchor: high, head: Math.min(owner.head, low), scope: owner.scope };
      });
    }
    visualLineStates = kept;
    visualHead = kept[Math.min(selection.mainIndex, kept.length - 1)]!.head;
    dispatchVisualSelection(selection);
  }

  function renderVisualStates(states: readonly VisualState[]): void {
    if (mode === "visual-line") renderVisualLineStates(states);
    else renderVisualCharStates(states);
  }

  function switchToVisualLine(): void {
    const states = visualStates().map((state) => ({
      ...state,
      scope: vimRowAt(editor, state.head).scope,
    }));
    const changed = mode !== "visual-line";
    mode = "visual-line";
    editor.view.dom.dataset.vimMode = mode;
    resetMotionMemory();
    renderVisualLineStates(states);
    if (changed) options.onModeChange?.(mode);
  }

  function switchToVisualChar(): void {
    const text = doc(editor);
    const states = visualStates().map(({ anchor, head }) => ({
      anchor: normalCharPosition(text, anchor),
      head: normalCharPosition(text, head),
      scope: null,
    }));
    const changed = mode !== "visual";
    mode = "visual";
    editor.view.dom.dataset.vimMode = mode;
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
    const states = currentVisualCharStates().map((state) => ({
      anchor: state.head,
      head: state.head,
      scope: vimRowAt(editor, state.head).scope,
    }));
    setMode("visual-line");
    renderVisualLineStates(states);
  }

  function reselectLastVisual(): boolean {
    const previous = lastVisual;
    if (!previous || previous.states.length === 0) return false;
    const length = doc(editor).length;
    const states = previous.states.map((state) => ({
      anchor: clamp(state.anchor, 0, length),
      head: clamp(state.head, 0, length),
      scope: previous.mode === "visual-line" ? vimRowAt(editor, clamp(state.head, 0, length)).scope : null,
    }));
    setMode(previous.mode);
    renderVisualStates(states);
    return true;
  }

  function visualMove(token: string, count: number, explicit: boolean, find: FindSpec | null): boolean {
    const states = visualStates();
    const nextGoals: VerticalGoal[] = [];
    let moved = false;
    let known = true;
    const next = states.map((state, index) => {
      const result = motion(token, state.head, {
        count,
        explicit,
        goal: goals?.[index] ?? null,
        find,
        scope: mode === "visual-line" ? state.scope : null,
      });
      if (result === undefined) { known = false; return state; }
      if (result == null) return state;
      moved = true;
      if (result.goal) nextGoals.push(result.goal);
      let head = normalCharPosition(doc(editor), result.pos);
      if (mode === "visual") head = renderedObjectAtPosition(editor, head)?.from ?? head;
      if (state.scope && mode === "visual-line") {
        head = clamp(head, state.scope.from, Math.max(state.scope.from, state.scope.to - 1));
      }
      return { ...state, head, exclusiveWordEnd: mode === "visual" && (token === "w" || token === "W") };
    });
    if (!known) return false;
    goals = nextGoals.length === states.length ? nextGoals : null;
    if (moved) renderVisualStates(next);
    return true;
  }

  function selectVisualTextObject(token: string, count: number): boolean {
    const states = visualStates();
    const ranges = states.map((state) => textObject(token, state.head, count));
    if (ranges[0] === undefined) return false;
    if (ranges.some((range) => range == null)) {
      reportUnhandled(token);
      return true;
    }
    const objects = ranges as TextObjectRange[];
    const linewise = objects.some((range) => range.linewise);
    const text = doc(editor);
    const next = states.map((state, index) => {
      const range = objects[index]!;
      const low = Math.min(state.anchor, state.head);
      const high = Math.max(state.anchor, state.head);
      const extend = state.anchor !== state.head;
      const from = extend ? Math.min(low, range.from) : range.from;
      const lastChar = range.linewise
        ? range.to
        : range.to > range.from ? previousGraphemePosition(text, range.to) : range.from;
      const to = extend ? Math.max(high, lastChar) : lastChar;
      return { anchor: from, head: to, scope: null };
    });
    if (linewise && mode !== "visual-line") {
      mode = "visual-line";
      editor.view.dom.dataset.vimMode = mode;
      options.onModeChange?.(mode);
    }
    resetMotionMemory();
    renderVisualStates(next);
    return true;
  }

  /** The ranges a Visual command acts on; LINEWISE forces whole rows (`D`, `Y`, `C`). */
  function visualOpRanges(linewise: boolean): OpRange[] {
    if (mode === "visual-line" || linewise) {
      return visualStates().map((state) => ({
        kind: "line",
        span: spanBetween(editor, state.anchor, state.head, {
          scope: mode === "visual-line" ? state.scope : vimRowAt(editor, state.head).scope,
        }),
      }));
    }
    return editor.view.state.selection.ranges
      .filter((range) => !range.empty)
      .map((range) => ({ kind: "char", from: range.from, to: range.to }));
  }

  function visualOperator(op: VimOperator, linewise: boolean, count = 1): void {
    const ranges = visualOpRanges(linewise);
    const starts = visualStates().map((state) => Math.min(state.anchor, state.head));
    leaveVisualForCommand();
    if (op === "y") {
      if (ranges[0]?.kind === "line") {
        yank(ranges.flatMap((range) => range.kind === "line" ? [range.span.register] : []), "linewise");
      } else {
        const text = doc(editor);
        yank(ranges.flatMap((range) => range.kind === "char" ? [text.sliceString(range.from, range.to)] : []));
      }
      setNormalCursorPositions(editor, starts);
      return;
    }
    applyOperator(op, ranges, starts, count);
  }

  function visualReplace(ch: string): void {
    const ranges = visualOpRanges(false).map((range) => (
      range.kind === "line" ? { from: range.span.from, to: range.span.to } : range
    ));
    const starts = visualStates().map((state) => Math.min(state.anchor, state.head));
    leaveVisualForCommand();
    const specs = replaceSpecs(editor, ranges, ch);
    if (specs.length === 0) return;
    markChange();
    const change = editor.view.state.changes(specs);
    dispatchEdit(editor, { changes: change });
    setNormalCursorPositions(editor, starts.map((start) => change.mapPos(start, -1)));
  }

  function visualJoin(spaces: boolean): void {
    const text = doc(editor);
    const specs = visualStates().map((state) => {
      const first = text.lineAt(Math.min(state.anchor, state.head)).number;
      const last = text.lineAt(Math.max(state.anchor, state.head)).number;
      return { pos: text.line(first).from, joins: Math.max(1, last - first) };
    });
    leaveVisualForCommand();
    if (joinLines(editor, specs, spaces)) markChange();
    else normalizeNormalSelections(false);
  }

  /** Visual `I`/`A`: Insert at the selection's start/end, one caret per line in Visual-line. */
  function visualInsert(where: "start" | "end"): void {
    const text = doc(editor);
    const cursors: Array<{ pos: number; assoc?: -1 | 1 }> = [];
    const lineMode = mode === "visual-line";
    for (const state of visualStates()) {
      const low = Math.min(state.anchor, state.head);
      const high = Math.max(state.anchor, state.head);
      if (!lineMode) {
        cursors.push({ pos: where === "start" ? low : visualObjectEndPosition(editor, high) });
        continue;
      }
      const first = text.lineAt(low).number;
      const last = text.lineAt(high).number;
      for (let number = first; number <= last; number++) {
        const line = text.line(number);
        cursors.push({ pos: where === "start" ? firstNonBlankPosition(text, line.from) : line.to });
      }
    }
    leaveVisualForCommand();
    setInsertCursors(editor, cursors);
    enterInsert();
  }

  function syncSelectionFromEditor(): void {
    const text = doc(editor);
    const { anchor, head } = editor.getMarkdownSelectionRange();
    if (mode === "visual" && visualCharStates && visualCharDoc === text
        && visualCharSelection?.eq(editor.view.state.selection)) return;
    visualCharStates = null;
    visualCharSelection = null;
    visualCharDoc = null;
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
    const visualAnchor = renderedObjectAtPosition(editor, rawAnchor)?.from ?? rawAnchor;
    const changed = mode !== "visual";
    if (changed) setMode("visual");
    visualHead = renderedObjectAtPosition(editor, rawHead)?.from ?? rawHead;
    visualLineStates = null;
    resetMotionMemory();
    if (visualAnchor !== rawAnchor || visualHead !== rawHead) {
      const states = currentVisualCharStates();
      const mainIndex = Math.min(editor.view.state.selection.mainIndex, states.length - 1);
      states[mainIndex] = { anchor: visualAnchor, head: visualHead, scope: null };
      renderVisualCharStates(states);
    }
  }

  // -------------------------------------------------------------------------
  // Commands shared by Normal and Visual
  // -------------------------------------------------------------------------

  function paste(where: "before" | "after", yankReplaced: boolean): void {
    resetMotionMemory();
    markChange();
    const replacingVisual = mode === "visual" || mode === "visual-line";
    const replaced = replacingVisual ? visualOpRanges(false) : [];
    const replacedText = doc(editor);
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
    if (replacingVisual) leaveVisualForCommand();
    const target = captureEditorPasteTarget(editor.view, selectedRanges, {
      fragments: register.fragments.length > 0 ? register.fragments : [register.text],
      clipboardText: register.text,
    });
    // Capture the current register in case it changes before the async path runs.
    const localRegister = register;
    const pendingWrite = pendingClipboardWrite;
    const epoch = asyncEpoch;
    window.setTimeout(() => {
      if (destroyed || epoch !== asyncEpoch) return;
      void (async () => {
        // Wait for any in-flight clipboard write to land before reading back.
        // 400 ms guard prevents a stalled write from blocking paste indefinitely.
        await Promise.race([pendingWrite, new Promise<void>((r) => setTimeout(r, 400))]);
        if (destroyed || epoch !== asyncEpoch) return;
        const handled = await editor.pasteFromClipboard({ placement, target });
        if (!handled && localRegister.text) {
          editor.pastePlainText(localRegister.text, { placement, target });
        }
        // Visual `p` puts what it replaced in the register (Evil's
        // `evil-kill-on-visual-paste`); `P` leaves the register alone.  Only
        // after the read, or the clipboard would hand back the replaced text.
        if (yankReplaced && replaced.length > 0) {
          if (replaced[0]!.kind === "line") {
            yank(replaced.flatMap((range) => range.kind === "line" ? [range.span.register] : []), "linewise");
          } else {
            yank(replaced.flatMap((range) => (
              range.kind === "char" ? [replacedText.sliceString(range.from, range.to)] : []
            )));
          }
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

  function foldCommand(action: VimLiteFoldAction): boolean {
    resetMotionMemory();
    return options.onFold?.(action) ?? true;
  }

  function scrollCommand(where: "center" | "start" | "end"): void {
    editor.view.dispatch({ effects: EditorView.scrollIntoView(currentHead(editor), { y: where }) });
  }

  /** `z` commands shared by Normal and Visual. */
  function zCommand(key: string): boolean {
    switch (key) {
      case "c": return foldCommand("close");
      case "o": return foldCommand("open");
      case "a": return foldCommand("toggle");
      case "M": return foldCommand("close-all");
      case "R": return foldCommand("open-all");
      case "z": scrollCommand("center"); return true;
      case "t": scrollCommand("start"); return true;
      case "b": scrollCommand("end"); return true;
      default: return false;
    }
  }

  function appendChar(): void {
    const text = doc(editor);
    setInsertCursors(editor, editor.view.state.selection.ranges.map((range) => {
      const pos = normalCharPosition(text, range.head);
      const object = staticMathObjectAtPosition(editor, pos);
      if (object?.from === pos) return { pos: object.to };
      return { pos: Math.min(text.lineAt(pos).to, graphemeEndPosition(text, pos)) };
    }));
  }

  // -------------------------------------------------------------------------
  // Normal mode
  // -------------------------------------------------------------------------

  function moveNormal(token: string, count: number, explicit: boolean, find: FindSpec | null): boolean {
    const ranges = editor.view.state.selection.ranges;
    const nextGoals: VerticalGoal[] = [];
    let failed = false;
    const positions = ranges.map((range, index) => {
      const result = motion(token, range.head, {
        count,
        explicit,
        goal: goals?.[index] ?? null,
        find,
        scope: null,
      });
      if (result === undefined) return undefined;
      if (result == null) { failed = true; return range.head; }
      if (result.goal) nextGoals.push(result.goal);
      return result.pos;
    });
    if (positions[0] === undefined) return false;
    goals = nextGoals.length === ranges.length ? nextGoals : null;
    setNormalCursorPositions(editor, positions as number[]);
    if (failed && ranges.length === 1) reportUnhandled(`${token}${find?.target ?? ""}`);
    return true;
  }

  /** `D`/`C`/`Y`: from the caret to the end of its row, COUNT-1 rows further for a count. */
  function rowTailRanges(count: number): Array<{ from: number; to: number; row: VimRow }> {
    return editor.view.state.selection.ranges.map((range) => {
      const row = vimRowAt(editor, range.head);
      const { row: last } = stepRows(editor, row, count - 1, 1);
      return { from: clamp(range.head, row.from, row.to), to: last.to, row };
    });
  }

  function deleteToRowEnd(count: number, andInsert: boolean): void {
    const state = editor.view.state;
    const text = state.doc;
    const tails = rowTailRanges(count).filter((tail) => tail.from < tail.to);
    if (tails.length === 0) {
      if (andInsert) {
        markChange();
        enterInsert();
      }
      return;
    }
    markChange();
    yank(tails.map((tail) => text.sliceString(tail.from, tail.to)));
    const change = state.changes(tails.map((tail) => ({ from: tail.from, to: tail.to })));
    const applied = change.apply(text);
    const revealed = singleRevealedFormula(editor);
    dispatchEdit(editor, {
      changes: change,
      selection: EditorSelection.create(
        tails.map((tail) => {
          const at = change.mapPos(tail.from, -1);
          if (andInsert) return EditorSelection.cursor(at, tail.from > tail.row.from ? -1 : 1);
          // `D` leaves Normal mode on the new last character of the row.
          return EditorSelection.cursor(tail.from > tail.row.from
            ? previousGraphemePosition(applied, at)
            : normalCharPosition(applied, at));
        }),
        mainIndexFor(editor, tails.length),
      ),
      scrollIntoView: true,
    });
    restoreRevealedFormula(editor, revealed);
    if (andInsert) enterInsert();
  }

  function deleteCharacters(count: number, backward: boolean): void {
    const state = editor.view.state;
    const text = state.doc;
    const revealed = singleRevealedFormula(editor);
    const ranges = uniqueRanges(state.selection.ranges.flatMap((range) => {
      const span = characterSpan(editor, range.head, count, backward);
      return span ? [span] : [];
    }));
    if (ranges.length === 0) return;
    markChange();
    yank(ranges.map((range) => text.sliceString(range.from, range.to)));
    const change = state.changes(ranges.map(({ from, to }) => ({ from, to })));
    const applied = change.apply(text);
    dispatchEdit(editor, {
      changes: change,
      selection: EditorSelection.create(
        ranges.map((range) => EditorSelection.cursor(normalCharPosition(applied, change.mapPos(range.from, -1)))),
        mainIndexFor(editor, ranges.length),
      ),
      scrollIntoView: true,
    });
    restoreRevealedFormula(editor, revealed);
    normalizeNormalSelections(false);
  }

  function replaceCharacters(ch: string, count: number): void {
    const state = editor.view.state;
    const revealed = singleRevealedFormula(editor);
    const ranges = state.selection.ranges.flatMap((range) => {
      const span = countedCharacterRange(editor, range.head, count);
      return span ? [span] : [];
    });
    const specs = replaceSpecs(editor, ranges, ch);
    if (specs.length === 0) {
      reportUnhandled(`r${ch}`);
      return;
    }
    markChange();
    const change = state.changes(specs);
    const applied = change.apply(state.doc);
    // Vim leaves Normal cursors on the (last) replaced character, not after it.
    dispatchEdit(editor, {
      changes: change,
      selection: EditorSelection.create(
        specs.map((spec) => EditorSelection.cursor(previousGraphemePosition(applied, change.mapPos(spec.to, -1)))),
        mainIndexFor(editor, specs.length),
      ),
      scrollIntoView: true,
    });
    restoreRevealedFormula(editor, revealed);
  }

  function insertCommand(key: string, count: number): void {
    const text = doc(editor);
    switch (key) {
      case "i": {
        const object = renderedObjectAtPosition(editor, currentHead(editor));
        const formula = object ? formulaRangeAtWidgetPosition(editor.view.state, object.from) : null;
        const returnPos = object?.from ?? normalCharPosition(text, currentHead(editor));
        enterInsert(returnPos, count);
        if (formula) {
          setPos(editor, formula.contentFrom);
          insertEntry = { doc: doc(editor), boundary: currentHead(editor), returnPos };
          insertSession = { doc: doc(editor), head: currentHead(editor), count };
        }
        return;
      }
      case "a": {
        const object = renderedObjectAtPosition(editor, currentHead(editor));
        if (object) {
          const formula = formulaRangeAtWidgetPosition(editor.view.state, object.from);
          enterInsert(object.from, count);
          setPos(editor, formula?.contentTo ?? object.to);
          insertEntry = { doc: doc(editor), boundary: currentHead(editor), returnPos: object.from };
          insertSession = { doc: doc(editor), head: currentHead(editor), count };
          return;
        }
        appendChar();
        enterInsert(null, count);
        return;
      }
      case "I": {
        // Evil's `I` with visual lines: the first non-blank on the first row,
        // the row start on a continuation row. Unlike linewise operators,
        // insert entry must use the whole row when the cursor is inside a
        // revealed formula, so I can leave its TeX body.
        setInsertCursors(editor, editor.view.state.selection.ranges.map((range) => {
          const formula = revealedFormulaAt(editor, range.head);
          if (formula?.display) return { pos: formula.from };
          const row = vimRowAt(editor, range.head, 1, { scope: null });
          return { pos: row.lineStart ? Math.min(firstNonBlankIn(text, row.from, row.to), row.to) : row.from };
        }));
        enterInsert(normalCharPosition(doc(editor), currentHead(editor)), count);
        return;
      }
      case "A": {
        // End of the row; a continuation row keeps its caret on that row.
        // Do not clamp A to the revealed formula's content boundary.
        setInsertCursors(editor, editor.view.state.selection.ranges.map((range) => {
          const formula = revealedFormulaAt(editor, range.head);
          if (formula?.display) return { pos: formula.to };
          const row = vimRowAt(editor, range.head, 1, { scope: null });
          return { pos: row.to, assoc: row.lineEnd ? 1 : -1 };
        }));
        enterInsert(null, count);
        return;
      }
      case "o":
      case "O":
        markChange();
        openLine(editor, key === "o" ? "below" : "above");
        enterInsert();
        return;
    }
  }

  function repeatLastChange(count: number | null): void {
    const change = lastChange;
    if (!change) {
      reportUnhandled(".");
      return;
    }
    // A count typed before `.` has already started a command recording. The
    // replay edits must not replace the stored change with `3.` itself, which
    // would make the next dot recursively replay dots.
    recording = null;
    let keys = [...change.keys];
    if (count != null) {
      // A count on `.` replaces the original one, wherever it was typed.
      while (keys.length > 0 && /^[0-9]$/u.test(keys[0]!)) keys.shift();
      const operatorAt = keys[0] === "g" ? 2 : 1;
      if (OPERATOR_KEYS.has(keys[0] ?? "") || (keys[0] === "g" && G_OPERATOR_KEYS.has(keys[1] ?? ""))) {
        while (keys.length > operatorAt && /^[0-9]$/u.test(keys[operatorAt]!)) keys.splice(operatorAt, 1);
      }
      keys = [...String(count).split(""), ...keys];
    }
    replaying = true;
    try {
      for (const key of keys) normalKey(key);
      if (mode === "insert") {
        if (change.insert) {
          const edit = change.insert;
          const state = editor.view.state;
          const changes = state.selection.ranges.map((range) => ({
            from: clamp(range.head - edit.deleteBefore, 0, state.doc.length),
            to: clamp(range.head + edit.deleteAfter, 0, state.doc.length),
            insert: edit.text,
          }));
          const applied = state.changes(changes);
          editor.view.dispatch({
            changes: applied,
            selection: EditorSelection.create(
              changes.map((spec) => EditorSelection.cursor(applied.mapPos(spec.from, -1) + edit.text.length)),
              state.selection.mainIndex,
            ),
          });
        }
        escapeToNormal();
      }
    } finally {
      replaying = false;
    }
  }

  function gCommand(key: string, count: number, explicit: boolean): boolean {
    switch (key) {
      case "v":
        if (!reselectLastVisual()) reportUnhandled("gv");
        return true;
      case "J":
        resetMotionMemory();
        if (joinLines(editor, editor.view.state.selection.ranges.map((range) => ({
          pos: range.head,
          joins: Math.max(1, count - 1),
        })), false)) markChange();
        else reportUnhandled("gJ");
        return true;
      default: {
        const token = `g${key}`;
        if (!moveNormal(token, count, explicit, null)) reportUnhandled(token);
        else if (!VERTICAL_TOKENS.has(token)) resetMotionMemory();
        return true;
      }
    }
  }

  /** Resolve one complete Normal-mode token. */
  function normalToken(token: string, find: FindSpec | null = null): boolean {
    const explicit = countBuffer.length > 0;
    if (pendingOperator) {
      const operator = pendingOperator;
      pendingOperator = null;
      runOperatorMotion(operator, token, find);
      return true;
    }
    if (OPERATOR_KEYS.has(token) || (token.length === 2 && token[0] === "g" && G_OPERATOR_KEYS.has(token[1]!))) {
      pendingOperator = { op: token as VimOperator, count: takeCount(), explicit };
      return true;
    }
    const count = takeCount();
    if (token.length === 2 && token[0] === "g") return gCommand(token[1]!, count, explicit);
    if (token.length === 2 && token[0] === "z") {
      if (!zCommand(token[1]!)) reportUnhandled(token);
      return true;
    }
    if (moveNormal(token, count, explicit, find)) {
      if (!VERTICAL_TOKENS.has(token)) resetMotionMemory();
      return true;
    }
    resetMotionMemory();
    switch (token) {
      case "i":
      case "a":
      case "I":
      case "A":
      case "o":
      case "O":
        insertCommand(token, count);
        return true;
      case "v":
        enterVisual();
        return true;
      case "V":
        enterVisualLine();
        return true;
      case "x":
      case "Delete":
        deleteCharacters(count, false);
        return true;
      case "X":
        deleteCharacters(count, true);
        return true;
      case "D":
        deleteToRowEnd(count, false);
        return true;
      case "C":
        deleteToRowEnd(count, true);
        return true;
      case "Y": {
        const carets = heads();
        applyOperator("y", carets.map((head) => ({
          kind: "line",
          span: countedSpan(editor, head, count),
        })), carets);
        return true;
      }
      case "J":
        if (joinLines(editor, editor.view.state.selection.ranges.map((range) => ({
          pos: range.head,
          joins: Math.max(1, count - 1),
        })), true)) markChange();
        else reportUnhandled(token);
        return true;
      case "~":
        if (toggleCaseForward(editor, count)) markChange();
        else reportUnhandled(token);
        return true;
      case "p":
      case "P":
        paste(token === "p" ? "after" : "before", false);
        return true;
      case "u":
        for (let step = 0; step < count; step++) options.onUndo?.();
        normalizeNormalSelections(false);
        return true;
      case ".":
        repeatLastChange(explicit ? count : null);
        return true;
      case "s":
      case "S":
        startJumpInput(token === "s" ? 1 : -1);
        return true;
      case "/":
        lastSearch = { source: "host", forward: true };
        options.onFind?.();
        return true;
      case "Escape":
        setMode("normal");
        return true;
      default:
        if (!isSingleGrapheme(token)) return false;
        reportUnhandled(token);
        return true;
    }
  }

  /** Normal-mode key parser: count, prefix, then a token. */
  function normalKey(key: string): boolean {
    if (jumpSession) return handleJumpSessionKey(key);
    if (jumpInput) return handleJumpInputKey(key);
    // Before the chord table so `3dd`, `d3d` and `3d3d` all count, but after
    // the jump reader, whose labels may themselves be digits.
    if (consumeCountDigit(key)) return true;

    if (prefix) {
      const first = prefix;
      prefix = "";
      if (key === "Escape") {
        resetParser();
        return true;
      }
      if (first === "r") {
        if (!isSingleGrapheme(key)) {
          resetParser();
          reportUnhandled(`r${key}`);
          return true;
        }
        const count = takeCount();
        resetMotionMemory();
        replaceCharacters(key, count);
        return true;
      }
      if (isFindKind(first)) {
        if (!isSingleGrapheme(key)) {
          const sequence = `${pendingOperator?.op ?? ""}${first}${key}`;
          resetParser();
          reportUnhandled(sequence);
          return true;
        }
        lastFind = { kind: first, target: key };
        return normalToken(first, lastFind);
      }
      if (first === "i" || first === "a") {
        if (!pendingOperator) {
          resetParser();
          reportUnhandled(`${first}${key}`);
          return true;
        }
        return normalToken(`${first}${key}`);
      }
      if (first === "z" && pendingOperator) {
        const sequence = `${pendingOperator.op}z${key}`;
        resetParser();
        reportUnhandled(sequence);
        return true;
      }
      return normalToken(`${first}${key}`);
    }

    if (key === "g" || key === "z" || isFindKind(key)
        || (key === "r" && !pendingOperator)
        || ((key === "i" || key === "a") && pendingOperator)) {
      prefix = key;
      return true;
    }
    if (key === "Escape") {
      const wasPending = !parserIdle();
      resetParser();
      if (!wasPending) setMode("normal");
      return true;
    }
    const token = KEY_ALIASES[key] ?? (key === "Delete" && !pendingOperator ? "x" : key);
    if (normalToken(token)) return true;
    resetParser();
    return false;
  }

  // -------------------------------------------------------------------------
  // Visual mode
  // -------------------------------------------------------------------------

  function visualToken(token: string, find: FindSpec | null = null): boolean {
    const explicit = countBuffer.length > 0;
    const count = takeCount();
    if (textObject(token, 0, 1) !== undefined) return selectVisualTextObject(token, count);
    if (token.length === 2 && token[0] === "z") {
      if (!zCommand(token[1]!)) reportUnhandled(token);
      return true;
    }
    const lineMode = mode === "visual-line";
    switch (token) {
      case "d":
      case "x":
      case "Delete":
        visualOperator("d", false);
        return true;
      case "X":
      case "D":
        visualOperator("d", true);
        return true;
      case "y":
        visualOperator("y", false);
        return true;
      case "Y":
        visualOperator("y", true);
        return true;
      case "c":
        visualOperator("c", false);
        return true;
      case "C":
      case "R":
        visualOperator("c", true);
        return true;
      case "s":
      case "S":
        startJumpInput(token === "s" ? 1 : -1);
        return true;
      case ">":
      case "<":
        visualOperator(token, true, count);
        return true;
      case "~":
      case "g~":
        visualOperator("g~", false);
        return true;
      case "u":
      case "gu":
        visualOperator("gu", false);
        return true;
      case "U":
      case "gU":
        visualOperator("gU", false);
        return true;
      case "J":
      case "gJ":
        visualJoin(token === "J");
        return true;
      case "p":
      case "P":
        paste("after", token === "p");
        return true;
      case "o":
      case "O":
        resetMotionMemory();
        renderVisualStates((mode === "visual" ? readVisualCharStatesFromSelection() : visualStates())
          .map((state) => ({ ...state, anchor: state.head, head: state.anchor, exclusiveWordEnd: false })));
        return true;
      case "I":
      case "A":
        markChange();
        visualInsert(token === "I" ? "start" : "end");
        return true;
      case "v":
        if (lineMode) switchToVisualChar();
        else setMode("normal");
        return true;
      case "V":
        if (lineMode) setMode("normal");
        else switchToVisualLine();
        return true;
      case "/":
        resetMotionMemory();
        lastSearch = { source: "host", forward: true };
        options.onFind?.();
        return true;
      case "Escape":
        setMode("normal");
        return true;
      default:
        break;
    }
    if (visualMove(token, count, explicit, find)) {
      if (!VERTICAL_TOKENS.has(token)) resetMotionMemory();
      return true;
    }
    if (!isSingleGrapheme(token)) {
      if (token.length === 2 && (token[0] === "g" || token[0] === "i" || token[0] === "a")) {
        reportUnhandled(token);
        return true;
      }
      return false;
    }
    reportUnhandled(token);
    return true;
  }

  function visualKey(key: string): boolean {
    if (jumpSession) return handleJumpSessionKey(key);
    if (jumpInput) return handleJumpInputKey(key);
    if (consumeCountDigit(key)) return true;
    if (prefix) {
      const first = prefix;
      prefix = "";
      if (key === "Escape") {
        resetParser();
        return true;
      }
      if (first === "r") {
        countBuffer = "";
        if (!isSingleGrapheme(key)) {
          reportUnhandled(`r${key}`);
          return true;
        }
        resetMotionMemory();
        visualReplace(key);
        return true;
      }
      if (isFindKind(first)) {
        if (!isSingleGrapheme(key)) {
          countBuffer = "";
          reportUnhandled(`${first}${key}`);
          return true;
        }
        lastFind = { kind: first, target: key };
        return visualToken(first, lastFind);
      }
      return visualToken(`${first}${key}`);
    }
    if (key === "g" || key === "z" || key === "r" || key === "i" || key === "a" || isFindKind(key)) {
      prefix = key;
      return true;
    }
    const token = KEY_ALIASES[key] ?? key;
    if (visualToken(token)) return true;
    resetParser();
    return false;
  }

  // -------------------------------------------------------------------------
  // Embedded editables
  // -------------------------------------------------------------------------

  function editableNormalCommand(key: string, editable: HTMLElement): boolean {
    if (!isRichEditable(editable)) {
      if (key === "i" || key === "a") {
        enterInsert();
        return true;
      }
      prefix = "";
      // Normal mode must not destroy text. Printable keys are already
      // swallowed by the length check below, but Backspace and Delete are not
      // printable and would reach the control natively — so an embedded input
      // lost a character to a key Vim treats as a plain leftward motion, and
      // the rich-editable branch below already treats that way.
      if (key === "Backspace" || key === "Delete") return true;
      return isSingleGrapheme(key);
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
        prefix = "";
        if (!isSingleGrapheme(key)) return false;
        reportUnhandled(key);
        return true;
    }
  }

  /** Normal-mode entry with `.` recording around one complete command. */
  function recordedNormalKey(key: string): boolean {
    if (replaying) return normalKey(key);
    if (!recording && parserIdle() && key !== ".") recording = { keys: [], changed: false };
    recording?.keys.push(key);
    const handled = normalKey(key);
    const record = recording;
    if (record && parserIdle()) {
      recording = null;
      if (mode === "insert") pendingInsertChange = record.keys;
      else if (record.changed) lastChange = { keys: record.keys, insert: null };
    }
    return handled;
  }

  return {
    mode: () => mode,
    setMode,
    syncSelectionFromEditor,
    handleKey(event: VimLiteKey): boolean {
      if (destroyed) return false;
      if (event.isComposing) return false;
      if (isEscape(event)) {
        if (jumpInput || jumpSession) {
          cancelJump();
          return true;
        }
        cancelJump();
        recording = null;
        escapeToNormal();
        return true;
      }

      if (mode === "insert") {
        // Let CM6's native cursor commands own insert-mode movement. They use
        // visual wrapped lines and preserve the pixel goal column.
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
        const count = takeCount();
        resetParser();
        for (let step = 0; step < count; step++) options.onRedo?.();
        if (mode === "normal") normalizeNormalSelections(false);
        return true;
      }
      if (hasCommandModifier(event)) {
        cancelJump();
        return false;
      }

      if (mode === "normal") return recordedNormalKey(event.key);
      return visualKey(event.key);
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
        if (jumpInput || jumpSession) {
          cancelJump();
          return true;
        }
        recording = null;
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
      delete editor.view.dom.dataset.vimMode;
      asyncEpoch += 1;
      cancelJump();
    },
  };
}
