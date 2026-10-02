/** Deleting next to an image selects it first, then removes it whole (MarkText). */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { runEditorDelete } from "../../src/cm6/input-commands.ts";
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

describe("deleting an image", () => {
  it.each([
    ["a block image", "![](a.png)\n\nnext", "![](a.png)".length, "\n\nnext"],
    ["an inline image", "text ![](a.png) more", "text ![](a.png)".length, "text  more"],
    ["an image with layout attributes", "![cap](a.png){width=50%}\n", "![cap](a.png){width=50%}".length, "\n"],
  ])("Backspace after %s selects it, then deletes it", (_, doc, at, after) => {
    const ed = open(doc, at);
    runEditorDelete(ed.view, "backward");
    expect(ed.getMarkdown()).toBe(doc);
    const selection = ed.getMarkdownSelection();
    expect(doc.slice(selection.from, selection.to)).toMatch(/^!\[[^\]]*\]\(a\.png\)/);
    runEditorDelete(ed.view, "backward");
    expect(ed.getMarkdown()).toBe(after);
  });

  it("Delete before an image selects it", () => {
    const ed = open("x\n![](a.png)", 2);
    runEditorDelete(ed.view, "forward");
    expect(ed.getMarkdownSelection()).toEqual({ from: 2, to: 12 });
  });

  it("leaves ordinary text and links alone", () => {
    const ed = open("[a](b) c", 6);
    runEditorDelete(ed.view, "backward");
    expect(ed.getMarkdown()).toBe("[a](b c");
  });
});
