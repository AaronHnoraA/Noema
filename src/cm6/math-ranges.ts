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

/**
 * Re-pair fences into display-math ranges, reusing the previous range objects
 * (and their already-sliced `tex`) wherever the document did not disturb them.
 *
 * Both `previous` and the ranges produced from `fences` are in document order,
 * so a single cursor walks them together. The earlier implementation keyed a
 * Map by a `from:to:contentFrom:contentTo` string built for every range in the
 * document, which allocated a string and four mapped positions per formula on
 * every keystroke; a note with ~10k formulas paid all of it to edit one line.
 */
function rangesFromFences(
  doc: Text,
  fences: readonly BlockMathFence[],
  previous: readonly BlockMathRange[] = [],
  changes?: ChangeSet,
  firstChangeFrom = 0,
): BlockMathRange[] {
  // Positions ahead of every change map to themselves, so the common case of
  // editing below a long preamble skips position mapping entirely.
  const mapFrom = (position: number): number =>
    position < firstChangeFrom ? position : changes!.mapPos(position, -1);
  const mapTo = (position: number): number =>
    position < firstChangeFrom ? position : changes!.mapPos(position, 1);

  const ranges: BlockMathRange[] = [];
  let cursor = 0;
  let open: BlockMathFence | null = null;
  for (const fence of fences) {
    if (!open) {
      if (fence.kind === "open") open = fence;
      continue;
    }
    if (fence.kind !== "close") continue;
    const contentFrom = open.to < doc.length ? open.to + 1 : open.to;
    const from = open.from;
    const to = fence.to;
    const contentTo = fence.from;

    let reused: BlockMathRange | null = null;
    if (changes) {
      while (cursor < previous.length && mapFrom(previous[cursor]!.from) < from) cursor += 1;
      const candidate = previous[cursor];
      if (candidate
        && mapFrom(candidate.from) === from
        && mapTo(candidate.to) === to
        && mapFrom(candidate.contentFrom) === contentFrom
        && mapTo(candidate.contentTo) === contentTo
        && (candidate.contentTo < firstChangeFrom
          || changes.touchesRange(candidate.contentFrom, candidate.contentTo) === false)) {
        reused = candidate;
      }
    }

    if (reused
      && reused.from === from && reused.to === to
      && reused.contentFrom === contentFrom && reused.contentTo === contentTo) {
      ranges.push(reused);
    } else {
      ranges.push({
        from,
        to,
        contentFrom,
        contentTo,
        tex: reused ? reused.tex : doc.sliceString(contentFrom, contentTo).trim(),
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

/** Lowest offset in the old document that this change set disturbs. */
function firstChangedOffset(changes: ChangeSet): number {
  let first = Number.POSITIVE_INFINITY;
  changes.iterChangedRanges((fromA) => {
    if (fromA < first) first = fromA;
  });
  return first;
}

/** Merge two document-ordered fence runs without re-sorting the whole index. */
function mergeFences(
  left: readonly BlockMathFence[],
  right: readonly BlockMathFence[],
): BlockMathFence[] {
  if (right.length === 0) return left as BlockMathFence[];
  if (left.length === 0) return right as BlockMathFence[];
  const merged: BlockMathFence[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const a = left[leftIndex]!;
    const b = right[rightIndex]!;
    if (a.from < b.from || (a.from === b.from && a.to <= b.to)) {
      merged.push(a);
      leftIndex += 1;
    } else {
      merged.push(b);
      rightIndex += 1;
    }
  }
  for (; leftIndex < left.length; leftIndex += 1) merged.push(left[leftIndex]!);
  for (; rightIndex < right.length; rightIndex += 1) merged.push(right[rightIndex]!);
  return merged;
}

function updateBlockMathIndex(
  index: BlockMathIndex,
  oldDoc: Text,
  newDoc: Text,
  changes: ChangeSet,
): BlockMathIndex {
  const { oldWindows, newWindows } = changedLineWindows(oldDoc, newDoc, changes);
  const firstChangeFrom = firstChangedOffset(changes);

  // Surviving fences stay in document order, and a rescan of the changed lines
  // is ordered too, so the two runs merge in linear time. Sorting the whole
  // index instead made every keystroke in a formula-heavy note pay
  // O(fences log fences) — ~21k fences here — for a one-line edit.
  const surviving: BlockMathFence[] = [];
  for (const fence of index.fences) {
    if (overlapsAnyLineWindow(fence, oldWindows)) continue;
    surviving.push(fence.to < firstChangeFrom
      ? fence
      : {
          from: changes.mapPos(fence.from, -1),
          to: changes.mapPos(fence.to, 1),
          kind: fence.kind,
        });
  }
  const fences = mergeFences(surviving, scanBlockMathFencesInLines(newDoc, newWindows));
  return {
    fences,
    ranges: rangesFromFences(newDoc, fences, index.ranges, changes, firstChangeFrom),
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

/** Find the display-math content containing a position without scanning every range. */
export function blockMathRangeAt(state: EditorState, position: number): BlockMathRange | null {
  const ranges = getBlockMathRanges(state);
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.contentFrom <= position) low = mid + 1;
    else high = mid;
  }
  const candidate = ranges[low - 1];
  return candidate && position >= candidate.contentFrom && position <= candidate.contentTo
    ? candidate
    : null;
}

/** Display-math range whose whole `\[ … \]` span brackets a position. */
export function blockMathRangeSpanning(state: EditorState, position: number): BlockMathRange | null {
  const ranges = getBlockMathRanges(state);
  let low = 0;
  let high = ranges.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (ranges[mid]!.from <= position) low = mid + 1;
    else high = mid;
  }
  const candidate = ranges[low - 1];
  return candidate && position >= candidate.from && position <= candidate.to ? candidate : null;
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
