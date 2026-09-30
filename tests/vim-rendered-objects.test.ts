/** Rendered math and images are Vim objects; Insert edits their source. */
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";
import { isVisualMode, setVisualMode } from "../src/cm6/extensions/visual/visual-mode.ts";
import { revealFormulaSource } from "../src/cm6/extensions/visual/widgets/math.ts";

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
    keys: (...keys: string[]) => { for (const key of keys) vim.handleKey({ key }); },
    head: () => editor.getMarkdownSelectionRange().head,
    picked: () => {
      const { from, to } = editor.getMarkdownSelection();
      return editor.getMarkdown().slice(from, to);
    },
    markdown: () => editor.getMarkdown(),
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("collapsed formulas as words", () => {
  const source = String.raw`aa \(x+y\) bb`;

  test("w skips the whole formula, and b returns to its start", () => {
    const s = mount(source, 0);
    s.keys("w");
    expect(s.head()).toBe(3);
    s.keys("w");
    expect(s.head()).toBe(11);
    s.keys("b");
    expect(s.head()).toBe(3);
    s.done();
  });

  test("e reaches a formula as a one-character word, then advances past it", () => {
    const s = mount(source, 0);
    s.keys("e");
    expect(s.head()).toBe(1);
    s.keys("e");
    expect(s.head()).toBe(3);
    s.keys("e");
    expect(s.head()).toBe(12);
    s.done();
  });

  test("v selects the whole rendered formula", () => {
    const s = mount(source, 3);
    s.keys("v");
    expect(s.picked()).toBe(String.raw`\(x+y\)`);
    s.done();
  });

  test("cw replaces the formula as one word and opens Insert without changing the view", () => {
    const s = mount(source, 3);
    s.keys("c", "w");
    expect(s.markdown()).toBe("aa  bb");
    expect(s.vim.mode()).toBe("insert");
    expect(isVisualMode(s.editor.view)).toBe(true);
    s.keys("Escape");
    expect(isVisualMode(s.editor.view)).toBe(true);
    s.done();
  });

  test("diw deletes exactly one collapsed formula", () => {
    const s = mount(source, 3);
    s.keys("d", "i", "w");
    expect(s.markdown()).toBe("aa  bb");
    s.done();
  });

  test("r replaces an unexpanded formula as one visible character", () => {
    const s = mount(source, 3);
    s.keys("r", "Z");
    expect(s.markdown()).toBe("aa Z bb");
    expect(s.head()).toBe(3);
    s.done();
  });

  test("counted r counts an adjacent formula once", () => {
    const s = mount(String.raw`a\(x\)c`, 0);
    s.keys("2", "r", "Z");
    expect(s.markdown()).toBe("ZZc");
    s.done();
  });

  test("case commands leave an unexpanded formula's backing Markdown untouched", () => {
    const s = mount(String.raw`a\(x+y\)b`, 1);
    s.keys("~");
    expect(s.markdown()).toBe(String.raw`a\(x+y\)b`);
    s.keys("g", "U", "i", "w");
    expect(s.markdown()).toBe(String.raw`a\(x+y\)B`);
    s.done();
  });

  test("f skips hidden formula source and finds the next visible character", () => {
    const text = String.raw`aa \(x+y\) + bb`;
    const s = mount(text, 0);
    s.keys("f", "+");
    expect(s.head()).toBe(text.lastIndexOf("+"));
    s.done();

    const hiddenOnly = mount(String.raw`aa \(x+y\) bb`, 0);
    hiddenOnly.keys("f", "+");
    expect(hiddenOnly.head()).toBe(0);
    hiddenOnly.done();
  });

  test("* skips the same word hidden inside a rendered formula", () => {
    const text = String.raw`x \(x\) x`;
    const s = mount(text, 0);
    s.keys("*");
    expect(s.head()).toBe(text.lastIndexOf("x"));
    s.done();
  });

  test("a enters the formula's TeX content without changing the view", () => {
    const s = mount(source, 3);
    s.keys("a");
    expect(isVisualMode(s.editor.view)).toBe(true);
    expect(s.head()).toBe(8);
    expect(s.editor.view.dom.querySelector(".cm-math-inline")).toBeNull();
    s.keys("Escape");
    expect(isVisualMode(s.editor.view)).toBe(true);
    s.done();
  });

  test("I and A leave a revealed formula for the row edges", () => {
    const text = String.raw`start \(x+y\) end`;
    for (const [key, target] of [["I", 0], ["A", text.length]] as const) {
      const s = mount(text, text.indexOf("x+y"));
      try {
        const from = text.indexOf(String.raw`\(`);
        expect(revealFormulaSource(s.editor.view, from, text.indexOf(String.raw`\)`) + 2, 0)).toBe(true);
        s.editor.setSelection(text.indexOf("x+y") + 1);
        s.vim.syncSelectionFromEditor();
        s.keys(key);
        expect(s.vim.mode()).toBe("insert");
        expect(s.head()).toBe(target);
      } finally {
        s.done();
      }
    }
  });

  test("I and A leave a revealed display formula across its fence lines", () => {
    const text = "before\n\\[\nx+y\n\\]\nafter";
    for (const [key, target] of [
      ["I", text.indexOf(String.raw`\[`) ],
      ["A", text.indexOf(String.raw`\]`) + 2],
    ] as const) {
      const s = mount(text, text.indexOf("x+y"));
      try {
        const from = text.indexOf(String.raw`\[`);
        expect(revealFormulaSource(s.editor.view, from, text.indexOf(String.raw`\]`) + 2, 0)).toBe(true);
        s.editor.setSelection(text.indexOf("x+y") + 1);
        s.vim.syncSelectionFromEditor();
        s.keys(key);
        expect(s.vim.mode()).toBe("insert");
        expect(s.head()).toBe(target);
      } finally {
        s.done();
      }
    }
  });

  test("a on plain prose keeps nearby rendered objects and only moves one character", () => {
    const s = mount(source, 0);
    s.keys("a");
    expect(s.head()).toBe(1);
    expect(s.vim.mode()).toBe("insert");
    expect(isVisualMode(s.editor.view)).toBe(true);
    expect(s.editor.view.dom.querySelector(".cm-math-inline")).not.toBeNull();
    s.done();
  });
});

