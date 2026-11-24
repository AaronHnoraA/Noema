import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { undoDepth } from "@codemirror/commands";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { cellTarget } from "../../src/cm6/commands/index.ts";
import { runEditorTextInput } from "../../src/cm6/input-commands.ts";
import { computeTableColumnPercentages } from "../../src/cm6/table-model.ts";
import { mapRenderedOffsetToSource } from "../../src/cm6/table-source-cells.ts";
import { tableContextMenuItems, tableMenuTargetFromEvent } from "../../src/cm6/table-context-menu.ts";

const markdown = "before\n\n| A | B |\n| --- | --- |\n| one | two |\n| three | four |\n\nafter";
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
  document.body.replaceChildren();
});

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

function mount(initialContent = markdown) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
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
  it("keeps a cell's closing pipe inside its editable DOM at the caret boundary", () => {
    const source = "| Header | Value |\n| --- | --- |\n| item| value |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    const boundary = source.lastIndexOf("| value |");
    editor.view.dispatch({ selection: { anchor: boundary } });
    const active = host.querySelector<HTMLElement>(".cm-table-source-active-cell")!;
    expect(active.querySelector(".cm-table-source-pipe")?.textContent).toBe("|");
    expect(active.textContent).toBe(" item|");
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(editor, "中文");
    expect(editor.getMarkdown()).toContain("| item中文| value |");
    expect(host.querySelector(".cm-table-source-active-cell .cm-table-source-pipe")?.textContent).toBe("|");
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
  });

  it("keeps text appended at a cell boundary inside the single visible grid cell", async () => {
    const source = "| Name| Value|\n| --- | --- |\n| item | value |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    const at = source.indexOf("Name") + "Name".length;
    editor.view.dispatch({ selection: { anchor: at } });
    const active = host.querySelector<HTMLElement>(".cm-table-source-active-cell")!;
    expect(active).toBeTruthy();
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(editor, "s");
    type(editor, "中文");
    expect(editor.getMarkdown().split("\n")[0]).toBe("| Names中文| Value|");
    expect(active.textContent).toContain("Names中文");
    expect(host.querySelectorAll(".cm-table-source-header .cm-table-source-cell")).toHaveLength(2);
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    await frame();
    expect(host.querySelectorAll(".cm-table-source-header .cm-table-source-cell")).toHaveLength(2);
  });

  it("keeps a selected header cell editable when composition replaces its entire text", async () => {
    const source = "| Name | Value |\n| --- | --- |\n| item | value |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    editor.view.dispatch({ selection: { anchor: source.indexOf("Name") + 4 } });
    expect(host.querySelector(".cm-table-source-active-cell")).toBeTruthy();
    editor.view.dispatch({ selection: { anchor: source.indexOf("Name"), head: source.indexOf("Name") + 4 } });
    const active = host.querySelector<HTMLElement>(".cm-table-source-active-cell")!;
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    type(editor, "中文");
    expect(editor.getMarkdown().split("\n")[0]).toBe("| 中文 | Value |");
    expect(active.textContent).toContain("中文");
    expect(host.querySelectorAll(".cm-table-source-header .cm-table-source-cell")).toHaveLength(2);
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    await frame();
    expect(host.querySelectorAll(".cm-table-source-header .cm-table-source-cell")).toHaveLength(2);
  });

  it("keeps the editable cell DOM stable while a Chinese input method composes", async () => {
    const { editor, host } = mount();
    clickCell(host, 1, 0);
    const active = host.querySelector<HTMLElement>(".cm-table-source-active-cell")!;
    const neighbour = host.querySelector<HTMLElement>('.cm-table-source-rendered-cell[data-row="1"][data-col="1"]')!;
    expect(active).toBeTruthy();
    expect(neighbour).toBeTruthy();

    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    expect(editor.view.compositionStarted).toBe(true);
    const from = editor.getMarkdown().indexOf("one");
    editor.view.dispatch({
      changes: { from, to: from + 3, insert: "ni|" },
      selection: { anchor: from + 3 },
      userEvent: "input.type.compose.start",
    });
    expect(host.querySelector(".cm-table-source-active-cell")).toBe(active);
    expect(host.querySelector('.cm-table-source-rendered-cell[data-row="1"][data-col="1"]')).toBe(neighbour);
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    await frame();
    await frame();
    expect(host.querySelector(".cm-table-source-active-cell")).toBe(active);
    expect(host.querySelector('.cm-table-source-rendered-cell[data-row="1"][data-col="1"]')).toBe(neighbour);

    editor.view.dispatch({
      changes: { from, to: from + 3, insert: "你" },
      selection: { anchor: from + 1 },
      userEvent: "input.type.compose",
    });
    expect(editor.getMarkdown()).toContain("| 你 | two |");
    expect(host.querySelector(".cm-table-source-active-cell")).toBe(active);
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    await frame();
    await frame();
    expect(host.querySelectorAll(".cm-table-source-active-cell")).toHaveLength(1);
    expect(host.querySelectorAll(".cm-table-source-rendered-cell")).toHaveLength(5);
    expect(editor.getMarkdown()).toContain("| 你 | two |");
  });

  it("clears stale grid decorations if a composed edit removes the table delimiter", async () => {
    const { editor, host } = mount();
    clickCell(host, 1, 0);
    const delimiter = editor.getMarkdown().indexOf("| --- | --- |");
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    editor.view.dispatch({
      changes: { from: delimiter, to: delimiter + "| --- | --- |".length, insert: "| 中文 | 中文 |" },
      selection: { anchor: delimiter + 3 },
      userEvent: "input.type.compose",
    });
    editor.view.contentDOM.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    await frame();
    await frame();
    expect(host.querySelector(".cm-table-source-row")).toBeNull();
    expect(host.querySelector(".cm-table-block")).toBeNull();
    expect(editor.view.contentDOM.textContent).toContain("中文");
  });

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
    expect(row.classList.contains("noema-table-wrap")).toBe(true);
    expect(row.classList.contains("noema-table-align-right")).toBe(true);
    expect(row.style.getPropertyValue("--noema-table-width")).toBe("40%");
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
    const formula = host.querySelector<HTMLElement>(".cm-table-source-rendered-cell .noema-math-inline")!;
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

  it("keeps the active row grid intact when the active cell contains <br>, math, or emoji widgets", () => {
    const source = "| A | B | C |\n| --- | --- | --- |\n| left | alpha <br> \\(x\\) :smile: | right |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    editor.view.dispatch({ selection: { anchor: source.indexOf("alpha") + 2 } });
    const activeRow = host.querySelector<HTMLElement>(".cm-table-source-row.cm-table-source-has-active");
    expect(activeRow).toBeTruthy();
    // Both sibling columns remain positioned rendered widgets inside the row.
    expect(activeRow!.querySelectorAll(".cm-table-source-positioned-cell")).toHaveLength(2);
    expect(activeRow!.style.getPropertyValue("--noema-table-active-width")).toMatch(/%$/);
    // Inline widgets inside the active cell stay present without collapsing the row.
    expect(activeRow!.querySelector(".cm-html-inline-widget")).toBeTruthy();
    expect(activeRow!.querySelector(".cm-table-source-active-cell")).toBeTruthy();
  });

  it("shares identical content-aware column percentages between preview <colgroup> and editing grid", () => {
    const source = "| # | Detailed Description |\n| --- | --- |\n| 1 | A much longer prose explanation column |\n| 2 | Another substantial entry here |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    const expected = computeTableColumnPercentages([
      ["#", "Detailed Description"],
      ["1", "A much longer prose explanation column"],
      ["2", "Another substantial entry here"],
    ]);
    expect(expected[1]!).toBeGreaterThan(expected[0]!);
    expect(Number((expected[0]! + expected[1]!).toFixed(2))).toBe(100);
    const cols = Array.from(host.querySelectorAll<HTMLTableColElement>(".cm-table-block table colgroup col"));
    expect(cols.map((c) => c.style.width)).toEqual(expected.map((w) => `${w}%`));

    clickCell(host, 1, 0, editor);
    const row = host.querySelector<HTMLElement>(".cm-table-source-row")!;
    expect(row.style.getPropertyValue("--noema-table-col-template")).toBe(expected.map((w) => `${w}%`).join(" "));
  });

  it("maps rendered plain-text click offsets accurately back to Markdown source offsets", () => {
    expect(mapRenderedOffsetToSource("hello **world**!", 0, 12)).toBe(0);
    expect(mapRenderedOffsetToSource("hello **world**!", 7, 12)).toBe(9);
    expect(mapRenderedOffsetToSource("see [docs](https://example.com) now", 5, 12)).toBe(6);
    expect(mapRenderedOffsetToSource("a\\|b", 2, 3)).toBe(3);
    expect(mapRenderedOffsetToSource("`code` tail", 2, 9)).toBe(3);
  });

  it("Cmd/Ctrl-clicking a rendered link in preview or inactive edit cell opens the URL instead of editing", () => {
    const source = "| Link | Other |\n| --- | --- |\n| [Example](https://example.com) | two |";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editors.push(editor);
    const opened: string[] = [];
    editor.view.dom.addEventListener("noema:open-url", (event) => {
      opened.push((event as CustomEvent<{ href: string }>).detail.href);
    });
    const link = host.querySelector<HTMLAnchorElement>(".cm-table-block a")!;
    expect(link).toBeTruthy();
    link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
    expect(opened).toEqual(["https://example.com"]);
    expect(host.querySelector(".cm-table-block")).toBeTruthy();

    // Also in editing mode when clicking a link in an inactive cell
    clickCell(host, 1, 1, editor);
    const inactiveLink = host.querySelector<HTMLAnchorElement>(".cm-table-source-rendered-cell a")!;
    expect(inactiveLink).toBeTruthy();
    inactiveLink.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0, metaKey: true }));
    expect(opened).toEqual(["https://example.com", "https://example.com"]);
  });

  it("context menu works identically in preview and editing states, and drag handles open it on click", () => {
    const { editor, host } = mount();
    const previewCell = host.querySelector<HTMLElement>(".cm-table-block tbody tr:first-child td:first-child")!;
    const previewTarget = tableMenuTargetFromEvent(editor.view, previewCell);
    expect(previewTarget).toMatchObject({ row: 1, col: 0, rowCount: 3, colCount: 2, isEditing: false });
    const items = tableContextMenuItems(editor.view, previewTarget!);
    const rowMenu = items.find((i) => i.label === "Row")!.submenu!;
    rowMenu.find((i) => i.label === "Insert Row Above")!.run!();
    expect(editor.getMarkdown()).toContain("| A | B |\n| --- | --- |\n|  |  |\n| one | two |");

    // Now table is in editing mode; context menu resolves the active editing row too.
    const sourceRow = host.querySelector<HTMLElement>(".cm-table-source-row.cm-table-source-has-active")!;
    const editTarget = tableMenuTargetFromEvent(editor.view, sourceRow);
    expect(editTarget).toMatchObject({ row: 1, col: 0, isEditing: true });
    const colMenu = tableContextMenuItems(editor.view, editTarget!).find((i) => i.label === "Column")!.submenu!;
    colMenu.find((i) => i.label === "Insert Column Left")!.run!();
    expect(editor.getMarkdown().split("\n")[2]).toBe("|  | A | B |");

    // Leave table back to preview and verify clicking a row drag handle dispatches context menu event
    editor.view.dispatch({ selection: { anchor: 0 } });
    let menuEventCount = 0;
    editor.view.dom.addEventListener("noema:table-context-menu", () => { menuEventCount++; });
    host.querySelector<HTMLElement>(".cm-table-row-drag-handle")!.click();
    expect(menuEventCount).toBe(1);
  });

  it("size picker highlights the full hovered rectangle, flags shrink, and closes on Escape", () => {
    const { host } = mount();
    host.querySelector<HTMLButtonElement>(".cm-table-toolbar button[title='Resize table with grid']")!.click();
    const picker = host.querySelector<HTMLElement>(".cm-table-size-picker")!;
    expect(picker).toBeTruthy();
    const target = picker.querySelector<HTMLButtonElement>(".cm-table-size-cell[title='2 rows × 1 columns']")!;
    target.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    expect(picker.querySelectorAll(".cm-table-size-cell.is-in-range")).toHaveLength(1);
    expect(picker.querySelector(".cm-table-size-label")?.textContent).toContain("2 × 1");
    expect(picker.querySelector(".cm-table-size-label")?.classList.contains("is-shrink")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(host.querySelector(".cm-table-size-picker")).toBeNull();
  });

  it("cross-boundary selection entering a table opens its editing grid cleanly", () => {
    const { editor, host } = mount();
    expect(host.querySelector(".cm-table-block")).toBeTruthy();
    editor.view.dispatch({ selection: { anchor: 0, head: markdown.indexOf("one") + 1 } });
    expect(host.querySelector(".cm-table-source-row")).toBeTruthy();
    editor.view.dispatch({ selection: { anchor: 0 } });
    expect(host.querySelector(".cm-table-block")).toBeTruthy();
  });

  it("pins inactive row cells explicitly to grid row 1 and column 1..N so cm-widgetBuffer cannot stack them", () => {
    const threeCol = [
      "#+begin observation 三个复杂度模型",
      "| 模型 | 假设 | 问题 |",
      "| --- | --- | --- |",
      "| Code-capacity | 仅数据比特含噪，测量与恢复理想 | 噪声结构与纠错码本身的关系 |",
      "| Phenomenological | 数据和综合征测量可能出错 | 多轮纠错、测量错误与时间相关性 |",
      "| Circuit-level | 具体量子门、等待、测量和重置都可能出错 | 真实纠错电路的故障传播 |",
      "#+end observation",
    ].join("\n");
    const { editor, host } = mount(threeCol);
    // Focus middle header cell ("假设")
    editor.view.dispatch({ selection: { anchor: threeCol.indexOf("假设") } });
    const rows = Array.from(host.querySelectorAll<HTMLElement>(".cm-table-source-row"));
    expect(rows).toHaveLength(4);
    expect(rows[0]!.classList.contains("cm-table-source-has-active")).toBe(true);
    expect(rows[0]!.classList.contains("cm-table-source-active-is-last")).toBe(false);
    // Positioned inactive cells on active row wrap natural content for non-latching ResizeObserver measurement
    const positioned = Array.from(rows[0]!.querySelectorAll<HTMLElement>(".cm-table-source-positioned-cell"));
    expect(positioned).toHaveLength(2);
    expect(positioned.every((el) => el.querySelector(".cm-table-source-cell-content") !== null)).toBe(true);
    // Every inactive row pins all 3 cells explicitly to row 1, columns 1..3
    for (const inactiveRow of rows.slice(1)) {
      expect(inactiveRow.classList.contains("cm-table-source-has-active")).toBe(false);
      const cells = Array.from(inactiveRow.querySelectorAll<HTMLElement>(".cm-table-source-rendered-cell"));
      expect(cells).toHaveLength(3);
      expect(cells.map((c) => c.style.gridColumn)).toEqual(["1", "2", "3"]);
      expect(cells.map((c) => c.style.gridRow)).toEqual(["1", "1", "1"]);
    }
    // Moving caret to last column toggles cm-table-source-active-is-last
    editor.view.dispatch({ selection: { anchor: threeCol.indexOf("问题") } });
    const activeHeader = host.querySelector<HTMLElement>(".cm-table-source-row.cm-table-source-has-active")!;
    expect(activeHeader.classList.contains("cm-table-source-active-is-last")).toBe(true);

    // Real CM6 DOM structure: side:-1 TableSourceToolbarWidget precedes header line with identical posAtDOM === tableFrom,
    // while the preceding org-env heading has an earlier posAtDOM (so domTopForAnchor aligns identically across preview/edit).
    const tableFrom = editor.view.state.doc.line(2).from;
    const toolbar = host.querySelector<HTMLElement>(".cm-table-source-toolbar")!;
    const heading = host.querySelector<HTMLElement>(".cm-org-env-heading-widget")!;
    expect(toolbar).toBeTruthy();
    expect(activeHeader.previousElementSibling).toBe(toolbar);
    expect(editor.view.posAtDOM(toolbar)).toBe(tableFrom);
    expect(editor.view.posAtDOM(heading)).toBeLessThan(tableFrom);
  });

  it("emits unitless column ratios on sized editing tables so active-row padding scales with table width", () => {
    const sized = [
      "| 模型 | 假设 | 问题 |  |",
      "| --- | --- | --- | --- |",
      "| Code-capacity | 仅数据比特含噪 | 噪声结构 |  |",
      "{width=75%}",
      "",
      "after",
    ].join("\n");
    const { editor, host } = mount(sized);
    const headerLine = editor.view.state.doc.line(1);
    // Focus empty 4th column in header row
    editor.view.dispatch({ selection: { anchor: headerLine.to - 1 } });
    const activeRow = host.querySelector<HTMLElement>(".cm-table-source-row.cm-table-source-has-active")!;
    expect(activeRow.style.getPropertyValue("--noema-table-width")).toBe("75%");
    const leftRatio = Number(activeRow.style.getPropertyValue("--noema-table-active-left-ratio"));
    const rightRatio = Number(activeRow.style.getPropertyValue("--noema-table-active-right-ratio"));
    expect(leftRatio).toBeGreaterThan(0.7);
    expect(leftRatio).toBeLessThan(1);
    expect(rightRatio).toBe(0);
  });
});
