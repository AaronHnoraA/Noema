import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import {
  cancelPointerSelection,
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

  test("finishes a drag when mouseup occurs outside the editor", async () => {
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(host, outside);
    const view = new EditorView({
      state: EditorState.create({ doc: "alpha beta", extensions: [pointerSelectionExtension] }),
      parent: host,
    });
    // happy-dom has no layout engine. Keep CodeMirror's native mousedown path
    // active while supplying the one coordinate lookup that path requires.
    Object.defineProperty(view, "posAndSideAtCoords", {
      configurable: true,
      value: () => ({ pos: 0, assoc: 1 }),
    });

    try {
      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      expect(isPointerSelecting(view.state)).toBe(true);

      outside.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 0 }));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      expect(isPointerSelecting(view.state)).toBe(false);
      expect(getMousedownSelection(view.state)).toBeUndefined();
    } finally {
      view.destroy();
      host.remove();
      outside.remove();
    }
  });

  test("pointer cancellation can atomically collapse a stale line selection", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const view = new EditorView({
      state: EditorState.create({ doc: "alpha\nbeta", extensions: [pointerSelectionExtension] }),
      parent: host,
    });
    try {
      view.dispatch({
        selection: { anchor: 0, head: 6 },
        effects: pointerSelectionEffect.of(true),
      });
      cancelPointerSelection(view, 6);
      expect(isPointerSelecting(view.state)).toBe(false);
      expect(view.state.selection.main).toMatchObject({ anchor: 6, head: 6 });
      expect(getMousedownSelection(view.state)).toBeUndefined();
    } finally {
      view.destroy();
      host.remove();
    }
  });

  test("pointer end drops an orphaned secondary highlight behind the main cursor", async () => {
    const host = document.createElement("div");
    const outside = document.createElement("button");
    document.body.append(host, outside);
    const selection = EditorSelection.create([
      EditorSelection.range(7, 16),
      EditorSelection.cursor(0),
    ], 1);
    const view = new EditorView({
      state: EditorState.create({
        doc: "cursor\nstale row",
        selection,
        extensions: [EditorState.allowMultipleSelections.of(true), pointerSelectionExtension],
      }),
      parent: host,
    });
    Object.defineProperty(view, "posAndSideAtCoords", {
      configurable: true,
      value: () => ({ pos: 0, assoc: 1 }),
    });

    try {
      expect(view.state.selection.main.empty).toBe(true);
      expect(view.state.selection.ranges.some((range) => !range.empty)).toBe(true);

      // A secondary-button press starts our lifecycle listener without asking
      // happy-dom to synthesize a native primary-button selection update.
      view.contentDOM.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 2 }));
      expect(isPointerSelecting(view.state)).toBe(true);
      outside.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, button: 2 }));
      await new Promise((resolve) => globalThis.setTimeout(resolve, 0));

      expect(isPointerSelecting(view.state)).toBe(false);
      expect(view.state.selection.ranges).toHaveLength(1);
      expect(view.state.selection.main).toMatchObject({ anchor: 0, head: 0 });
    } finally {
      view.destroy();
      host.remove();
      outside.remove();
    }
  });

  test("keeps Overleaf range and empty-line helpers", () => {
    const state = EditorState.create({ doc: "one\n\n\nthree" });
    expect(extendBackwardsOverEmptyLines(state.doc, state.doc.line(3))).toBe(state.doc.line(2).from);
    expect(extendForwardsOverEmptyLines(state.doc, state.doc.line(2))).toBe(state.doc.line(3).to);
    expect(selectionIntersects(EditorSelection.single(2, 5), { from: 4, to: 8 })).toBe(true);
  });
});
