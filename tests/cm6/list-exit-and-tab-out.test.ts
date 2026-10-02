/**
 * Leaving a list keeps the new text out of the previous item (MarkText splits
 * the list into list / paragraph / list), and Tab at the end of an inline
 * span's content jumps past its closing markup (MarkText tabHandler).
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { ensureSyntaxTree } from "@codemirror/language";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { runEditorEnter, runEditorTab } from "../../src/cm6/input-commands.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];
function open(doc: string, from: number, to = from): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: doc });
  editor.setSelection(from, to);
  editors.push(editor);
  return editor;
}
afterEach(() => { while (editors.length) editors.pop()!.destroy(); });

function type(ed: Editor, text: string): void {
  ed.view.dispatch(ed.view.state.replaceSelection(text));
}

function listItemCount(ed: Editor): number {
  const tree = ensureSyntaxTree(ed.view.state, ed.view.state.doc.length, 1000)!;
  let count = 0;
  tree.iterate({ enter: (node) => { if (node.name === "ListItem") count++; } });
  return count;
}

describe("leaving a list", () => {
  it("text typed after the last item is a paragraph of its own", () => {
    const ed = open("- a\n- ", 6);
    runEditorEnter(ed.view);
    type(ed, "foo");
    expect(ed.getMarkdown()).toBe("- a\n\nfoo");
    expect(listItemCount(ed)).toBe(1);
  });

  it("an empty middle item splits the list around a paragraph", () => {
    const ed = open("- a\n- \n- c", 6);
    runEditorEnter(ed.view);
    type(ed, "foo");
    expect(ed.getMarkdown()).toBe("- a\n\nfoo\n\n- c");
    expect(listItemCount(ed)).toBe(2);
  });

  it("a lone empty item still clears to nothing", () => {
    const ed = open("- ", 2);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("");
  });

  it("a nested empty item steps out one level", () => {
    const ed = open("- a\n    - b\n    - ", 18);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("- a\n    - b\n- ");
    expect(ed.getMarkdownSelection()).toEqual({ from: 14, to: 14 });
  });

  it("a nested ordered item continues the parent numbering", () => {
    const ed = open("1. a\n    - \n2. b", 11);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("1. a\n2. \n3. b");
  });

  it("an empty quote line leaves the quote with a blank line", () => {
    const ed = open("> a\n> ", 6);
    runEditorEnter(ed.view);
    type(ed, "foo");
    expect(ed.getMarkdown()).toBe("> a\n\nfoo");
  });

  it("an empty quoted item stays in the quote, separated", () => {
    const ed = open("> - a\n> - ", 10);
    runEditorEnter(ed.view);
    type(ed, "foo");
    expect(ed.getMarkdown()).toBe("> - a\n>\n> foo");
  });
});

describe("Tab past inline markup", () => {
  it.each([
    ["x **bold** y", "bold", "x **bold**"],
    ["x *it* y", "it", "x *it*"],
    ["x `code` y", "code", "x `code`"],
    ["x ~~del~~ y", "del", "x ~~del~~"],
    ["x ==mark== y", "mark", "x ==mark=="],
    ["x [text](https://a.b) y", "text", "x [text](https://a.b)"],
    ["x \\(a+b\\) y", "a+b", "x \\(a+b\\)"],
  ])("%s", (doc, inner, through) => {
    const ed = open(doc, doc.indexOf(inner) + inner.length);
    runEditorTab(ed.view);
    expect(ed.getMarkdown()).toBe(doc);
    expect(ed.getMarkdownSelection().from).toBe(through.length);
  });

  it("leaves the innermost span first", () => {
    const doc = "***x*** y";
    const ed = open(doc, 4);
    runEditorTab(ed.view);
    runEditorTab(ed.view);
    expect(ed.getMarkdownSelection().from).toBe(7);
    expect(ed.getMarkdown()).toBe(doc);
  });

  it("keeps list indentation when not at a span end", () => {
    const ed = open("- a\n- b", 7);
    runEditorTab(ed.view);
    expect(ed.getMarkdown()).toBe("- a\n    - b");
  });
});
