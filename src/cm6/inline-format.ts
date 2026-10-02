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
 *   - a soft-wrapped paragraph gets one marker pair across its lines; a
 *     selection crossing blocks is wrapped line by line after block prefixes;
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
  type Text,
  type SelectionRange,
  type TransactionSpec,
} from "@codemirror/state";
import { syntaxTree, syntaxTreeAvailable } from "@codemirror/language";
import type { Tree } from "@lezer/common";
import { markdownInlineContext } from "./languages/markdown/index.ts";

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
const NON_TEXT_BLOCK_NODES = new Set([...CODE_BLOCK_NODES, "Table", "HorizontalRule"]);

/**
 * The block prefix a line's inline content starts after: indentation, quote
 * markers, an ATX heading marker, or a list marker with an optional task box.
 */
const BLOCK_PREFIX_RE = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/u;

/** Fence intervals are built once per immutable document, then queried cheaply. */
const fenceCache = new WeakMap<Text, Array<{ from: number; to: number }>>();

function fencedRanges(doc: Text): Array<{ from: number; to: number }> {
  const cached = fenceCache.get(doc);
  if (cached) return cached;
  const ranges: Array<{ from: number; to: number }> = [];
  let open: { from: number; char: string; length: number; list: boolean } | null = null;
  let offset = 0;
  for (const line of doc.iterLines()) {
    const ordinary: RegExpExecArray | null = /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/u.exec(line);
    const listed: RegExpExecArray | null = ordinary ? null
      : /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?[ \t]{0,3}(`{3,}|~{3,})([^\n]*)$/u.exec(line);
    const continued: RegExpExecArray | null = open?.list && !ordinary && !listed
      ? /^(?:[ \t]{0,3}>[ \t]?)*[ \t]{0,7}(`{3,}|~{3,})([ \t]*)$/u.exec(line)
      : null;
    const candidate: RegExpExecArray | null = ordinary ?? listed ?? continued;
    if (candidate) {
      const marker: string = candidate[1]!;
      const rest = candidate[2]!.trim();
      if (open) {
        if (marker[0] === open.char && marker.length >= open.length && !rest) {
          ranges.push({ from: open.from, to: offset + line.length });
          open = null;
        }
      } else if (marker[0] !== "`" || !rest.includes("`")) {
        open = { from: offset, char: marker[0]!, length: marker.length, list: Boolean(listed) };
      }
    }
    offset += line.length + 1;
  }
  if (open) ranges.push({ from: open.from, to: doc.length });
  fenceCache.set(doc, ranges);
  return ranges;
}

