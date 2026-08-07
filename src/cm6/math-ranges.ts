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

type BlockMathFence = {
  from: number;
  to: number;
  kind: "open" | "close";
};

type BlockMathIndex = {
  fences: readonly BlockMathFence[];
  ranges: readonly BlockMathRange[];
};

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
  return scanBlockMathIndexInDoc(doc).ranges.slice();
}

function scanBlockMathFencesInLines(
  doc: Text,
  windows: readonly { from: number; to: number }[],
): BlockMathFence[] {
  const fences: BlockMathFence[] = [];
  for (const window of windows) {
    const firstLine = doc.lineAt(Math.max(0, Math.min(window.from, doc.length))).number;
    const lastLine = doc.lineAt(Math.max(0, Math.min(window.to, doc.length))).number;
    for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) {
      const line = doc.line(lineNumber);
      if (BLOCK_MATH_OPEN_RE.test(line.text)) {
        fences.push({ from: line.from, to: line.to, kind: "open" });
      } else if (BLOCK_MATH_CLOSE_RE.test(line.text)) {
        fences.push({ from: line.from, to: line.to, kind: "close" });
      }
    }
  }
  return fences;
}

function rangesFromFences(
  doc: Text,
  fences: readonly BlockMathFence[],
  previous: readonly BlockMathRange[] = [],
  changes?: ChangeSet,
): BlockMathRange[] {
  const ranges: BlockMathRange[] = [];
  const reusable = new Map<string, { range: BlockMathRange; contentChanged: boolean }>();
  if (changes) {
    for (const range of previous) {
      const mapped = {
        from: changes.mapPos(range.from, -1),
        to: changes.mapPos(range.to, 1),
        contentFrom: changes.mapPos(range.contentFrom, -1),
        contentTo: changes.mapPos(range.contentTo, 1),
      };
      reusable.set(
        `${mapped.from}:${mapped.to}:${mapped.contentFrom}:${mapped.contentTo}`,
        { range, contentChanged: changes.touchesRange(range.contentFrom, range.contentTo) !== false },
      );
    }
  }

  let open: BlockMathFence | null = null;
  for (const fence of fences) {
    if (!open) {
      if (fence.kind === "open") open = fence;
      continue;
    }
    if (fence.kind !== "close") continue;
    const contentFrom = open.to < doc.length ? open.to + 1 : open.to;
    const candidate = {
      from: open.from,
      to: fence.to,
      contentFrom,
      contentTo: fence.from,
    };
    const cached = reusable.get(
      `${candidate.from}:${candidate.to}:${candidate.contentFrom}:${candidate.contentTo}`,
    );
    if (cached && !cached.contentChanged
      && cached.range.from === candidate.from && cached.range.to === candidate.to
      && cached.range.contentFrom === candidate.contentFrom
      && cached.range.contentTo === candidate.contentTo) {
      ranges.push(cached.range);
    } else {
      ranges.push({
        ...candidate,
        tex: cached && !cached.contentChanged
          ? cached.range.tex
          : doc.sliceString(contentFrom, fence.from).trim(),
      });
    }
    open = null;
  }
  return ranges;
}

function scanBlockMathIndexInDoc(doc: Text): BlockMathIndex {
  const fences = scanBlockMathFencesInLines(doc, [{ from: 0, to: doc.length }]);
  return { fences, ranges: rangesFromFences(doc, fences) };
}

function mergeLineWindows(
  windows: Array<{ from: number; to: number }>,
): Array<{ from: number; to: number }> {
  windows.sort((a, b) => a.from - b.from || a.to - b.to);
  const merged: Array<{ from: number; to: number }> = [];
  for (const window of windows) {
    const previous = merged[merged.length - 1];
    if (previous && window.from <= previous.to + 1) {
      previous.to = Math.max(previous.to, window.to);
    } else {
      merged.push({ ...window });
    }
  }
  return merged;
}

function changedLineWindows(
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeSet,
): {
  oldWindows: Array<{ from: number; to: number }>;
  newWindows: Array<{ from: number; to: number }>;
} {
  const oldWindows: Array<{ from: number; to: number }> = [];
  const newWindows: Array<{ from: number; to: number }> = [];
  changes.iterChanges((fromA, toA, fromB, toB) => {
    const oldStart = oldDoc.lineAt(Math.min(fromA, oldDoc.length));
    const oldEnd = oldDoc.lineAt(Math.min(toA, oldDoc.length));
    oldWindows.push({ from: oldStart.from, to: oldEnd.to });
    const newStart = newDoc.lineAt(Math.min(fromB, newDoc.length));
    const newEnd = newDoc.lineAt(Math.min(toB, newDoc.length));
    newWindows.push({ from: newStart.from, to: newEnd.to });
  });
  return {
    oldWindows: mergeLineWindows(oldWindows),
    newWindows: mergeLineWindows(newWindows),
  };
}

function overlapsAnyLineWindow(
  fence: BlockMathFence,
  windows: readonly { from: number; to: number }[],
): boolean {
  return windows.some((window) => fence.from <= window.to && fence.to >= window.from);
}

function updateBlockMathIndex(
  index: BlockMathIndex,
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeSet,
): BlockMathIndex {
  const { oldWindows, newWindows } = changedLineWindows(oldDoc, newDoc, changes);
  const fences = index.fences
    .filter((fence) => !overlapsAnyLineWindow(fence, oldWindows))
    .map((fence) => ({
      ...fence,
      from: changes.mapPos(fence.from, -1),
      to: changes.mapPos(fence.to, 1),
    }));
  fences.push(...scanBlockMathFencesInLines(newDoc, newWindows));
  fences.sort((a, b) => a.from - b.from || a.to - b.to);
  return {
    fences,
    ranges: rangesFromFences(newDoc, fences, index.ranges, changes),
  };
}

export const blockMathRangesField = StateField.define<BlockMathIndex>({
  create: (state) => scanBlockMathIndexInDoc(state.doc),
  update(index, tr) {
    if (!tr.docChanged) return index;
    return updateBlockMathIndex(index, tr.startState.doc, tr.state.doc, tr.changes);
  },
});

export const blockMathRangesExtension: Extension = blockMathRangesField;

export function getBlockMathRanges(state: EditorState): readonly BlockMathRange[] {
  return state.field(blockMathRangesField, false)?.ranges ?? scanBlockMathRangesInDoc(state.doc);
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
