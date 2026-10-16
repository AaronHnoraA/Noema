/** The rendered-construct layer: reveal policies, the registry, and Vim pinning. */
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";
import {
  rangeRevealsSource,
  renderedConstructAt,
  selectionOpensSource,
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

describe("roles under Vim pinning", () => {
  test("an object stays rendered under a pinned caret; structure still opens", () => {
    const { view, done } = mount("one @@lean4 [tag] two");
    try {
      view.dispatch({ selection: { anchor: 6 }, effects: setConstructsPinned.of(true) });
      expect(selectionOpensSource(view.state, 4, 17, "edge", "object")).toBe(false);
      expect(selectionOpensSource(view.state, 4, 17, "edge", "structure")).toBe(true);
      view.dispatch({ effects: setConstructsPinned.of(false) });
      expect(selectionOpensSource(view.state, 4, 17, "edge", "object")).toBe(true);
    } finally {
      done();
    }
  });
});

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

describe("a table is edited as text", () => {
  test("an editable rendered table is an embedded surface, so selected cells keep focus and keys", async () => {
    const { isInEmbeddedSurface } = await import("../src/cm6/embedded-surface.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: "x\n\n| a | b |\n|---|---|\n| c | d |" });
    try {
      const cell = host.querySelector(".cm-table-block td")!;
      expect(isInEmbeddedSurface(cell)).toBe(true);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  const md = "Above\n\n| a | b |\n|---|---|\n| c | d |\n\nBelow";

  test("Vim j onto a table opens its source and moves through it row by row", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: md });
    const vim = createVimLite(editor, host);
    try {
      vim.setMode("normal");
      editor.setSelection(0, 0);
      vim.syncSelectionFromEditor();
      const line = () => editor.view.state.doc.lineAt(editor.view.state.selection.main.head).text;
      expect(host.querySelector(".cm-table-block table")).toBeTruthy();
      vim.handleKey({ key: "j" });
      vim.handleKey({ key: "j" });
      expect(line()).toBe("| a | b |");
      expect(host.querySelector(".cm-table-block")).toBeNull();
      vim.handleKey({ key: "j" });
      vim.handleKey({ key: "j" });
      expect(line()).toBe("| c | d |");
      vim.handleKey({ key: "j" });
      vim.handleKey({ key: "j" });
      expect(line()).toBe("Below");
      expect(host.querySelector(".cm-table-block table")).toBeTruthy();
    } finally {
      vim.destroy();
      editor.destroy();
      host.remove();
    }
  });
});
