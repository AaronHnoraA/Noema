/**
 * Toggleable inline Markdown formats (bold, italic, strike, code, highlight,
 * superscript, subscript) and "clear format".
 *
 * The rules follow MarkText's `Format.format()` (muya `block/base/format.ts`),
 * restated over source text because Noema's document *is* the Markdown:
 *
 *   - a selection (or caret) inside a span of the format removes that span's
 *     markers instead of nesting another pair;
 *   - spans of the format that only partly overlap the selection are merged
 *     into one span covering both, rather than producing `**a **b** c**`;
 *   - whitespace at the selection edges stays outside the markers, since
 *     `** word **` is not emphasis in CommonMark (files.md and MarkText both
 *     trim);
 *   - a selection across lines is wrapped line by line after each line's block
 *     prefix (list marker, quote, heading marks), because emphasis cannot span
 *     a paragraph break;
 *   - a bare caret outside any span inserts an empty marker pair around it.
 *
 * Spans come from the Lezer Markdown tree, except `==highlight==`, which the
 * grammar does not know and live preview scans per line; that scan is restated
 * here with the same rules so toggling agrees with what is rendered.
 */

import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { Tree } from "@lezer/common";

export type InlineFormatKind =
  | "bold"
  | "italic"
  | "strike"
  | "code"
  | "highlight"
  | "superscript"
  | "subscript";

export const INLINE_FORMAT_KINDS: readonly InlineFormatKind[] = [
  "bold",
  "italic",
  "strike",
  "code",
  "highlight",
  "superscript",
  "subscript",
];

export type InlineFormatSpan = {
  kind: InlineFormatKind;
  /** Start of the opening marker. */
  from: number;
  /** End of the closing marker. */
  to: number;
  contentFrom: number;
  contentTo: number;
};

type TreeFormat = Exclude<InlineFormatKind, "highlight">;

const TREE_FORMATS: Record<TreeFormat, { node: string; mark: string }> = {
  bold: { node: "StrongEmphasis", mark: "EmphasisMark" },
  italic: { node: "Emphasis", mark: "EmphasisMark" },
  strike: { node: "Strikethrough", mark: "StrikethroughMark" },
  code: { node: "InlineCode", mark: "CodeMark" },
  superscript: { node: "Superscript", mark: "SuperscriptMark" },
  subscript: { node: "Subscript", mark: "SubscriptMark" },
};

const DEFAULT_MARKER: Record<InlineFormatKind, string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
  highlight: "==",
  superscript: "^",
  subscript: "~",
};

const CODE_NODES = new Set(["InlineCode", "FencedCode", "CodeBlock", "IndentedCode"]);
const CODE_BLOCK_NODES = new Set(["FencedCode", "CodeBlock", "IndentedCode"]);

/**
 * The block prefix a line's inline content starts after: indentation, quote
 * markers, an ATX heading marker, or a list marker with an optional task box.
 */
const BLOCK_PREFIX_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/u;

function treeFor(state: EditorState, upto: number): Tree {
  return ensureSyntaxTree(state, Math.min(state.doc.length, upto), 200) ?? syntaxTree(state);
}

function escapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let pos = index - 1; pos >= 0 && text[pos] === "\\"; pos--) slashes++;
  return slashes % 2 === 1;
}

function codeRangesIn(tree: Tree, from: number, to: number): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  tree.iterate({
    from,
    to,
    enter(node) {
      if (!CODE_NODES.has(node.name)) return;
      ranges.push({ from: node.from, to: node.to });
      return false;
    },
  });
  return ranges;
}

function overlapsAny(from: number, to: number, ranges: readonly { from: number; to: number }[]): boolean {
  return ranges.some((range) => from < range.to && to > range.from);
}

/** `==highlight==` spans on one line, by the rule live preview renders. */
export function highlightSpansInLine(
  text: string,
  lineFrom: number,
  codeRanges: readonly { from: number; to: number }[] = [],
): InlineFormatSpan[] {
  const spans: InlineFormatSpan[] = [];
  let open = 0;
  while ((open = text.indexOf("==", open)) >= 0) {
    if (escapedAt(text, open) || text[open + 2] === "=" || overlapsAny(lineFrom + open, lineFrom + open + 2, codeRanges)) {
      open += 2;
      continue;
    }
    const close = text.indexOf("==", open + 2);
    if (close < 0) break;
    if (close === open + 2 || escapedAt(text, close) || text[close + 2] === "=") {
      open = close + 2;
      continue;
    }
    const from = lineFrom + open;
    const to = lineFrom + close + 2;
    if (!overlapsAny(from, to, codeRanges)) {
      spans.push({ kind: "highlight", from, to, contentFrom: from + 2, contentTo: to - 2 });
    }
    open = close + 2;
  }
  return spans;
}

