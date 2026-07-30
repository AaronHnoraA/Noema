import { EditorSelection, EditorState } from "@codemirror/state";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  extendBackwardsOverEmptyLines,
  extendForwardsOverEmptyLines,
  getMousedownSelection,
  isPointerSelecting,
  pointerSelectionEffect,
  pointerSelectionExtension,
  selectionIntersects,
} from "../../src/cm6/extensions/visual/selection.ts";

describe("visual pointer selection state", () => {
  test("records pointer state and maps the mousedown selection through edits", () => {
    let state = EditorState.create({
      doc: "alpha beta",
      selection: { anchor: 6 },
      extensions: [pointerSelectionExtension],
    });
    let transaction = state.update({ effects: pointerSelectionEffect.of(true) });
    state = transaction.state;
    expect(isPointerSelecting(state)).toBe(true);
    expect(getMousedownSelection(state)?.main.anchor).toBe(6);

    transaction = state.update({ changes: { from: 0, insert: "X" } });
    state = transaction.state;
    expect(getMousedownSelection(state)?.main.anchor).toBe(7);
    state = state.update({ effects: pointerSelectionEffect.of(false) }).state;
    expect(isPointerSelecting(state)).toBe(false);
    expect(getMousedownSelection(state)).toBeUndefined();
  });

  test("keeps Overleaf range and empty-line helpers", () => {
    const state = EditorState.create({ doc: "one\n\n\nthree" });
    expect(extendBackwardsOverEmptyLines(state.doc, state.doc.line(3))).toBe(state.doc.line(2).from);
    expect(extendForwardsOverEmptyLines(state.doc, state.doc.line(2))).toBe(state.doc.line(3).to);
    expect(selectionIntersects(EditorSelection.single(2, 5), { from: 4, to: 8 })).toBe(true);
  });
});
