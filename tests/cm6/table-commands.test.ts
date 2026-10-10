/** Table commands keep a table a table, wherever the cursor is in it. */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];

function open(doc: string, position: number): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: doc });
  editor.setSelection(position, position);
  editors.push(editor);
  return editor;
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

const TABLE = "| A | B |\n| --- | --- |\n| 1 | 2 |";

describe("table commands", () => {
  it("inserts a row below the delimiter when the cursor is in the header", () => {
    const ed = open(TABLE, 3);
    expect(ed.runCommand("table-insert-row")).toBe(true);
    expect(ed.getMarkdown()).toBe("| A | B |\n| --- | --- |\n|   |   |\n| 1 | 2 |");
    // The cursor is in the new row's first cell.
    const { from } = ed.getMarkdownSelection();
    expect(ed.getMarkdown().slice(0, from)).toBe("| A | B |\n| --- | --- |\n| ");
  });

  it("inserts a row below the current body row", () => {
    const ed = open(TABLE, TABLE.length - 3);
    ed.runCommand("table-insert-row");
    expect(ed.getMarkdown()).toBe("| A | B |\n| --- | --- |\n| 1 | 2 |\n|   |   |");
  });

  it("deletes the only body row of a table at the end of the note", () => {
    const ed = open(TABLE, TABLE.length - 3);
    expect(ed.runCommand("table-delete-row")).toBe(true);
    expect(ed.getMarkdown()).toBe("| A | B |\n| --- | --- |");
    const { from } = ed.getMarkdownSelection();
    expect(from).toBeLessThanOrEqual(ed.getMarkdown().length);
    expect(from).toBeGreaterThan("| A | B |\n".length);
  });

  it("deletes a body row and keeps the cursor inside the table", () => {
    const doc = `${TABLE}\n| 3 | 4 |\n\nAfter`;
    const ed = open(doc, doc.indexOf("| 3") + 2);
    ed.runCommand("table-delete-row");
    expect(ed.getMarkdown()).toBe(`${TABLE}\n\nAfter`);
    expect(ed.getMarkdownSelection().from).toBeLessThanOrEqual(TABLE.length);
  });

  it("never deletes the header or the delimiter row", () => {
    expect(open(TABLE, 3).runCommand("table-delete-row")).toBe(false);
    expect(open(TABLE, 12).runCommand("table-delete-row")).toBe(false);
  });
});
