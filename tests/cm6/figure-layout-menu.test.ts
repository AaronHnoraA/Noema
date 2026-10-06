import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { applyFigureLayout, applyFigureLayouts, figureLayoutMenuItems, figureLayoutTarget, swapAdjacentFigures } from "../../src/cm6/figure-layout-menu.ts";
import { setTikzRendererForTests } from "../../src/tikz-browser.ts";

function mount(markdown: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: markdown });
  editor.setMarkdownSelection(markdown.length);
  return { editor, host, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("figure layout context menu", () => {
  test("whole figure grip swaps mixed adjacent blocks and keeps source bytes", () => {
    const source = "![plot](plot.png)\n\n| A | B |\n|---|---|\n| 1 | 2 |\n{align=left data-note=keep}\n\nend";
    const { editor, host, cleanup } = mount(source);
    try {
      const image = host.querySelector<HTMLElement>(".cm-image-widget")!;
      const table = host.querySelector<HTMLElement>(".cm-table-editable-block")!;
      expect(image.querySelector(".cm-figure-move-grip")).toBeTruthy();
      expect(table.querySelector(".cm-figure-move-grip")).toBeTruthy();
      image.querySelector<HTMLButtonElement>(".cm-figure-move-grip")!.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, altKey: true, key: "ArrowDown" }),
      );
      expect(editor.getMarkdown()).toBe("| A | B |\n|---|---|\n| 1 | 2 |\n{align=left data-note=keep}\n\n![plot](plot.png)\n\nend");
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
    } finally { cleanup(); }
  });

  test("figure reorder refuses intervening prose and stale source", () => {
    const source = "![a](a.png)\n\nprose\n\n![b](b.png)";
    const { editor, host, cleanup } = mount(source);
    try {
      const figures = host.querySelectorAll<HTMLElement>(".cm-image-widget");
      const first = figureLayoutTarget(editor.view, figures[0])!;
      const second = figureLayoutTarget(editor.view, figures[1])!;
      expect(swapAdjacentFigures(editor.view, first, second)).toBe(false);
      editor.replaceMarkdownRange(0, 0, "prefix\n");
      expect(swapAdjacentFigures(editor.view, first, second)).toBe(false);
    } finally { cleanup(); }
  });

  test("whole figure swap includes TikZ and Mermaid bodies", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const tikz = "#+begin tikz figure-id\n\\draw (0,0) -- (1,1);\n#+end tikz";
    const mermaid = "```mermaid\ngraph TD\nA-->B\n```";
    const source = `${tikz}\n\n${mermaid}`;
    const { editor, host, cleanup } = mount(source);
    try {
      const left = figureLayoutTarget(editor.view, host.querySelector(".cm-tikz-env-widget"));
      const right = figureLayoutTarget(editor.view, host.querySelector(".cm-mermaid-widget:not(.cm-mermaid-widget-preview)"));
      expect(left?.kind).toBe("tikz");
      expect(right?.kind).toBe("diagram");
      expect(swapAdjacentFigures(editor.view, left!, right!)).toBe(true);
      expect(editor.getMarkdown()).toBe(`${mermaid}\n\n${tikz}`);
    } finally { cleanup(); setTikzRendererForTests(null); }
  });

  test("shared bottom-edge height control edits each figure's existing attrs", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const cases = [
      ["![a](one.png)\nend", ".cm-image-widget:not(.cm-tikz-env-widget)"],
      ["| A | B |\n|---|---|\n| 1 | 2 |\n# end", ".cm-table-editable-block"],
      ["#+begin tikz aaa\n\\draw (0,0) -- (1,1);\n#+end tikz\nend", ".cm-tikz-env-widget"],
      ["```mermaid\ngraph TD\nA-->B\n```\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)"],
    ] as const;
    try {
      for (const [source, selector] of cases) {
        const { editor, host, cleanup } = mount(source);
        try {
          const handle = host.querySelector<HTMLButtonElement>(`${selector} > .cm-figure-height-handle`);
          expect(handle, selector).toBeTruthy();
          handle!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
          expect(editor.getMarkdown(), selector).toMatch(/\{height=\d+px\}/);
          editor.undo();
          expect(editor.getMarkdown(), selector).toBe(source);
        } finally { cleanup(); }
      }
    } finally { setTikzRendererForTests(null); }
  });

  test("all block figures expose the same source-backed layout toolbar", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const cases = [
      ["| A | B |\n|---|---|\n| 1 | 2 |\n# end", ".cm-table-editable-block"],
      ["#+begin tikz aaa\n\\draw (0,0) -- (1,1);\n#+end tikz\nend", ".cm-tikz-env-widget"],
      ["```mermaid\ngraph TD\nA-->B\n```\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)"],
    ] as const;
    try {
      for (const [source, selector] of cases) {
        const { editor, host, cleanup } = mount(source);
        try {
          const toolbar = host.querySelector<HTMLElement>(`${selector} > .cm-figure-layout-toolbar`);
          expect(toolbar).toBeTruthy();
          toolbar!.querySelector<HTMLButtonElement>('button[aria-label="Wrap text right"]')!.click();
          expect(editor.getMarkdown()).toContain("{wrap=right}");
          editor.undo();
          expect(editor.getMarkdown()).toBe(source);
        } finally { cleanup(); }
      }
    } finally { setTikzRendererForTests(null); }
  });

  test("mixed figure layouts commit together and reject a stale target atomically", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const source = "| A | B |\n|---|---|\n| 1 | 2 |\n# end\n#+begin tikz aaa\n\\draw (0,0) -- (1,1);\n#+end tikz";
    const { editor, host, cleanup } = mount(source);
    try {
      const table = figureLayoutTarget(editor.view, host.querySelector(".cm-table-editable-block"))!;
      const tikz = figureLayoutTarget(editor.view, host.querySelector(".cm-tikz-env-widget"))!;
      expect(table?.kind).toBe("table");
      expect(tikz?.kind).toBe("tikz");
      expect(applyFigureLayouts(editor.view, [
        { target: table, patch: { width: "50%" } },
        { target: tikz, patch: { align: "right", width: "50%" } },
      ])).toBe(true);
      expect(editor.getMarkdown()).toContain("\n{width=50%}\n# end");
      expect(editor.getMarkdown()).toContain("#+begin tikz aaa {align=right width=50%}");
      expect(applyFigureLayouts(editor.view, [{ target: table, patch: { width: "25%" } }])).toBe(false);
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
    } finally { cleanup(); setTikzRendererForTests(null); }
  });

  test("adjacent table and TikZ pair through existing wrap attrs in one undo step", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const source = "| A | B |\n|---|---|\n| 1 | 2 |\n\n#+begin tikz aaa\n\\draw (0,0) -- (1,1);\n#+end tikz";
    const { editor, host, cleanup } = mount(source);
    try {
      const button = host.querySelector<HTMLButtonElement>('.cm-table-editable-block > .cm-figure-layout-toolbar button[aria-label="Place beside next figure"]');
      expect(button).toBeTruthy();
      const tableTarget = figureLayoutTarget(editor.view, host.querySelector(".cm-table-editable-block"));
      const tikzTarget = figureLayoutTarget(editor.view, host.querySelector(".cm-tikz-env-widget"));
      expect({ tableTarget, tikzTarget, gap: tableTarget && tikzTarget ? editor.view.state.doc.sliceString(tableTarget.to, tikzTarget.from) : null }).toMatchObject({
        tableTarget: { kind: "table" }, tikzTarget: { kind: "tikz" }, gap: "\n\n",
      });
      button!.click();
      expect(editor.getMarkdown()).toContain("| 1 | 2 |\n{wrap=left width=48%}\n\n#+begin tikz aaa {wrap=right width=48%}");
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
    } finally { cleanup(); setTikzRendererForTests(null); }
  });

  test("image and table pair, while intervening prose prevents pairing", () => {
    for (const gap of ["\n\n", "\n\nThis is a captioned explanation.\n\n"]) {
      const source = `![plot](plot.png)${gap}| A | B |\n|---|---|\n| 1 | 2 |\n# end`;
      const { editor, host, cleanup } = mount(source);
      try {
        const button = host.querySelector<HTMLButtonElement>('.cm-image-widget .cm-image-toolbar button[title="Place with next figure"]');
        expect(button).toBeTruthy();
        button!.click();
        if (gap.trim()) expect(editor.getMarkdown()).toBe(source);
        else {
          expect(editor.getMarkdown()).toContain("![plot](plot.png){wrap=left width=48%}");
          expect(editor.getMarkdown()).toContain("| 1 | 2 |\n{wrap=right width=48%}");
          editor.undo();
          expect(editor.getMarkdown()).toBe(source);
        }
      } finally { cleanup(); }
    }
  });

  test("table, TikZ and diagram resize handles write their existing width attrs", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const cases = [
      ["| A | B |\n|---|---|\n| 1 | 2 |\n# end", ".cm-table-editable-block", "table"],
      ["#+begin tikz aaa\n\\draw (0,0) -- (1,1);\n#+end tikz\nend", ".cm-tikz-env-widget", "tikz"],
      ["```mermaid\ngraph TD\nA-->B\n```\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)", "diagram"],
    ] as const;
    try {
      for (const [source, selector, kind] of cases) {
        const { editor, host, cleanup } = mount(source);
        try {
          const figure = host.querySelector<HTMLElement>(selector)!;
          const handle = figure.querySelector<HTMLButtonElement>(".cm-figure-resize-handle");
          expect(handle, kind).toBeTruthy();
          handle!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
          expect(editor.getMarkdown(), kind).toMatch(/\{width=\d+px\}/);
          editor.undo();
          expect(editor.getMarkdown(), kind).toBe(source);
        } finally { cleanup(); }
      }
    } finally { setTikzRendererForTests(null); }
  });

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
      expect(editor.getMarkdown()).toContain("{data-note=keep align=right}");
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

  test("repeated TikZ wrap choices replace old attributes and keep the picture visible", async () => {
    const originalCurrentFile = window.AaronnoteCurrentFile;
    window.AaronnoteCurrentFile = () => "/notes/layout-wrap.md";
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"><path d="M0 0L20 10"/></svg>');
    const body = "\\draw (0,0) -- (1,1);\n#+end tikz";
    const source = `before\n#+begin tikz aaa {wrap=left} {wrap=left} {wrap=right} {wrap=right}\n${body}\nafter`;
    const { editor, host, cleanup } = mount(source);
    try {
      const figure = () => host.querySelector<HTMLElement>(".cm-tikz-env-widget")!;
      expect(figureLayoutTarget(editor.view, figure())?.layout).toMatchObject({ align: "right", wrap: true });
      expect(figure().classList.contains("aaronnote-image-align-right")).toBe(true);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(figure().querySelector("svg")).toBeTruthy();
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure())!, { align: "left", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toBe(`before\n#+begin tikz aaa {wrap=left}\n${body}\nafter`);
      expect(figure().classList.contains("aaronnote-image-align-left")).toBe(true);
      expect(figure().classList.contains("cm-aaronnote-measured-widget")).toBe(false);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(figure().querySelector("svg")).toBeTruthy();
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure())!, { align: "left", wrap: true })).toBe(false);
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure())!, { align: "right", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toBe(`before\n#+begin tikz aaa {wrap=right}\n${body}\nafter`);
    } finally { cleanup(); window.AaronnoteCurrentFile = originalCurrentFile; setTikzRendererForTests(null); }
  });

  test("TikZ layout changes preserve unrelated title attributes", () => {
    const source = "#+begin tikz aaa {note=keep} {wrap=left}\n\\draw (0,0) -- (1,1);\n#+end tikz";
    const { editor, host, cleanup } = mount(source);
    try {
      const figure = host.querySelector<HTMLElement>(".cm-tikz-env-widget")!;
      expect(figure.classList.contains("aaronnote-image-align-left")).toBe(true);
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure)!, { align: "right", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toContain("#+begin tikz aaa {note=keep} {wrap=right}\n");
      expect(host.querySelector(".cm-tikz-env-widget")?.classList.contains("aaronnote-image-align-right")).toBe(true);
    } finally { cleanup(); }
  });

  test("table and diagram use a separate layout line and reset cleanly", () => {
    for (const [source, selector, kind, tail] of [
      // GFM keeps plain text under a table as a row, so the table is followed
      // by a heading, which ends it, as in export and the Lezer tree.
      ["| A | B |\n|---|---|\n| 1 | 2 |\n# end", ".cm-table-editable-block", "table", "# end"],
      ["```mermaid\ngraph TD\nA-->B\n```\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)", "diagram", "end"],
    ] as const) {
      const { editor, host, cleanup } = mount(source);
      try {
        const target = figureLayoutTarget(editor.view, host.querySelector(selector));
        expect(target?.kind).toBe(kind);
        expect(applyFigureLayout(editor.view, target!, { align: "left", width: "75%" })).toBe(true);
        expect(editor.getMarkdown()).toContain(`\n{align=left width=75%}\n${tail}`);
        const updated = figureLayoutTarget(editor.view, host.querySelector(selector));
        expect(updated?.layout.width).toBe("75%");
        expect(applyFigureLayout(editor.view, updated!, { align: "center", width: "" })).toBe(true);
        expect(editor.getMarkdown()).toBe(source);
      } finally { cleanup(); }
    }
  });

  test("existing table and diagram attributes are replaced in place", () => {
    for (const [source, selector, tail] of [
      ["| A | B |\n|---|---|\n| 1 | 2 |\n{wrap:right,width:40%}\n# end", ".cm-table-editable-block", "# end"],
      ["```mermaid\ngraph TD\nA-->B\n```\n{wrap:right,width:40%}\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)", "end"],
    ] as const) {
      const { editor, host, cleanup } = mount(source);
      try {
        const target = figureLayoutTarget(editor.view, host.querySelector(selector));
        expect(target?.layout).toMatchObject({ align: "right", wrap: true, width: "40%" });
        expect(applyFigureLayout(editor.view, target!, { align: "left", wrap: false })).toBe(true);
        expect(editor.getMarkdown()).toContain(`\n{align=left width=40%}\n${tail}`);
        expect(editor.getMarkdown().match(/\n\{/g)).toHaveLength(1);
      } finally { cleanup(); }
    }
  });
});
