/**
 * Screen-row geometry: the rows the reader sees, shared by every vertical
 * motion — Vim's `j`/`k` and the editor's ArrowUp/ArrowDown alike.
 *
 * Noema's Vim layer works on what the reader sees, not on raw Markdown source
 * lines: a long paragraph soft-wrapped into five rows is five Vim lines, the
 * way Evil treats a buffer with `visual-line-mode` and
 * `evil-respect-visual-line-mode`.  `j`/`k`, `0`/`^`/`$`, `dd`/`yy`/`cc`, `V`,
 * `D`/`C`/`Y`, `A`/`I` and `f`/`t` all resolve through this module.  The `g`
 * variants (`gj`, `g0`, `g$`, …) keep the source-line meaning.
 *
 * A row is a half-open offset range `[from, to)` of one logical line: `to` is
 * the offset after the row's last character and never includes the newline.
 * Consecutive rows of a line share their boundary offset, so a wrap boundary is
 * ambiguous as a caret position.  The `assoc` argument disambiguates it the way
 * CodeMirror does: `-1` means "the end of the earlier row", `1` means "the start
 * of the later row".  A Normal-mode block cursor on offset `p` covers the
 * character *at* `p`, so it always belongs to the row resolved with `assoc = 1`.
 *
 * Without layout (a detached or hidden editor, or a headless test DOM) rows
 * degrade to logical lines, which keeps keyboard editing usable and keeps the
 * behaviour deterministic under test.  The layout path goes through the
 * `VimRowLayout` interface so tests can substitute a fixed-width wrap model.
 */

