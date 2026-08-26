/**
 * hjkl in Visual and Visual-line mode.
 *
 * Visual mode is inclusive of the character `v` started on, so the rendered CM6
 * range is always one grapheme wider than the logical head — these tests assert
 * the selected *text*, which is what that inclusiveness is actually for.
 * Visual-line owns whole rows, so horizontal keys must be swallowed rather than
 * fall through to CodeMirror and collapse the selection behind Vim's back.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";

function mount(text: string, at: number, enter: "v" | "V") {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const vim = createVimLite(editor, host);
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  vim.handleKey({ key: enter });
  return {
    editor,
    vim,
    keys: (...list: string[]) => { for (const key of list) vim.handleKey({ key }); },
    picked: () => {
      const { from, to } = editor.getMarkdownSelection();
      return editor.getMarkdown().slice(from, to);
    },
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("Visual mode grows and shrinks with h and l", () => {
  test("v alone covers the character under the caret", () => {
    const s = mount("abcdef", 0, "v");
    expect(s.picked()).toBe("a");
    s.done();
  });

  test("l extends forward one character at a time", () => {
    const s = mount("abcdef", 0, "v");
    s.keys("l");
    expect(s.picked()).toBe("ab");
    s.keys("l");
    expect(s.picked()).toBe("abc");
    s.done();
  });

  test("a count extends by that many", () => {
    const s = mount("abcdef", 0, "v");
    s.keys("3", "l");
    expect(s.picked()).toBe("abcd");
    s.done();
  });

  test("h extends backward, keeping the anchor character", () => {
    const s = mount("abcdef", 3, "v");
    s.keys("h");
    expect(s.picked()).toBe("cd");
    s.done();
  });

  test("h can walk back past the anchor to the line start", () => {
    const s = mount("abcdef", 3, "v");
    s.keys("h", "h", "h", "h");
    expect(s.picked()).toBe("abcd");
    s.done();
  });

  test("h at a line start and l at a line end hold the selection", () => {
    const a = mount("abc\ndef", 4, "v");
    a.keys("h");
    expect(a.picked()).toBe("d");
    a.done();
    const b = mount("abc\ndef", 2, "v");
    b.keys("l");
    expect(b.picked()).toBe("c");
    b.done();
  });
});

describe("Visual mode j and k span lines", () => {
  test("j reaches the same column on the next line", () => {
    const s = mount("abcdef\nabcdef", 1, "v");
    s.keys("j");
    expect(s.picked()).toBe("bcdef\nab");
    s.done();
  });

  test("k selects backwards to the same column", () => {
    const s = mount("abcdef\nabcdef", 8, "v");
    s.keys("k");
    expect(s.picked()).toBe("bcdef\nab");
    s.done();
  });

  test("the goal column survives a short line", () => {
    const s = mount("abcdef\nxy\nabcdef", 4, "v");
    s.keys("j", "j");
    expect(s.picked()).toBe("ef\nxy\nabcde");
    s.done();
  });

  test("o swaps the ends without changing what is selected", () => {
    const s = mount("abcdef\nabcdef", 1, "v");
    s.keys("j");
    const before = s.picked();
    s.keys("o");
    expect(s.picked()).toBe(before);
    s.done();
  });
});

describe("Visual-line owns whole rows", () => {
  test("V selects the caret's line with its newline", () => {
    const s = mount("aaa\nbbb\nccc", 0, "V");
    expect(s.picked()).toBe("aaa\n");
    s.done();
  });

  test("j and k add and remove whole lines", () => {
    const s = mount("aaa\nbbb\nccc", 0, "V");
    s.keys("j");
    expect(s.picked()).toBe("aaa\nbbb\n");
    s.keys("j");
    expect(s.picked()).toBe("aaa\nbbb\nccc");
    s.done();
  });

  test("k extends upward", () => {
    const s = mount("aaa\nbbb\nccc", 8, "V");
    s.keys("k");
    expect(s.picked()).toBe("bbb\nccc");
    s.done();
  });

  test("a count adds that many lines", () => {
    const s = mount("a\nb\nc\nd", 0, "V");
    s.keys("2", "j");
    expect(s.picked()).toBe("a\nb\nc\n");
    s.done();
  });

  test("h and l are swallowed instead of collapsing the selection", () => {
    const s = mount("aaa\nbbb", 1, "V");
    s.keys("h");
    expect(s.picked()).toBe("aaa\n");
    s.keys("l");
    expect(s.picked()).toBe("aaa\n");
    expect(s.vim.mode()).toBe("visual-line");
    s.done();
  });

  test("0 and $ are swallowed for the same reason", () => {
    const s = mount("aaa\nbbb", 1, "V");
    s.keys("0");
    expect(s.picked()).toBe("aaa\n");
    s.keys("$");
    expect(s.picked()).toBe("aaa\n");
    s.done();
  });

  test("j on the last line and k on the first hold", () => {
    const a = mount("aaa\nbbb", 4, "V");
    a.keys("j");
    expect(a.picked()).toBe("bbb");
    a.done();
    const b = mount("aaa\nbbb", 1, "V");
    b.keys("k");
    expect(b.picked()).toBe("aaa\n");
    b.done();
  });
});
