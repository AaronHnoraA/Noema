/**
 * Screen-row geometry for Vim-lite.
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

import { EditorSelection, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { nextGraphemePosition } from "../src/cm6/text-boundaries.ts";

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
    // A replaced block widget may legitimately span several source lines; any
    // other answer that does not contain POS is a measuring failure (the line
    // is outside the rendered viewport, or the DOM is mid-update).
    if (from > pos || to < pos) return { from: line.from, to: line.to };
    // CodeMirror's "end of visual line" can stop before a hanging wrap space.
    // Rows must partition the line, so extend TO until it is the next row's
    // start — otherwise that space belongs to no row and stepping over rows
    // makes no progress.
    const lineEnd = doc.lineAt(to).to;
    for (let probe = 0; probe < ROW_END_PROBE_LIMIT && to < lineEnd; probe++) {
      if (measuredStart(view, to, 1) !== from) break;
      to = nextGraphemePosition(doc, to);
    }
    from = Math.min(from, pos);
    return { from, to: Math.max(to, pos) };
  },

  xAt(view, pos) {
    const coords = view.coordsAtPos(pos, 1);
    if (!coords) return null;
    return coords.left - view.contentDOM.getBoundingClientRect().left;
  },

  posAtX(view, row, x) {
    const coords = view.coordsAtPos(row.from, 1);
    if (!coords) return row.from;
    const rect = view.contentDOM.getBoundingClientRect();
    const hit = view.posAtCoords({ x: rect.left + x, y: (coords.top + coords.bottom) / 2 }, false);
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
