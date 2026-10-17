/**
 * Keyboard movement inside the rendered table (MarkText TableCellContent):
 * arrows and Backspace at a cell's text edge move between cells and, past the
 * table, back into the document; Mod-Enter adds a row below.
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../../src/editor-api.ts";

const markdown = "before\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n\nafter";
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function open(doc = markdown, row = 1, col = 0) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: doc });
  editors.push(editor);
  const cell = host.querySelector<HTMLTableElement>("table")!.rows[row]!.cells[col] as HTMLTableCellElement;
  cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  const input = cell.querySelector<HTMLInputElement>("input")!;
  input.focus();
  return { editor, host, input };
}

function key(target: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

async function settle() {
  await tick();
  await frame();
  await tick();
}

function activeCell(host: HTMLElement): { row: number; col: number; caret: number } | null {
  const input = document.activeElement;
  if (!(input instanceof HTMLInputElement) || !host.contains(input)) return null;
  const cell = input.closest("td, th") as HTMLTableCellElement;
  return { row: Number(cell.dataset.row), col: Number(cell.dataset.col), caret: input.selectionStart ?? -1 };
}

describe("table keyboard movement", () => {
  it("ArrowDown and ArrowUp move to the same column", async () => {
    const { host, input } = open(markdown, 1, 1);
    expect(key(input, { key: "ArrowDown" }).defaultPrevented).toBe(true);
    await settle();
    expect(activeCell(host)).toMatchObject({ row: 2, col: 1, caret: 0 });
    key(document.activeElement as HTMLElement, { key: "ArrowUp" });
    await settle();
    expect(activeCell(host)).toMatchObject({ row: 1, col: 1, caret: 3 });
  });

  it("ArrowRight at a cell's end enters the next cell; inside text it stays native", async () => {
    const { host, input } = open();
    input.setSelectionRange(1, 1);
    expect(key(input, { key: "ArrowRight" }).defaultPrevented).toBe(false);
    input.setSelectionRange(3, 3);
    key(input, { key: "ArrowRight" });
    await settle();
    expect(activeCell(host)).toMatchObject({ row: 1, col: 1, caret: 0 });
  });

  it("ArrowLeft and Backspace at a cell's start enter the previous cell's end", async () => {
    const { host, input } = open(markdown, 2, 0);
    input.setSelectionRange(0, 0);
    key(input, { key: "Backspace" });
    await settle();
    expect(activeCell(host)).toMatchObject({ row: 1, col: 1, caret: 3 });
    const next = document.activeElement as HTMLInputElement;
    next.setSelectionRange(0, 0);
    key(next, { key: "ArrowLeft" });
    await settle();
    expect(activeCell(host)).toMatchObject({ row: 1, col: 0, caret: 3 });
  });

  it("ArrowDown from the last row returns the caret to the line below", async () => {
    const { editor, host, input } = open(markdown, 2, 0);
    key(input, { key: "ArrowDown" });
    await settle();
    expect(activeCell(host)).toBeNull();
    const pos = editor.getMarkdownSelection().from;
    expect(editor.view.state.doc.lineAt(pos).text).toBe("");
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("ArrowUp from the header returns the caret above, keeping a typed edit", async () => {
    const { editor, host, input } = open(markdown, 0, 0);
    input.value = "Head";
    input.dispatchEvent(new InputEvent("input", { bubbles: true }));
    input.setSelectionRange(0, 0);
    key(input, { key: "ArrowUp" });
    await settle();
    expect(activeCell(host)).toBeNull();
    expect(editor.getMarkdown()).toContain("| Head | B |");
    expect(editor.getMarkdownSelection().from).toBe("before\n".length);
  });

  it("leaving a table that ends the note opens a line below it", async () => {
    const doc = "| A | B |\n| --- | --- |\n| one | two |";
    const { editor, input } = open(doc, 1, 1);
    key(input, { key: "ArrowDown" });
    await settle();
    expect(editor.getMarkdown()).toBe(`${doc}\n`);
    expect(editor.getMarkdownSelection().from).toBe(doc.length + 1);
  });

  it("Mod-Enter inserts an empty row below and edits its first cell", async () => {
    const { editor, host, input } = open(markdown, 1, 1);
    key(input, { key: "Enter", metaKey: true });
    await settle();
    expect(editor.getMarkdown()).toContain("| one | two |\n|  |  |\n| three | four |");
    expect(activeCell(host)).toMatchObject({ row: 2, col: 0 });
  });
});

describe("selected cell movement", () => {
  it("arrows move focus between selected cells without editing", async () => {
    const { host, input } = open(markdown, 1, 0);
    key(input, { key: "Escape" });
    const cell = document.activeElement as HTMLTableCellElement;
    expect(cell.tagName).toBe("TD");
    key(cell, { key: "ArrowRight" });
    expect((document.activeElement as HTMLElement).dataset.col).toBe("1");
    key(document.activeElement as HTMLElement, { key: "ArrowDown" });
    expect((document.activeElement as HTMLElement).dataset.row).toBe("2");
    expect(host.querySelector("input")).toBeNull();
  });
});
