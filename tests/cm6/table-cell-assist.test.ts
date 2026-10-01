import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { tableCellMathRanges, tableCellSnippetContext } from "../../src/cm6/table-cell-assist.ts";
import { expandSnippetBody, inputSnippetEditor, SnippetSession } from "../../aaronnote/snippets.ts";

function mount(source: string, readOnly = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source, readOnly });
  editor.setMarkdownSelection(source.length);
  return { host, editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("Markdown table cell editing", () => {
  test("formula and snippet context stays inside the active cell", () => {
    expect(tableCellSnippetContext("text \\(\\alp", 11)).toEqual({ prefix: "\\alp", mode: "tex-mode" });
    expect(tableCellSnippetContext("text \\(x\\) bold", 17)).toEqual({ prefix: "bold", mode: "markdown-mode" });
    expect(tableCellSnippetContext("`\\(literal` \\alpha", 18)).toEqual({ prefix: "\\alpha", mode: "markdown-mode" });
    expect(tableCellMathRanges("`\\(literal\\)` and \\(x+1\\)")).toEqual([
      { from: 18, to: 25, tex: "x+1" },
    ]);
    expect(tableCellMathRanges("\\(\\) then \\(x\\)")).toEqual([
      { from: 10, to: 15, tex: "x" },
    ]);
  });

  test("a cell renders Markdown and math while its source input is active", async () => {
    const { host, cleanup } = mount("| A | B |\n| --- | --- |\n| **old** | 2 |");
    try {
      const cell = host.querySelector<HTMLTableCellElement>("tbody td")!;
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      const input = cell.querySelector<HTMLInputElement>(".cm-table-cell-input")!;
      expect(input.value).toBe("**old**");
      input.value = "*new* \\(x^2\\)";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      const preview = cell.querySelector<HTMLElement>(".cm-table-cell-live-preview")!;
      expect(preview.hidden).toBe(false);
      expect(preview.querySelector("em")?.textContent).toBe("new");
      expect(preview.querySelector(".aaronnote-math-inline[data-tex='x^2']")).toBeTruthy();
    } finally { cleanup(); }
  });

  test("clicking a rendered formula edits only that formula and commits to Markdown", () => {
    const source = "| A | B |\n| --- | --- |\n| `\\(literal\\)` and \\(x+1\\) | 2 |";
    const { host, editor, cleanup } = mount(source);
    try {
      const formula = host.querySelector<HTMLElement>("tbody td .aaronnote-math-inline")!;
      expect(formula).toBeTruthy();
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(formula.classList.contains("cm-table-math-editor")).toBe(true);
      expect(formula.closest("td")?.querySelector(".cm-table-cell-input")).toBeNull();
      formula.dispatchEvent(new CustomEvent("aaronnote:table-math-draft", { detail: { latex: "y+2" } }));
      formula.dispatchEvent(new CustomEvent("aaronnote:table-math-commit"));
      expect(editor.getMarkdown()).toContain("`\\(literal\\)` and \\(y+2\\)");
      expect(host.querySelector("tbody td .aaronnote-math-inline[data-tex='y+2']")).toBeTruthy();
    } finally { cleanup(); }
  });

  test("switching cells commits a formula draft and opens the clicked cell", async () => {
    const { host, editor, cleanup } = mount("| A | B |\n| --- | --- |\n| \\(x\\) | next |");
    try {
      const formula = host.querySelector<HTMLElement>("tbody td .aaronnote-math-inline")!;
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      formula.dispatchEvent(new CustomEvent("aaronnote:table-math-draft", { detail: { latex: "y" } }));
      const secondCell = host.querySelectorAll<HTMLTableCellElement>("tbody td")[1]!;
      secondCell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      expect(editor.getMarkdown()).toContain("| \\(y\\) | next |");
      expect(host.querySelectorAll<HTMLTableCellElement>("tbody td")[1]?.querySelector<HTMLInputElement>(".cm-table-cell-input")?.value).toBe("next");
    } finally { cleanup(); }
  });

  test("clicking prose in the same cell after formula editing opens its source", async () => {
    const { host, editor, cleanup } = mount("| A | B |\n| --- | --- |\n| prose \\(x\\) | next |");
    try {
      const formula = host.querySelector<HTMLElement>("tbody td .aaronnote-math-inline")!;
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      formula.dispatchEvent(new CustomEvent("aaronnote:table-math-draft", { detail: { latex: "y" } }));
      formula.closest("td")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
      expect(editor.getMarkdown()).toContain("prose \\(y\\)");
      expect(host.querySelector<HTMLInputElement>("tbody td .cm-table-cell-input")?.value).toBe("prose \\(y\\)");
    } finally { cleanup(); }
  });

  test("formula editor failure falls back to a working source input", () => {
    const source = "| A | B |\n| --- | --- |\n| \\(x\\) | 2 |";
    const { host, editor, cleanup } = mount(source);
    try {
      const formula = host.querySelector<HTMLElement>("tbody td .aaronnote-math-inline")!;
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      formula.dispatchEvent(new Event("aaronnote:table-math-unavailable"));
      const input = host.querySelector<HTMLInputElement>("tbody td .cm-table-cell-input")!;
      expect(input.value).toBe("\\(x\\)");
      input.value = "\\(z\\)";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      input.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      expect(editor.getMarkdown()).toContain("\\(z\\)");
    } finally { cleanup(); }
  });

  test("cell input sends completion requests and lets accepted Tab stay inside the cell", () => {
    const { host, editor, cleanup } = mount("| A | B |\n| --- | --- |\n| one | two |");
    try {
      const cell = host.querySelector<HTMLTableCellElement>("tbody td")!;
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      const input = cell.querySelector<HTMLInputElement>(".cm-table-cell-input")!;
      input.focus();
      const requests: HTMLInputElement[] = [];
      host.addEventListener("aaronnote:table-cell-completion-request", (event) => {
        requests.push((event as CustomEvent<{ input: HTMLInputElement }>).detail.input);
      });
      host.addEventListener("aaronnote:table-cell-completion-key", (event) => event.preventDefault());
      input.value = "frac";
      input.dispatchEvent(new InputEvent("input", { bubbles: true }));
      expect(requests).toContain(input);
      const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      input.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(true);
      expect(cell.querySelector(".cm-table-cell-input")).toBe(input);
      expect(editor.getMarkdown()).toContain("| one | two |");
    } finally { cleanup(); }
  });

  test("read-only tables keep rendered cells without edit controls", () => {
    const { host, cleanup } = mount("| A | B |\n| --- | --- |\n| **one** | \\(x\\) |", true);
    try {
      expect(host.querySelector("tbody td strong")?.textContent).toBe("one");
      expect(host.querySelector("tbody td .aaronnote-math-inline")).toBeTruthy();
      expect(host.querySelector(".cm-table-toolbar")).toBeNull();
      const cell = host.querySelector<HTMLTableCellElement>("tbody td")!;
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(cell.querySelector(".cm-table-cell-input")).toBeNull();
    } finally { cleanup(); }
  });

  test("table input uses ordinary snippet fields before Tab moves cells", () => {
    const input = document.createElement("input");
    input.value = "frac";
    document.body.append(input);
    input.setSelectionRange(4, 4);
    try {
      const session = new SnippetSession(inputSnippetEditor(input));
      expect(expandSnippetBody({ body: "\\frac{${1:a}}{${2:b}}$0" }).tabstops.map((stop) => stop.index)).toEqual([1, 2, 0]);
      expect(session.insert({ key: "frac", body: "\\frac{${1:a}}{${2:b}}$0" }, 4)).toBe(true);
      expect(input.value).toBe("\\frac{a}{b}");
      expect(input.value.slice(input.selectionStart!, input.selectionEnd!)).toBe("a");
      input.setRangeText("x", input.selectionStart!, input.selectionEnd!, "end");
      input.setSelectionRange(7, 7);
      expect(session.previewState().stops.map((stop) => [stop.index, stop.from, stop.to])).toEqual([[1, 6, 7], [2, 9, 10]]);
      expect(session.next()).toBe(true);
      expect(session.previewState().stops.map((stop) => [stop.index, stop.from, stop.to, stop.active])).toEqual([[2, 9, 10, true]]);
      expect({ value: input.value, start: input.selectionStart, end: input.selectionEnd, selected: input.value.slice(input.selectionStart!, input.selectionEnd!) }).toEqual({ value: "\\frac{x}{b}", start: 9, end: 10, selected: "b" });
      input.setRangeText("y", input.selectionStart!, input.selectionEnd!, "end");
      input.setSelectionRange(10, 10);
      expect(session.next()).toBe(true);
      expect(input.value).toBe("\\frac{x}{y}");
      expect(session.next()).toBe(true);
      expect(session.next()).toBe(false);
    } finally { input.remove(); }
  });
});
