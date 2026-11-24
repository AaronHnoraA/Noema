/**
 * Keyboard movement in a table (MarkText TableCellContent). A caret moved into
 * a table by the keyboard edits its Markdown source with the main editor;
 * a click keeps the surrounding cells rendered. The keys
 * keep the cell model:
 * arrows at a cell's text edge move between cells and, past the table, back
 * into the document; Backspace at a cell's start never deletes a pipe;
 * Mod-Enter adds a row below; Shift-Enter breaks a line inside the cell.
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { cellTarget } from "../../src/cm6/commands/index.ts";
import { runEditorTextInput } from "../../src/cm6/input-commands.ts";
import { fixedWidthRowLayout, setVimRowLayoutForTesting } from "../../src/cm6/screen-rows.ts";

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
  it("ArrowDown and ArrowUp move to the same column preserving horizontal offset", () => {
    const { editor } = open(markdown, 1, 1);
    expect(press(editor, { key: "ArrowDown" }).defaultPrevented).toBe(true);
    expect(caretCell(editor)).toMatchObject({ row: 2, col: 1, offset: 3 });
    press(editor, { key: "ArrowUp" });
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 1, offset: 3 });
  });

  it("ArrowDown and ArrowUp step through wrapped visual rows inside a cell before crossing rows", () => {
    const doc = "| A | B |\n| --- | --- |\n| long wrapped cell text | two |\n| next | four |";
    const { editor } = open(doc, 1, 0);
    const restore = setVimRowLayoutForTesting(fixedWidthRowLayout(10));
    try {
      const cellStart = doc.indexOf("long wrapped");
      editor.view.dispatch({ selection: { anchor: cellStart + 2 } });
      expect(press(editor, { key: "ArrowDown" }).defaultPrevented).toBe(true);
      // Stayed on row 1, col 0 (moved onto next wrapped visual row inside the cell)
      expect(caretCell(editor)?.row).toBe(1);
      expect(caretCell(editor)?.col).toBe(0);
      expect(editor.view.state.selection.main.head).toBeGreaterThan(cellStart + 2);
      // Reaching the last visual row of the cell then crosses into row 2
      press(editor, { key: "ArrowDown" });
      press(editor, { key: "ArrowDown" });
      expect(caretCell(editor)?.row).toBe(2);
      expect(caretCell(editor)?.col).toBe(0);
    } finally {
      restore();
    }
  });

  it("forward Delete at cell end moves to the next cell without deleting the pipe", () => {
    const { editor } = open(markdown, 1, 0);
    press(editor, { key: "Delete" });
    expect(editor.getMarkdown()).toBe(markdown);
    expect(caretCell(editor)).toMatchObject({ row: 1, col: 1, offset: 0 });
  });

  it("Home, End, Mod-Arrow and Mod-Backspace stay scoped to the active cell", () => {
    const { editor } = open(markdown, 1, 1);
    const twoStart = markdown.indexOf("two");
    const twoEnd = twoStart + 3;
    press(editor, { key: "Home" });
    expect(editor.view.state.selection.main.head).toBe(twoStart);
    press(editor, { key: "End" });
    expect(editor.view.state.selection.main.head).toBe(twoEnd);
    press(editor, { key: "ArrowLeft", [MOD]: true });
    expect(editor.view.state.selection.main.head).toBe(twoStart);
    press(editor, { key: "ArrowRight", [MOD]: true });
    expect(editor.view.state.selection.main.head).toBe(twoEnd);
    press(editor, { key: "Backspace", [MOD]: true });
    expect(editor.getMarkdown()).toBe("before\n\n| A | B |\n| --- | --- |\n| one |  |\n| three | four |\n\nafter");
  });

  it("Mod-A escalates from active cell to table to entire document", () => {
    const { editor } = open(markdown, 1, 0);
    const oneFrom = markdown.indexOf("one");
    press(editor, { key: "a", [MOD]: true });
    expect(editor.getMarkdownSelection()).toEqual({ from: oneFrom, to: oneFrom + 3 });
    press(editor, { key: "a", [MOD]: true });
    expect(editor.getMarkdownSelection()).toEqual({
      from: markdown.indexOf("| A | B |"),
      to: markdown.indexOf("| three | four |") + "| three | four |".length,
    });
    press(editor, { key: "a", [MOD]: true });
    expect(editor.getMarkdownSelection()).toEqual({ from: 0, to: markdown.length });
  });

  it("typing | inside a table cell auto-escapes it instead of splitting columns", () => {
    const { editor } = open(markdown, 1, 0);
    expect(runEditorTextInput(editor.view, "|")).toBe(true);
    expect(editor.getMarkdown()).toContain("| one\\| | two |");
    // Already preceded by backslash: stays single escaped pipe.
    expect(runEditorTextInput(editor.view, "\\")).toBe(true);
    expect(runEditorTextInput(editor.view, "|")).toBe(true);
    expect(editor.getMarkdown()).toContain("| one\\|\\| | two |");
  });

  it("Tab and Enter navigate without reformatting earlier rows or adding undo steps", () => {
    const unformatted = "| A | Long Header |\n| --- | --- |\n| x | y |\n| z | w |";
    const { editor } = open(unformatted, 1, 0);
    const docBefore = editor.view.state.doc;
    press(editor, { key: "Tab" });
    expect(editor.view.state.doc).toBe(docBefore);
    expect(editor.getMarkdown()).toBe(unformatted);
    press(editor, { key: "Enter" });
    expect(editor.view.state.doc).toBe(docBefore);
    expect(editor.getMarkdown()).toBe(unformatted);
  });

  it("outer-pipe-less GFM tables support Tab, Enter, arrows, Backspace, Delete and commands", () => {
    const pipeless = "A | B\n--- | ---\none | two\nthree | four";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: pipeless });
    editors.push(editor);
    editor.view.dispatch({ selection: { anchor: pipeless.indexOf("one") + 3 } });
    // Tab moves to "two" and selects it
    press(editor, { key: "Tab" });
    expect(editor.getMarkdownSelection()).toEqual({
      from: pipeless.indexOf("two"),
      to: pipeless.indexOf("two") + 3,
    });
    // ArrowDown moves to "four" in same column
    editor.view.dispatch({ selection: { anchor: pipeless.indexOf("two") + 2 } });
    press(editor, { key: "ArrowDown" });
    expect(editor.view.state.selection.main.head).toBe(pipeless.indexOf("four") + 2);
    // Delete at end of "three" jumps to "four" without deleting |
    editor.view.dispatch({ selection: { anchor: pipeless.indexOf("three") + 5 } });
    press(editor, { key: "Delete" });
    expect(editor.getMarkdown()).toBe(pipeless);
    expect(editor.view.state.selection.main.head).toBe(pipeless.indexOf("four"));
    // Commands also work on pipe-less tables
    expect(editor.runCommand("table-insert-row")).toBe(true);
    expect(editor.getMarkdown().split("\n")).toHaveLength(5);
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
