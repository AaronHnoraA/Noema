/**
 * Source that is literal text, where no Markdown construct is recognized:
 * code (fenced, indented, inline) and math (display, inline, inline spanning
 * lines). Constructs never start inside these ranges, so a `((ref))`, `[^1]`,
 * `[[link]]` or `@@command` written in a formula or a code span stays as typed
 * — in every construct family alike.
 */

import type { EditorState, Line } from "@codemirror/state";
import { scanCodeRanges } from "../../../code-ranges.ts";
import {
  blockMathRangesOverlapping,
  getMultilineInlineMathRanges,
  mergeOverlappingRanges,
} from "../../../math-ranges.ts";
import { scanInlineMathRanges } from "../../../../inline-math.ts";

export type SourceSpan = { from: number; to: number };

/** Math touching WINDOWS — display, multi-line inline, single-line inline — merged and sorted. */
export function mathRangesIn(state: EditorState, windows: readonly SourceSpan[]): SourceSpan[] {
  const ranges: SourceSpan[] = blockMathRangesOverlapping(state, windows).map(({ from, to }) => ({ from, to }));
  const multiline = getMultilineInlineMathRanges(state);
  for (const window of windows) {
    // Ordered and disjoint: binary search for the first one ending after the window start.
    let low = 0;
    let high = multiline.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (multiline[middle]!.to <= window.from) low = middle + 1;
      else high = middle;
    }
    for (let index = low; index < multiline.length && multiline[index]!.from < window.to; index++) {
      ranges.push({ from: multiline[index]!.from, to: multiline[index]!.to });
    }
    const text = state.doc.sliceString(window.from, window.to);
    if (text.includes("\\(")) ranges.push(...scanInlineMathRanges(text, window.from));
  }
  return mergeOverlappingRanges(ranges);
}

/** Literal ranges — math and code — touching WINDOWS, merged and sorted. */
export function literalRangesIn(state: EditorState, windows: readonly SourceSpan[]): SourceSpan[] {
  return mergeOverlappingRanges([...mathRangesIn(state, windows), ...scanCodeRanges(state, windows)]);
}

/** Literal ranges touching LINE, merged and sorted. */
export function literalRangesOnLine(state: EditorState, line: Pick<Line, "from" | "to" | "text">): SourceSpan[] {
  return literalRangesIn(state, [{ from: line.from, to: line.to }]);
}
