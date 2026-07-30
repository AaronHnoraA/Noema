/**
 * Heading folding for aaronnote.
 *
 * Reuses the incremental tocIndexField (toc-index.ts) — zero new document scanning.
 * Only headings with source === "markdown" are foldable.
 *
 * Chevron widget:
 * - Inline <span> positioned into the left margin.
 * - Zero vertical height — bare WidgetType (no MeasuredWidget per CLAUDE.md).
 * - Invisible by default; shown on heading line hover via CSS.
 *
 * Fold commands: fold-heading, unfold-heading, toggle-fold,
 *                fold-all-headings, unfold-all-headings
 * vim-lite: zc, zo, za, zM, zR
 */
import { codeFolding, foldEffect, foldedRanges, foldService, foldState, unfoldEffect } from "@codemirror/language";
import { RangeSetBuilder, Transaction, type EditorState, type Extension } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { tocIndexFromState, type MarkdownHeading } from "./toc-index.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface HeadingWithLine extends MarkdownHeading {
  lineNumber: number;
}

type HeadingFoldEntry = {
  key: string;
  heading: HeadingWithLine;
  range: { from: number; to: number };
};

function markdownHeadingsWithLines(state: EditorState): HeadingWithLine[] {
  const index = tocIndexFromState(state);
  return index.headings
    .filter((h) => h.source === "markdown")
    .map((h) => ({
      ...h,
      lineNumber: state.doc.lineAt(h.markerFrom ?? h.pos).number,
    }));
}

function foldRangeForHeading(
  headings: HeadingWithLine[],
  h: HeadingWithLine,
  doc: EditorView["state"]["doc"],
): { from: number; to: number } | null {
  const headingLine = doc.line(h.lineNumber);
  let end = doc.line(doc.lines).to;

  for (const other of headings) {
    if (other === h || other.lineNumber <= h.lineNumber) continue;
    if ((other.renderLevel ?? other.level) <= (h.renderLevel ?? h.level)) {
      end = doc.line(other.lineNumber - 1).to;
      break;
    }
  }

  if (end <= headingLine.to) return null;
  return { from: headingLine.to, to: end };
}

function headingFoldKeys(headings: readonly HeadingWithLine[]): string[] {
  const counts = new Map<string, number>();
  const stack: Array<{ level: number; ordinal: number }> = [];
  return headings.map((heading) => {
    const level = heading.renderLevel ?? heading.level;
    while (stack.length > 0 && level <= stack[stack.length - 1]!.level) {
      stack.pop();
    }
    const parentPath = stack.map((part) => part.ordinal).join(".");
    const siblingGroup = `${parentPath}|${level}`;
    const ordinal = (counts.get(siblingGroup) ?? 0) + 1;
    counts.set(siblingGroup, ordinal);
    const path = parentPath ? `${parentPath}.${ordinal}` : String(ordinal);
    stack.push({ level, ordinal });
    return `${path}:${level}:${heading.text}`;
  });
}

function headingFoldEntries(state: EditorState): HeadingFoldEntry[] {
  const headings = markdownHeadingsWithLines(state);
  const keys = headingFoldKeys(headings);
  const entries: HeadingFoldEntry[] = [];
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]!;
    const range = foldRangeForHeading(headings, heading, state.doc);
    if (!range) continue;
    entries.push({ key: keys[index]!, heading, range });
  }
  return entries;
}

function foldedRangeMatches(state: EditorState, range: { from: number; to: number }): boolean {
  let found = false;
  foldedRanges(state).between(range.from, range.from, (from, to) => {
    if (from === range.from && to === range.to) found = true;
  });
  return found;
}

function foldedRangeOnLine(state: EditorState, lineFrom: number, lineTo: number): { from: number; to: number } | null {
  let found: { from: number; to: number } | null = null;
  foldedRanges(state).between(lineFrom, lineTo, (from, to) => {
    if (!found || from < found.from) found = { from, to };
  });
  return found;
}

function headingFoldEntryAtCursor(state: EditorState): HeadingFoldEntry | null {
  const pos = state.selection.main.from;
  const line = state.doc.lineAt(pos);
  let best: HeadingFoldEntry | null = null;
  for (const entry of headingFoldEntries(state)) {
    const onHeadingLine = entry.heading.lineNumber === line.number;
    const insideBody = entry.range.from <= pos && pos <= entry.range.to;
    if (!onHeadingLine && !insideBody) continue;
    if (!best || entry.range.from >= best.range.from) best = entry;
  }
  return best;
}

function topLevelHeadingFoldRanges(state: EditorState): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  let foldedUntil = -1;
  for (const entry of headingFoldEntries(state)) {
    if (entry.range.from <= foldedUntil) continue;
    ranges.push(entry.range);
    foldedUntil = entry.range.to;
  }
  return ranges;
}

