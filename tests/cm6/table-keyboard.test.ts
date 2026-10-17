/**
 * Keyboard movement in a table (MarkText TableCellContent). A caret moved into
 * a table by the keyboard edits its Markdown source with the main editor (a
 * click edits a rendered cell in place: table-cell-input.test.ts); the keys
 * keep the cell model:
 * arrows at a cell's text edge move between cells and, past the table, back
 * into the document; Backspace at a cell's start never deletes a pipe;
 * Mod-Enter adds a row below; Shift-Enter breaks a line inside the cell.
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { cellTarget } from "../../src/cm6/commands/index.ts";

const markdown = "before\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n\nafter";
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
/** CodeMirror's `Mod`: Command on macOS, Control elsewhere. */
const MOD = /Mac/.test(navigator.platform) ? "metaKey" : "ctrlKey";

/** Open DOC with the caret at the end of cell (ROW, COL) of its table's source: the source opens. */
function open(doc = markdown, row = 1, col = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: doc });
  editors.push(editor);
  const state = editor.view.state;
  let first = 1;
  while (!/^\s*\|/.test(state.doc.line(first).text)) first++;
  const line = state.doc.line(first + (row === 0 ? 0 : row + 1));
  editor.view.dispatch({ selection: { anchor: line.from + cellTarget(line.text, col).head } });
  return { editor, host };
}

function press(editor: Editor, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  editor.view.contentDOM.dispatchEvent(event);
  return event;
}

/** The table cell holding the caret, by rendered row (header is 0) and column, and the caret's offset in its text. */
function caretCell(editor: Editor): { row: number; col: number; offset: number } | null {
  const state = editor.view.state;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  if (!/^\s*\|.*\|\s*$/.test(line.text)) return null;
  let first = line.number;
  while (first > 1 && /^\s*\|.*\|\s*$/.test(state.doc.line(first - 1).text)) first--;
  const sourceRow = line.number - first;
  const row = sourceRow === 0 ? 0 : sourceRow - 1;
  const before = line.text.slice(0, head - line.from);
  const col = (before.match(/\|/g)?.length ?? 1) - 1;
  const cellStart = before.lastIndexOf("|") + 1;
  const offset = before.slice(cellStart).replace(/^ /, "").length;
  return { row, col, offset };
}

describe("table cells are edited in the source", () => {
  it("a caret in a cell opens the table's source", () => {
    const { editor, host } = open(markdown, 1, 1);
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 1, offset: 3 });
    expect(host.querySelector(".cm-table-block")).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("leaving the table renders it again", () => {
    const { editor, host } = open(markdown, 1, 1);
    editor.view.dispatch({ selection: { anchor: editor.getMarkdown().length } });
    expect(host.querySelector(".cm-table-block table")).toBeTruthy();
  });
});

describe("table keyboard movement", () => {
  it("ArrowDown and ArrowUp move to the same column", () => {
    const { editor } = open(markdown, 1, 1);
    expect(press(editor, { key: "ArrowDown" }).defaultPrevented).toBe(true);
    expect(caretCell(editor)).toMatchObject({ row: 2, col: 1, offset: 0 });
    press(editor, { key: "ArrowUp" });
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 1, offset: 3 });
  });

  it("ArrowUp from the first body row skips the delimiter row", () => {
    const { editor } = open(markdown, 1, 0);
    press(editor, { key: "ArrowUp" });
    expect(caretCell(editor)).toMatchObject({ row: 0, col: 0 });
  });

  it("ArrowRight at a cell's end enters the next cell; inside text it stays native", () => {
    const { editor } = open(markdown, 1, 0);
    const end = editor.view.state.selection.main.head;
    editor.view.dispatch({ selection: { anchor: end - 1 } });
    press(editor, { key: "ArrowRight" });
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 0, offset: 3 });
    editor.view.dispatch({ selection: { anchor: end } });
    press(editor, { key: "ArrowRight" });
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 1, offset: 0 });
  });

  it("ArrowLeft and Backspace at a cell's start enter the previous cell's end", () => {
    const { editor } = open(markdown, 2, 0);
    const cell = caretCell(editor)!;
    editor.view.dispatch({ selection: { anchor: editor.view.state.selection.main.head - cell.offset } });
    press(editor, { key: "Backspace" });
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 1, offset: 3 });
    expect(editor.getMarkdown()).toBe(markdown);
    editor.view.dispatch({ selection: { anchor: editor.view.state.selection.main.head - 3 } });
    press(editor, { key: "ArrowLeft" });
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 0, offset: 3 });
  });

  it("ArrowDown from the last row leaves the table as text movement does", () => {
    const { editor } = open(markdown, 2, 0);
    press(editor, { key: "ArrowDown" });
    expect(caretCell(editor)).toBeNull();
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("leaving a table that ends the note opens a line below it", () => {
    const doc = "| A | B |\n| --- | --- |\n| one | two |";
    const { editor } = open(doc, 1, 1);
    press(editor, { key: "ArrowDown" });
    expect(editor.getMarkdown()).toBe(`${doc}\n`);
    expect(editor.getMarkdownSelection().from).toBe(doc.length + 1);
  });

  it("Mod-Enter inserts an empty row below and puts the caret in its first cell", () => {
    const { editor } = open(markdown, 1, 1);
    press(editor, { key: "Enter", [MOD]: true });
    expect(editor.getMarkdown()).toMatch(/\| one +\| two +\|\n\| +\| +\|\n\| three +\| four +\|/);
    expect(caretCell(editor)).toMatchObject({ row: 2, col: 0 });
  });

  it("Shift-Enter breaks a line inside the cell instead of ending the row", () => {
    const { editor } = open(markdown, 1, 0);
    press(editor, { key: "Enter", shiftKey: true });
    expect(editor.getMarkdown()).toContain("| one<br> | two |");
  });
});

describe("selected cell movement", () => {
  it("arrows move focus between selected cells without opening the source", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
    editors.push(editor);
    const cell = host.querySelector<HTMLTableElement>("table")!.rows[1]!.cells[0] as HTMLTableCellElement;
    cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, shiftKey: true }));
    await frame();
    expect((document.activeElement as HTMLElement).tagName).toBe("TD");
    const key = (target: Element, name: string) =>
      target.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
    key(document.activeElement!, "Escape");
    key(document.activeElement!, "ArrowRight");
    expect((document.activeElement as HTMLElement).dataset.col).toBe("1");
    key(document.activeElement!, "ArrowDown");
    expect((document.activeElement as HTMLElement).dataset.row).toBe("2");
    expect(host.querySelector(".cm-table-block table")).toBeTruthy();
    expect(editor.getMarkdown()).toBe(markdown);
  });
});
