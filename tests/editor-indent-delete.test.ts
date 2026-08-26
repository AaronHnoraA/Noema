/**
 * Tab and Backspace have to agree about how big one indent step is.
 *
 * `runEditorTab` inserts one indent unit, but the delete chain bottomed out in
 * a single-grapheme delete, so Tab followed by Backspace left the line one
 * space shallower than it started. Backspace inside leading whitespace now
 * falls back to the previous tab stop, which is CodeMirror's own
 * `deleteCharBackward` rule.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { runEditorDelete, runEditorTab, runEditorTextInput } from "../src/cm6/input-commands.ts";

function mount(text: string, at = 0, to = at) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: text });
  editor.setSelection(at, to);
  return {
    editor,
    view: editor.view,
    markdown: () => editor.getMarkdown(),
    head: () => editor.getMarkdownSelection().from,
    done: () => { editor.destroy(); host.remove(); },
  };
}

describe("Tab and Backspace round-trip", () => {
  test("Tab then Backspace returns the line to where it started", () => {
    const s = mount("abc", 3);
    runEditorTab(s.view, false);
    const indented = s.markdown();
    expect(indented).not.toBe("abc");
    s.editor.setSelection(indented.length - 3, indented.length - 3);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("abc");
    s.done();
  });
});

describe("Backspace in leading whitespace snaps to the previous tab stop", () => {
  test("from one full indent", () => {
    const s = mount("  abc", 2);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("abc");
    expect(s.head()).toBe(0);
    s.done();
  });

  test("from two full indents", () => {
    const s = mount("    abc", 4);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("  abc");
    s.done();
  });

  test("an off-stop caret only falls back to the stop below it", () => {
    const s = mount("   abc", 3);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("  abc");
    s.done();
  });

  test("a single space still deletes as one character", () => {
    const s = mount(" abc", 1);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("abc");
    s.done();
  });
});

describe("it never widens an ordinary Backspace", () => {
  test("a space between words is one character", () => {
    const s = mount("a   b", 4);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("a  b");
    s.done();
  });

  test("indentation after the first non-blank is not leading whitespace", () => {
    const s = mount("ab    cd", 6);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("ab   cd");
    s.done();
  });

  test("a caret in the middle of a word", () => {
    const s = mount("  abcd", 4);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("  acd");
    s.done();
  });

  test("a literal tab is deleted whole, not expanded", () => {
    const s = mount("\t\tabc", 2);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("\tabc");
    s.done();
  });

  test("a selection still deletes exactly the selection", () => {
    const s = mount("    abc", 1, 6);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe(" c");
    s.done();
  });

  test("Backspace at the very start of the document does nothing", () => {
    const s = mount("  abc", 0);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("  abc");
    s.done();
  });

  test("a list marker still outdents rather than eating indentation", () => {
    const s = mount("- item", 2);
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("item");
    s.done();
  });

  test("an auto-closed bracket pair still deletes as a pair", () => {
    const s = mount("", 0);
    runEditorTextInput(s.view, "(");
    expect(s.markdown()).toBe("()");
    runEditorDelete(s.view, "backward");
    expect(s.markdown()).toBe("");
    s.done();
  });

  test("forward Delete is untouched by the indent rule", () => {
    const s = mount("    abc", 0);
    runEditorDelete(s.view, "forward");
    expect(s.markdown()).toBe("   abc");
    s.done();
  });
});
