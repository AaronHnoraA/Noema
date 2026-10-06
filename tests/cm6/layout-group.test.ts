import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { markdownTopLevelBlocks, renderMarkdownHTML } from "../../src/render-html.ts";

describe("native layout group", () => {
  const source = "#+begin layout {cols=3 mode=grid data-note=keep}\nFirst paragraph.\n\n![plot](plot.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n#+end layout\n\nEnd";

  test("reader lays out ordinary Markdown blocks in a mixed grid", () => {
    const html = renderMarkdownHTML(source);
    expect(html).toContain('class="noema-layout-group noema-layout-grid"');
    expect(html).toContain('style="--noema-layout-cols:3;--noema-layout-tracks:');
    expect(html).toContain("First paragraph.");
    expect(html).toContain("plot.png");
    expect(html).toContain("<table");
  });

  test("grid cells reorder through parser source spans in one undo step", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editor.setMarkdownSelection(source.length);
    try {
      const body = source.slice(source.indexOf("\n") + 1, source.indexOf("#+end layout"));
      expect(markdownTopLevelBlocks(body)).toHaveLength(3);
      const grips = host.querySelectorAll<HTMLButtonElement>(".cm-layout-cell-grip");
      expect(grips).toHaveLength(3);
      grips[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, altKey: true, key: "ArrowRight" }));
      expect(editor.getMarkdown()).toContain("![plot](plot.png)\n\nFirst paragraph.\n\n| A | B |");
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
    } finally { editor.destroy(); host.remove(); }
  });

  test("column divider stores native width weights and reader applies them", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editor.setMarkdownSelection(source.length);
    try {
      const divider = host.querySelector<HTMLButtonElement>(".cm-layout-column-divider");
      expect(divider).toBeTruthy();
      divider!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      expect(editor.getMarkdown()).toMatch(/#\+begin layout \{cols=3 mode=grid data-note=keep widths=[\d.]+-[\d.]+-[\d.]+\}/);
      expect(renderMarkdownHTML(editor.getMarkdown())).toContain("--noema-layout-tracks:");
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
    } finally { editor.destroy(); host.remove(); }
  });

  test("layout edits preserve an existing Noema block identity", () => {
    const id = "0198fbac-0780-7c99-85e6-333333333333";
    const withId = source.replace("data-note=keep}", `data-note=keep} {#${id}}`);
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: withId });
    editor.setMarkdownSelection(withId.length);
    try {
      host.querySelector<HTMLButtonElement>('button[aria-label="Flow text between columns"]')!.click();
      expect(editor.getMarkdown()).toContain(`{cols=3 mode=flow data-note=keep} {#${id}}`);
      editor.undo();
      expect(editor.getMarkdown()).toBe(withId);
    } finally { editor.destroy(); host.remove(); }
  });

  test("editor controls update only the opener and can reveal source", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editor.setMarkdownSelection(source.length);
    try {
      const group = host.querySelector<HTMLElement>(".cm-layout-group-widget");
      expect(group).toBeTruthy();
      expect(group?.querySelectorAll(".cm-layout-group-content > *").length).toBeGreaterThanOrEqual(3);
      group?.querySelector<HTMLButtonElement>('button[aria-label="Flow text between columns"]')?.click();
      expect(editor.getMarkdown()).toContain("#+begin layout {cols=3 mode=flow data-note=keep}");
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
      host.querySelector<HTMLButtonElement>('button[aria-label="Edit layout source"]')?.click();
      expect(host.querySelector(".cm-layout-group-widget")).toBeNull();
      expect(editor.getMarkdown()).toBe(source);
    } finally { editor.destroy(); host.remove(); }
  });

  test("clicking a grid cell reveals that cell's Markdown", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    editor.setMarkdownSelection(source.length);
    try {
      const cell = host.querySelectorAll<HTMLElement>(".cm-layout-cell")[1]!;
      expect(cell).toBeTruthy();
      expect(Number(cell.dataset.cmSourceAnchor)).toBe(source.indexOf("![plot]"));
      cell.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      expect(editor.getMarkdownSelection().from).toBe(source.indexOf("![plot]"));
      expect(host.querySelector(".cm-layout-group-widget")).toBeNull();
    } finally { editor.destroy(); host.remove(); }
  });
});
