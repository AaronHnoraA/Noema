/**
 * Operator + motion: `dw`, `cw`, `y$`, `dt,` and friends.
 *
 * Normal mode previously accepted only the doubled forms `dd` and `yy`; every
 * other operator chord fell through to `reportUnhandled`. The exclusive vs
 * inclusive distinction is the substance here — `dw` must stop before the next
 * word while `de` eats the current word's last character.
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
    register: () => (window as unknown as {
      __aaronoteVimRegister?: { text: string; kind: string };
    }).__aaronoteVimRegister,
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("d with a word motion", () => {
  test("dw deletes up to the next word, keeping the separator", () => {
    const s = mount("one two three", 0);
    s.keys("d", "w");
    expect(s.markdown()).toBe("two three");
    s.done();
  });

  test("2dw deletes two words", () => {
    const s = mount("one two three", 0);
    s.keys("2", "d", "w");
    expect(s.markdown()).toBe("three");
    s.done();
  });

  test("dw on the last word of a line stops at the line end", () => {
    const s = mount("one two\nthree", 4);
    s.keys("d", "w");
    expect(s.markdown()).toBe("one \nthree");
    s.done();
  });

  test("de eats the word's last character, unlike dw", () => {
    const s = mount("one two", 0);
    s.keys("d", "e");
    expect(s.markdown()).toBe(" two");
    s.done();
  });

  test("db deletes backwards to the start of the word", () => {
    const s = mount("one two three", 8);
    s.keys("d", "b");
    expect(s.markdown()).toBe("one three");
    s.done();
  });

  test("dW treats punctuation as part of the word", () => {
    const s = mount("foo-bar baz", 0);
    s.keys("d", "W");
    expect(s.markdown()).toBe("baz");
    s.done();
  });

  test("dw yanks what it removed", () => {
    const s = mount("one two", 0);
    s.keys("d", "w");
    expect(s.register()?.text).toBe("one ");
    expect(s.register()?.kind).toBe("characterwise");
    s.done();
  });
});

describe("d with line-boundary motions", () => {
  test("d$ deletes to the end of the line", () => {
    const s = mount("abcdef\nnext", 2);
    s.keys("d", "$");
    expect(s.markdown()).toBe("ab\nnext");
    s.done();
  });

  test("d0 deletes back to the start of the line", () => {
    const s = mount("abcdef", 3);
    s.keys("d", "0");
    expect(s.markdown()).toBe("def");
    s.done();
  });

  test("d^ deletes back to the first non-blank", () => {
    const s = mount("   abcdef", 6);
    s.keys("d", "^");
    expect(s.markdown()).toBe("   def");
    s.done();
  });

  test("dl deletes one character forward", () => {
    const s = mount("abc", 1);
    s.keys("d", "l");
    expect(s.markdown()).toBe("ac");
    s.done();
  });

  test("3dl deletes three characters", () => {
    const s = mount("abcdef", 0);
    s.keys("3", "d", "l");
    expect(s.markdown()).toBe("def");
    s.done();
  });

  test("dh deletes one character backward and never crosses the line start", () => {
    const s = mount("ab\ncd", 3);
    s.keys("d", "h");
    expect(s.markdown()).toBe("ab\ncd");
    s.done();
  });
});

describe("d with a find motion", () => {
  test("dt, deletes up to but not including the comma", () => {
    const s = mount("abc,def", 0);
    s.keys("d", "t", ",");
    expect(s.markdown()).toBe(",def");
    s.done();
  });

  test("df, includes the comma", () => {
    const s = mount("abc,def", 0);
    s.keys("d", "f", ",");
    expect(s.markdown()).toBe("def");
    s.done();
  });

  test("2df. reaches the second target", () => {
    const s = mount("a.b.c", 0);
    s.keys("2", "d", "f", ".");
    expect(s.markdown()).toBe("c");
    s.done();
  });

  test("dF deletes backwards up to the found character", () => {
    const s = mount("abc,def", 6);
    s.keys("d", "F", ",");
    expect(s.markdown()).toBe("abcf");
    s.done();
  });

  test("a find with no match leaves the document alone and reports", () => {
    const s = mount("abc", 0);
    s.keys("d", "f", "z");
    expect(s.markdown()).toBe("abc");
    expect(s.unhandled).toEqual(["dfz"]);
    s.done();
  });

  test("Escape abandons a pending operator find silently", () => {
    const s = mount("abc", 0);
    s.keys("d", "f", "Escape");
    expect(s.markdown()).toBe("abc");
    expect(s.unhandled).toEqual([]);
    s.done();
  });

  test("a digit after df is the literal target", () => {
    const s = mount("ab2cd", 0);
    s.keys("d", "f", "2");
    expect(s.markdown()).toBe("cd");
    s.done();
  });
});

describe("c changes and opens Insert", () => {
  test("cw changes to the end of the word, not into the next one", () => {
    const s = mount("one two", 0);
    s.keys("c", "w");
    expect(s.markdown()).toBe(" two");
    expect(s.vim.mode()).toBe("insert");
    s.done();
  });

  test("cw from mid-word changes only the rest of the word", () => {
    const s = mount("hello world", 2);
    s.keys("c", "w");
    expect(s.markdown()).toBe("he world");
    s.done();
  });

  test("cw on the last character of a word changes just it", () => {
    const s = mount("ab cd", 1);
    s.keys("c", "w");
    expect(s.markdown()).toBe("a cd");
    s.done();
  });

  test("c$ changes to the end of the line", () => {
    const s = mount("abcdef", 2);
    s.keys("c", "$");
    expect(s.markdown()).toBe("ab");
    expect(s.vim.mode()).toBe("insert");
    s.done();
  });

  test("ct, changes up to the comma", () => {
    const s = mount("abc,def", 0);
    s.keys("c", "t", ",");
    expect(s.markdown()).toBe(",def");
    expect(s.vim.mode()).toBe("insert");
    s.done();
  });

  test("cc clears the line but keeps the line itself", () => {
    const s = mount("aaa\nbbb", 1);
    s.keys("c", "c");
    expect(s.markdown()).toBe("\nbbb");
    expect(s.vim.mode()).toBe("insert");
    s.done();
  });

  test("cc keeps a list marker's indentation", () => {
    const s = mount("aaa\n    bbb", 6);
    s.keys("c", "c");
    expect(s.markdown()).toBe("aaa\n    ");
    s.done();
  });
});

describe("y with a motion leaves the document alone", () => {
  test("yw yanks a word", () => {
    const s = mount("one two", 0);
    s.keys("y", "w");
    expect(s.markdown()).toBe("one two");
    expect(s.register()?.text).toBe("one ");
    s.done();
  });

  test("y$ yanks to the end of the line", () => {
    const s = mount("abcdef", 2);
    s.keys("y", "$");
    expect(s.register()?.text).toBe("cdef");
    s.done();
  });

  test("yy still yanks the whole line, linewise", () => {
    const s = mount("abc\ndef", 0);
    s.keys("y", "y");
    expect(s.register()?.text).toBe("abc\n");
    expect(s.register()?.kind).toBe("linewise");
    s.done();
  });

  test("the caret parks at the start of what was yanked", () => {
    const s = mount("one two", 4);
    s.keys("y", "b");
    expect(s.head()).toBe(0);
    s.done();
  });
});

describe("linewise operator motions", () => {
  test("dj deletes this line and the next", () => {
    const s = mount("a\nb\nc", 0);
    s.keys("d", "j");
    expect(s.markdown()).toBe("c");
    expect(s.register()?.kind).toBe("linewise");
    s.done();
  });

  test("dk deletes this line and the one above", () => {
    const s = mount("a\nb\nc", 2);
    s.keys("d", "k");
    expect(s.markdown()).toBe("c");
    s.done();
  });

  test("2dj covers three lines", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("2", "d", "j");
    expect(s.markdown()).toBe("d");
    s.done();
  });

  test("dG deletes from here to the end of the document", () => {
    const s = mount("a\nb\nc\nd", 2);
    s.keys("d", "G");
    expect(s.markdown()).toBe("a");
    s.done();
  });

  test("dgg deletes from here back to the first line", () => {
    const s = mount("a\nb\nc\nd", 4);
    s.keys("d", "g", "g");
    expect(s.markdown()).toBe("d");
    s.done();
  });

  test("yj yanks two lines without changing them", () => {
    const s = mount("a\nb\nc", 0);
    s.keys("y", "j");
    expect(s.markdown()).toBe("a\nb\nc");
    expect(s.register()?.text).toBe("a\nb\n");
    s.done();
  });

  test("a linewise delete leaves a legal Normal-mode caret", () => {
    const s = mount("a\n  bb\ncc", 0);
    s.keys("d", "j");
    expect(s.markdown()).toBe("cc");
    expect(s.head()).toBe(0);
    s.done();
  });
});

describe("paragraph operator motions", () => {
  test("d} deletes to the end of the paragraph", () => {
    const s = mount("one\ntwo\n\nthree", 0);
    s.keys("d", "}");
    expect(s.markdown()).toBe("\nthree");
    s.done();
  });

  test("d{ deletes back to the previous blank line", () => {
    const s = mount("one\n\ntwo\nthree", 5);
    s.keys("d", "{");
    expect(s.markdown()).toBe("one\ntwo\nthree");
    s.done();
  });
});

describe("operators leave a legal caret and clean state", () => {
  test("dw at the end of the line does not park past the last character", () => {
    const s = mount("one two", 4);
    s.keys("d", "w");
    expect(s.markdown()).toBe("one ");
    expect(s.head()).toBeLessThanOrEqual(3);
    s.done();
  });

  test("an operator followed by a non-motion leaves no stuck state", () => {
    const s = mount("one two", 0);
    s.keys("d", "q");
    expect(s.unhandled).toEqual(["dq"]);
    s.keys("d", "w");
    expect(s.markdown()).toBe("two");
    s.done();
  });

  test("Escape cancels a pending operator", () => {
    const s = mount("one two", 0);
    s.keys("d", "Escape");
    expect(s.unhandled).toEqual([]);
    s.keys("w");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("a motion that selects nothing is not an error", () => {
    const s = mount("abc", 0);
    s.keys("d", "h");
    expect(s.markdown()).toBe("abc");
    expect(s.unhandled).toEqual([]);
    s.done();
  });
});
