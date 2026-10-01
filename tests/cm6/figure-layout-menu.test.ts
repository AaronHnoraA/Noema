import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { applyFigureLayout, figureLayoutMenuItems, figureLayoutTarget } from "../../src/cm6/figure-layout-menu.ts";
import { setTikzRendererForTests } from "../../src/tikz-browser.ts";

function mount(markdown: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  editor.setMarkdownSelection(markdown.length);
  return { editor, host, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("figure layout context menu", () => {
  test("image alignment and width edit only its attrs and stay undoable", () => {
    const source = 'before\n![a](picture.png "title"){align=left data-note=keep}\nafter';
    const { editor, host, cleanup } = mount(source);
    try {
      const figure = host.querySelector<HTMLElement>(".cm-image-widget");
      const target = figureLayoutTarget(editor.view, figure?.querySelector("img") ?? null);
      expect(target?.kind).toBe("image");
      const menu = figureLayoutMenuItems(editor.view, target!);
      expect(menu[0]?.checked).toBe(true);
      menu.find((item) => item.label === "Align Right")?.run?.();
      expect(editor.getMarkdown()).toBe('before\n![a](picture.png "title"){data-note=keep align=right}\nafter');
      const updated = host.querySelector<HTMLElement>(".cm-image-widget");
      expect(updated?.classList.contains("aaronnote-image-align-right")).toBe(true);
      const width = figureLayoutMenuItems(editor.view, figureLayoutTarget(editor.view, updated)!).find((item) => item.label === "Width");
      width?.submenu?.find((item) => item.label === "50%")?.run?.();
      expect(editor.getMarkdown()).toContain("{data-note=keep align=right width=50%}");
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
      const resetTarget = figureLayoutTarget(editor.view, host.querySelector(".cm-image-widget"));
      expect(applyFigureLayout(editor.view, resetTarget!, { align: "center", wrap: false, width: "", height: "" })).toBe(true);
      expect(editor.getMarkdown()).toContain("{data-note=keep align=center}");
      expect(figureLayoutTarget(editor.view, host.querySelector(".cm-image-widget"))?.layout.align).toBe("center");
    } finally { cleanup(); }
  });

  test("a menu opened before another document edit cannot write to stale offsets", () => {
    const { editor, host, cleanup } = mount("![a](one.png)\nafter");
    try {
      const target = figureLayoutTarget(editor.view, host.querySelector(".cm-image-widget"));
      expect(target).toBeTruthy();
      editor.replaceMarkdownRange(0, 0, "prefix\n");
      expect(applyFigureLayout(editor.view, target!, { align: "right" })).toBe(false);
      expect(editor.getMarkdown()).toBe("prefix\n![a](one.png)\nafter");
    } finally { cleanup(); }
  });

  test("TikZ alignment, wrap and width preserve the source body", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const source = "before\n#+begin tikz diagram-id\n\\draw (0,0) -- (1,1);\n#+end tikz\nafter";
    const { editor, host, cleanup } = mount(source);
    try {
      const figure = host.querySelector<HTMLElement>(".cm-tikz-env-widget");
      const target = figureLayoutTarget(editor.view, figure);
      expect(target?.kind).toBe("tikz");
      expect(applyFigureLayout(editor.view, target!, { align: "right", wrap: false, width: "50%" })).toBe(true);
      expect(editor.getMarkdown()).toContain("#+begin tikz diagram-id {align=right width=50%}\n\\draw (0,0) -- (1,1);\n#+end tikz");
      expect(host.querySelector(".cm-tikz-env-widget")?.classList.contains("aaronnote-image-align-right")).toBe(true);
      const next = figureLayoutTarget(editor.view, host.querySelector(".cm-tikz-env-widget"));
      expect(applyFigureLayout(editor.view, next!, { align: "left", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toContain("{wrap=left width=50%}");
      expect(host.querySelector(".cm-tikz-env-widget")?.classList.contains("aaronnote-image-wrap")).toBe(true);
    } finally { cleanup(); setTikzRendererForTests(null); }
  });

  test("table and diagram use a separate layout line and reset cleanly", () => {
    for (const [source, selector, kind] of [
      ["| A | B |\n|---|---|\n| 1 | 2 |\nend", ".cm-table-editable-block", "table"],
      ["```mermaid\ngraph TD\nA-->B\n```\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)", "diagram"],
    ] as const) {
      const { editor, host, cleanup } = mount(source);
      try {
        const target = figureLayoutTarget(editor.view, host.querySelector(selector));
        expect(target?.kind).toBe(kind);
        expect(applyFigureLayout(editor.view, target!, { align: "left", width: "75%" })).toBe(true);
        expect(editor.getMarkdown()).toContain("\n{align=left width=75%}\nend");
        const updated = figureLayoutTarget(editor.view, host.querySelector(selector));
        expect(updated?.layout.width).toBe("75%");
        expect(applyFigureLayout(editor.view, updated!, { align: "center", width: "" })).toBe(true);
        expect(editor.getMarkdown()).toBe(source);
      } finally { cleanup(); }
    }
  });

  test("existing table and diagram attributes are replaced in place", () => {
    for (const [source, selector] of [
      ["| A | B |\n|---|---|\n| 1 | 2 |\n{wrap:right,width:40%}\nend", ".cm-table-editable-block"],
      ["```mermaid\ngraph TD\nA-->B\n```\n{wrap:right,width:40%}\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)"],
    ] as const) {
      const { editor, host, cleanup } = mount(source);
      try {
        const target = figureLayoutTarget(editor.view, host.querySelector(selector));
        expect(target?.layout).toMatchObject({ align: "right", wrap: true, width: "40%" });
        expect(applyFigureLayout(editor.view, target!, { align: "left", wrap: false })).toBe(true);
        expect(editor.getMarkdown()).toContain("\n{align=left width=40%}\nend");
        expect(editor.getMarkdown().match(/\n\{/g)).toHaveLength(1);
      } finally { cleanup(); }
    }
  });
});
