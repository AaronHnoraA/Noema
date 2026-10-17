import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { domRowLayout } from "../src/cm6/screen-rows.ts";

/**
 * A fake view for one source line drawn as two rows.  Row 1 covers [0, WRAP)
 * and row 2 [WRAP, end); each is 20px tall.  It reproduces how CodeMirror
 * reports the offsets at the wrap when row 2 opens with something that is not
 * plain text: `moveToLineBoundary` and `coordsAtPos(pos, 1)` both put the
 * slot at WRAP on row 1, and CodeMirror only starts row 2 at ROW2_START.
 */
function fakeView(text: string, wrap: number, row2Start: number, drawn: (pos: number) => "row1" | "row2" | "sliver") {
  const state = EditorState.create({ doc: text });
  const end = text.length;
  const box = (pos: number, top: number, bottom: number) => ({ left: pos * 10, right: pos * 10, top, bottom });
  const coordsOf = (pos: number) => {
    const where = drawn(pos);
    if (where === "row1") return box(pos, 0, 20);
    if (where === "sliver") return box(0, 20, 20);
    return box(pos - wrap, 20, 40);
  };
  const view = {
    state,
    contentDOM: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 500, height: 40 }) },
    coordsAtPos(pos: number, side: -1 | 1) {
      // The caret slot before the character at WRAP is reported on row 1.
      if (side > 0 && pos <= wrap) return pos === wrap ? box(wrap, 0, 20) : coordsOf(pos);
      return coordsOf(side < 0 ? pos - 1 : pos);
    },
    moveToLineBoundary(range: SelectionRange, forward: boolean) {
      const onRow2 = range.head > wrap && range.head >= row2Start;
      const head = forward ? (onRow2 ? end : wrap) : (onRow2 ? row2Start : 0);
      return EditorSelection.cursor(head);
    },
  };
  return view as unknown as EditorView;
}

describe("DOM row geometry at a wrap that opens with a rendered object", () => {
  // "aaaa bbbb " on row 1, then an inline formula [10, 14) opening row 2.
  const formula = fakeView("aaaa bbbb QQQQ cccc", 10, 10, (pos) => (pos < 10 ? "row1" : "row2"));

  test("row 1 stops before a formula drawn on row 2", () => {
    expect(domRowLayout.rowAt(formula, 2, 1)).toEqual({ from: 0, to: 10 });
  });

  test("the formula's first offset belongs to row 2", () => {
    expect(domRowLayout.rowAt(formula, 10, 1)).toEqual({ from: 10, to: 19 });
    expect(domRowLayout.rowAt(formula, 12, 1)).toEqual({ from: 10, to: 19 });
  });

  test("assoc -1 at the wrap still means the end of row 1", () => {
    expect(domRowLayout.rowAt(formula, 10, -1)).toEqual({ from: 0, to: 10 });
  });

  // "aaaa bbbb " on row 1, then a hidden `**` [10, 12) drawn as a zero-height
  // sliver at the top of row 2; CodeMirror starts row 2 at "cccc".
  const marker = fakeView("aaaa bbbb **cccc", 10, 12, (pos) => (pos < 10 ? "row1" : pos < 12 ? "sliver" : "row2"));

  test("a hidden marker opening row 2 belongs to row 2", () => {
    expect(domRowLayout.rowAt(marker, 2, 1)).toEqual({ from: 0, to: 10 });
    expect(domRowLayout.rowAt(marker, 10, 1)).toEqual({ from: 10, to: 16 });
    expect(domRowLayout.rowAt(marker, 13, 1)).toEqual({ from: 10, to: 16 });
  });
});