/** Every span of KIND that touches [from, to]. */
export function inlineFormatSpans(
  state: EditorState,
  kind: InlineFormatKind,
  from: number,
  to: number,
): InlineFormatSpan[] {
  const doc = state.doc;
  const lo = Math.max(0, Math.min(from, to));
  const hi = Math.min(doc.length, Math.max(from, to));
  const tree = treeFor(state, hi);
  if (kind === "highlight") {
    const spans: InlineFormatSpan[] = [];
    const first = doc.lineAt(lo).number;
    const last = doc.lineAt(hi).number;
    for (let number = first; number <= last; number++) {
      const line = doc.line(number);
      spans.push(...highlightSpansInLine(line.text, line.from, codeRangesIn(tree, line.from, line.to)));
    }
    return spans.filter((span) => span.from <= hi && span.to >= lo);
  }
  const { node: nodeName, mark } = TREE_FORMATS[kind];
  const spans: InlineFormatSpan[] = [];
  tree.iterate({
    from: lo,
    to: hi,
    enter(node) {
      if (node.name !== nodeName) return;
      const open = node.node.firstChild;
      const close = node.node.lastChild;
      if (!open || !close || open.name !== mark || close.name !== mark || open.from === close.from) return;
      spans.push({ kind, from: node.from, to: node.to, contentFrom: open.to, contentTo: close.from });
    },
  });
  return spans;
}

/** The innermost span of KIND that a range or caret sits inside, if any. */
function enclosingSpan(state: EditorState, kind: InlineFormatKind, range: SelectionRange): InlineFormatSpan | null {
  const candidates = inlineFormatSpans(state, kind, range.from, range.to).filter((span) => (
    range.empty
      ? range.from > span.from && range.from < span.to
      : range.from >= span.from && range.to <= span.to
  ));
  candidates.sort((a, b) => (a.to - a.from) - (b.to - b.from));
  return candidates[0] ?? null;
}

function insideCodeBlock(state: EditorState, pos: number): boolean {
  let node: ReturnType<Tree["resolveInner"]> | null = treeFor(state, pos).resolveInner(pos, -1);
  for (; node; node = node.parent) {
    if (CODE_BLOCK_NODES.has(node.name)) return true;
  }
  return false;
}

/** The backtick fence and padding that keep TEXT literal inside inline code. */
function codeMarkers(text: string): { open: string; close: string } {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  const fence = "`".repeat(longest + 1);
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return { open: fence + pad, close: pad + fence };
}

function markersFor(kind: InlineFormatKind, text: string): { open: string; close: string } {
  if (kind === "code") return codeMarkers(text);
  const marker = DEFAULT_MARKER[kind];
  return { open: marker, close: marker };
}

type RangeEdit = { changes: ChangeSpec[]; anchor: number; head: number };

function markerDeletions(spans: readonly InlineFormatSpan[]): Array<{ from: number; to: number }> {
  const deletions = new Map<string, { from: number; to: number }>();
  for (const span of spans) {
    deletions.set(`${span.from}:${span.contentFrom}`, { from: span.from, to: span.contentFrom });
    deletions.set(`${span.contentTo}:${span.to}`, { from: span.contentTo, to: span.to });
  }
  return [...deletions.values()].filter((range) => range.to > range.from).sort((a, b) => a.from - b.from);
}

function unwrapEdit(state: EditorState, span: InlineFormatSpan, range: SelectionRange): RangeEdit {
  const changes = markerDeletions([span]);
  const set = state.changes(changes);
  const clamp = (pos: number): number => Math.max(span.contentFrom, Math.min(span.contentTo, pos));
  // A selection that took in the markers keeps exactly the content selected.
  const anchor = set.mapPos(range.empty ? range.anchor : clamp(range.anchor), -1);
  const head = set.mapPos(range.empty ? range.head : clamp(range.head), 1);
  return { changes, anchor, head };
}

/**
 * Wrap [from, to) after merging the partly-overlapping SPANS of the same kind.
 * Returns null when nothing but whitespace or block prefixes was selected.
 */
