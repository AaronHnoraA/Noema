/** The rendered-construct layer: reveal policies, the registry, and Vim pinning. */
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { createEditor } from "../src/editor-api.ts";
import {
  rangeRevealsSource,
  renderedConstructAt,
  setConstructsPinned,
} from "../src/cm6/extensions/visual/constructs/index.ts";

const caret = (pos: number) => EditorSelection.cursor(pos);
const range = (from: number, to: number) => EditorSelection.range(from, to);

describe("reveal policies", () => {
  test("an edge construct opens for a caret inside or touching it", () => {
    expect(rangeRevealsSource(caret(4), 4, 9, "edge")).toBe(true);
    expect(rangeRevealsSource(caret(6), 4, 9, "edge")).toBe(true);
    expect(rangeRevealsSource(caret(9), 4, 9, "edge")).toBe(true);
    expect(rangeRevealsSource(caret(3), 4, 9, "edge")).toBe(false);
  });

  test("an interior construct opens only for a caret strictly inside", () => {
    expect(rangeRevealsSource(caret(4), 4, 9, "interior")).toBe(false);
    expect(rangeRevealsSource(caret(6), 4, 9, "interior")).toBe(true);
    expect(rangeRevealsSource(caret(9), 4, 9, "interior")).toBe(false);
  });

  test("a range opens a construct only when one of its ends falls inside", () => {
    expect(rangeRevealsSource(range(0, 20), 4, 9, "edge")).toBe(false);
    expect(rangeRevealsSource(range(6, 20), 4, 9, "edge")).toBe(true);
    expect(rangeRevealsSource(range(0, 6), 4, 9, "interior")).toBe(true);
  });
});

function mount(text: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const view = editor.view as unknown as EditorView;
  return { view, done: () => { editor.destroy(); host.remove(); } };
}

describe("construct registry", () => {
  const text = "See [^note] and ((019a0000-0000-7000-8000-000000000000)) here.\n\n`[^code]` \\([^math]\\)";
  const footnote = text.indexOf("[^note]");
  const ref = text.indexOf("((");

  test("reports the construct drawn at a position", () => {
    const { view, done } = mount(text);
    try {
      view.dispatch({ selection: { anchor: 0 } });
      expect(renderedConstructAt(view, footnote + 2)).toMatchObject({ kind: "footnote", from: footnote, to: footnote + 7 });
      expect(renderedConstructAt(view, ref + 3)).toMatchObject({ kind: "block-ref", from: ref });
      expect(renderedConstructAt(view, 1)).toBeNull();
    } finally {
      done();
    }
  });

  test("a construct whose source the caret opened is plain text again", () => {
    const { view, done } = mount(text);
    try {
      view.dispatch({ selection: { anchor: footnote + 3 } });
      expect(renderedConstructAt(view, footnote + 2)).toBeNull();
    } finally {
      done();
    }
  });

  test("Vim pinning keeps the construct under the caret rendered", () => {
    const { view, done } = mount(text);
    try {
      view.dispatch({ selection: { anchor: footnote + 3 }, effects: setConstructsPinned.of(true) });
      expect(renderedConstructAt(view, footnote + 2)).toMatchObject({ kind: "footnote" });
    } finally {
      done();
    }
  });

  test("constructs written in code or math stay literal", () => {
    const { view, done } = mount(text);
    try {
      view.dispatch({ selection: { anchor: 0 } });
      expect(renderedConstructAt(view, text.indexOf("[^code]") + 2)?.kind).not.toBe("footnote");
      expect(renderedConstructAt(view, text.indexOf("[^math]") + 2)?.kind).not.toBe("footnote");
    } finally {
      done();
    }
  });
});
