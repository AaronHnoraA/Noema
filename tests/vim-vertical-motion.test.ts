/**
 * `j`/`k` in Normal mode, including the widget-snapping the pixel path does.
 *
 * The headless DOM cannot measure wrapped rows, but real key handling still
 * traverses the visible formula and heading rows as one Vim line each.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";
import { getBlockMathRanges } from "../src/cm6/math-ranges.ts";

function mount(text: string, at = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const vim = createVimLite(editor, host);
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  return {
    editor,
    vim,
    keys: (...list: string[]) => { for (const key of list) vim.handleKey({ key }); },
    head: () => editor.getMarkdownSelectionRange().head,
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("a vertical motion snaps onto a collapsed display formula", () => {
  const DOC = "aaa\n\\[\nx^2\n\\]\nbbb";

  test("the formula is one collapsed range", () => {
    const e = mount(DOC);
    expect(getBlockMathRanges(e.editor.view.state).map((r) => [r.from, r.to])).toEqual([[4, 13]]);
    e.done();
  });

  test("moving down stops on the formula before the following line", () => {
    const e = mount(DOC, 1);
    e.keys("j");
    expect(e.head()).toBe(4);
    e.keys("j");
    expect(e.head()).toBe(15);
    e.done();
  });

  test("moving up stops on the formula before the preceding line", () => {
    const e = mount(DOC, 15);
    e.keys("k");
    expect(e.head()).toBe(4);
    e.keys("k");
    expect(e.head()).toBe(1);
    e.done();
  });
});

describe("a vertical motion snaps onto an org-env heading", () => {
  const DOC = "aaa\n#+begin theorem T\nBody.\n#+end theorem\nbbb";

  test("downward", () => {
    const e = mount(DOC, 1);
    e.keys("j");
    expect(e.head()).toBe(20);
    e.done();
  });

  test("upward", () => {
    const e = mount(DOC, 22);
    e.keys("k");
    expect(e.head()).toBe(20);
    e.done();
  });
});

describe("a blank line a block absorbed is still a stop", () => {
  test("downward and upward both land on it", () => {
    const e = mount("aaa\n\nbbb", 1);
    e.keys("j");
    expect(e.head()).toBe(4);
    e.keys("j", "k");
    expect(e.head()).toBe(4);
    e.done();
  });

  test("ordinary lines move one row at a time", () => {
    const e = mount("aaa\nbbb\nccc", 1);
    e.keys("j", "j", "k");
    expect(e.head()).toBe(5);
    e.done();
  });

  test("horizontal motion stays on its line", () => {
    const e = mount("aaa\n\nbbb", 6);
    e.keys("l");
    expect(e.head()).toBe(7);
    e.done();
  });

  test("Source mode keeps ordinary source lines", () => {
    const e = mount("aaa\n\nbbb", 1);
    e.editor.view.dom.classList.remove("aaronnote-visual-typography");
    e.keys("j");
    expect(e.head()).toBe(4);
    e.done();
  });
});

describe("j and k keep the goal column (logical-line fallback)", () => {
  test("a short line clamps but does not lose the column", () => {
    const s = mount("abcdef\nxy\nabcdef", 4);
    s.keys("j");
    expect(s.head()).toBe(8);
    s.keys("j");
    expect(s.head()).toBe(14);
    s.done();
  });

  test("the column survives an empty line", () => {
    const s = mount("abcdef\n\nabcdef", 4);
    s.keys("j");
    expect(s.head()).toBe(7);
    s.keys("j");
    expect(s.head()).toBe(12);
    s.done();
  });

  test("k restores it going back up", () => {
    const s = mount("abcdef\nxy\nabcdef", 13);
    s.keys("k", "k");
    expect(s.head()).toBe(3);
    s.done();
  });

  test("a horizontal motion resets the column", () => {
    const s = mount("abcdef\nxy\nabcdef", 4);
    s.keys("j", "h", "j");
    expect(s.head()).toBe(10);
    s.done();
  });

  test("the column is measured in graphemes, not bytes", () => {
    const s = mount("中文字符\nab\n中文字符", 2);
    s.keys("j", "j");
    expect(s.head()).toBe(10);
    s.done();
  });

  test("j on the last line and k on the first stay put", () => {
    const a = mount("abc\ndef", 5);
    a.keys("j");
    expect(a.head()).toBe(5);
    a.done();
    const b = mount("abc\ndef", 1);
    b.keys("k");
    expect(b.head()).toBe(1);
    b.done();
  });
});

describe("h and l never leave the line", () => {
  test("h at a line start and l at a line end hold", () => {
    const a = mount("abc\ndef", 4);
    a.keys("h");
    expect(a.head()).toBe(4);
    a.done();
    const b = mount("abc\ndef", 2);
    b.keys("l");
    expect(b.head()).toBe(2);
    b.done();
  });

  test("l stops on the last character rather than past it", () => {
    const s = mount("abcd", 0);
    s.keys("l", "l", "l", "l", "l");
    expect(s.head()).toBe(3);
    s.done();
  });

  test("both are no-ops on an empty line", () => {
    const a = mount("abc\n\ndef", 4);
    a.keys("h");
    expect(a.head()).toBe(4);
    a.keys("l");
    expect(a.head()).toBe(4);
    a.done();
  });

  test("they step whole grapheme clusters", () => {
    const emoji = mount("a👨‍👩‍👧b", 1);
    emoji.keys("l");
    expect(emoji.head()).toBe(9);
    emoji.keys("h");
    expect(emoji.head()).toBe(1);
    emoji.done();
  });

  test("an inline formula is entered at its boundary, not mid-TeX", () => {
    const s = mount(String.raw`a \(x\) b`, 0);
    s.keys("l", "l");
    expect(s.head()).toBe(2);
    s.done();
  });
});