import { EditorSelection, type SelectionRange, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { nextGraphemePosition, previousGraphemePosition } from "./text-boundaries.ts";
import { renderedConstructAt } from "./extensions/visual/constructs/registry.ts";

export type VimRowSpan = { from: number; to: number };

/** Source of wrapped-row boundaries.  Only the default implementation measures. */
export interface VimRowLayout {
  /** True when rows can be measured; false degrades every row to its logical line. */
  available(view: EditorView): boolean;
  /** Row containing POS; ASSOC picks the earlier (-1) or later (1) row at a wrap boundary. */
  rowAt(view: EditorView, pos: number, assoc: -1 | 1): VimRowSpan;
  /** Pixel x of POS relative to the content box, for goal columns. */
  xAt(view: EditorView, pos: number): number | null;
  /** Offset on the row containing ROWPOS closest to pixel X. */
  posAtX(view: EditorView, row: VimRowSpan, x: number): number;
}

/** Maximum graphemes probed past a reported row end to find the next row's start. */
const ROW_END_PROBE_LIMIT = 16;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function logicalRow(doc: Text, pos: number): VimRowSpan {
  const line = doc.lineAt(clamp(pos, 0, doc.length));
  return { from: line.from, to: line.to };
}

function measuredStart(view: EditorView, pos: number, assoc: -1 | 1): number {
  return view.moveToLineBoundary(EditorSelection.cursor(pos, assoc), false, true).head;
}

function measuredEnd(view: EditorView, pos: number, assoc: -1 | 1): number {
  return view.moveToLineBoundary(EditorSelection.cursor(pos, assoc), true, true).head;
}

type RowBand = { top: number; bottom: number };

/** Graphemes examined on either side of a row for text that has no height. */
const HIDDEN_RUN_PROBE_LIMIT = 32;

/**
 * The vertical band where the character at POS is drawn.  It is read from the
 * character's own end edge: `coordsAtPos(pos, 1)` is the caret slot before
 * it, and CodeMirror puts that slot at the end of the previous row when POS
 * starts a wrapped row with a widget (an inline formula, an image).
 */
function bandAt(view: EditorView, pos: number): RowBand | null {
  const doc = view.state.doc;
  const coords = pos < doc.lineAt(pos).to
    ? view.coordsAtPos(nextGraphemePosition(doc, pos), -1) ?? view.coordsAtPos(pos, 1)
    : view.coordsAtPos(pos, 1);
  return coords ? { top: coords.top, bottom: coords.bottom } : null;
}

function hasHeight(band: RowBand): boolean {
  return band.bottom - band.top >= 1;
}

/**
 * The vertical band of the row starting at FROM: that of its first character
 * with a height.  Hidden Markdown syntax is laid out as a sliver without one.
 */
function visibleBand(view: EditorView, from: number, to: number): RowBand | null {
  const doc = view.state.doc;
  let fallback: RowBand | null = null;
  let at = from;
  for (let probe = 0; probe <= HIDDEN_RUN_PROBE_LIMIT && at <= to; probe++) {
    const band = bandAt(view, at);
    if (band && hasHeight(band)) return band;
    fallback ??= band;
    if (at >= to) break;
    at = nextGraphemePosition(doc, at);
  }
  return fallback;
}

/**
 * Whether POS is drawn on the row occupying BAND.  A hidden sliver sits at
 * the top of its row, so it belongs there when its top falls inside the band;
 * two characters with a height share a row when they overlap by more than
 * half of the shorter one.
 */
function onBand(view: EditorView, pos: number, band: RowBand): boolean {
  const other = bandAt(view, pos);
  if (!other) return false;
  if (!hasHeight(other)) return other.top >= band.top - 2 && other.top < band.bottom - 2;
  if (!hasHeight(band)) return band.top >= other.top - 2 && band.top < other.bottom - 2;
  const overlap = Math.min(band.bottom, other.bottom) - Math.max(band.top, other.top);
  return overlap > Math.min(band.bottom - band.top, other.bottom - other.top) / 2;
}

export const domRowLayout: VimRowLayout = {
  available(view) {
    const rect = view.contentDOM.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  },

  rowAt(view, pos, assoc) {
    const doc = view.state.doc;
    const line = doc.lineAt(clamp(pos, 0, doc.length));
    let from = measuredStart(view, pos, assoc);
    let to = measuredEnd(view, pos, assoc);
    // CodeMirror attaches the slot before a row-opening widget or hidden
    // marker to the previous row, even with assoc 1.  When the character at
    // POS is drawn below that row, POS opens the next row: it runs from POS to
    // the end of the row CodeMirror reports for the first offset past it.
    if (assoc > 0 && to === pos && from < pos && pos < line.to) {
      const prior = visibleBand(view, from, previousGraphemePosition(doc, pos));
      if (prior && !onBand(view, pos, prior)) {
        let inner = nextGraphemePosition(doc, pos);
        for (let probe = 0; probe < HIDDEN_RUN_PROBE_LIMIT && inner < line.to; probe++) {
          if (measuredStart(view, inner, 1) > from) break;
          inner = nextGraphemePosition(doc, inner);
        }
        from = pos;
        to = Math.max(pos, measuredEnd(view, inner, 1));
      }
    }
    if (from > pos || to < pos) {
      // An answer that misses POS and leaves its line is a measuring failure
      // (the line is outside the rendered viewport, or the DOM is mid-update).
      if (from < line.from || to > line.to) return { from: line.from, to: line.to };
      // One inside the line is hidden Markdown syntax: the `## ` of a heading
      // or the `>` of a quote has no height, and CodeMirror reports the row
      // as starting after it.  POS is on that row all the same.
      from = Math.min(from, pos);
      to = Math.max(to, pos);
    }
    // A replaced block widget may legitimately span several source lines.
    if (from < line.from || to > line.to) return { from, to };
    // CodeMirror's "end of visual line" can stop before a hanging wrap space.
    // Rows must partition the line, so extend TO until it is the next row's
    // start — otherwise that space belongs to no row and stepping over rows
    // makes no progress.  CodeMirror also reports the slot before a widget
    // opening the next row as this row's, so stop at anything drawn below.
    const rowBand = visibleBand(view, from, to);
    for (let probe = 0; probe < ROW_END_PROBE_LIMIT && to < line.to; probe++) {
      if (measuredStart(view, to, 1) !== from) break;
      if (rowBand && !onBand(view, to, rowBand)) break;
      to = nextGraphemePosition(doc, to);
    }
    // Take in what is drawn on the same row but was measured as another one:
    // a hidden marker before the row, or the text after a hidden marker.
    const band = visibleBand(view, from, to);
    if (!band) return { from, to };
    // A measured boundary is taken only when it is itself drawn on this row:
    // a hidden marker opening a wrapped row is measured with the row above.
    for (let probe = 0; probe < HIDDEN_RUN_PROBE_LIMIT && to < line.to; probe++) {
      if (!onBand(view, to, band)) break;
      const end = Math.min(measuredEnd(view, to, 1), line.to);
      to = end > to && onBand(view, previousGraphemePosition(doc, end), band)
        ? end
        : nextGraphemePosition(doc, to);
    }
    for (let probe = 0; probe < HIDDEN_RUN_PROBE_LIMIT && from > line.from; probe++) {
      const previous = previousGraphemePosition(doc, from);
      if (!onBand(view, previous, band)) break;
      const start = Math.max(measuredStart(view, previous, 1), line.from);
      from = start < previous && onBand(view, start, band) ? start : previous;
    }
    return { from, to };
  },

  xAt(view, pos) {
    const coords = view.coordsAtPos(pos, 1);
    if (!coords) return null;
    return coords.left - view.contentDOM.getBoundingClientRect().left;
  },

  posAtX(view, row, x) {
    // A row that opens with hidden syntax has no height at its first offset.
    const band = visibleBand(view, row.from, row.to);
    if (!band) return row.from;
    const rect = view.contentDOM.getBoundingClientRect();
    const hit = view.posAtCoords({ x: rect.left + x, y: (band.top + band.bottom) / 2 }, false);
    return clamp(hit, row.from, row.to);
  },
};

let activeLayout: VimRowLayout = domRowLayout;

/**
 * Replace the row geometry.  Tests use this to model soft wrapping, which a
 * headless DOM cannot lay out; returns a function restoring the previous one.
 */
export function setVimRowLayoutForTesting(layout: VimRowLayout): () => void {
  const previous = activeLayout;
  activeLayout = layout;
  return () => { activeLayout = previous; };
}

export function rowLayoutAvailable(view: EditorView): boolean {
  return activeLayout.available(view);
}

/** The screen row holding POS, or its logical line when nothing can be measured. */
export function screenRowAt(view: EditorView, pos: number, assoc: -1 | 1 = 1): VimRowSpan {
  const doc = view.state.doc;
  const safe = clamp(pos, 0, doc.length);
  if (!activeLayout.available(view)) return logicalRow(doc, safe);
  return activeLayout.rowAt(view, safe, assoc);
}

/** Pixel goal column of POS, or null without layout. */
export function screenColumnAt(view: EditorView, pos: number): number | null {
  return activeLayout.available(view) ? activeLayout.xAt(view, pos) : null;
}

/** Offset closest to pixel X on ROW; the row start when nothing can be measured. */
export function screenPosAtColumn(view: EditorView, row: VimRowSpan, x: number): number {
  return activeLayout.available(view) ? activeLayout.posAtX(view, row, x) : row.from;
}

/**
 * Fixed-width wrap model for tests: every logical line wraps each WIDTH
 * characters, and one character is one pixel.  Real layout wraps at word
 * boundaries, but rows only need to partition lines for Vim's purposes.
 */
export function fixedWidthRowLayout(width: number): VimRowLayout {
  const row = (doc: Text, pos: number, assoc: -1 | 1): VimRowSpan => {
    const line = doc.lineAt(pos);
    const length = line.to - line.from;
    let index = Math.floor((pos - line.from) / width);
    if (assoc < 0 && pos > line.from && (pos - line.from) % width === 0) index -= 1;
    const last = Math.max(0, Math.ceil(length / width) - 1);
    index = clamp(index, 0, last);
    return {
      from: line.from + index * width,
      to: Math.min(line.to, line.from + (index + 1) * width),
    };
  };
  return {
    available: () => true,
    rowAt: (view, pos, assoc) => row(view.state.doc, pos, assoc),
    xAt: (view, pos) => {
      const r = row(view.state.doc, pos, 1);
      return pos - r.from;
    },
    posAtX: (_view, span, x) => clamp(span.from + Math.round(x), span.from, span.to),
  };
}

// ---------------------------------------------------------------------------
// Visual rows: screen rows, with a block object counted as one row
// ---------------------------------------------------------------------------

/** A row as vertical motion sees it: a screen row, or a whole block object. */
export type VisualRow = VimRowSpan & {
  /** The row starts its source line (or is a block object). */
  lineStart: boolean;
  /** The row ends its source line (or is a block object). */
  lineEnd: boolean;
  /** Logical (source-line) rows instead of screen rows. */
  logical: boolean;
};

/**
 * The block drawn at POS, if any: a display formula, a diagram, a folded code
 * block, a metadata cover, a table — one row to every vertical motion, as the
 * reader sees it. Structure that opens where the caret lands (a table) is no
 * longer drawn once the caret is there, and is then moved through as text.
 */
export function drawnBlockAt(view: EditorView, pos: number): (VimRowSpan & { structure: boolean }) | null {
  const construct = renderedConstructAt(view, pos);
  return construct?.block
    ? { from: construct.from, to: construct.to, structure: construct.role === "structure" }
    : null;
}

/** The visual row holding POS; ASSOC picks the earlier (-1) or later (1) row at a wrap. */
export function visualRowAt(view: EditorView, pos: number, assoc: -1 | 1 = 1, logical = false): VisualRow {
  const doc = view.state.doc;
  const safe = clamp(pos, 0, doc.length);
  const line = doc.lineAt(safe);
  const object = drawnBlockAt(view, assoc < 0 && safe > line.from ? safe - 1 : safe);
  if (object) return { from: object.from, to: object.to, lineStart: true, lineEnd: true, logical };
  const row = logical ? logicalRow(doc, safe) : screenRowAt(view, safe, assoc);
  return {
    from: row.from,
    to: row.to,
    lineStart: row.from === doc.lineAt(row.from).from,
    lineEnd: row.to === doc.lineAt(row.to).to,
    logical,
  };
}

/** The visual row after ROW, or null at the end of the document. */
export function nextVisualRow(view: EditorView, row: VisualRow): VisualRow | null {
  const doc = view.state.doc;
  if (row.to >= doc.length) return null;
  const start = row.lineEnd ? row.to + 1 : row.to;
  if (start > doc.length) return null;
  let next = visualRowAt(view, start, 1, row.logical);
  if (next.from <= row.from) {
    // A measuring failure must not trap a motion on one row.
    if (row.logical) return null;
    next = visualRowAt(view, start, 1, true);
    if (next.from <= row.from) return null;
  }
  return next;
}

/** The visual row before ROW, or null at the start of the document. */
export function prevVisualRow(view: EditorView, row: VisualRow): VisualRow | null {
  if (row.from <= 0) return null;
  const end = row.lineStart ? row.from - 1 : row.from;
  let previous = visualRowAt(view, end, -1, row.logical);
  if (previous.from >= row.from) {
    if (row.logical) return null;
    previous = visualRowAt(view, end, -1, true);
    if (previous.from >= row.from) return null;
  }
  return previous;
}

/**
 * ArrowUp/ArrowDown for the editor's caret, over the same rows as Vim's
 * `j`/`k`: the adjacent visual row at the goal column (CodeMirror's pixel
 * `goalColumn`, kept across repeated presses). A block object is crossed whole,
 * landing just past it, which callers use to enter a display formula; a block
 * of structure (a table) is entered at its near edge, where it opens. A caret
 * cannot rest inside an inline object's hidden source, so it lands at the
 * object's start. Returns RANGE unchanged at the edge of the document.
 */
export function moveByVisualRow(view: EditorView, range: SelectionRange, forward: boolean): SelectionRange {
  const row = visualRowAt(view, range.head, range.assoc < 0 ? -1 : 1);
  const target = forward ? nextVisualRow(view, row) : prevVisualRow(view, row);
  if (!target) return range;
  // A pixel goal with layout; without it (a detached editor) the character column.
  const measured = activeLayout.available(view);
  const goal = range.goalColumn ?? (measured ? screenColumnAt(view, range.head) ?? 0 : range.head - row.from);
  const object = drawnBlockAt(view, target.from);
  if (object && object.from === target.from && object.to === target.to) {
    // An object is crossed whole, landing just past it; structure (a table)
    // is entered at its near edge and opens there as text.
    const at = object.structure === forward ? target.from : target.to;
    return EditorSelection.cursor(at, forward ? -1 : 1, undefined, measured ? goal : undefined);
  }
  let pos = target.from >= target.to ? target.from
    : measured ? screenPosAtColumn(view, target, goal) : Math.min(target.from + goal, target.to);
  const inline = renderedConstructAt(view, pos);
  if (inline && !inline.block && (inline.role ?? "object") === "object" && pos >= inline.from && pos < inline.to) {
    // CodeMirror draws the slot before an object that opens a wrapped row at
    // the end of the row above, so a caret there would look as if it had not
    // moved; it goes after the object instead, on the row it is drawn on.
    pos = inline.from <= target.from ? inline.to : pos > inline.from ? inline.from : pos;
  }
  // The end of a row that wraps is also the start of the next; keep the caret on this one.
  const assoc = pos === target.to && !target.lineEnd ? -1 : 1;
  return EditorSelection.cursor(pos, assoc, undefined, measured ? goal : undefined);
}
