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
  const marker = "#".repeat(level);
  const allAtLevel = targets.every((line) => ATX_RE.exec(line.text)?.[2] === marker);
  const changes: ChangeSpec[] = [];
  for (const line of targets) {
    const match = ATX_RE.exec(line.text);
    const oldLength = match?.[0].length ?? 0;
    const indent = match?.[1] ?? "";
    const prefix = allAtLevel ? indent : `${indent}${marker} `;
    const change = replacePrefix(line, oldLength, prefix);
    if (change) changes.push(change);
  }
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
  for (const line of targets) {
    const match = ATX_RE.exec(line.text);
    const level = match ? (match[2] ?? "").length : 0;
    const next = delta < 0
      ? (level === 0 ? 6 : Math.max(1, level - 1))
      : (level === 0 ? 0 : level === 6 ? 0 : level + 1);
    if (next === level) continue;
    const indent = match?.[1] ?? "";
    const change = replacePrefix(line, match?.[0].length ?? 0, next === 0 ? indent : `${indent}${"#".repeat(next)} `);
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
export function toggleListSpec(state: EditorState, kind: ListKind): TransactionSpec | null {
  const lines = selectedLines(state);
  const targets = lines.length > 1 ? lines.filter((line) => line.text.trim()) : lines;
  if (targets.length === 0) return null;
  const parsed = targets.map((line) => {
    const quote = /^(?:\s{0,3}>[ \t]?)*/u.exec(line.text)?.[0] ?? "";
    const rest = line.text.slice(quote.length);
    const match = LIST_RE.exec(rest);
    return { line, quote, match };
  });
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
    // A heading marker cannot follow a list marker on the same line; drop it.
    const heading = match ? null : ATX_RE.exec(line.text.slice(quote.length));
    const headingLength = heading?.[0].length ?? 0;
    const leading = match ? indent : (/^[ \t]*/u.exec(line.text.slice(quote.length))?.[0] ?? "");
    const prefix = `${quote}${leading}${listMarker(kind, ordinal, checked, match)}`;
    const replaceLength = match ? oldLength : quote.length + Math.max(headingLength, leading.length);
    const change = replacePrefix(line, replaceLength, prefix);
    if (change) changes.push(change);
  }
  return withMappedSelection(state, changes);
}
