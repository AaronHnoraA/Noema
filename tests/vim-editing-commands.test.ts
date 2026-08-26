/**
 * Normal-mode editing commands that counts, or the editor's own Markdown
 * behavior, had passed by.
 *
 *  - `3rz` replaced one character instead of three.
 *  - `3>>` indented one line instead of three.
 *  - Leaving Visual after `y` parked the caret at the far end of the yank
 *    instead of its start, because collapsing the still-selected range
 *    overwrote the caret position the yank had asked for.
 *  - `o` copied only a line's indentation, so it opened a bare line under
 *    `- item` while Enter continued the list.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";
import { indentMarkdownBlock, markdownContinuationPrefix } from "../src/cm6/commands/index.ts";

function mount(text: string, at = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const unhandled: string[] = [];
  const vim = createVimLite(editor, host, {
    onUnhandledKey: (seq) => unhandled.push(seq),
    onIndent: (direction) => indentMarkdownBlock(editor.view, direction),
  });
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

describe("r takes a count", () => {
  test("3r replaces three characters", () => {
    const s = mount("abcdef", 0);
    s.keys("3", "r", "z");
    expect(s.markdown()).toBe("zzzdef");
    s.done();
  });

  test("the caret lands on the last replaced character", () => {
    const s = mount("abcdef", 0);
    s.keys("3", "r", "z");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("a bare r still replaces one and stays on it", () => {
    const s = mount("abc", 1);
    s.keys("r", "z");
    expect(s.markdown()).toBe("azc");
    expect(s.head()).toBe(1);
    s.done();
  });

  test("it refuses when the line is too short, like Vim", () => {
    const s = mount("ab\ncd", 0);
    s.keys("5", "r", "z");
    expect(s.markdown()).toBe("ab\ncd");
    s.done();
  });

  test("it never runs past the end of the line", () => {
    const s = mount("abc\ndef", 1);
    s.keys("2", "r", "z");
    expect(s.markdown()).toBe("azz\ndef");
    s.done();
  });

  test("a count does not disturb replacing with a digit", () => {
    const s = mount("abcdef", 0);
    s.keys("2", "r", "7");
    expect(s.markdown()).toBe("77cdef");
    s.done();
  });

  test("Escape abandons a pending r silently", () => {
    const s = mount("abc", 1);
    s.keys("r", "Escape");
    expect(s.markdown()).toBe("abc");
    expect(s.unhandled).toEqual([]);
    s.done();
  });

  test("r still replaces a whole Visual selection", () => {
    const s = mount("abcdef", 1);
    s.keys("v", "l", "l", "r", "z");
    expect(s.markdown()).toBe("azzzef");
    s.done();
  });
});

describe("indent takes a count", () => {
  test("3>> indents three lines", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("3", ">", ">");
    expect(s.markdown()).toBe("  a\n  b\n  c\nd");
    s.done();
  });

  test("3<< outdents three lines", () => {
    const s = mount("  a\n  b\n  c\nd", 2);
    s.keys("3", "<", "<");
    expect(s.markdown()).toBe("a\nb\nc\nd");
    s.done();
  });

  test("a bare >> still indents one line", () => {
    const s = mount("a\nb", 0);
    s.keys(">", ">");
    expect(s.markdown()).toBe("  a\nb");
    s.done();
  });

  test("the caret ends on the first non-blank of the first line", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("3", ">", ">");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("a count past the end of the document clamps", () => {
    const s = mount("a\nb", 0);
    s.keys("9", ">", ">");
    expect(s.markdown()).toBe("  a\n  b");
    s.done();
  });

  test("it indents list items as list items", () => {
    const s = mount("- a\n- b\n- c\n- d", 2);
    s.keys("3", ">", ">");
    expect(s.markdown()).toBe("  - a\n  - b\n  - c\n- d");
    s.done();
  });

  test("a motion afterwards starts from a clean count", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("3", ">", ">");
    s.keys("j");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("Escape abandons a pending indent silently", () => {
    const s = mount("a\nb", 0);
    s.keys(">", "Escape");
    expect(s.markdown()).toBe("a\nb");
    expect(s.unhandled).toEqual([]);
    s.done();
  });
});

describe("yanking in Visual leaves the caret at the start", () => {
  test("characterwise", () => {
    const s = mount("abcdef", 2);
    s.keys("v", "l", "y");
    expect(s.register()?.text).toBe("cd");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("linewise", () => {
    const s = mount("aaa\nbbb\nccc", 4);
    s.keys("V", "j", "y");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("a backwards selection also starts where the text does", () => {
    const s = mount("abcdef", 4);
    s.keys("v", "h", "h", "y");
    expect(s.register()?.text).toBe("cde");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("deleting still leaves the caret where the text was removed", () => {
    const s = mount("abcdef", 1);
    s.keys("v", "l", "d");
    expect(s.markdown()).toBe("adef");
    expect(s.head()).toBe(1);
    s.done();
  });
});

describe("o and O continue the Markdown block, like Enter", () => {
  test("a bullet list", () => {
    const s = mount("- item", 3);
    s.keys("o");
    expect(s.markdown()).toBe("- item\n- ");
    expect(s.vim.mode()).toBe("insert");
    s.done();
  });

  test("an ordered list numbers the next item", () => {
    const s = mount("1. item", 4);
    s.keys("o");
    expect(s.markdown()).toBe("1. item\n2. ");
    s.done();
  });

  test("a task list", () => {
    const s = mount("- [ ] task", 8);
    s.keys("o");
    expect(s.markdown()).toBe("- [ ] task\n- [ ] ");
    s.done();
  });

  test("a block quote", () => {
    const s = mount("> quoted", 4);
    s.keys("o");
    expect(s.markdown()).toBe("> quoted\n> ");
    s.done();
  });

  test("a nested list keeps its indentation and its marker", () => {
    const s = mount("  - item", 5);
    s.keys("o");
    expect(s.markdown()).toBe("  - item\n  - ");
    s.done();
  });

  test("O opens the continued line above", () => {
    const s = mount("- item", 3);
    s.keys("O");
    expect(s.markdown()).toBe("- \n- item");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("an empty item opens a bare line, the way Enter declines to continue it", () => {
    const s = mount("- ", 2);
    s.keys("o");
    expect(s.markdown()).toBe("- \n");
    s.done();
  });

  test("plain indented prose still only carries its indentation", () => {
    const s = mount("    abc", 5);
    s.keys("o");
    expect(s.markdown()).toBe("    abc\n    ");
    s.done();
  });

  test("an unindented paragraph opens a bare line", () => {
    const s = mount("abc\ndef", 1);
    s.keys("o");
    expect(s.markdown()).toBe("abc\n\ndef");
    s.done();
  });
});

describe("the continuation prefix is one shared rule", () => {
  test("it matches what Enter continues", () => {
    expect(markdownContinuationPrefix("- item")).toBe("- ");
    expect(markdownContinuationPrefix("* item")).toBe("* ");
    expect(markdownContinuationPrefix("1. item")).toBe("2. ");
    expect(markdownContinuationPrefix("3) item")).toBe("4) ");
    expect(markdownContinuationPrefix("- [ ] task")).toBe("- [ ] ");
    expect(markdownContinuationPrefix("> quoted")).toBe("> ");
    expect(markdownContinuationPrefix("  - item")).toBe("  - ");
  });

  test("an empty block and plain prose fall back to indentation", () => {
    expect(markdownContinuationPrefix("- ")).toBe("");
    expect(markdownContinuationPrefix("> ")).toBe("");
    expect(markdownContinuationPrefix("    abc")).toBe("    ");
    expect(markdownContinuationPrefix("abc")).toBe("");
    expect(markdownContinuationPrefix("")).toBe("");
  });
});
