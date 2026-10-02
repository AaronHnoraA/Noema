/** Shift-Enter continues the item or quote without a new marker (HyperMD newline). */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { ensureSyntaxTree } from "@codemirror/language";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];
afterEach(() => { while (editors.length) editors.pop()!.destroy(); document.body.replaceChildren(); });

function shiftEnter(doc: string, at = doc.length): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const ed = createEditorCM6(host, { initialContent: doc });
  editors.push(ed);
  ed.setSelection(at, at);
  ed.view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
  return ed;
}

describe("Shift-Enter", () => {
  it.each([
    ["- item", "- item\n  "],
    ["10. item", "10. item\n    "],
    ["- [ ] task", "- [ ] task\n      "],
    ["> quote", "> quote\n> "],
    ["> - quoted item", "> - quoted item\n>   "],
    ["  continued text", "  continued text\n  "],
    ["plain", "plain\n"],
  ])("%j", (doc, expected) => {
    const ed = shiftEnter(doc);
    expect(ed.getMarkdown()).toBe(expected);
    expect(ed.getMarkdownSelection().from).toBe(expected.length);
  });

  it("keeps a second line inside the list item", () => {
    const ed = shiftEnter("- item");
    ed.view.dispatch(ed.view.state.replaceSelection("more"));
    const tree = ensureSyntaxTree(ed.view.state, ed.view.state.doc.length, 1000)!;
    const items: string[] = [];
    tree.iterate({ enter: (node) => { if (node.name === "ListItem") items.push(ed.view.state.doc.sliceString(node.from, node.to)); } });
    expect(items).toEqual(["- item\n  more"]);
  });

  it("leaves code fences to the ordinary newline", () => {
    const doc = "```\n  x\n```";
    const ed = shiftEnter(doc, 7);
    expect(ed.getMarkdown()).toBe("```\n  x\n  \n```");
  });
});
