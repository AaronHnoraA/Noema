import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";
import {
  firstChangedLine,
  viewportDeltaRanges,
} from "../../src/cm6/utils/tree-operations/change-ranges.ts";

describe("incremental change ranges", () => {
  test("returns only viewport content that newly enters either edge", () => {
    expect(viewportDeltaRanges(100, 200, [{ from: 80, to: 140 }, { from: 170, to: 240 }])).toEqual([
      { from: 80, to: 100 },
      { from: 200, to: 240 },
    ]);
    expect(viewportDeltaRanges(100, 200, [{ from: 120, to: 180 }])).toEqual([]);
  });

  test("finds the earliest changed line in the new document", () => {
    const state = EditorState.create({ doc: "one\ntwo\nthree" });
    const transaction = state.update({ changes: { from: 4, to: 7, insert: "second" } });
    expect(firstChangedLine(transaction.changes, transaction.state.doc)).toBe(2);
  });
});
