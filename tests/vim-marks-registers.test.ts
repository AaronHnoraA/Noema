/**
 * Marks, named registers, the jump list, `gi` and the Ctrl chords.
 *
 * None of these existed: `ma` reported `m` as unbound and then ran `a`, which
 * opened Insert, and `"ayy` and `qa` ended the same way.  Ctrl-D and Ctrl-O
 * reached CodeMirror's Emacs-style bindings, which deleted a character and
 * opened a line while the editor was in Normal mode.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../pages/vim-lite.ts";

const LINES = Array.from({ length: 60 }, (_, index) => `line ${index} text`);

function mount(text: string, at = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  editor.setMarkdown(text, { history: "reset" });
  const unhandled: string[] = [];
  const pasted: string[] = [];
  const vim = createVimLite(editor, host, {
    onUndo: () => editor.undo(),
    onRedo: () => editor.redo(),
    onUnhandledKey: (sequence) => unhandled.push(sequence),
  });
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  return {
    editor, vim, unhandled, pasted,
    keys: (...list: string[]) => { for (const key of list) vim.handleKey({ key }); },
    ctrl: (key: string) => vim.handleKey({ key, ctrlKey: true }),
    head: () => editor.getMarkdownSelectionRange().head,
    line: () => editor.view.state.doc.lineAt(editor.getMarkdownSelectionRange().head).number,
    markdown: () => editor.getMarkdown(),
    settle: () => new Promise((resolve) => setTimeout(resolve, 30)),
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("marks", () => {
  test("m sets a mark; ` returns to it and ' to its line", () => {
    const s = mount("one\n  two words\nthree", 9);
    s.keys("m", "a");
    expect(s.vim.mode()).toBe("normal");
    s.keys("g", "g");
    expect(s.head()).toBe(0);
    s.keys("`", "a");
    expect(s.head()).toBe(9);
    s.keys("g", "g", "'", "a");
    expect(s.head()).toBe(6);
    expect(s.unhandled).toEqual([]);
    s.done();
  });

  test("a mark follows the text when an edit moves it", () => {
    const s = mount("one\ntwo\nthree", 8);
    s.keys("m", "b", "g", "g", "d", "d");
    expect(s.markdown()).toBe("two\nthree");
    s.keys("`", "b");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("is a motion for operators, and an unset mark does nothing", () => {
    const s = mount("one\ntwo\nthree\nfour", 0);
    s.keys("j", "j", "m", "a", "g", "g", "d", "'", "a");
    expect(s.markdown()).toBe("four");
    s.keys("d", "'", "z");
    expect(s.markdown()).toBe("four");
    s.done();
  });
});

describe("the jump list", () => {
  test("Ctrl-O goes back through jumps, Ctrl-I forward, and `` swaps with the last", () => {
    const s = mount(LINES.join("\n"), 0);
    s.keys("G");
    expect(s.line()).toBe(60);
    s.keys("1", "0", "G");
    expect(s.line()).toBe(10);
    s.ctrl("o");
    expect(s.line()).toBe(60);
    s.ctrl("o");
    expect(s.line()).toBe(1);
    s.ctrl("i");
    expect(s.line()).toBe(60);
    s.keys("`", "`");
    expect(s.line()).toBe(1);
    expect(s.markdown()).toBe(LINES.join("\n"));
    s.done();
  });
});

describe("Ctrl chords never edit outside Insert", () => {
  test("Ctrl-D and Ctrl-U move by half a page, Ctrl-F and Ctrl-B by a page", () => {
    const s = mount(LINES.join("\n"), 0);
    const text = s.markdown();
    expect(s.ctrl("d")).toBe(true);
    const half = s.line() - 1;
    expect(half).toBeGreaterThan(1);
    expect(s.ctrl("f")).toBe(true);
    expect(s.line()).toBeGreaterThan(half + 1);
    expect(s.ctrl("b")).toBe(true);
    expect(s.ctrl("u")).toBe(true);
    expect(s.line()).toBe(1);
    expect(s.markdown()).toBe(text);
    s.done();
  });

  test("the chords CodeMirror would turn into edits are consumed", () => {
    const s = mount("alpha beta\ngamma", 3);
    for (const key of ["d", "u", "o", "k", "t", "h", "a", "e"]) {
      expect(s.ctrl(key)).toBe(true);
    }
    expect(s.markdown()).toBe("alpha beta\ngamma");
    expect(s.vim.mode()).toBe("normal");
    s.done();
  });

  test("they stay with the editor in Insert mode", () => {
    const s = mount("alpha", 0);
    s.keys("i");
    expect(s.ctrl("d")).toBe(false);
    s.done();
  });
});

describe("named registers", () => {
  test("a delete does not replace what \"a holds, and \"ap pastes it", async () => {
    const s = mount("one\ntwo\nthree", 0);
    s.keys("\"", "a", "y", "y", "j", "d", "d");
    expect(s.markdown()).toBe("one\nthree");
    expect(s.vim.mode()).toBe("normal");
    s.keys("\"", "a", "p");
    await s.settle();
    expect(s.markdown()).toBe("one\nthree\none");
    expect(s.unhandled).toEqual([]);
    s.done();
  });

  test("\"0 keeps the last yank across deletes, and \"_ deletes without yanking", async () => {
    const s = mount("keep\ndrop\nlast", 0);
    s.keys("y", "y", "j", "\"", "_", "d", "d");
    expect(s.markdown()).toBe("keep\nlast");
    s.keys("d", "d");
    expect(s.markdown()).toBe("keep");
    s.keys("\"", "0", "p");
    await s.settle();
    expect(s.markdown()).toBe("keep\nkeep");
    s.done();
  });

  test("an uppercase name appends", async () => {
    const s = mount("one\ntwo\nx", 0);
    s.keys("\"", "a", "y", "y", "j", "\"", "A", "y", "y", "G", "\"", "a", "p");
    await s.settle();
    expect(s.markdown()).toBe("one\ntwo\nx\none\ntwo");
    s.done();
  });

  test("the register lasts for one command only", () => {
    const s = mount("abc def", 0);
    s.keys("\"", "a", "y", "w", "w", "\"", "b", "y", "w");
    s.keys("\"", "c", "p");
    expect(s.unhandled).toEqual(["\"cp"]);
    s.done();
  });
});

describe("gi and the prefixes that are not supported", () => {
  test("gi resumes Insert where it was left", () => {
    const s = mount("alpha beta\ngamma", 5);
    s.keys("i", "Escape", "j", "g", "i");
    expect(s.vim.mode()).toBe("insert");
    expect(s.head()).toBe(5);
    s.done();
  });

  test("qa, @a and ZZ consume their argument instead of running it", () => {
    const s = mount("alpha", 0);
    s.keys("q", "a", "@", "a", "Z", "Z");
    expect(s.vim.mode()).toBe("normal");
    expect(s.markdown()).toBe("alpha");
    expect(s.unhandled).toEqual(["qa", "@a", "ZZ"]);
    s.done();
  });
});
