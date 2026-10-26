import { EditorState } from "@codemirror/state";
import { Decoration, EditorView, type ViewUpdate } from "@codemirror/view";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { constructViewPlugin } from "../../src/cm6/extensions/visual/constructs/view-plugin.ts";
import { selectionOpensSource } from "../../src/cm6/extensions/visual/constructs/reveal.ts";
import { pointerSelectionEffect, pointerSelectionExtension } from "../../src/cm6/extensions/visual/selection.ts";
import { refreshViewportDecorations } from "../../src/cm6/viewport-refresh.ts";
import { createEditor } from "../../src/editor-api.ts";
import { blockExtraFullRebuildCount } from "../../src/cm6/extensions/visual/widgets/block-extras.ts";

describe("viewport work during a pointer selection", () => {
  test("renders new viewport constructs with the mousedown reveal state", () => {
    const host = document.createElement("div");
    document.body.append(host);
    let builds = 0;
    const revealed: boolean[] = [];
    const family = constructViewPlugin({
      build: (current) => {
        builds++;
        revealed.push(selectionOpensSource(current.state, 1, 4, "interior", "structure"));
        return Decoration.none;
      },
      revealKey: (current) => selectionOpensSource(current.state, 1, 4, "interior", "structure") ? "open" : "closed",
    });
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: "a\nb\nc\n",
        extensions: [pointerSelectionExtension, family],
      }),
    });
    try {
      expect(builds).toBe(1);
      view.dispatch({ effects: pointerSelectionEffect.of(true) });
      view.dispatch({ selection: { anchor: 0, head: 2 } });
      expect(builds).toBe(1);

      // Happy DOM does not calculate a scrolling viewport. Supply the same
      // ViewUpdate flags CodeMirror sends when a drag reaches the window edge.
      const value = view.plugin(family) as { update(update: ViewUpdate): void };
      const viewportUpdate = {
        view,
        state: view.state,
        transactions: [],
        selectionSet: true,
        docChanged: false,
        viewportChanged: true,
      } as unknown as ViewUpdate;
      value.update(viewportUpdate);
      value.update(viewportUpdate);
      expect(builds).toBe(3);
      expect(revealed).toEqual([false, false, false]);

      view.dispatch({ effects: pointerSelectionEffect.of(false) });
      expect(builds).toBe(4);
      expect(revealed.at(-1)).toBe(true);
    } finally {
      view.destroy();
      host.remove();
    }
  });

  test("a parser viewport refresh does not reveal Markdown under a moving selection", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: "**bold** more text" });
    const hidden = () => editor.view.dom.querySelectorAll(".syntax-hidden").length;
    try {
      expect(hidden()).toBeGreaterThan(0);
      editor.view.dispatch({ effects: pointerSelectionEffect.of(true) });
      editor.view.dispatch({ selection: { anchor: 15, head: 4 } });
      editor.view.dispatch({ effects: refreshViewportDecorations.of([{ from: 0, to: 18 }]) });
      expect(hidden()).toBeGreaterThan(0);

      editor.view.dispatch({ effects: pointerSelectionEffect.of(false) });
      expect(hidden()).toBe(0);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("a parser refresh waits until mouseup before rebuilding all block widgets", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { initialContent: "before\n\n---\n\nafter" });
    try {
      const built = blockExtraFullRebuildCount();
      editor.view.dispatch({ effects: pointerSelectionEffect.of(true) });
      editor.view.dispatch({ selection: { anchor: 0, head: 10 } });
      editor.view.dispatch({ effects: refreshViewportDecorations.of([{ from: 0, to: editor.view.state.doc.length }]) });
      expect(blockExtraFullRebuildCount()).toBe(built);
      editor.view.dispatch({ effects: pointerSelectionEffect.of(false) });
      expect(blockExtraFullRebuildCount()).toBe(built + 1);
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
