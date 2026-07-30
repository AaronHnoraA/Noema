import type { ChangeSet, Text } from "@codemirror/state";

export type DocumentRange = { from: number; to: number };

/** Return the 1-based line number of the earliest position changed in DOC. */
export function firstChangedLine(changes: ChangeSet, doc: Text): number {
  let minLine = Infinity;
  changes.iterChangedRanges((_fromA, _toA, fromB) => {
    const pos = Math.min(fromB, doc.length > 0 ? doc.length - 1 : 0);
    const line = doc.lineAt(pos).number;
    if (line < minLine) minLine = line;
  });
  return Number.isFinite(minLine) ? minLine : 1;
}

/**
 * Return portions of NEW_RANGES not covered by the previous viewport
 * envelope. Consumers can scan only content that has just entered view.
 */
export function viewportDeltaRanges(
  previousFrom: number,
  previousTo: number,
  newRanges: readonly DocumentRange[],
): DocumentRange[] {
  const delta: DocumentRange[] = [];
  for (const { from, to } of newRanges) {
    if (to > previousTo) delta.push({ from: Math.max(from, previousTo), to });
    if (from < previousFrom) delta.push({ from, to: Math.min(to, previousFrom) });
  }
  return delta.filter((range) => range.from < range.to);
}