function formatContext(state: EditorState, from: number, to: number) {
  let start = from;
  let end = to;
  if (!syntaxTreeAvailable(state, to)) {
    const ranges = fencedRanges(state.doc);
    for (const pos of [from, to]) {
      let low = 0;
      let high = ranges.length;
      while (low < high) {
        const mid = (low + high) >>> 1;
        if (ranges[mid]!.to < pos) low = mid + 1;
        else high = mid;
      }
      const fence = ranges[low];
      if (fence && fence.from <= pos) {
        start = Math.min(start, fence.from);
        end = Math.max(end, fence.to);
      }
    }
  }
  return markdownInlineContext(state, start, end);
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
  const spans: InlineFormatSpan[] = [];
  const { tree, base } = formatContext(state, lo, hi);
  if (kind === "highlight") {
    for (let number = doc.lineAt(lo).number; number <= doc.lineAt(hi).number; number++) {
      const line = doc.line(number);
      if (insideCodeBlock(state, line.from + Math.min(1, line.length))) continue;
      const codes = codeRangesIn(tree, line.from - base, line.to - base)
        .map((range) => ({ from: base + range.from, to: base + range.to }));
      spans.push(...highlightSpansInLine(line.text, line.from, codes));
    }
    return spans;
  }
  const { node: nodeName, mark } = TREE_FORMATS[kind];
  tree.iterate({
    from: lo - base,
    to: hi - base,
    enter(node) {
      if (CODE_BLOCK_NODES.has(node.name)) return false;
      if (node.name !== nodeName) return;
      const open = node.node.firstChild;
      const close = node.node.lastChild;
      if (!open || !close || open.name !== mark || close.name !== mark || open.from === close.from) return;
      spans.push({ kind, from: base + node.from, to: base + node.to,
        contentFrom: base + open.to, contentTo: base + close.from });
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
  const parsed = syntaxTree(state);
  if (parsed.length > pos) {
    for (let node: ReturnType<Tree["resolveInner"]> | null = parsed.resolveInner(pos, -1); node; node = node.parent) {
      if (CODE_BLOCK_NODES.has(node.name)) return true;
    }
    return false;
  }
  const ranges = fencedRanges(state.doc);
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (ranges[mid]!.to < pos) low = mid + 1;
    else high = mid;
  }
  if (low < ranges.length && ranges[low]!.from <= pos) return true;
  const line = state.doc.lineAt(pos);
  return /^[ \t]{4,}\S/u.test(line.text) && (line.number === 1 || !state.doc.line(line.number - 1).text.trim());
}

/** A format over whole blocks must not turn a fence, table or rule into text. */
function selectionIntersectsNonTextBlock(state: EditorState, from: number, to: number): boolean {
  if (insideCodeBlock(state, from) || insideCodeBlock(state, to > from ? to - 1 : to)) return true;
  if (from === to) return false;
  if (!syntaxTreeAvailable(state, to)) {
    const ranges = fencedRanges(state.doc);
    let low = 0;
    let high = ranges.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (ranges[mid]!.to <= from) low = mid + 1;
      else high = mid;
    }
    if (low < ranges.length && ranges[low]!.from < to) return true;
  }
  const { tree, base } = markdownInlineContext(state, from, to);
  const localFrom = from - base;
  const localTo = to - base;
  let inOneCell = false;
  for (let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(localFrom, 1); node; node = node.parent) {
    if (node.name === "TableCell" && node.to >= localTo) { inOneCell = true; break; }
  }
  let blocked = false;
  tree.iterate({
    from: localFrom,
    to: localTo,
    enter(node) {
      if (node.from >= localTo || node.to <= localFrom) return false;
      if (node.name === "Table" && inOneCell) return false;
      if (NON_TEXT_BLOCK_NODES.has(node.name)) { blocked = true; return false; }
    },
  });
  return blocked;
}

/** MarkText formats each text leaf while preserving intervening block syntax. */
function formattableSelections(state: EditorState, range: SelectionRange): SelectionRange[] {
  const { tree, base } = formatContext(state, range.from, range.to);
  const selections: SelectionRange[] = [];
  tree.iterate({
    from: range.from - base,
    to: range.to - base,
    enter(node) {
      if (CODE_BLOCK_NODES.has(node.name)) return false;
      const heading = /^(?:ATX|Setext)Heading[1-6]?$/u.test(node.name);
      if (!heading && node.name !== "Paragraph" && node.name !== "TableCell") return;
      let from = Math.max(range.from, base + node.from);
      let to = Math.min(range.to, base + node.to);
      if (heading) {
        const marks = node.node.getChildren("HeaderMark");
        for (const mark of marks) {
          if (mark.from === node.from) from = Math.max(from, base + mark.to);
          else to = Math.min(to, base + mark.from);
        }
      }
      const text = state.doc.sliceString(from, Math.max(from, to));
      from += text.length - text.trimStart().length;
      to -= text.length - text.trimEnd().length;
      if (from < to) selections.push(EditorSelection.range(from, to));
      return false;
    },
  });
  return selections;
}

function insideInlineCode(state: EditorState, pos: number): boolean {
  const { tree, base } = markdownInlineContext(state, pos);
  const local = pos - base;
  let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(local, -1);
  for (; node; node = node.parent) {
    if (node.name === "InlineCode" && node.from < local && local < node.to) return true;
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

/** Spans that cover every selected line's text; empty lines need no marker. */
function selectedFormatSpans(state: EditorState, kind: InlineFormatKind, range: SelectionRange): InlineFormatSpan[] | null {
  const doc = state.doc;
  const spans = inlineFormatSpans(state, kind, range.from, range.to);
  if (spans.length === 0) return null;
  const selected = new Map<string, InlineFormatSpan>();
  let spanIndex = 0;
  for (let number = doc.lineAt(range.from).number; number <= doc.lineAt(range.to).number; number++) {
    const line = doc.line(number);
    let start = Math.max(range.from, line.from);
    let end = Math.min(range.to, line.to);
    if (start === line.from) start += (line.text.match(BLOCK_PREFIX_RE)?.[0] ?? "").length;
    if (start >= end) continue;
    const segment = doc.sliceString(start, end);
    start += segment.length - segment.trimStart().length;
    end -= segment.length - segment.trimEnd().length;
    if (start >= end) continue;
    while (spanIndex < spans.length && spans[spanIndex]!.to <= start) spanIndex++;
    const covering = spans[spanIndex];
    if (!covering || covering.from > start || covering.to < end) return null;
    selected.set(`${covering.from}:${covering.to}`, covering);
  }
  return selected.size === 0 ? null : [...selected.values()];
}

function unwrapSelectedLines(state: EditorState, kind: InlineFormatKind, range: SelectionRange): RangeEdit | null {
  const spans = selectedFormatSpans(state, kind, range);
  if (!spans) return null;
  const changes = markerDeletions(spans);
  const set = state.changes(changes);
  const forward = range.anchor <= range.head;
  return {
    changes,
    anchor: set.mapPos(range.anchor, forward ? -1 : 1),
    head: set.mapPos(range.head, forward ? 1 : -1),
  };
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
  let start = from;
  let end = to;
  for (const span of spans) {
    start = Math.min(start, span.from);
    end = Math.max(end, span.to);
  }
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

  // In one paragraph a soft break belongs to the same inline token. Wrap it
  // once, as MarkText does for a block's text, instead of writing a pair of
  // markers on every visual line. Container boundaries still use the
  // line-by-line path below.
  if (text.includes("\n") && ["bold", "italic", "strike", "code"].includes(kind)) {
    const { tree, base } = markdownInlineContext(state, start, end);
    const localStart = start - base;
    const localEnd = end - base;
    for (let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(localStart, 1); node; node = node.parent) {
      if (node.name !== "Paragraph" || node.from > localStart || node.to < localEnd) continue;
      const lead = text.length - text.trimStart().length;
      const trail = text.length - text.trimEnd().length;
      const inner = text.slice(lead, text.length - trail);
      if (!inner) break;
      const { open, close } = markersFor(kind, inner);
      const output = text.slice(0, lead) + open + inner + close + text.slice(text.length - trail);
      const changes: ChangeSpec[] = [{ from: start, to: end, insert: output }];
      return backward
        ? { changes, anchor: start + output.length - trail - close.length, head: start + lead + open.length }
        : { changes, anchor: start + lead + open.length, head: start + output.length - trail - close.length };
    }
  }

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

/** Inline constructs a format must wrap whole, never split. */
const ATOMIC_INLINE_NODES = new Set(["Link", "Image", "Autolink", "InlineCode", "InlineMath", "HTMLTag"]);

/**
 * Widen [from, to) so neither end splits a link, image, code span or formula.
 *
 * Wrapping `see [do` in `**` produced `**see [do**cs](u)`, which renders as
 * neither bold nor a link. MarkText formats inside tokens only; Typora
 * extends the selection over the link. Noema extends it.
 */
function expandOverAtomicInlines(state: EditorState, from: number, to: number): { from: number; to: number } {
  const { tree, base } = markdownInlineContext(state, from, to);
  const localFrom = from - base;
  const localTo = to - base;
  let start = from;
  let end = to;
  for (let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(localFrom, 1); node; node = node.parent) {
    if (ATOMIC_INLINE_NODES.has(node.name) && node.from < localFrom && node.to > localFrom) start = Math.min(start, base + node.from);
  }
  for (let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(localTo, -1); node; node = node.parent) {
    if (ATOMIC_INLINE_NODES.has(node.name) && node.from < localTo && node.to > localTo) end = Math.max(end, base + node.to);
  }
  return { from: start, to: end };
}

function toggleTextRange(state: EditorState, kind: InlineFormatKind, range: SelectionRange): RangeEdit | null {
  if (!inlineFormatAvailable(state, kind, range)) return null;

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

  const selectedLines = unwrapSelectedLines(state, kind, range);
  if (selectedLines) return selectedLines;

  const { from, to } = expandOverAtomicInlines(state, range.from, range.to);
  const neighbours = inlineFormatSpans(state, kind, from, to)
    .filter((span) => span.from < to && span.to > from);
  return wrapEdit(state, kind, from, to, neighbours, range.head < range.anchor);
}

function rangeHasFormat(state: EditorState, kind: InlineFormatKind, range: SelectionRange): boolean {
  return Boolean(enclosingSpan(state, kind, range) || (!range.empty && selectedFormatSpans(state, kind, range)));
}

function toggleRange(state: EditorState, kind: InlineFormatKind, range: SelectionRange): RangeEdit | null {
  if (range.empty || !selectionIntersectsNonTextBlock(state, range.from, range.to)) {
    return toggleTextRange(state, kind, range);
  }
  const selections = formattableSelections(state, range);
  if (selections.length === 0) return null;
  const active = selections.map((selection) => rangeHasFormat(state, kind, selection));
  const remove = active.every(Boolean);
  const entries = selections.map((selection, index) => ({
    selection,
    edit: remove || !active[index] ? toggleTextRange(state, kind, selection) : null,
  }));
  const changes = entries.flatMap((entry) => entry.edit?.changes ?? []);
  if (changes.length === 0) return null;
  const combined = state.changes(changes);
  const boundary = (entry: typeof entries[number], end: boolean): number => {
    if (!entry.edit) return combined.mapPos(end ? entry.selection.to : entry.selection.from, end ? 1 : -1);
    const own = state.changes(entry.edit.changes);
    const shift = combined.mapPos(entry.selection.from, -1) - own.mapPos(entry.selection.from, -1);
    return (end ? entry.edit.head : entry.edit.anchor) + shift;
  };
  const from = boundary(entries[0]!, false);
  const to = boundary(entries[entries.length - 1]!, true);
  return range.anchor <= range.head ? { changes, anchor: from, head: to } : { changes, anchor: to, head: from };
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
  const selections = !range.empty && selectionIntersectsNonTextBlock(state, range.from, range.to)
    ? formattableSelections(state, range) : [range];
  for (const kind of INLINE_FORMAT_KINDS) {
    if (selections.length > 0 && selections.every((selection) => rangeHasFormat(state, kind, selection))) active.add(kind);
  }
  return active;
}

/**
 * Whether the main selection contains formattable text. A mixed selection
 * applies to its text leaves; a selection wholly in code has no such target.
 */
export function inlineFormatsAvailable(state: EditorState): boolean {
  const range = state.selection.main;
  return !selectionIntersectsNonTextBlock(state, range.from, range.to)
    || (!range.empty && formattableSelections(state, range).length > 0);
}

/** A caret inside inline code can only toggle the code span itself. */
export function inlineFormatAvailable(
  state: EditorState,
  kind: InlineFormatKind,
  range: SelectionRange = state.selection.main,
): boolean {
  if (selectionIntersectsNonTextBlock(state, range.from, range.to)
      && (range.empty || formattableSelections(state, range).length === 0)) return false;
  return kind === "code" || !range.empty || !insideInlineCode(state, range.from);
}

/**
 * Where Tab leaves an inline span when the caret sits at the end of its
 * content: past `**`, `` ` ``, `==`, `\)`, or a link's `](url)`. MarkText's
 * `ParagraphContent.tabHandler` jumps over the closing format the same way,
 * so typing can continue after a span whose markers live preview hides.
 * Returns null when the caret is not at such an end.
 */
export function inlineFormatExitTarget(state: EditorState, pos: number): number | null {
  let best: { to: number; size: number } | null = null;
  const consider = (closeFrom: number, to: number, from: number): void => {
    if (closeFrom !== pos || to <= pos) return;
    if (!best || to - from < best.size) best = { to, size: to - from };
  };
  for (const kind of INLINE_FORMAT_KINDS) {
    for (const span of inlineFormatSpans(state, kind, pos, pos)) {
      if (span.contentTo < span.to) consider(span.contentTo, span.to, span.from);
    }
  }
  const { tree, base } = formatContext(state, pos, pos);
  for (let node: ReturnType<Tree["resolveInner"]> | null = tree.resolveInner(pos - base, -1); node; node = node.parent) {
    if (node.name === "Link" || node.name === "Image") {
      const marks = node.getChildren("LinkMark");
      const close = marks.find((mark) => state.doc.sliceString(base + mark.from, base + mark.to) === "]");
      if (close) consider(base + close.from, base + node.to, base + node.from);
    } else if (node.name === "InlineMath" && state.doc.sliceString(base + node.to - 2, base + node.to) === "\\)") {
      consider(base + node.to - 2, base + node.to, base + node.from);
    }
  }
  return (best as { to: number } | null)?.to ?? null;
}
