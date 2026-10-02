/**
 * Rectangular cell selection (MarkText TableRectSelection, prosemirror-tables
 * CellSelection in Marker): copy as a GFM sub-table, two-stage delete,
 * Mod-A escalation.
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { setSystemClipboardWriter } from "../../src/system-clipboard.ts";
import {
  clearRectCells,
  rectCellSources,
  removeRectStructure,
  tableCellRect,
} from "../../src/cm6/table-rect-selection.ts";

const markdown = "before\n\n| A | B | C |\n| --- | :-: | --- |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |\n\nafter";
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  setSystemClipboardWriter(null);
  document.body.replaceChildren();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function open(doc = markdown) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: doc });
  editors.push(editor);
  const table = () => host.querySelector<HTMLTableElement>("table")!;
  const cell = (row: number, col: number) => table().rows[row]!.cells[col] as HTMLTableCellElement;
  return { editor, host, table, cell };
}

function mouse(target: HTMLElement, type: string, init: MouseEventInit = {}) {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, buttons: 1, ...init }));
}
function key(target: Element, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}
function selected(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll<HTMLElement>(".cm-table-cell-selected"))
    .map((cell) => `${cell.dataset.row},${cell.dataset.col}`);
}

describe("table rectangle model", () => {
  const rows = [["A", "B", "C"], ["1", "2", "3"], ["4", "5", "6"]];
  it("reads and clears the rectangle", () => {
    const rect = tableCellRect({ row: 2, col: 1 }, { row: 1, col: 0 });
    expect(rectCellSources(rows, rect)).toEqual([["1", "2"], ["4", "5"]]);
    expect(clearRectCells(rows, rect)).toEqual([["A", "B", "C"], ["", "", "3"], ["", "", "6"]]);
    expect(clearRectCells([["", ""]], tableCellRect({ row: 0, col: 0 }, { row: 0, col: 1 }))).toBeNull();
  });
  it("removes what an empty rectangle spans", () => {
    expect(removeRectStructure(rows, ["", "center", ""], tableCellRect({ row: 0, col: 1 }, { row: 2, col: 1 })))
      .toEqual({ kind: "columns", rows: [["A", "C"], ["1", "3"], ["4", "6"]], aligns: ["", ""] });
    expect(removeRectStructure(rows, [], tableCellRect({ row: 1, col: 0 }, { row: 1, col: 2 })))
      .toEqual({ kind: "rows", rows: [["A", "B", "C"], ["4", "5", "6"]] });
    expect(removeRectStructure(rows, [], tableCellRect({ row: 0, col: 0 }, { row: 2, col: 2 }))).toEqual({ kind: "table" });
    expect(removeRectStructure(rows, [], tableCellRect({ row: 1, col: 1 }, { row: 2, col: 2 }))).toBeNull();
  });
});

describe("table rectangle selection", () => {
  it("dragging across cells selects the rectangle", () => {
    const { host, cell } = open();
    mouse(cell(1, 0), "mousedown");
    mouse(cell(1, 1), "mousemove");
    mouse(cell(2, 1), "mousemove");
    mouse(cell(2, 1), "mouseup", { buttons: 0 });
    expect(selected(host).sort()).toEqual(["1,0", "1,1", "2,0", "2,1"]);
    // The drag's end reaches the selection even though the widget stops
    // mouseup from bubbling, so the keyboard acts on the rectangle.
    expect((document.activeElement as HTMLElement).dataset.row).toBe("2");
    expect(host.querySelector("input")).toBeNull();
  });

  it("Shift-click extends from the last cell, and Shift+Arrow grows it", () => {
    const { host, cell } = open();
    cell(1, 0).focus();
    mouse(cell(1, 1), "mousedown", { shiftKey: true });
    expect(selected(host).sort()).toEqual(["1,0", "1,1"]);
    key(document.activeElement!, { key: "ArrowDown", shiftKey: true });
    expect(selected(host).sort()).toEqual(["1,0", "1,1", "2,0", "2,1"]);
    key(document.activeElement!, { key: "Escape" });
    expect(selected(host)).toEqual([]);
  });

  it("copies a rectangle as a GFM table and one cell as its text", async () => {
    const copied: string[] = [];
    setSystemClipboardWriter(async (text) => { copied.push(text); return true; });
    const { cell } = open();
    cell(1, 1).focus();
    mouse(cell(2, 2), "mousedown", { shiftKey: true });
    key(document.activeElement!, { key: "c", metaKey: true });
    cell(2, 0).focus();
    mouse(cell(2, 0), "mousedown", { shiftKey: true });
    key(document.activeElement!, { key: "c", metaKey: true });
    await tick();
    expect(copied).toEqual(["| 2 | 3 |\n| :---: | --- |\n| 5 | 6 |", "4"]);
  });

  it("Delete empties the cells first, then removes the column they span", async () => {
    const { editor, cell } = open();
    cell(0, 1).focus();
    mouse(cell(2, 1), "mousedown", { shiftKey: true });
    key(document.activeElement!, { key: "Delete" });
    expect(editor.getMarkdown()).toContain("| A |  | C |\n| --- | :---: | --- |\n| 1 |  | 3 |\n| 4 |  | 6 |");
    key(document.activeElement!, { key: "Backspace" });
    await tick();
    expect(editor.getMarkdown()).toBe("before\n\n| A | C |\n| --- | --- |\n| 1 | 3 |\n| 4 | 6 |\n\nafter");
  });

  it("removes an emptied body row", async () => {
    const { editor, cell } = open("| A | B |\n| --- | --- |\n|  |  |\n| x | y |");
    cell(1, 0).focus();
    mouse(cell(1, 1), "mousedown", { shiftKey: true });
    key(document.activeElement!, { key: "Delete" });
    await tick();
    expect(editor.getMarkdown()).toBe("| A | B |\n| --- | --- |\n| x | y |");
  });

  it("Mod-A grows cell to table to document, and Mod-X on the whole table deletes it", async () => {
    setSystemClipboardWriter(async () => true);
    const { editor, host, cell } = open();
    cell(1, 1).focus();
    mouse(cell(1, 1), "mousedown", { shiftKey: true });
    key(document.activeElement!, { key: "a", metaKey: true });
    expect(selected(host)).toHaveLength(9);
    key(document.activeElement!, { key: "x", metaKey: true });
    await frame();
    expect(editor.getMarkdown()).toBe("before\n\n\nafter");
  });
});

describe("short delimiter rows", () => {
  it.each(["| A | B |\n|-|:-:|\n| 1 | 2 |", "| A | B |\n| - | - |\n| 1 | 2 |"])("renders %j as a table, as export does", (doc) => {
    const { host } = open(doc);
    expect(host.querySelector("table")?.rows.length).toBe(2);
  });
});
