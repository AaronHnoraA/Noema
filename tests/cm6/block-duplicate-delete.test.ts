/** Block menu actions (MarkText paragraph front menu): duplicate and delete. */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); document.body.replaceChildren(); });

function open(doc: string, at: number): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const ed = createEditorCM6(host, { initialContent: doc });
  ed.setSelection(at, at);
  editors.push(ed);
  return ed;
}

describe("duplicate block", () => {
  it.each([
    ["a paragraph, set apart by a blank line", "one\ntwo\n\nnext", 1, "one\ntwo\n\none\ntwo\n\nnext"],
    ["a list item as the next sibling", "- a\n- b\n", 5, "- a\n- b\n- b\n"],
    ["a table without merging the copies", "| a |\n|-|\n| 1 |\n", 0, "| a |\n|-|\n| 1 |\n\n| a |\n|-|\n| 1 |\n"],
    ["a final paragraph without a trailing newline", "x\n\nlast", 4, "x\n\nlast\n\nlast"],
  ])("%s", (_, doc, at, expected) => {
    const ed = open(doc, at);
    expect(ed.runCommand("duplicate-block")).toBe(true);
    expect(ed.getMarkdown()).toBe(expected);
  });

  it("puts the caret at the same place in the copy", () => {
    const ed = open("para\n", 2);
    ed.runCommand("duplicate-block");
    expect(ed.getMarkdown()).toBe("para\n\npara\n");
    expect(ed.getMarkdownSelection().from).toBe(8);
  });
});

describe("delete block", () => {
  it.each([
    ["keeps one blank line between neighbours", "a\n\nmiddle\n\nb", 4, "a\n\nb"],
    ["removes a list item", "- a\n- b\n- c", 5, "- a\n- c"],
    ["removes the last block cleanly", "a\n\nlast", 4, "a\n"],
    ["removes the first block", "first\n\nb", 1, "b"],
  ])("%s", (_, doc, at, expected) => {
    const ed = open(doc, at);
    expect(ed.runCommand("delete-block")).toBe(true);
    expect(ed.getMarkdown()).toBe(expected);
  });
});
