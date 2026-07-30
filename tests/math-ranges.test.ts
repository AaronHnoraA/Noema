import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";

import {
  blockMathRangesExtension,
  blockMathRangesOverlapping,
  getBlockMathRanges,
  mergeOverlappingRanges,
  positionInsideAnyRange,
  rangeAtPosition,
  rangeInsideAny,
  rangeOverlapsAny,
  scanBlockMathRanges,
} from "../src/cm6/math-ranges.ts";

describe("block math range queries", () => {
  test("finds overlaps, containment, and point hits on sorted ranges", () => {
    const ranges = scanBlockMathRanges("a\n\\[\nx\n\\]\nb\n\\[\ny\n\\]\nc");

    expect(ranges).toHaveLength(2);
    expect(rangeOverlapsAny(0, ranges[0]!.from, ranges)).toBe(false);
    expect(rangeOverlapsAny(ranges[0]!.from - 1, ranges[0]!.from + 1, ranges)).toBe(true);
    expect(rangeOverlapsAny(ranges[0]!.to, ranges[1]!.from, ranges)).toBe(false);
    expect(rangeOverlapsAny(ranges[1]!.to - 1, ranges[1]!.to + 4, ranges)).toBe(true);

    expect(rangeInsideAny(ranges[0]!.from + 1, ranges[0]!.to - 1, ranges)).toBe(true);
    expect(rangeInsideAny(ranges[0]!.from, ranges[0]!.to + 1, ranges)).toBe(false);

    expect(positionInsideAnyRange(ranges[1]!.from, ranges)).toBe(true);
    expect(positionInsideAnyRange(ranges[1]!.to, ranges)).toBe(false);
    expect(rangeAtPosition(ranges[1]!.from + 1, ranges)).toBe(ranges[1]);
    expect(rangeAtPosition(ranges[1]!.to, ranges)).toBeNull();
  });

  test("updates math tex incrementally for edits inside an existing block", () => {
    const state = EditorState.create({
      doc: "before\n\\[\nx\n\\]\nafter",
      extensions: [blockMathRangesExtension],
    });
    const before = getBlockMathRanges(state)[0]!;
    const next = state.update({
      changes: { from: before.contentFrom + 1, to: before.contentFrom + 1, insert: " + y" },
    }).state;
    const after = getBlockMathRanges(next)[0]!;

    expect(after.from).toBe(before.from);
    expect(after.to).toBe(before.to + 4);
    expect(after.contentFrom).toBe(before.contentFrom);
    expect(after.contentTo).toBe(before.contentTo + 4);
    expect(after.tex).toBe("x + y");
  });

  test("reuses unaffected math ranges and crops queries to viewport windows", () => {
    const state = EditorState.create({
      doc: "\\[\na\n\\]\ntext\n\\[\nb\n\\]",
      extensions: [blockMathRangesExtension],
    });
    const before = getBlockMathRanges(state);
    const textPos = state.doc.toString().indexOf("text") + 2;
    const next = state.update({ changes: { from: textPos, insert: "!" } }).state;
    const after = getBlockMathRanges(next);

    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(after[1]!.tex).toBe(before[1]!.tex);
    expect(blockMathRangesOverlapping(next, [{ from: after[1]!.from, to: after[1]!.to }])).toEqual([after[1]]);
  });

  test("merges nested protection ranges before binary-search range queries", () => {
    const ranges = mergeOverlappingRanges([
      { from: 0, to: 100 },
      { from: 10, to: 20 },
      { from: 30, to: 40 },
    ]);

    expect(ranges).toEqual([{ from: 0, to: 100 }]);
    expect(rangeInsideAny(50, 60, ranges)).toBe(true);
    expect(rangeOverlapsAny(50, 60, ranges)).toBe(true);
  });
});
