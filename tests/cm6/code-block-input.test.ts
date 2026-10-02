/** Typing in fenced code (MarkText codeBlockContent rules). */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { runEditorEnter, runEditorTab } from "../../src/cm6/input-commands.ts";
import { exitFencedCode } from "../../src/cm6/code-block-input.ts";
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

describe("fenced code typing", () => {
  it("Enter between braces opens an indented line", () => {
    const doc = "```js\nif (a) {}\n```";
    const ed = open(doc, doc.indexOf("{}") + 1);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("```js\nif (a) {\n    \n}\n```");
    expect(ed.getMarkdownSelection()).toEqual({ from: 19, to: 19 });
  });

  it("uses the block's own indentation unit and base indent", () => {
    const doc = "```py\ndef f():\n  x = []\n```";
    const ed = open(doc, doc.indexOf("[]") + 1);
    runEditorEnter(ed.view);
    expect(ed.getMarkdown()).toBe("```py\ndef f():\n  x = [\n    \n  ]\n```");
  });

  it("Tab inserts a soft tab at the caret", () => {
    const doc = "```js\na b\n```";
    const ed = open(doc, doc.indexOf(" b"));
    runEditorTab(ed.view);
    expect(ed.getMarkdown()).toBe("```js\na    b\n```");
  });

  it("Tab and Shift-Tab shift selected lines by the block's unit", () => {
    const doc = "```py\nif x:\n  y\nz\n```";
    const ed = open(doc, 6, doc.indexOf("z") + 1);
    runEditorTab(ed.view);
    expect(ed.getMarkdown()).toBe("```py\n  if x:\n    y\n  z\n```");
    ed.setSelection(6, ed.getMarkdown().indexOf("z") + 1);
    runEditorTab(ed.view, true);
    runEditorTab(ed.view, true);
    expect(ed.getMarkdown()).toBe("```py\nif x:\ny\nz\n```");
  });

  it("Tab outside code keeps list behaviour", () => {
    const ed = open("- a\n- b", 7);
    runEditorTab(ed.view);
    expect(ed.getMarkdown()).toBe("- a\n    - b");
  });

  it("Mod-Enter leaves the block for the line after the closing fence", () => {
    const doc = "```js\nx\n```";
    const ed = open(doc, 7);
    expect(exitFencedCode(ed.view)).toBe(true);
    expect(ed.getMarkdown()).toBe("```js\nx\n```\n");
    expect(ed.getMarkdownSelection()).toEqual({ from: doc.length + 1, to: doc.length + 1 });
    const next = open("```js\nx\n```\n\nafter", 7);
    exitFencedCode(next.view);
    expect(next.getMarkdownSelection()).toEqual({ from: 12, to: 12 });
  });
});
