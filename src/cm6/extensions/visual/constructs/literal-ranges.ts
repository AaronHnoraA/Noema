/**
 * Source that is literal text, where no Markdown construct is recognized:
 * code (fenced, indented, inline) and math (display, inline, inline spanning
 * lines). Constructs never start inside these ranges, so a `((ref))` or `[^1]`
 * written in a formula or a code span stays as typed.
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

/** Literal ranges touching LINE, merged and sorted. */
export function literalRangesOnLine(state: EditorState, line: Pick<Line, "from" | "to" | "text">): SourceSpan[] {
  const window = [{ from: line.from, to: line.to }];
  const ranges: SourceSpan[] = blockMathRangesOverlapping(state, window).map(({ from, to }) => ({ from, to }));
  const multiline = getMultilineInlineMathRanges(state);
  // Ordered and disjoint: the first one ending after the line start is the only candidate.
  let low = 0;
  let high = multiline.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (multiline[middle]!.to <= line.from) low = middle + 1;
    else high = middle;
  }
  for (let index = low; index < multiline.length && multiline[index]!.from < line.to; index++) {
    ranges.push({ from: multiline[index]!.from, to: multiline[index]!.to });
  }
  if (line.text.includes("\\(")) ranges.push(...scanInlineMathRanges(line.text, line.from));
  ranges.push(...scanCodeRanges(state, window));
  return mergeOverlappingRanges(ranges);
}
