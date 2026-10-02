/** Undo steps follow words and insert/delete switches (MarkText history rules). */

import { describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { runEditorDelete, runEditorTextInput } from "../../src/cm6/input-commands.ts";

function open(doc = "") {
  const host = document.createElement("div");
  document.body.append(host);
  return createEditorCM6(host, { initialContent: doc });
}

function type(editor: ReturnType<typeof open>, text: string) {
  for (const char of text) runEditorTextInput(editor.view, char);
}

describe("history grouping", () => {
  it("undoes a quickly typed sentence one word at a time", () => {
    const ed = open();
    type(ed, "hello brave world");
    expect(ed.getMarkdown()).toBe("hello brave world");
    ed.undo();
    expect(ed.getMarkdown()).toBe("hello brave");
    ed.undo();
    expect(ed.getMarkdown()).toBe("hello");
    ed.undo();
    expect(ed.getMarkdown()).toBe("");
    ed.destroy();
  });

  it("separates a correction from the typing before it", () => {
    const ed = open();
    type(ed, "helo");
    runEditorDelete(ed.view, "backward");
    type(ed, "lo");
    expect(ed.getMarkdown()).toBe("hello");
    ed.undo();
    expect(ed.getMarkdown()).toBe("hel");
    ed.undo();
    expect(ed.getMarkdown()).toBe("helo");
    ed.undo();
    expect(ed.getMarkdown()).toBe("");
    ed.destroy();
  });
});
