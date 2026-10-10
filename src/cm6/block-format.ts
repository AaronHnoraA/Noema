/**
 * Block-level format commands: heading level, blockquote and list kind.
 *
 * Each applies to every line a selection range touches and toggles, the way
 * MarkText (`paragraphFrontMenu`/`format` "paragraph" commands) and Typora do:
 * running a format a line already has turns it back into a plain paragraph,
 * and a mixed selection is brought to the requested format first.
 *
 *   - headings: `#`…`######`; the same level again removes the marker;
 *   - blockquote: adds one `> ` level to every line, or removes one when every
 *     non-blank line is already quoted;
 *   - lists: bullet, ordered (numbered from 1 in selection order) and task;
 *     converting between them keeps indentation and an existing task's
 *     checked state.
 *
 * Changes preserve the caret's place in the text instead of jumping to the
 * line end, so a heading or list toggle never moves what the author is typing.
 */

import {
  EditorSelection,
  type ChangeSpec,
  type EditorState,
  type Line,
  type TransactionSpec,
} from "@codemirror/state";

export type ListKind = "bullet" | "ordered" | "task";

const ATX_RE = /^(\s{0,3})(#{1,6})(?:[ \t]+|$)/u;
const QUOTE_RE = /^(\s{0,3})>[ \t]?/u;
const LIST_RE = /^([ \t]*)(?:([-*+])|(\d{1,9})([.)]))[ \t]+(?:\[([ xX])\](?:[ \t]+|$))?/u;
/** Quote markers and a list marker (with task box) that contain a line's block. */
const CONTAINER_RE = /^(?:[ \t]{0,3}>[ \t]?)*(?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?)?/u;

type HeadingParts = { from: number; markLength: number; indent: string; level: number };

/**
 * The heading inside a line's containers. A heading command changes only the
 * block the caret is in, as MarkText's `updateParagraph` does: `> # T` keeps
 * its quote and `- item` stays a list item (`- ## item`) instead of becoming
 * `# > # T` or `## - item`.
 */
function headingParts(line: Line): HeadingParts {
  const container = CONTAINER_RE.exec(line.text)?.[0] ?? "";
  const match = ATX_RE.exec(line.text.slice(container.length));
  return {
    from: line.from + container.length,
    markLength: match?.[0].length ?? 0,
    indent: match?.[1] ?? "",
    level: match ? (match[2] ?? "").length : 0,
  };
}

function setHeadingLevel(state: EditorState, parts: HeadingParts, level: number): ChangeSpec | null {
  const insert = level === 0 ? parts.indent : `${parts.indent}${"#".repeat(level)} `;
  if (state.doc.sliceString(parts.from, parts.from + parts.markLength) === insert) return null;
  return { from: parts.from, to: parts.from + parts.markLength, insert };
}

/** Lines touched by the selection; a range ending at a line start excludes that line. */
function selectedLines(state: EditorState): Line[] {
  const seen = new Set<number>();
  const lines: Line[] = [];
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from);
    const endPos = range.to > range.from && state.doc.lineAt(range.to).from === range.to ? range.to - 1 : range.to;
    const last = state.doc.lineAt(Math.max(range.from, endPos));
    for (let number = first.number; number <= last.number; number++) {
      if (seen.has(number)) continue;
      seen.add(number);
      lines.push(state.doc.line(number));
    }
  }
  return lines.sort((a, b) => a.number - b.number);
}

/** Keep the selection on the same text across the line rewrites. */
function withMappedSelection(state: EditorState, changes: ChangeSpec[]): TransactionSpec | null {
  if (changes.length === 0) return null;
  const set = state.changes(changes);
  const selection = EditorSelection.create(
    state.selection.ranges.map((range) => (
      range.empty
        ? EditorSelection.cursor(set.mapPos(range.head, 1))
        : EditorSelection.range(set.mapPos(range.anchor, range.anchor <= range.head ? -1 : 1), set.mapPos(range.head, range.anchor <= range.head ? 1 : -1))
    )),
    state.selection.mainIndex,
  );
  return { changes: set, selection, scrollIntoView: true, userEvent: "input.format" };
}

