import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { tableCellMathRanges } from "../../src/cm6/table-cell-assist.ts";

function mount(source: string, readOnly = false) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source, readOnly });
  return { host, editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("Markdown table formula editing", () => {
  test("recognizes math while leaving code spans literal", () => {
    expect(tableCellMathRanges("`\\(literal\\)` and \\(x+1\\)")).toEqual([
      { from: 18, to: 25, tex: "x+1" },
    ]);
    expect(tableCellMathRanges("\\(\\) then \\(x\\)")).toEqual([
      { from: 10, to: 15, tex: "x" },
    ]);
  });

  test("a rendered formula enters the same CM6 source flow as body text", async () => {
    const source = "| A | B |\n| --- | --- |\n| `\\(literal\\)` and \\(x+1\\) | 2 |";
    const { host, editor, cleanup } = mount(source);
    try {
      const formula = host.querySelector<HTMLElement>("tbody td .aaronnote-math-inline")!;
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      formula.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(editor.getMarkdownSelection().from).toBe(source.indexOf("x+1"));
      expect(host.querySelector(".cm-table-source-row")).toBeTruthy();
      expect(host.querySelector(".cm-table-math-editor")).toBeNull();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      editor.replaceMarkdownRange(source.indexOf("x+1"), source.indexOf("x+1") + 3, "y+2");
      expect(editor.getMarkdown()).toContain("`\\(literal\\)` and \\(y+2\\)");
    } finally { cleanup(); }
  });

  test("clicking a second formula targets the second source range", () => {
    const source = "| A | B |\n| --- | --- |\n| \\(x\\) and \\(y\\) | 2 |";
    const { host, editor, cleanup } = mount(source);
    try {
      const formula = host.querySelectorAll<HTMLElement>("tbody td .aaronnote-math-inline")[1]!;
      formula.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      formula.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(editor.getMarkdownSelection().from).toBe(source.indexOf("y"));
    } finally { cleanup(); }
  });

  test("prose and table formulas place the caret at the same clicked offset", () => {
    const source = "Before \\(abcd\\) after\n\n| A | B |\n| --- | --- |\n| \\(abcd\\) | 2 |";
    const { host, editor, cleanup } = mount(source);
    try {
      const pointAtThreeQuarters = (element: HTMLElement) => {
        element.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
        element.dispatchEvent(new MouseEvent("mousedown", {
          bubbles: true, cancelable: true, button: 0, clientX: 75,
        }));
      };
      pointAtThreeQuarters(host.querySelector<HTMLElement>(".cm-math-inline")!);
      expect(editor.getMarkdownSelection().from).toBe(source.indexOf("abcd") + 3);

      const tableFormula = host.querySelector<HTMLElement>("tbody td .aaronnote-math-inline")!;
      tableFormula.getBoundingClientRect = () => ({ left: 0, width: 100 }) as DOMRect;
      tableFormula.dispatchEvent(new MouseEvent("mousedown", {
        bubbles: true, cancelable: true, button: 0, clientX: 75,
      }));
      tableFormula.dispatchEvent(new MouseEvent("click", {
        bubbles: true, cancelable: true, button: 0, clientX: 75,
      }));
      expect(editor.getMarkdownSelection().from).toBe(source.lastIndexOf("abcd") + 3);
      expect(host.querySelectorAll(".cm-table-source-active-cell")).toHaveLength(1);
    } finally { cleanup(); }
  });

  test("read-only tables keep rendered cells without edit controls", () => {
    const { host, cleanup } = mount("| A | B |\n| --- | --- |\n| **one** | \\(x\\) |", true);
    try {
      expect(host.querySelector("tbody td strong")?.textContent).toBe("one");
      expect(host.querySelector("tbody td .aaronnote-math-inline")).toBeTruthy();
      expect(host.querySelector(".cm-table-toolbar")).toBeNull();
    } finally { cleanup(); }
  });
});