function foldRanges(view: EditorView, ranges: readonly { from: number; to: number }[]): boolean {
  const effects = ranges
    .filter((range) => !foldedRangeMatches(view.state, range))
    .map((range) => foldEffect.of(range));
  if (effects.length === 0) return false;
  view.dispatch({ effects, annotations: Transaction.addToHistory.of(false) });
  return true;
}

function unfoldRanges(view: EditorView, ranges: readonly { from: number; to: number }[]): boolean {
  if (ranges.length === 0) return false;
  view.dispatch({
    effects: ranges.map((range) => unfoldEffect.of(range)),
    annotations: Transaction.addToHistory.of(false),
  });
  return true;
}

// ---------------------------------------------------------------------------
// foldService — tells CodeMirror how to compute fold ranges for headings
// ---------------------------------------------------------------------------

const headingFoldService = foldService.of((state, lineStart) => {
  const headings = markdownHeadingsWithLines(state);
  const lineNumber = state.doc.lineAt(lineStart).number;
  const h = headings.find((heading) => heading.lineNumber === lineNumber);
  if (!h) return null;
  return foldRangeForHeading(headings, h, state.doc);
});

// ---------------------------------------------------------------------------
// Chevron widget — zero height inline span, CSS-hidden until hover/folded
// ---------------------------------------------------------------------------

class ChevronWidget extends WidgetType {
  lineFrom: number;
  folded: boolean;

  constructor(lineFrom: number, folded: boolean) {
    super();
    this.lineFrom = lineFrom;
    this.folded = folded;
  }

  eq(other: ChevronWidget) {
    return this.lineFrom === other.lineFrom && this.folded === other.folded;
  }

  toDOM(view: EditorView) {
    const span = document.createElement("span");
    span.className = `cm-heading-fold-arrow${this.folded ? " is-folded" : ""}`;
    span.setAttribute("aria-hidden", "true");
    span.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      view.dispatch({ selection: { anchor: this.lineFrom } });
      toggleFoldAtCursor(view);
      view.focus();
    });
    return span;
  }
  ignoreEvent() { return false; }
}

function buildChevronDecos(view: EditorView): DecorationSet {
  const entries = headingFoldEntries(view.state);
  if (entries.length === 0) return Decoration.none;

  const builder = new RangeSetBuilder<Decoration>();
  const { from: vpFrom, to: vpTo } = view.viewport;

  for (const entry of entries) {
    const h = entry.heading;
    const markerPos = h.markerFrom ?? h.pos;
    if (markerPos < vpFrom || markerPos > vpTo) continue;
    const lineStart = view.state.doc.line(h.lineNumber).from;
    const widget = Decoration.widget({
      widget: new ChevronWidget(lineStart, foldedRangeMatches(view.state, entry.range)),
      side: -1,
    });
    builder.add(lineStart, lineStart, widget);
  }

  return builder.finish();
}

const chevronPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) { this.decorations = buildChevronDecos(view); }
    update(update: { docChanged: boolean; viewportChanged: boolean; view: EditorView; startState: EditorState; state: EditorState }) {
      if (
        update.docChanged
        || update.viewportChanged
        || update.startState.field(foldState, false) !== update.state.field(foldState, false)
      ) {
        this.decorations = buildChevronDecos(update.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

export function captureHeadingFoldKeys(state: EditorState): string[] {
  const keys: string[] = [];
  for (const entry of headingFoldEntries(state)) {
    if (foldedRangeMatches(state, entry.range)) keys.push(entry.key);
  }
  return keys;
}

export function restoreHeadingFoldKeys(view: EditorView, keys: readonly string[] | undefined): boolean {
  if (!keys || keys.length === 0) return false;
  const wanted = new Set(keys);
  const ranges = headingFoldEntries(view.state)
    .filter((entry) => wanted.has(entry.key))
    .map((entry) => entry.range);
  return foldRanges(view, ranges);
}

export function foldHeadingAtCursor(view: EditorView): boolean {
  const entry = headingFoldEntryAtCursor(view.state);
  return entry ? foldRanges(view, [entry.range]) : false;
}

export function unfoldHeadingAtCursor(view: EditorView): boolean {
  const line = view.state.doc.lineAt(view.state.selection.main.from);
  const folded = foldedRangeOnLine(view.state, line.from, line.to);
  return folded ? unfoldRanges(view, [folded]) : false;
}

export function toggleFoldAtCursor(view: EditorView): boolean {
  return unfoldHeadingAtCursor(view) || foldHeadingAtCursor(view);
}

export function foldAllHeadings(view: EditorView): boolean {
  return foldRanges(view, topLevelHeadingFoldRanges(view.state));
}

export function unfoldAllHeadings(view: EditorView): boolean {
  const ranges: Array<{ from: number; to: number }> = [];
  foldedRanges(view.state).between(0, view.state.doc.length, (from, to) => {
    ranges.push({ from, to });
  });
  return unfoldRanges(view, ranges);
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export const headingFoldExtension: Extension = [
  codeFolding(),
  headingFoldService,
  chevronPlugin,
];
