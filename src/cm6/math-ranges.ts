import { StateField, type ChangeSet, type EditorState, type Extension, type Text } from "@codemirror/state";

const BLOCK_MATH_OPEN_RE = /^[ \t]*\\\[[ \t]*$/;
const BLOCK_MATH_CLOSE_RE = /^[ \t]*\\\][ \t]*$/;

export interface BlockMathRange {
  from: number;
  to: number;
  contentFrom: number;
  contentTo: number;
  tex: string;
}

export function scanBlockMathRanges(text: string, baseOffset = 0): BlockMathRange[] {
  const ranges: BlockMathRange[] = [];
  let lineFrom = 0;
  let openFrom = -1;
  let contentFrom = -1;

  while (lineFrom <= text.length) {
    const newline = text.indexOf("\n", lineFrom);
    const lineTo = newline < 0 ? text.length : newline;
    const line = text.slice(lineFrom, lineTo);

    if (openFrom < 0) {
      if (BLOCK_MATH_OPEN_RE.test(line)) {
        openFrom = lineFrom;
        contentFrom = newline < 0 ? lineTo : newline + 1;
      }
    } else if (BLOCK_MATH_CLOSE_RE.test(line)) {
      ranges.push({
        from: baseOffset + openFrom,
        to: baseOffset + lineTo,
        contentFrom: baseOffset + contentFrom,
        contentTo: baseOffset + lineFrom,
        tex: text.slice(contentFrom, lineFrom).trim(),
      });
      openFrom = -1;
      contentFrom = -1;
    }

    if (newline < 0) break;
    lineFrom = newline + 1;
  }

  return ranges;
}

export function scanBlockMathRangesInDoc(doc: Text): BlockMathRange[] {
  const ranges: BlockMathRange[] = [];
  let openFrom = -1;
  let contentFrom = -1;

  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const line = doc.line(lineNum);
    if (openFrom < 0) {
      if (BLOCK_MATH_OPEN_RE.test(line.text)) {
        openFrom = line.from;
        contentFrom = line.to < doc.length ? line.to + 1 : line.to;
      }
      continue;
    }
    if (!BLOCK_MATH_CLOSE_RE.test(line.text)) continue;
    ranges.push({
      from: openFrom,
      to: line.to,
      contentFrom,
      contentTo: line.from,
      tex: doc.sliceString(contentFrom, line.from).trim(),
    });
    openFrom = -1;
    contentFrom = -1;
  }

  return ranges;
}

function canMapBlockMathRanges(
  state: EditorState,
  ranges: readonly BlockMathRange[],
  changes: ChangeSet,
): boolean {
  let canMap = true;
  changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
    if (!canMap) return;
    const removed = state.doc.sliceString(fromA, toA);
    const added = inserted.toString();
    if (
      removed.includes("\\[") || added.includes("\\[") ||
      removed.includes("\\]") || added.includes("\\]")
    ) {
      canMap = false;
      return;
    }
    const touched = ranges.find((range) => fromA <= range.to && toA >= range.from);
    if (touched && (fromA < touched.contentFrom || toA > touched.contentTo)) {
      canMap = false;
      return;
    }
    if (!touched && fromA !== toA && fromB !== toB) {
      canMap = false;
    }
  });
  return canMap;
}

function firstChangedPosition(changes: ChangeSet): number {
  let first = Number.POSITIVE_INFINITY;
  changes.iterChanges((fromA) => {
    first = Math.min(first, fromA);
  });
  return first;
}

function changedLinesMightOpenMathFence(state: EditorState, changes: ChangeSet): boolean {
  let found = false;
  changes.iterChanges((_fromA, _toA, fromB, toB) => {
    if (found) return;
    const lineFrom = state.doc.lineAt(fromB).number;
    const lineTo = state.doc.lineAt(Math.min(toB, state.doc.length)).number;
    for (let ln = lineFrom; ln <= lineTo && !found; ln++) {
      const lineText = state.doc.line(ln).text;
      if (BLOCK_MATH_OPEN_RE.test(lineText) || BLOCK_MATH_CLOSE_RE.test(lineText)) found = true;
    }
  });
  return found;
}