function replacePrefix(line: Line, oldLength: number, prefix: string): ChangeSpec | null {
  if (line.text.slice(0, oldLength) === prefix) return null;
  return { from: line.from, to: line.from + oldLength, insert: prefix };
}

/** Set every selected line to heading LEVEL, or back to text when all already are. */
export function toggleHeadingSpec(state: EditorState, level: number): TransactionSpec | null {
  const lines = selectedLines(state);
  const targets = lines.length > 1 ? lines.filter((line) => line.text.trim()) : lines;
  if (targets.length === 0) return null;
  const parts = targets.map(headingParts);
  const allAtLevel = parts.every((part) => part.level === level);
  const changes = parts.flatMap((part) => setHeadingLevel(state, part, allAtLevel ? 0 : level) ?? []);
  return withMappedSelection(state, changes);
}

/**
 * Move every selected heading one level up (DELTA -1) or down (+1), as
 * MarkText's "upgrade/degrade heading": text promotes to `######`, `#` stays,
 * and `######` demotes back to text.
 */
export function changeHeadingLevelSpec(state: EditorState, delta: -1 | 1): TransactionSpec | null {
  const lines = selectedLines(state);
  const targets = lines.length > 1 ? lines.filter((line) => line.text.trim()) : lines;
  const changes: ChangeSpec[] = [];
  for (const part of targets.map(headingParts)) {
    const next = delta < 0
      ? (part.level === 0 ? 6 : Math.max(1, part.level - 1))
      : (part.level === 0 || part.level === 6 ? 0 : part.level + 1);
    if (next === part.level) continue;
    const change = setHeadingLevel(state, part, next);
    if (change) changes.push(change);
  }
  return withMappedSelection(state, changes);
}

/** Add one quote level to every selected line, or remove one when all are quoted. */
export function toggleBlockquoteSpec(state: EditorState): TransactionSpec | null {
  const lines = selectedLines(state);
  const content = lines.filter((line) => line.text.trim());
  const allQuoted = content.length > 0 && content.every((line) => QUOTE_RE.test(line.text));
  const changes: ChangeSpec[] = [];
  for (const line of lines) {
    if (allQuoted) {
      const match = QUOTE_RE.exec(line.text);
      if (match) changes.push({ from: line.from, to: line.from + match[0].length, insert: match[1] ?? "" });
      continue;
    }
    // A blank line inside a multi-line selection stays part of the quote.
    changes.push({ from: line.from, insert: line.text.trim() ? "> " : ">" });
  }
  return withMappedSelection(state, changes);
}

function listMarker(kind: ListKind, ordinal: number, checked: boolean, previous: RegExpExecArray | null): string {
  if (kind === "ordered") return `${ordinal}${previous?.[4] ?? "."} `;
  const bullet = previous?.[2] ?? "-";
  if (kind === "task") return `${bullet} [${checked ? "x" : " "}] `;
  return `${bullet} `;
}

function listKindOf(match: RegExpExecArray | null): ListKind | null {
  if (!match) return null;
  if (match[5] != null) return "task";
  return match[3] != null ? "ordered" : "bullet";
}

/**
 * Turn every selected line into a KIND list item, or back into text when all
 * already are. Quote prefixes stay outside the list marker.
 */
type ParsedListLine = { line: Line; quote: string; match: RegExpExecArray | null };

function parseListLine(line: Line): ParsedListLine {
  const quote = /^(?:\s{0,3}>[ \t]?)*/u.exec(line.text)?.[0] ?? "";
  return { line, quote, match: LIST_RE.exec(line.text.slice(quote.length)) };
}

function indentWidth(text: string): number {
  let width = 0;
  for (const char of text) width += char === "\t" ? 4 : 1;
  return width;
}

/** Same list: same quote depth, indentation and marker family. */
function sameList(a: ParsedListLine, b: ParsedListLine): boolean {
  if (!a.match || !b.match || a.quote.trim() !== b.quote.trim()) return false;
  if (indentWidth(a.match[1] ?? "") !== indentWidth(b.match[1] ?? "")) return false;
  return a.match[2] ? a.match[2] === b.match[2] : a.match[4] === b.match[4];
}

