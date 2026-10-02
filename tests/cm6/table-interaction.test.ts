import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { undoDepth } from "@codemirror/commands";
import { createEditor, type Editor } from "../../src/editor-api.ts";

const markdown = "before\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n\nafter";
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

function open() {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  editors.push(editor);
  const cell = host.querySelector<HTMLTableCellElement>("tbody td")!;
  cell.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  return { editor, host, cell, input: cell.querySelector<HTMLInputElement>("input")! };
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
function type(input: HTMLInputElement, value: string, isComposing = false) {
  input.value = value;
  input.dispatchEvent(new InputEvent("input", { bubbles: true, isComposing }));
}
function key(target: HTMLElement, init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

describe("table cell input and history", () => {
  it.each(["Enter", "Tab", "Escape"])("leaves composing %s to the input method", (name) => {
    const { editor, input } = open();
    type(input, "中文", true);
    expect(key(input, { key: name, isComposing: true }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(input.isConnected).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("tracks composition events and Safari's 229 key without opening completion", () => {
    const { editor, input, host } = open();
    let requests = 0;
    host.addEventListener("aaronnote:table-cell-completion-request", () => requests++);
    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(input, "中文");
    expect(key(input, { key: "Enter" }).defaultPrevented).toBe(false);
    expect(requests).toBe(0);
    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "中文" }));
    expect(requests).toBe(1);
    expect(key(input, { key: "Enter", keyCode: 229 }).defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(editor.getMarkdown()).toBe(markdown);
  });

  it("Shift-Enter inserts a cell line break at the selection without navigating", () => {
    const { editor, input } = open();
    input.setSelectionRange(1, 2);
    key(input, { key: "Enter", shiftKey: true });
    expect(input.value).toBe("o<br>e");
    expect(document.activeElement).toBe(input);
    expect(input.selectionStart).toBe(5);
    expect(editor.getMarkdown()).toBe(markdown);
    input.blur();
    expect(editor.getMarkdown()).toContain("| o<br>e | two |");
  });

  it("committing two cells creates two reversible steps even within 500 ms", async () => {
    const { editor, host, input } = open();
    type(input, "first edit");
    input.blur();
    const second = host.querySelectorAll<HTMLTableCellElement>("tbody td")[1]!;
    key(second, { key: "Enter" });
    const nextInput = second.querySelector<HTMLInputElement>("input")!;
    type(nextInput, "second edit");
    nextInput.blur();
    expect(undoDepth(editor.view.state)).toBe(2);
    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toContain("| first edit | two |");
    expect(editor.undo()).toBe(true);
    expect(editor.getMarkdown()).toBe(markdown);
    expect(editor.redo()).toBe(true);
    expect(editor.getMarkdown()).toContain("| first edit | two |");
    await frame();
  });

  it.each([{ metaKey: true }, { ctrlKey: true }])("undo and redo work from the cell preview: %j", async (modifier) => {
    const { editor, cell, input } = open();
    type(input, "changed");
    input.blur();
    cell.focus();
    expect(key(cell, { key: "z", ...modifier }).defaultPrevented).toBe(true);
    await frame();
    expect(editor.getMarkdown()).toBe(markdown);
    expect(document.activeElement).toBe(cell);
    key(cell, { key: "z", shiftKey: true, ...modifier });
    await frame();
    expect(editor.getMarkdown()).toContain("| changed | two |");
    expect(document.activeElement).toBe(cell);
  });
});
