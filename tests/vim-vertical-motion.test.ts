/**
 * `j`/`k` in Normal mode, including the widget-snapping the pixel path does.
 *
 * `moveScreenLine` has two halves. With real layout it moves by wrapped screen
 * row through `EditorView.moveVertically` and then asks `crossedVisualEntry`
 * whether the motion stepped over something the Visual layer collapsed — a
 * display formula, an org-env heading, or a blank line absorbed to zero height.
 * With no layout to measure it falls back to logical lines.
 *
 * A headless DOM reports a zero-sized content box, so the suite only ever
 * reached the fallback and the snapping logic was never executed. It measures
 * nothing itself, so it is tested here directly against an explicit start and
 * target.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite, crossedVisualEntry } from "../aaronnote/vim-lite.ts";
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

function entries(text: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const at = (start: number, target: number, dir: -1 | 1) =>
    crossedVisualEntry(editor, start, target, dir);
  return {
    editor,
    at,
    mathRanges: () => getBlockMathRanges(editor.view.state).map((r) => [r.from, r.to]),
    done: () => { editor.destroy(); host.remove(); },
  };
}

describe("a vertical motion snaps onto a collapsed display formula", () => {
  const DOC = "aaa\n\\[\nx^2\n\\]\nbbb";

  test("the formula is one collapsed range", () => {
    const e = entries(DOC);
    expect(e.mathRanges()).toEqual([[4, 13]]);
    e.done();
  });

  test("moving down over it lands on its start, not past it", () => {
    const e = entries(DOC);
    expect(e.at(1, 16, 1)).toBe(4);
    e.done();
  });

  test("moving up over it lands on its start too", () => {
    const e = entries(DOC);
    expect(e.at(16, 1, -1)).toBe(4);
    e.done();
  });

  test("a motion that stops short of it does not snap", () => {
    const e = entries(DOC);
    expect(e.at(1, 5, 1)).toBe(null);
    e.done();
  });
});

describe("a vertical motion snaps onto an org-env heading", () => {
  const DOC = "aaa\n#+begin theorem T\nBody.\n#+end theorem\nbbb";

  test("downward", () => {
    const e = entries(DOC);
    expect(e.at(1, 42, 1)).toBe(20);
    e.done();
  });

  test("upward", () => {
    const e = entries(DOC);
    expect(e.at(42, 1, -1)).toBe(20);
    e.done();
  });
});

describe("a blank line a block absorbed is still a stop", () => {
  test("downward and upward both land on it", () => {
    const e = entries("aaa\n\nbbb");
    expect(e.at(1, 6, 1)).toBe(4);
    expect(e.at(6, 1, -1)).toBe(4);
    e.done();
  });

  test("ordinary lines with nothing collapsed never snap", () => {
    const e = entries("aaa\nbbb\nccc");
    expect(e.at(1, 5, 1)).toBe(null);
    expect(e.at(5, 1, -1)).toBe(null);
    e.done();
  });

  test("a motion inside one line never snaps", () => {
    const e = entries("aaa\n\nbbb");
    expect(e.at(6, 7, 1)).toBe(null);
    expect(e.at(1, 0, -1)).toBe(null);
    e.done();
  });

  test("Source mode has nothing collapsed, so it never snaps", () => {
    const e = entries("aaa\n\nbbb");
    e.editor.view.dom.classList.remove("aaronnote-visual-typography");
    expect(e.at(1, 6, 1)).toBe(null);
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
