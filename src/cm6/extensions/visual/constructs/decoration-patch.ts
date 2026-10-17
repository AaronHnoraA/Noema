/**
 * Patching a construct family's decorations in place.
 *
 * A block family keeps its decorations for the whole document and, on each
 * transaction, redraws only what changed: the constructs a selection opened or
 * closed, the lines an edit touched, a range a viewport refresh asked for.
 * Every family does it the same way through this module:
 *
 * - `openedKey` records which constructs the selection has open, as a string,
 *   so a selection change that opens or closes nothing costs one comparison;
 * - `rebuildForRevealChange` redraws exactly the constructs whose state the
 *   change flipped;
 * - `rebuildDecorations` redraws arbitrary ranges (edits, refreshes);
 * - `replaceDecorations` swaps ranges for decorations built elsewhere.
 */

import type { Range } from "@codemirror/state";
import type { Decoration, DecorationSet } from "@codemirror/view";

export type Span = { from: number; to: number };

/** Sorted, with overlapping or touching spans merged. */
export function mergeSpans(spans: Iterable<Span>): Span[] {
  const sorted = [...spans]
    .filter((span) => span.from <= span.to)
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Span[] = [];
  for (const span of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && span.from <= previous.to) previous.to = Math.max(previous.to, span.to);
    else merged.push({ from: span.from, to: span.to });
  }
  return merged;
}

/** The opened constructs SPANS as a key: equal keys mean nothing opened or closed. */
export function openedKey(spans: Iterable<Span>): string {
  return [...spans].map((span) => `${span.from}:${span.to}`).join("|");
}

/**
 * The spans in KEY. A part may carry a label before its offsets
 * (`toc:12:40`); the last two numbers are the span.
 */
export function spansFromKey(key: string): Span[] {
  if (!key) return [];
  const spans: Span[] = [];
  for (const part of key.split("|")) {
    const pieces = part.split(":");
    const from = Number(pieces[pieces.length - 2]);
    const to = Number(pieces[pieces.length - 1]);
    if (Number.isFinite(from) && Number.isFinite(to) && from <= to) spans.push({ from, to });
  }
  return spans;
}

/** CURRENT with the decorations inside RANGES removed and ADD added. */
export function replaceDecorations(
  current: DecorationSet,
  ranges: Iterable<Span>,
  add: readonly Range<Decoration>[],
): DecorationSet {
  let next = current;
  for (const range of ranges) {
    next = next.update({ filterFrom: range.from, filterTo: range.to, filter: () => false });
  }
  return add.length > 0 ? next.update({ add: [...add], sort: true }) : next;
}

/** CURRENT with RANGES (merged first) redrawn by BUILD. */
export function rebuildDecorations(
  current: DecorationSet,
  ranges: Iterable<Span>,
  build: (from: number, to: number) => readonly Range<Decoration>[],
): DecorationSet {
  const merged = mergeSpans(ranges);
  if (merged.length === 0) return current;
  const add: Range<Decoration>[] = [];
  for (const range of merged) add.push(...build(range.from, range.to));
  return replaceDecorations(current, merged, add);
}

/** CURRENT with the constructs opened or closed between OLD_KEY and NEW_KEY redrawn. */
export function rebuildForRevealChange(
  current: DecorationSet,
  oldKey: string,
  newKey: string,
  build: (from: number, to: number) => readonly Range<Decoration>[],
): DecorationSet {
  if (oldKey === newKey) return current;
  return rebuildDecorations(current, [...spansFromKey(oldKey), ...spansFromKey(newKey)], build);
}
