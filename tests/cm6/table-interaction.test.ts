import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { undoDepth } from "@codemirror/commands";
import { createEditor, type Editor } from "../../src/editor-api.ts";

const markdown = "before\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n\nafter";
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  editors.push(editor);
  return { editor, host };
}

/** Click a rendered cell: the table's source opens with the caret in it. */
function clickCell(host: HTMLElement, row: number, col: number) {
  const cell = host.querySelector<HTMLTableElement>(".cm-table-block table")!.rows[row]!.cells[col] as HTMLTableCellElement;
  cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
}

function key(target: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

/** Type TEXT at the caret as the main editor's input does. */
function type(editor: Editor, text: string) {
  const { from, to } = editor.view.state.selection.main;
  editor.view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
}

// A table cell is document text: input-method composition, completion and
// snippets are the main editor's (tests/vim-input-method.test.ts,
// tests/host-input-focus.test.ts, tests/snippets.test.ts), not the table's.
describe("table cells edited through the main editor", () => {
  it("Shift-Enter replaces the selection in a cell with a line break, staying in the cell", () => {
    const { editor, host } = mount();
    clickCell(host, 1, 0);
    // Keyboard handling, not focus, is under test; a focused view would make
    // happy-dom report the written selection back synchronously.
    (document.activeElement as HTMLElement | null)?.blur();
    const one = editor.getMarkdown().indexOf("one");
    editor.view.dispatch({ selection: { anchor: one + 1, head: one + 2 } });
    key(editor.view.contentDOM, { key: "Enter", shiftKey: true });
    expect(editor.getMarkdown()).toContain("| o<br>e | two |");
    expect(editor.view.state.selection.main.head).toBe(one + 5);
  });

  it("edits in two cells are two reversible steps even within 500 ms", () => {
    const { editor, host } = mount();
    clickCell(host, 1, 0);
    type(editor, " edit");
    const two = editor.getMarkdown().indexOf("two") + 3;
    editor.view.dispatch({ selection: { anchor: two } });
    type(editor, " more");
    expect(undoDepth(editor.view.state)).toBe(2);
    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toContain("| one edit | two |");
    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
    expect(editor.redo()).toBe(true);
    expect(editor.getMarkdown()).toContain("| one edit | two |");
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("undo works from a selected rendered cell and returns the caret to the edit: %j", async (modifier) => {
    const { editor, host } = mount();
    clickCell(host, 1, 0);
    type(editor, " changed");
    editor.view.dispatch({ selection: { anchor: 0 } });
    const cell = host.querySelector<HTMLTableElement>(".cm-table-block table")!.rows[1]!.cells[0] as HTMLTableCellElement;
    cell.focus();
    expect(key(cell, { key: "z", ...modifier }).defaultPrevented).toBe(true);
    await frame();
    expect(editor.getMarkdown()).toBe(markdown);
    // As everywhere in the document, undo puts the caret back at the change:
    // inside the table, which therefore shows its source.
    const head = editor.view.state.selection.main.head;
    expect(editor.view.state.doc.lineAt(head).text).toBe("| one | two |");
    expect(editor.redo()).toBe(true);
    expect(editor.getMarkdown()).toContain("| one changed | two |");
  });
});