function wrapEdit(
  state: EditorState,
  kind: InlineFormatKind,
  from: number,
  to: number,
  spans: readonly InlineFormatSpan[],
  backward: boolean,
): RangeEdit | null {
  const doc = state.doc;
  const start = Math.min(from, ...spans.map((span) => span.from));
  const end = Math.max(to, ...spans.map((span) => span.to));
  const removed = markerDeletions(spans);
  // Plain text of [start, end) with the merged spans' markers dropped.
  let text = "";
  let firstKept = -1;
  let cursor = start;
  for (const deletion of [...removed, { from: end, to: end }]) {
    const chunkTo = Math.min(deletion.from, end);
    if (chunkTo > cursor) {
      if (firstKept < 0) firstKept = cursor;
      text += doc.sliceString(cursor, chunkTo);
    }
    cursor = Math.max(cursor, deletion.to);
  }
  const firstPos = firstKept < 0 ? start : firstKept;

  let output = "";
  let contentStart = -1;
  let contentEnd = -1;
  let lineStart = 0;
  while (lineStart <= text.length) {
    const newline = text.indexOf("\n", lineStart);
    const lineEnd = newline < 0 ? text.length : newline;
    const segment = text.slice(lineStart, lineEnd);
    // Only the first line of the range may start mid-line; every later line
    // begins at a document line start and so owns its block prefix.
    const docLineStart = lineStart === 0 ? doc.lineAt(firstPos).from === firstPos : true;
    const prefix = docLineStart ? (segment.match(BLOCK_PREFIX_RE)?.[0] ?? "") : "";
    const body = segment.slice(prefix.length);
    const lead = body.length - body.trimStart().length;
    const trail = body.length - body.trimEnd().length;
    const inner = body.slice(lead, body.length - trail);
    if (inner) {
      const { open, close } = markersFor(kind, inner);
      const before = segment.slice(0, prefix.length + lead);
      const after = segment.slice(segment.length - trail);
      if (contentStart < 0) contentStart = output.length + before.length + open.length;
      output += before + open + inner + close + after;
      contentEnd = output.length - after.length - close.length;
    } else {
      output += segment;
    }
    if (newline < 0) break;
    output += "\n";
    lineStart = newline + 1;
  }
  if (contentStart < 0) return null;
  const changes: ChangeSpec[] = [{ from: start, to: end, insert: output }];
  return backward
    ? { changes, anchor: start + contentEnd, head: start + contentStart }
    : { changes, anchor: start + contentStart, head: start + contentEnd };
}

function toggleRange(state: EditorState, kind: InlineFormatKind, range: SelectionRange): RangeEdit | null {
  if (kind !== "code" && insideCodeBlock(state, range.from)) return null;

  const enclosing = enclosingSpan(state, kind, range);
  if (enclosing) return unwrapEdit(state, enclosing, range);

  if (range.empty) {
    const { open, close } = markersFor(kind, "");
    return {
      changes: [{ from: range.from, insert: open + close }],
      anchor: range.from + open.length,
      head: range.from + open.length,
    };
  }

  const neighbours = inlineFormatSpans(state, kind, range.from, range.to)
    .filter((span) => span.from < range.to && span.to > range.from);
  return wrapEdit(state, kind, range.from, range.to, neighbours, range.head < range.anchor);
}

/** Toggle KIND over every selection range, as one undoable transaction. */
export function toggleInlineFormatSpec(state: EditorState, kind: InlineFormatKind): TransactionSpec | null {
  let changed = false;
  const spec = state.changeByRange((range) => {
    const edit = toggleRange(state, kind, range);
    if (!edit) return { range };
    changed = true;
    return { changes: edit.changes, range: EditorSelection.range(edit.anchor, edit.head) };
  });
  if (!changed) return null;
  return { ...spec, scrollIntoView: true, userEvent: "input.format" };
}

/**
 * Remove every inline format marker that touches each selection range — the
 * spans inside it and the ones it starts or ends in. A bare caret clears the
 * spans it sits inside.
 */
export function clearInlineFormatSpec(state: EditorState): TransactionSpec | null {
  let changed = false;
  const spec = state.changeByRange((range) => {
    const spans = INLINE_FORMAT_KINDS.flatMap((kind) => inlineFormatSpans(state, kind, range.from, range.to))
      .filter((span) => (
        range.empty
          ? range.from > span.from && range.from < span.to
          : span.from < range.to && span.to > range.from
      ));
    const changes = markerDeletions(spans);
    if (changes.length === 0) return { range };
    changed = true;
    const set = state.changes(changes);
    return {
      changes,
      range: EditorSelection.range(set.mapPos(range.anchor, range.anchor <= range.head ? -1 : 1), set.mapPos(range.head, range.anchor <= range.head ? 1 : -1)),
    };
  });
  if (!changed) return null;
  return { ...spec, scrollIntoView: true, userEvent: "input.format" };
}

/** The formats active over the main selection, for toolbar state. */
export function activeInlineFormats(state: EditorState): Set<InlineFormatKind> {
  const range = state.selection.main;
  const active = new Set<InlineFormatKind>();
  for (const kind of INLINE_FORMAT_KINDS) {
    if (enclosingSpan(state, kind, range)) active.add(kind);
  }
  return active;
}
