/**
 * Normal mode has no legal cursor position past the last character of a line.
 * Commands that rewrite the document must land the caret somewhere Vim would
 * actually leave it, or the very next `i`/`x` acts on the wrong offset.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";

function mount(text: string, at = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: text });
  const unhandled: string[] = [];
  const vim = createVimLite(editor, host, { onUnhandledKey: (seq) => unhandled.push(seq) });
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  return {
    editor,
    vim,
    unhandled,
    keys: (...list: string[]) => { for (const key of list) vim.handleKey({ key }); },
    head: () => editor.getMarkdownSelectionRange().head,
    markdown: () => editor.getMarkdown(),
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("dd leaves a legal Normal-mode cursor", () => {
  test("deleting the last line lands on the first character of the line above", () => {
    const s = mount("aaa\nbbb", 4);
    s.keys("d", "d");
    expect(s.markdown()).toBe("aaa");
    expect(s.head()).toBe(0);
    s.done();
  });

  test("the caret after deleting the last line is a real character position", () => {
    const s = mount("aaa\nbbb", 4);
    s.keys("d", "d");
    s.keys("x");
    // Before the fix the caret sat at offset 3 — past the end — so `x` ate the
    // final "a" instead of the first one.
    expect(s.markdown()).toBe("aa");
    s.done();
  });

  test("i after deleting the last line opens Insert at the start, not past the end", () => {
    const s = mount("aaa\nbbb", 4);
    s.keys("d", "d");
    s.keys("i");
    expect(s.vim.mode()).toBe("insert");
    expect(s.head()).toBe(0);
    s.done();
  });

  test("indentation is respected: the caret goes to the first non-blank", () => {
    const s = mount("  aaa\n  bbb", 8);
    s.keys("d", "d");
    expect(s.markdown()).toBe("  aaa");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("deleting a middle line lands on the first non-blank of the line that moved up", () => {
    const s = mount("aaa\nbbb\n    ccc", 4);
    s.keys("d", "d");
    expect(s.markdown()).toBe("aaa\n    ccc");
    expect(s.head()).toBe(8);
    s.done();
  });

  test("deleting the only line leaves the caret at the start of the empty document", () => {
    const s = mount("aaa", 1);
    s.keys("d", "d");
    expect(s.markdown()).toBe("");
    expect(s.head()).toBe(0);
    s.done();
  });

  test("a blank line that moves up still gets a legal caret", () => {
    const s = mount("aaa\nbbb\n", 4);
    s.keys("d", "d");
    expect(s.markdown()).toBe("aaa\n");
    expect(s.head()).toBe(4);
    s.done();
  });
});
