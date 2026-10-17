import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { undoDepth } from "@codemirror/commands";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { cellTarget } from "../../src/cm6/commands/index.ts";
import { runEditorTextInput } from "../../src/cm6/input-commands.ts";

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

/** Put the caret at the end of cell (ROW, COL) in the table's source: it opens as text. */
function clickCell(host: HTMLElement, row: number, col: number, editor = editors[editors.length - 1]!) {
  void host;
  const state = editor.view.state;
  let first = 1;
  while (!/^\s*\|/.test(state.doc.line(first).text)) first++;
  const line = state.doc.line(first + (row === 0 ? 0 : row + 1));
  editor.view.dispatch({ selection: { anchor: line.from + cellTarget(line.text, col).head } });
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
describe("table source edited through the main editor (keyboard entry)", () => {
  it("keeps the toolbar and layout attributes while a cell is active", () => {
    const source = "| A | B |\n| --- | --- |\n| one | two |\n{wrap=right width=40%}\n\nAfter";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    const cell = host.querySelector<HTMLTableCellElement>("tbody td")!;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(host.querySelector(".cm-table-source-toolbar .cm-table-toolbar")).toBeTruthy();
    const row = host.querySelector<HTMLElement>(".cm-table-source-row")!;
    expect(row.classList.contains("aaronnote-table-wrap")).toBe(true);
    expect(row.classList.contains("aaronnote-table-align-right")).toBe(true);
    expect(row.style.getPropertyValue("--aaronnote-table-width")).toBe("40%");
    expect(host.querySelector(".cm-table-source-attrs-hidden")?.textContent).toBe("");
    expect(host.querySelector('.cm-table-source-toolbar button[title="Insert row below"]')).toBeTruthy();
    expect(editor.getMarkdown()).toBe(source);
  });

  it("keeps other cells rendered while the current cell uses the main editor", async () => {
    const source = "| A | B | C |\n| --- | --- | --- |\n| **one** | \\(x+1\\) | three |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    const first = host.querySelector<HTMLTableCellElement>("tbody td")!;
    first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    first.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(host.querySelectorAll(".cm-table-source-active-cell")).toHaveLength(1);
    expect(host.querySelectorAll(".cm-table-source-rendered-cell")).toHaveLength(5);
    const formula = host.querySelector<HTMLElement>(".cm-table-source-rendered-cell .aaronnote-math-inline")!;
    expect(formula).toBeTruthy();
    formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(editor.getMarkdownSelection().from).toBe(source.indexOf("x+1"));
    const body = host.querySelectorAll(".cm-table-source-row")[1]!;
    expect(body.querySelector('.cm-table-source-rendered-cell[data-col="0"] strong')?.textContent).toBe("one");
    expect(body.querySelector('.cm-table-source-rendered-cell[data-col="1"]')).toBeNull();
    expect(body.querySelectorAll(".cm-table-source-active-cell")).toHaveLength(1);
    expect(editor.getMarkdown()).toBe(source);
  });

  it("opens an empty rendered cell in place and types into the document", async () => {
    const source = "| A | B | C |\n| --- | --- | --- |\n| one |  | three |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    const first = host.querySelector<HTMLTableCellElement>("tbody td")!;
    first.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    first.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    host.querySelector<HTMLElement>('.cm-table-source-rendered-cell[data-row="1"][data-col="1"]')!
      .dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    expect(runEditorTextInput(editor.view, "two")).toBe(true);
    expect(editor.getMarkdown()).toContain("| one | two | three |");
    expect(host.querySelectorAll(".cm-table-source-row")).toHaveLength(2);
  });

  it("clicking a rendered cell keeps a visible grid and edits through the document editor", () => {
    const { editor, host } = mount();
    const cell = host.querySelector<HTMLTableElement>(".cm-table-block table")!.rows[1]!.cells[0]!;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
    cell.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, button: 0 }));
    cell.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    expect(host.querySelector(".cm-table-cell-input")).toBeNull();
    expect(host.querySelectorAll(".cm-table-source-row")).toHaveLength(3);
    expect(host.querySelectorAll(".cm-table-source-cell").length).toBeGreaterThanOrEqual(6);
    expect(editor.getMarkdownSelection().from).toBe(markdown.indexOf("one") + 3);
    expect(runEditorTextInput(editor.view, "! ")).toBe(true);
    expect(editor.getMarkdown()).toContain("| one!  | two |");
    expect(host.querySelectorAll(".cm-table-source-row")).toHaveLength(3);
    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
  });

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
