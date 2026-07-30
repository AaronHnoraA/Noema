import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorState } from "@codemirror/state";

import {
  ProjectionItem,
  updateProjectionPosition,
} from "../../src/cm6/utils/projection.ts";
import { mergeChangeRanges } from "../../src/cm6/utils/projection-state-field.ts";

class TestProjectionItem extends ProjectionItem {}

function itemAt(from: number, to: number, line: number, toLine: number): TestProjectionItem {
  return Object.assign(new TestProjectionItem(), { from, to, line, toLine });
}

describe("CM6 incremental projection utilities", () => {
  test("keeps object identity when an item does not move", () => {
    const state = EditorState.create({ doc: "first\nsecond" });
    const transaction = state.update({ changes: { from: 0, insert: "" } });
    const item = itemAt(6, 12, 2, 2);
    expect(updateProjectionPosition(item, transaction)).toBe(item);
  });

  test("maps offsets and line numbers after an upstream insertion", () => {
    const state = EditorState.create({ doc: "first\nsecond" });
    const transaction = state.update({ changes: { from: 0, insert: "top\nmiddle\n" } });
    const mapped = updateProjectionPosition(itemAt(6, 12, 2, 2), transaction);
    expect(mapped).toMatchObject({ from: 17, to: 23, line: 4, toLine: 4 });
  });

  test("merges disjoint ChangeSet ranges in both coordinate spaces", () => {
    const state = EditorState.create({ doc: "abcdefghij" });
    const transaction = state.update({
      changes: [
        { from: 1, to: 2, insert: "XYZ" },
        { from: 8, to: 9, insert: "" },
      ],
    });
    expect(mergeChangeRanges(transaction.changes)).toEqual({
      oldFrom: 1,
      oldTo: 9,
      newFrom: 1,
      newTo: 10,
    });
  });
});

