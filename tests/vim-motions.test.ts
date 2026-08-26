/**
 * Counts and the core motions/operators that Normal mode was missing.
 *
 * Before this, every digit, `e`, `^`, `{`, `}`, `f`/`t`, `D`, `C`, `Y`, `J`
 * and `~` fell through to `reportUnhandled`, so the most ordinary Vim habits
 * ("3j", "dw"-adjacent editing, "ct,") did nothing at all.
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
    selection: () => editor.getMarkdownSelection(),
    markdown: () => editor.getMarkdown(),
    done: () => { vim.destroy(); editor.destroy(); host.remove(); },
  };
}

describe("count prefixes", () => {
  test("3j moves three lines", () => {
    const s = mount("a\nb\nc\nd\ne", 0);
    s.keys("3", "j");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("2k moves back two lines", () => {
    const s = mount("a\nb\nc\nd\ne", 8);
    s.keys("2", "k");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("multi-digit counts accumulate", () => {
    const s = mount("abcdefghijklmnop", 0);
    s.keys("1", "2", "l");
    expect(s.head()).toBe(12);
    s.done();
  });

  test("0 is a motion on its own but a digit inside a count", () => {
    const s = mount("abcdefghijklmnop", 5);
    s.keys("0");
    expect(s.head()).toBe(0);
    s.keys("1", "0", "l");
    expect(s.head()).toBe(10);
    s.done();
  });

  test("3w crosses three words", () => {
    const s = mount("one two three four", 0);
    s.keys("3", "w");
    expect(s.head()).toBe(14);
    s.done();
  });

  test("3x deletes three characters and yanks all of them", () => {
    const s = mount("abcdef", 0);
    s.keys("3", "x");
    expect(s.markdown()).toBe("def");
    const register = (window as unknown as { __aaronoteVimRegister?: { text: string } }).__aaronoteVimRegister;
    expect(register?.text).toBe("abc");
    s.done();
  });

  test("2dd deletes two lines and yanks both", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("2", "d", "d");
    expect(s.markdown()).toBe("c\nd");
    const register = (window as unknown as { __aaronoteVimRegister?: { text: string } }).__aaronoteVimRegister;
    expect(register?.text).toBe("a\nb\n");
    s.done();
  });

  test("d3d is the same as 3dd", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("d", "3", "d");
    expect(s.markdown()).toBe("d");
    s.done();
  });

  test("2d3d multiplies to six lines, like Vim", () => {
    const s = mount("a\nb\nc\nd\ne\nf\ng", 0);
    s.keys("2", "d", "3", "d");
    expect(s.markdown()).toBe("g");
    s.done();
  });

  test("2yy yanks two lines", () => {
    const s = mount("a\nb\nc", 0);
    s.keys("2", "y", "y");
    const register = (window as unknown as { __aaronoteVimRegister?: { text: string } }).__aaronoteVimRegister;
    expect(register?.text).toBe("a\nb\n");
    s.done();
  });

  test("a count deleting past the end of the document stops there", () => {
    const s = mount("a\nb", 0);
    s.keys("9", "d", "d");
    expect(s.markdown()).toBe("");
    s.done();
  });

  test("an absurd count is clamped rather than hanging the editor", () => {
    const s = mount("abc", 0);
    s.keys("9", "9", "9", "9", "9", "9", "9", "9", "9", "l");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("a motion clears the count so the next one starts fresh", () => {
    const s = mount("a\nb\nc\nd\ne", 0);
    s.keys("3", "j");
    s.keys("j");
    expect(s.head()).toBe(8);
    s.done();
  });

  test("Escape abandons a half-typed count", () => {
    const s = mount("a\nb\nc\nd\ne", 0);
    s.keys("3", "Escape", "j");
    expect(s.head()).toBe(2);
    s.done();
  });
});

describe("G and gg take a line number", () => {
  test("G alone goes to the end", () => {
    const s = mount("a\nb\nc", 0);
    s.keys("G");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("3G goes to line three", () => {
    const s = mount("aa\nbb\ncc\ndd", 0);
    s.keys("3", "G");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("2gg goes to line two, at its first non-blank", () => {
    const s = mount("aa\n   bb\ncc", 0);
    s.keys("2", "g", "g");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("a line number past the end clamps to the last line", () => {
    const s = mount("a\nb", 0);
    s.keys("9", "G");
    expect(s.head()).toBe(2);
    s.done();
  });
});

describe("e and E stop on the last character of a word", () => {
  test("e from the start of a word", () => {
    const s = mount("foo bar", 0);
    s.keys("e");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("e again crosses to the next word", () => {
    const s = mount("foo bar", 0);
    s.keys("e", "e");
    expect(s.head()).toBe(6);
    s.done();
  });

  test("3e crosses three words", () => {
    const s = mount("one two three", 0);
    s.keys("3", "e");
    expect(s.head()).toBe(12);
    s.done();
  });

  test("e treats punctuation as its own word, E does not", () => {
    const a = mount("foo-bar baz", 0);
    a.keys("e");
    expect(a.head()).toBe(2);
    a.done();
    const b = mount("foo-bar baz", 0);
    b.keys("E");
    expect(b.head()).toBe(6);
    b.done();
  });

  test("e at the end of the document stays on a real character", () => {
    const s = mount("foo", 2);
    s.keys("e");
    expect(s.head()).toBe(2);
    s.done();
  });
});

describe("^ goes to the first non-blank", () => {
  test("from further along the line", () => {
    const s = mount("   abc", 5);
    s.keys("^");
    expect(s.head()).toBe(3);
    s.done();
  });

  test("0 still goes to the true line start", () => {
    const s = mount("   abc", 5);
    s.keys("0");
    expect(s.head()).toBe(0);
    s.done();
  });

  test("an all-blank line falls back to the line start", () => {
    const s = mount("a\n   \nb", 3);
    s.keys("^");
    expect(s.head()).toBe(2);
    s.done();
  });
});

describe("{ and } move by paragraph", () => {
  test("} stops on the blank line between paragraphs", () => {
    const s = mount("one\ntwo\n\nthree\nfour", 0);
    s.keys("}");
    expect(s.head()).toBe(8);
    s.done();
  });

  test("} from the last paragraph lands at the end of the document", () => {
    const s = mount("one\n\ntwo", 6);
    s.keys("}");
    expect(s.head()).toBe(7);
    s.done();
  });

  test("{ walks back to the previous blank line", () => {
    const s = mount("one\n\ntwo\nthree", 10);
    s.keys("{");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("{ from the first paragraph lands at the start", () => {
    const s = mount("one\ntwo", 5);
    s.keys("{");
    expect(s.head()).toBe(0);
    s.done();
  });

  test("a run of blank lines is skipped, not stepped through", () => {
    const s = mount("a\n\n\n\nb", 0);
    s.keys("}");
    expect(s.head()).toBe(2);
    s.keys("}");
    expect(s.head()).toBe(5);
    s.done();
  });
});

describe("f, F, t, T and their repeats", () => {
  test("f jumps onto the next occurrence", () => {
    const s = mount("hello world", 0);
    s.keys("f", "o");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("t stops one short of it", () => {
    const s = mount("hello world", 0);
    s.keys("t", "o");
    expect(s.head()).toBe(3);
    s.done();
  });

  test("2fo finds the second occurrence", () => {
    const s = mount("hello world", 0);
    s.keys("2", "f", "o");
    expect(s.head()).toBe(7);
    s.done();
  });

  test("F searches backwards", () => {
    const s = mount("hello world", 10);
    s.keys("F", "o");
    expect(s.head()).toBe(7);
    s.done();
  });

  test("T stops one past it", () => {
    const s = mount("hello world", 10);
    s.keys("T", "o");
    expect(s.head()).toBe(8);
    s.done();
  });

  test("; repeats the last find and , reverses it", () => {
    const s = mount("hello world", 0);
    s.keys("f", "o");
    expect(s.head()).toBe(4);
    s.keys(";");
    expect(s.head()).toBe(7);
    s.keys(",");
    expect(s.head()).toBe(4);
    s.done();
  });

  test("; makes progress after t instead of sticking", () => {
    const s = mount("a.b.c.d", 0);
    s.keys("t", ".");
    expect(s.head()).toBe(0);
    s.keys(";");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("a find never leaves the caret's own line", () => {
    const s = mount("abc\nxyz", 0);
    s.keys("f", "z");
    expect(s.head()).toBe(0);
    expect(s.unhandled).toEqual(["fz"]);
    s.done();
  });

  test("a missing target reports rather than moving", () => {
    const s = mount("abc", 0);
    s.keys("f", "q");
    expect(s.head()).toBe(0);
    expect(s.unhandled).toEqual(["fq"]);
    s.done();
  });

  test("Escape abandons a pending find silently", () => {
    const s = mount("abc", 0);
    s.keys("f", "Escape");
    expect(s.unhandled).toEqual([]);
    expect(s.vim.mode()).toBe("normal");
    s.done();
  });

  test("a digit after f is the literal target, not a count", () => {
    const s = mount("a1b2", 0);
    s.keys("f", "2");
    expect(s.head()).toBe(3);
    s.done();
  });
});

describe("D, C and Y act on the rest of the line", () => {
  test("D deletes to the end of the line", () => {
    const s = mount("abcdef\nnext", 2);
    s.keys("D");
    expect(s.markdown()).toBe("ab\nnext");
    s.done();
  });

  test("D leaves a legal Normal-mode caret", () => {
    const s = mount("abcdef", 2);
    s.keys("D");
    expect(s.head()).toBe(1);
    s.done();
  });

  test("C deletes to the end of the line and opens Insert there", () => {
    const s = mount("abcdef", 2);
    s.keys("C");
    expect(s.markdown()).toBe("ab");
    expect(s.vim.mode()).toBe("insert");
    expect(s.head()).toBe(2);
    s.done();
  });

  test("Y yanks to the end of the line without changing it", () => {
    const s = mount("abcdef", 2);
    s.keys("Y");
    expect(s.markdown()).toBe("abcdef");
    const register = (window as unknown as { __aaronoteVimRegister?: { text: string } }).__aaronoteVimRegister;
    expect(register?.text).toBe("cdef");
    s.done();
  });

  test("D on the last character of a line is a no-op on the text", () => {
    const s = mount("ab\ncd", 1);
    s.keys("D");
    expect(s.markdown()).toBe("a\ncd");
    s.done();
  });
});

describe("J joins lines", () => {
  test("J pulls the next line up with a single space", () => {
    const s = mount("one\ntwo", 0);
    s.keys("J");
    expect(s.markdown()).toBe("one two");
    s.done();
  });

  test("J strips the joined line's indentation", () => {
    const s = mount("one\n      two", 0);
    s.keys("J");
    expect(s.markdown()).toBe("one two");
    s.done();
  });

  test("J does not double an existing trailing space", () => {
    const s = mount("one \ntwo", 0);
    s.keys("J");
    expect(s.markdown()).toBe("one two");
    s.done();
  });

  test("3J joins three lines into one", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("3", "J");
    expect(s.markdown()).toBe("a b c\nd");
    s.done();
  });

  test("J on the last line reports instead of silently doing nothing", () => {
    const s = mount("only", 0);
    s.keys("J");
    expect(s.markdown()).toBe("only");
    expect(s.unhandled).toEqual(["J"]);
    s.done();
  });

  test("the caret lands at the join, as Vim leaves it", () => {
    const s = mount("one\ntwo", 0);
    s.keys("J");
    expect(s.head()).toBe(3);
    s.done();
  });
});

describe("~ swaps case and steps forward", () => {
  test("one character", () => {
    const s = mount("abc", 0);
    s.keys("~");
    expect(s.markdown()).toBe("Abc");
    expect(s.head()).toBe(1);
    s.done();
  });

  test("a count covers that many characters", () => {
    const s = mount("abcdef", 0);
    s.keys("3", "~");
    expect(s.markdown()).toBe("ABCdef");
    expect(s.head()).toBe(3);
    s.done();
  });

  test("uppercase becomes lowercase", () => {
    const s = mount("ABC", 0);
    s.keys("3", "~");
    expect(s.markdown()).toBe("abc");
    s.done();
  });

  test("it never runs past the end of the line", () => {
    const s = mount("ab\ncd", 0);
    s.keys("9", "~");
    expect(s.markdown()).toBe("AB\ncd");
    s.done();
  });

  test("non-letters are left alone but still stepped over", () => {
    const s = mount("a-b", 0);
    s.keys("3", "~");
    expect(s.markdown()).toBe("A-B");
    s.done();
  });
});

describe("counts and the new motions work in Visual mode too", () => {
  test("3l extends the selection by three characters", () => {
    const s = mount("abcdef", 0);
    s.keys("v", "3", "l");
    const { from, to } = s.selection();
    expect(s.markdown().slice(from, to)).toBe("abcd");
    s.done();
  });

  test("e extends to the end of the word", () => {
    const s = mount("foo bar", 0);
    s.keys("v", "e");
    const { from, to } = s.selection();
    expect(s.markdown().slice(from, to)).toBe("foo");
    s.done();
  });

  test("f extends up to the target character", () => {
    const s = mount("hello world", 0);
    s.keys("v", "f", "o");
    const { from, to } = s.selection();
    expect(s.markdown().slice(from, to)).toBe("hello");
    s.done();
  });

  test("^ extends back to the first non-blank", () => {
    const s = mount("   abcdef", 6);
    s.keys("v", "^");
    // Visual is inclusive of the character `v` started on, so the run reaches
    // back from the first non-blank through the caret's own character.
    const { from, to } = s.selection();
    expect(s.markdown().slice(from, to)).toBe("abcd");
    s.done();
  });

  test("2j in Visual-line covers three lines", () => {
    const s = mount("a\nb\nc\nd", 0);
    s.keys("V", "2", "j", "d");
    expect(s.markdown()).toBe("d");
    s.done();
  });

  test("~ swaps the case of the whole Visual selection", () => {
    const s = mount("abcdef", 0);
    s.keys("v", "3", "l", "~");
    expect(s.markdown()).toBe("ABCDef");
    expect(s.vim.mode()).toBe("normal");
    s.done();
  });
});
