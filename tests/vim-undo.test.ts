/**
 * `u` and Ctrl-R as Vim has them.
 *
 *  - One `u` takes back one command.  The editor's history is finer than
 *    that: `cwfoo bar<Esc>` is a delete plus one event per typed word, and
 *    used to need three presses.
 *  - After `u` the caret is where the command had it when it changed the
 *    text (the start of the deleted word, not wherever in it the caret
 *    stood), and Ctrl-R returns there too.
 *  - Reloading a note whose text has not changed keeps the history.  A
 *    reconnect reloads the open note, and used to leave `u` with nothing.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../pages/vim-lite.ts";

function mount(text: string, at = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  editor.setMarkdown(text, { history: "reset" });
  const vim = createVimLite(editor, host, {
    onUndo: () => editor.undo(),
    onRedo: () => editor.redo(),
  });
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  const type = (text: string): void => {
    // Insert mode leaves typing to the editor; one event per character, a
    // new history event at each space, as real typing produces.
    for (const ch of text) {
      editor.view.dispatch({ ...editor.view.state.replaceSelection(ch), userEvent: "input.type" });
    }
  };
  return {
    editor,
    vim,
    type,
    keys: (...list: string[]) => { for (const key of list) vim.handleKey({ key }); },
    redo: () => vim.handleKey({ key: "r", ctrlKey: true }),
    head: () => editor.getMarkdownSelectionRange().head,
    markdown: () => editor.getMarkdown(),
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("one u undoes one command", () => {
  test("a change and everything typed in its Insert session", () => {
    const s = mount("alpha beta gamma", 6);
    s.keys("c", "w");
    s.type("one two three");
    s.keys("Escape");
    expect(s.markdown()).toBe("alpha one two three gamma");
    s.keys("u");
    expect(s.markdown()).toBe("alpha beta gamma");
    expect(s.head()).toBe(6);
    s.redo();
    expect(s.markdown()).toBe("alpha one two three gamma");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("an opened line and its text", () => {
    const s = mount("first\nlast", 2);
    s.keys("o");
    s.type("a b c");
    s.keys("Escape");
    expect(s.markdown()).toBe("first\na b c\nlast");
    s.keys("u");
    expect(s.markdown()).toBe("first\nlast");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("a counted insert", () => {
    const s = mount("ab", 1);
    s.keys("3", "i");
    s.type("x");
    s.keys("Escape");
    expect(s.markdown()).toBe("axxxb");
    s.keys("u");
    expect(s.markdown()).toBe("ab");
    s.done();
  });

  test("separate commands stay separate, and a count takes several", () => {
    const s = mount("abcdef", 0);
    s.keys("x", "x", "x");
    expect(s.markdown()).toBe("def");
    s.keys("u");
    expect(s.markdown()).toBe("cdef");
    s.keys("2", "u");
    expect(s.markdown()).toBe("abcdef");
    s.redo();
    s.redo();
    expect(s.markdown()).toBe("cdef");
    s.done();
  });

  test("a new change after an undo does not revive the undone group", () => {
    const s = mount("alpha beta", 0);
    s.keys("c", "w");
    s.type("one two");
    s.keys("Escape", "u");
    expect(s.markdown()).toBe("alpha beta");
    s.keys("x");
    expect(s.markdown()).toBe("lpha beta");
    s.keys("u");
    expect(s.markdown()).toBe("alpha beta");
    s.keys("u");
    expect(s.markdown()).toBe("alpha beta");
    s.done();
  });
});

describe("the caret after u", () => {
  test("returns to the start of what a text object deleted", () => {
    const s = mount("alpha beta gamma", 8);
    s.keys("d", "i", "w", "u");
    expect(s.markdown()).toBe("alpha beta gamma");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("returns to the first non-blank after dd from beyond it", () => {
    const s = mount("one\n  two words\nthree", 10);
    s.keys("d", "d", "u");
    expect(s.markdown()).toBe("one\n  two words\nthree");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("stays where x was typed", () => {
    const s = mount("abcdef", 3);
    s.keys("x", "u");
    expect(s.head()).toBe(3);
    s.done();
  });
});

describe("reloading the same text", () => {
  test("keeps the undo history", () => {
    const s = mount("abcdef", 0);
    s.keys("x");
    const saved = s.markdown();
    s.editor.setMarkdown(saved, { history: "reset", preserveView: true });
    s.keys("u");
    expect(s.markdown()).toBe("abcdef");
    s.done();
  });

  test("still drops it when the text really changed", () => {
    const s = mount("abcdef", 0);
    s.keys("x");
    s.editor.setMarkdown("something else", { history: "reset", preserveView: true });
    s.keys("u");
    expect(s.markdown()).toBe("something else");
    s.done();
  });
});