/**
 * Every item of the list ITEM belongs to, at its own level. Continuation
 * lines, nested items and the blank lines of a loose list are crossed; a
 * shallower line or a different list ends it.
 */
function siblingListItems(state: EditorState, item: ParsedListLine): ParsedListLine[] {
  const base = indentWidth(item.match?.[1] ?? "");
  const collect = (step: -1 | 1): ParsedListLine[] => {
    const found: ParsedListLine[] = [];
    for (let number = item.line.number + step; number >= 1 && number <= state.doc.lines; number += step) {
      const parsed = parseListLine(state.doc.line(number));
      const body = parsed.line.text.slice(parsed.quote.length);
      if (parsed.quote.trim() !== item.quote.trim() && body.trim()) break;
      if (!body.trim()) continue;
      if (sameList(parsed, item)) { found.push(parsed); continue; }
      if (indentWidth(/^[ \t]*/u.exec(body)![0]) > base) continue;
      break;
    }
    return found;
  };
  return [...collect(-1).reverse(), item, ...collect(1)];
}

export function toggleListSpec(state: EditorState, kind: ListKind): TransactionSpec | null {
  const lines = selectedLines(state);
  const targets = lines.length > 1 ? lines.filter((line) => line.text.trim()) : lines;
  if (targets.length === 0) return null;
  let parsed = targets.map(parseListLine);
  // Inside one list, the command is about that list: MarkText converts or
  // unwraps the list at the caret (`_closestListAtCursor`), and so does
  // Typora. Converting only the selected items split one list into several.
  if (parsed.every(({ match }) => match) && parsed.every((entry) => sameList(entry, parsed[0]!))) {
    const siblings = siblingListItems(state, parsed[0]!);
    const siblingLines = new Set(siblings.map((sibling) => sibling.line.number));
    if (parsed.every((entry) => siblingLines.has(entry.line.number))) parsed = siblings;
  }
  const allKind = parsed.every(({ match }) => listKindOf(match) === kind);
  const changes: ChangeSpec[] = [];
  let ordinal = 0;
  for (const { line, quote, match } of parsed) {
    const oldLength = quote.length + (match?.[0].length ?? 0);
    const indent = match?.[1] ?? "";
    if (allKind) {
      const change = replacePrefix(line, oldLength, `${quote}${indent}`);
      if (change) changes.push(change);
      continue;
    }
    ordinal += 1;
    const checked = (match?.[5] ?? " ").toLowerCase() === "x";
    // A heading stays a heading inside the new item (`- # Title`), as
    // MarkText's list wrap keeps the wrapped block.
    const leading = match ? indent : (/^[ \t]*/u.exec(line.text.slice(quote.length))?.[0] ?? "");
    const prefix = `${quote}${leading}${listMarker(kind, ordinal, checked, match)}`;
    const replaceLength = match ? oldLength : quote.length + leading.length;
    const change = replacePrefix(line, replaceLength, prefix);
    if (change) changes.push(change);
  }
  return withMappedSelection(state, changes);
}

/**
 * Check or uncheck the task items among the selected lines. One unchecked
 * item makes the command check them all, so a mixed selection settles in one
 * step instead of inverting line by line; lines that are not tasks are left
 * alone, and null means there was no task to toggle.
 */
export function toggleTaskCheckSpec(state: EditorState): TransactionSpec | null {
  const tasks = selectedLines(state).map(parseListLine).filter((item) => item.match?.[5] != null);
  if (tasks.length === 0) return null;
  const mark = tasks.some((item) => item.match![5] === " ") ? "x" : " ";
  const changes: ChangeSpec[] = [];
  for (const { line, quote, match } of tasks) {
    if (match![5]!.toLowerCase() === mark) continue;
    const box = line.from + quote.length + match![0].lastIndexOf("[") + 1;
    changes.push({ from: box, to: box + 1, insert: mark });
  }
  return withMappedSelection(state, changes);
}