describe("the explicit rendered-object whitelist", () => {
  test("an image is one object in Normal and Visual mode", () => {
    const s = mount("pre ![x](a.png) post", 0);
    s.keys("w");
    expect(s.head()).toBe(4);
    s.keys("v");
    expect(s.picked()).toBe("![x](a.png)");
    s.done();
  });

  test("w moves past a rendered image as one word", () => {
    const s = mount("pre ![x](a.png) post", 0);
    s.keys("w", "w");
    expect(s.head()).toBe(16);
    s.done();
  });

  test("diw on an image removes its complete Markdown source", () => {
    const s = mount("pre ![x](a.png) post", 4);
    s.keys("d", "i", "w");
    expect(s.markdown()).toBe("pre  post");
    s.done();
  });

  test("r replaces a rendered image as one visible character", () => {
    const s = mount("pre ![x](a.png) post", 4);
    s.keys("r", "Z");
    expect(s.markdown()).toBe("pre Z post");
    s.done();
  });

  test("f does not find characters hidden in an image's Markdown", () => {
    const s = mount("pre ![x](a.png) post", 0);
    s.keys("f", "x");
    expect(s.head()).toBe(0);
    s.done();
  });

  test("a count skips an image beyond the mounted viewport as one word", () => {
    const text = "x\n".repeat(2000) + "![x](a.png) tail";
    const s = mount(text, 0);
    expect(s.editor.view.viewport.to).toBeLessThan(text.indexOf("!["));
    s.keys("2", "0", "0", "1", "w");
    expect(s.head()).toBe(text.indexOf("tail"));
    s.done();
  });

  test("inline code stays character-level", () => {
    const s = mount("a `x+y` b", 2);
    s.keys("v");
    expect(s.picked()).toBe("`");
    s.done();
  });

  test("footnote references and block reference chips are one object each", () => {
    const footnote = mount("a [^note] b", 2);
    footnote.keys("v");
    expect(footnote.picked()).toBe("[^note]");
    footnote.done();

    const reference = "((20260825095344-i40x2sr))";
    const block = mount(`a ${reference} b`, 2);
    block.keys("v");
    expect(block.picked()).toBe(reference);
    block.done();
  });

  test("a rendered task checkbox is one object", () => {
    const s = mount("- [ ] task", 2);
    s.keys("v");
    expect(s.picked()).toBe("[ ]");
    s.done();
  });

  test("Insert entry keys preserve the reader's current view", () => {
    const s = mount("text ![x](a.png) and \\(x\\)", 0);
    expect(isVisualMode(s.editor.view)).toBe(true);
    for (const key of ["i", "a", "I", "A", "o", "O"]) {
      s.keys(key);
      expect(s.vim.mode()).toBe("insert");
      expect(isVisualMode(s.editor.view)).toBe(true);
      s.keys("Escape");
      expect(isVisualMode(s.editor.view)).toBe(true);
    }

    s.editor.view.dispatch(setVisualMode(false));
    s.keys("i");
    expect(isVisualMode(s.editor.view)).toBe(false);
    s.keys("Escape");
    expect(isVisualMode(s.editor.view)).toBe(false);
    s.done();
  });

  test("creating and destroying the Vim controller does not change the view", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: "ordinary text" });
    expect(isVisualMode(editor.view)).toBe(true);
    const vim = createVimLite(editor, host);
    expect(isVisualMode(editor.view)).toBe(true);
    vim.destroy();
    expect(isVisualMode(editor.view)).toBe(true);
    editor.destroy();
    host.remove();
  });

  test("adopting a pointer selection updates the mode used by rendered objects", () => {
    const s = mount("one ![x](a.png) two", 0);
    s.keys("i");
    s.editor.setSelection(0, 3);
    s.vim.syncSelectionFromEditor();
    expect(s.vim.mode()).toBe("visual");
    expect(s.editor.view.dom.dataset.vimMode).toBe("visual");
    expect(isVisualMode(s.editor.view)).toBe(true);
    s.done();
  });
});