export const blockMathRangesField = StateField.define<readonly BlockMathRange[]>({
  create: (state) => scanBlockMathRangesInDoc(state.doc),
  update(ranges, tr) {
    if (!tr.docChanged) return ranges;
    if (!canMapBlockMathRanges(tr.startState, ranges, tr.changes)) {
      if (ranges.length === 0 && !changedLinesMightOpenMathFence(tr.state, tr.changes)) return ranges;
      return scanBlockMathRangesInDoc(tr.state.doc);
    }
    const firstChanged = firstChangedPosition(tr.changes);
    return ranges.map((range) => {
      if (range.to < firstChanged) return range;
      const from = tr.changes.mapPos(range.from, -1);
      const to = tr.changes.mapPos(range.to, 1);
      const contentFrom = tr.changes.mapPos(range.contentFrom, -1);
      const contentTo = tr.changes.mapPos(range.contentTo, 1);
      const contentChanged = tr.changes.touchesRange(range.contentFrom, range.contentTo);
      return {
        ...range,
        from,
        to,
        contentFrom,
        contentTo,
        tex: contentChanged ? tr.state.doc.sliceString(contentFrom, contentTo).trim() : range.tex,
      };
    });
  },
});

export const blockMathRangesExtension: Extension = blockMathRangesField;

export function getBlockMathRanges(state: EditorState): readonly BlockMathRange[] {
  return state.field(blockMathRangesField, false) ?? scanBlockMathRangesInDoc(state.doc);
}

export function blockMathRangesOverlapping(
  state: EditorState,
  windows: readonly { from: number; to: number }[],
): BlockMathRange[] {
  const ranges = getBlockMathRanges(state);
  if (ranges.length === 0 || windows.length === 0) return [];
  const matches: BlockMathRange[] = [];
  let low = 0;
  let high = ranges.length;
  const firstWindowFrom = windows[0]!.from;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.to <= firstWindowFrom) low = mid + 1;
    else high = mid;
  }
  let rangeIndex = low;
  for (const window of windows) {
    while (rangeIndex < ranges.length && ranges[rangeIndex]!.to <= window.from) rangeIndex++;
    for (let index = rangeIndex; index < ranges.length; index++) {
      const range = ranges[index]!;
      if (range.from >= window.to) break;
      if (range.to > window.from) matches.push(range);
    }
  }
  return matches;
}

export function rangeOverlapsAny(
  from: number,
  to: number,
  ranges: ReadonlyArray<Pick<BlockMathRange, "from" | "to">>,
): boolean {
  if (from >= to || ranges.length === 0) return false;
  let low = 0;
  let high = ranges.length - 1;
  let candidate = ranges.length;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (range.to > from) {
      candidate = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (candidate >= ranges.length) return false;
  const range = ranges[candidate]!;
  return range.from < to && range.to > from;
}

export function mergeOverlappingRanges(
  ranges: ReadonlyArray<Pick<BlockMathRange, "from" | "to">>,
): Array<{ from: number; to: number }> {
  const sorted = ranges
    .filter((range) => range.from < range.to)
    .map((range) => ({ from: range.from, to: range.to }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous && range.from <= previous.to) {
      previous.to = Math.max(previous.to, range.to);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function rangeInsideAny(
  from: number,
  to: number,
  ranges: ReadonlyArray<Pick<BlockMathRange, "from" | "to">>,
): boolean {
  if (from > to || ranges.length === 0) return false;
  let low = 0;
  let high = ranges.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (range.from <= from) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return false;
  const range = ranges[candidate]!;
  return from >= range.from && to <= range.to;
}

export function positionInsideAnyRange(
  pos: number,
  ranges: ReadonlyArray<Pick<BlockMathRange, "from" | "to">>,
): boolean {
  return rangeAtPosition(pos, ranges) != null;
}

export function rangeAtPosition<T extends Pick<BlockMathRange, "from" | "to">>(
  pos: number,
  ranges: readonly T[],
): T | null {
  if (ranges.length === 0) return null;
  let low = 0;
  let high = ranges.length - 1;
  let candidate = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const range = ranges[mid]!;
    if (range.from <= pos) {
      candidate = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  if (candidate < 0) return null;
  const range = ranges[candidate]!;
  return pos >= range.from && pos < range.to ? range : null;
}
