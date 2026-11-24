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

  test("bottom-edge height handle is scoped strictly to fixed-viewport figures (HTML embeds and Mermaid diagrams)", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const withHeight = [
      ["[](demo.html)\nend", ".cm-image-widget"],
      ["```mermaid\ngraph TD\nA-->B\n```\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)"],
    ] as const;
    const withoutHeight = [
      ["![a](one.png)\nend", ".cm-image-widget:not(.cm-tikz-env-widget)"],
      ["| A | B |\n|---|---|\n| 1 | 2 |\n# end", ".cm-table-editable-block"],
      ["#+begin tikz aaa\n\\draw (0,0) -- (1,1);\n#+end tikz\nend", ".cm-tikz-env-widget"],
    ] as const;
    try {
      for (const [source, selector] of withHeight) {
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
      for (const [source, selector] of withoutHeight) {
        const { host, cleanup } = mount(source);
        try {
          expect(host.querySelector(`${selector} > .cm-figure-height-handle`), selector).toBeNull();
        } finally { cleanup(); }
      }
    } finally { setTikzRendererForTests(null); }
  });

  test("all figures expose the same unified layout controls (inline bar or table toolbar popover)", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const inlineCases = [
      ["![a](one.png)\nend", ".cm-image-widget"],
      ["#+begin tikz aaa\n\\draw (0,0) -- (1,1);\n#+end tikz\nend", ".cm-tikz-env-widget"],
      ["```mermaid\ngraph TD\nA-->B\n```\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)"],
    ] as const;
    try {
      for (const [source, selector] of inlineCases) {
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
      // Tables keep ONE top-right toolbar with a `◫` layout popover (never two stacked toolbars).
      const tableSource = "| A | B |\n|---|---|\n| 1 | 2 |\n# end";
      const { editor, host, cleanup } = mount(tableSource);
      try {
        expect(host.querySelector(".cm-table-editable-block > .cm-figure-layout-toolbar")).toBeNull();
        const openBtn = host.querySelector<HTMLButtonElement>('.cm-table-toolbar button[aria-label="Table layout"]');
        expect(openBtn).toBeTruthy();
        openBtn!.click();
        const popover = host.querySelector<HTMLElement>(".cm-table-layout-popover");
        expect(popover).toBeTruthy();
        popover!.querySelector<HTMLButtonElement>('button[aria-label="Wrap text right"]')!.click();
        expect(editor.getMarkdown()).toContain("{wrap=right}");
        editor.undo();
        expect(editor.getMarkdown()).toBe(tableSource);
      } finally { cleanup(); }
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
      host.querySelector<HTMLButtonElement>('.cm-table-toolbar button[aria-label="Table layout"]')!.click();
      const button = host.querySelector<HTMLButtonElement>('.cm-table-layout-popover button[aria-label="Place beside next figure"]');
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

  test("image, table, TikZ and diagram resize handles write responsive percentage widths", () => {
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"></svg>');
    const cases = [
      ["![plot](plot.png){width=50%}\nend", ".cm-image-widget", "image", "{width=55%}"],
      ["| A | B |\n|---|---|\n| 1 | 2 |\n{width=60%}\n# end", ".cm-table-editable-block", "table", "{width=65%}"],
      ["#+begin tikz aaa {width=50%}\n\\draw (0,0) -- (1,1);\n#+end tikz\nend", ".cm-tikz-env-widget", "tikz", "{width=55%}"],
      ["```mermaid\ngraph TD\nA-->B\n```\n{width=50%}\nend", ".cm-mermaid-widget:not(.cm-mermaid-widget-preview)", "diagram", "{width=55%}"],
    ] as const;
    try {
      for (const [source, selector, kind, expected] of cases) {
        const { editor, host, cleanup } = mount(source);
        try {
          const figure = host.querySelector<HTMLElement>(selector)!;
          const handle = figure.querySelector<HTMLButtonElement>(".cm-figure-resize-handle");
          expect(handle, kind).toBeTruthy();
          handle!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
          expect(editor.getMarkdown(), kind).toContain(expected);
          editor.undo();
          expect(editor.getMarkdown(), kind).toBe(source);
        } finally { cleanup(); }
      }
    } finally { setTikzRendererForTests(null); }
  });

  test("right-aligned image drag expands leftward, Escape cancels, and width preset clears stale height", async () => {
    const source = "before\n![a](pic.png){align=right width=50% height=240px}\nafter";
    const { editor, host, cleanup } = mount(source);
    try {
      const figure = host.querySelector<HTMLElement>(".cm-image-widget")!;
      // Clicking width preset on an aspect-preserving image clears stale height.
      figure.querySelector<HTMLButtonElement>('button[title="Width 75%"]')!.click();
      expect(editor.getMarkdown()).toBe("before\n![a](pic.png){align=right width=75%}\nafter");

      // Dragging left on a right-aligned image increases percentage width.
      const updated = host.querySelector<HTMLElement>(".cm-image-widget")!;
      const handle = updated.querySelector<HTMLButtonElement>(".cm-figure-resize-handle")!;
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 200 }));
      handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 128 }));
      await new Promise(requestAnimationFrame);
      expect(handle.querySelector(".cm-figure-resize-badge")?.textContent).toMatch(/^\d+%$/);
      // Escape cancels without touching markdown.
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(handle.querySelector(".cm-figure-resize-badge")).toBeNull();
      expect(editor.getMarkdown()).toBe("before\n![a](pic.png){align=right width=75%}\nafter");

      // Re-drag and release commits responsive `%` width larger than 75%.
      handle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, clientX: 200 }));
      handle.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, cancelable: true, button: 0, clientX: 128 }));
      handle.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, cancelable: true, button: 0, clientX: 128 }));
      const match = editor.getMarkdown().match(/width=(\d+)%/);
      expect(match).toBeTruthy();
      expect(Number(match![1])).toBeGreaterThan(75);
    } finally { cleanup(); }
  });

  test("wrapped Mermaid uses shared .cm-float-anchor and keeps handles on the real figure box", () => {
    const source = "before\n\n```mermaid\ngraph LR\nA-->B\n```\n{wrap=right width=45%}\n\nafter";
    const { host, cleanup } = mount(source);
    try {
      const figure = host.querySelector<HTMLElement>(".cm-mermaid-widget")!;
      expect(figure.parentElement?.className).toBe("cm-float-anchor");
      expect(figure.classList.contains("noema-diagram-wrap")).toBe(true);
      expect(figure.classList.contains("noema-layout-has-width")).toBe(true);
      expect(figure.querySelector(".cm-figure-resize-handle")).toBeTruthy();
      expect(figure.querySelector(".cm-figure-height-handle")).toBeTruthy();
    } finally { cleanup(); }
  });

  test("editing table resolves figureLayoutTarget from source rows and resizes from bottom edge widget", () => {
    const source = "before\n\n| A | B |\n|---|---|\n| 1 | 2 |\n{width=60%}\n\n# end";
    const { editor, host, cleanup } = mount(source);
    try {
      editor.setMarkdownSelection(source.indexOf("1"));
      const sourceRow = host.querySelector<HTMLElement>(".cm-table-source-row")!;
      const rowTarget = figureLayoutTarget(editor.view, sourceRow);
      expect(rowTarget).toMatchObject({ kind: "table", layout: { width: "60%" } });

      // Top toolbar widget has no misplaced resize handle; bottom edge widget owns it.
      const topBar = host.querySelector<HTMLElement>(".cm-table-source-toolbar")!;
      const bottomEdge = host.querySelector<HTMLElement>(".cm-table-source-edge")!;
      expect(topBar.querySelector(".cm-figure-resize-handle")).toBeNull();
      const handle = bottomEdge.querySelector<HTMLButtonElement>(".cm-figure-resize-handle");
      expect(handle).toBeTruthy();
      handle!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      expect(editor.getMarkdown()).toContain("\n{width=65%}\n");
      editor.undo();
      expect(editor.getMarkdown()).toBe(source);
    } finally { cleanup(); }
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
      expect(updated?.classList.contains("noema-image-align-right")).toBe(true);
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
      expect(host.querySelector(".cm-tikz-env-widget")?.classList.contains("noema-image-align-right")).toBe(true);
      const next = figureLayoutTarget(editor.view, host.querySelector(".cm-tikz-env-widget"));
      expect(applyFigureLayout(editor.view, next!, { align: "left", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toContain("{wrap=left width=50%}");
      expect(host.querySelector(".cm-tikz-env-widget")?.classList.contains("noema-image-wrap")).toBe(true);
    } finally { cleanup(); setTikzRendererForTests(null); }
  });

  test("repeated TikZ wrap choices replace old attributes and keep the picture visible", async () => {
    const originalCurrentFile = window.NoemaCurrentFile;
    window.NoemaCurrentFile = () => "/notes/layout-wrap.md";
    setTikzRendererForTests(async () => '<svg viewBox="0 0 20 10"><path d="M0 0L20 10"/></svg>');
    const body = "\\draw (0,0) -- (1,1);\n#+end tikz";
    const source = `before\n#+begin tikz aaa {wrap=left} {wrap=left} {wrap=right} {wrap=right}\n${body}\nafter`;
    const { editor, host, cleanup } = mount(source);
    try {
      const figure = () => host.querySelector<HTMLElement>(".cm-tikz-env-widget")!;
      expect(figureLayoutTarget(editor.view, figure())?.layout).toMatchObject({ align: "right", wrap: true });
      expect(figure().classList.contains("noema-image-align-right")).toBe(true);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(figure().querySelector("svg")).toBeTruthy();
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure())!, { align: "left", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toBe(`before\n#+begin tikz aaa {wrap=left}\n${body}\nafter`);
      expect(figure().classList.contains("noema-image-align-left")).toBe(true);
      expect(figure().classList.contains("cm-noema-measured-widget")).toBe(false);
      await new Promise((resolve) => window.setTimeout(resolve, 0));
      expect(figure().querySelector("svg")).toBeTruthy();
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure())!, { align: "left", wrap: true })).toBe(false);
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure())!, { align: "right", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toBe(`before\n#+begin tikz aaa {wrap=right}\n${body}\nafter`);
    } finally { cleanup(); window.NoemaCurrentFile = originalCurrentFile; setTikzRendererForTests(null); }
  });

  test("TikZ layout changes preserve unrelated title attributes", () => {
    const source = "#+begin tikz aaa {note=keep} {wrap=left}\n\\draw (0,0) -- (1,1);\n#+end tikz";
    const { editor, host, cleanup } = mount(source);
    try {
      const figure = host.querySelector<HTMLElement>(".cm-tikz-env-widget")!;
      expect(figure.classList.contains("noema-image-align-left")).toBe(true);
      expect(applyFigureLayout(editor.view, figureLayoutTarget(editor.view, figure)!, { align: "right", wrap: true })).toBe(true);
      expect(editor.getMarkdown()).toContain("#+begin tikz aaa {note=keep} {wrap=right}\n");
      expect(host.querySelector(".cm-tikz-env-widget")?.classList.contains("noema-image-align-right")).toBe(true);
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
