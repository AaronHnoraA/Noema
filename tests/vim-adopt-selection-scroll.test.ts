/**
 * Adopting a selection is not moving it.
 *
 * In Normal mode a cursor placed on a rendered formula, table or image snaps
 * to the start of that object. When a click put it there, revealing the snapped
 * position scrolled the view back to the top of a block whose lower part had
 * just been clicked.
 */
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";

function mount(text: string, at = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const vim = createVimLite(editor, host);
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  const reveals: boolean[] = [];
  editor.onViewUpdate((update) => {
    for (const transaction of update.transactions) {
      if (transaction.selection) reveals.push(transaction.scrollIntoView);
    }
  });
  return {
    editor,
    vim,
    reveals,
    head: () => editor.getMarkdownSelectionRange().head,
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("a selection made elsewhere is adopted without scrolling", () => {
  const source = String.raw`aa \(x+y\) bb`;

  test("a click inside a rendered object snaps the cursor and leaves the viewport alone", () => {
    const s = mount(source, 0);
    // The pointer lands inside the formula; CodeMirror places the selection.
    s.editor.view.dispatch({ selection: { anchor: 6 }, userEvent: "select.pointer" });
    s.reveals.length = 0;
    s.vim.syncSelectionFromEditor();
    expect(s.head()).toBe(3);
    expect(s.reveals).toEqual([false]);
    s.done();
  });

  test("a drag that ends on a rendered object becomes a Visual selection without scrolling", () => {
    const s = mount(source, 0);
    s.editor.view.dispatch({ selection: { anchor: 0, head: 6 }, userEvent: "select.pointer" });
    s.reveals.length = 0;
    s.vim.syncSelectionFromEditor();
    expect(s.vim.mode()).toBe("visual");
    expect(s.reveals.every((reveal) => reveal === false)).toBe(true);
    s.done();
  });

  test("a motion made in Normal mode still reveals the cursor", () => {
    const s = mount(source, 0);
    s.reveals.length = 0;
    s.vim.handleKey({ key: "w" });
    expect(s.head()).toBe(3);
    expect(s.reveals).toEqual([true]);
    s.done();
  });
});
