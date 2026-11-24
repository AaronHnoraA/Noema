import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../../src/editor-api.ts";
import { runEditorDelete, runEditorMovement, runEditorTextInput } from "../../src/cm6/input-commands.ts";
import { renderMarkdownHTML } from "../../src/render-html.ts";
import {
  columnDividerLeftCss,
  columnLeftCss,
  columnRightCss,
  columnWidthCss,
  normalizeColumnWidths,
  parseColumnsHeader,
  serializeColumnsAttrs,
  splitColumnPanes,
} from "../../src/columns-layout.ts";
// @ts-ignore Server ESM module lives outside the renderer TypeScript graph.
import { preprocessNoemaForPandoc } from "../../server/lib/latex-export-pandoc.mjs";
// @ts-ignore Server ESM module lives outside the renderer TypeScript graph.
import { latexMacrosPackage } from "../../server/lib/latex-export.mjs";

describe("multi-column layout (`#+begin columns` + `#+col`)", () => {
  const multiBlockSource = [
    "#+begin columns {widths=60-40 valign=center data-note=keep}",
    "### Overview",
    "",
    "First paragraph with **bold** and \\(x^2\\).",
    "",
    "- Point A",
    "- Point B",
    "",
    "#+col {align=center}",
    "",
    "![Plot](assets/plot.png)",
    "",
    "| A | B |",
    "|---|---|",
    "| 1 | 2 |",
    "#+end columns",
    "",
    "End",
  ].join("\n");

  test("splitColumnPanes supports arbitrary multi-block panes and ignores #+col inside fences or nested envs", () => {
    const body = [
      "### Col 1",
      "",
      "```markdown",
      "#+col",
      "```",
      "",
      "#+begin note Inner",
      "#+col",
      "#+end note",
      "",
      "#+col {align=right}",
      "",
      "Second pane text.",
    ].join("\n");
    const panes = splitColumnPanes(body);
    expect(panes).toHaveLength(2);
    expect(panes[0]!.body).toContain("```markdown\n#+col\n```");
    expect(panes[0]!.body).toContain("#+begin note Inner\n#+col\n#+end note");
    expect(panes[0]!.align).toBe("inherit");
    expect(panes[1]!.align).toBe("right");
    expect(panes[1]!.body.trim()).toBe("Second pane text.");
  });

  test("width normalization always returns clean integers summing strictly to 100", () => {
    expect(normalizeColumnWidths(null, 3)).toEqual([34, 33, 33]);
    expect(normalizeColumnWidths([1, 2], 2)).toEqual([33, 67]);
    expect(normalizeColumnWidths([5, 95], 2)).toEqual([15, 85]);
    const spec = parseColumnsHeader("{widths=50-50 valign=top gap=md rule=on}");
    expect(serializeColumnsAttrs(spec, 2)).toBe("");
    expect(columnDividerLeftCss([60, 40], 0)).toContain("0.600000");
    expect(columnDividerLeftCss([60, 40], 0)).toContain("0.5 * var(--noema-columns-gap)");
    expect(columnLeftCss([60, 40], 0)).toBe("0px");
    expect(columnRightCss([60, 40], 1)).toBe("0px");
    expect(columnLeftCss([60, 40], 1)).toContain("0.600000");
    expect(columnWidthCss([60, 40], 0)).toContain("0.600000");
  });

  test("HTML reader renders full multi-block column panes with unified contract", () => {
    const html = renderMarkdownHTML(multiBlockSource, {
      assetResolver: (src) => `/resolved/${src}`,
    });
    const container = document.createElement("div");
    container.innerHTML = html;
    const root = container.querySelector<HTMLElement>(".noema-columns")!;
    expect(root).toBeTruthy();
    expect(root.classList.contains("noema-columns-columns")).toBe(true);
    expect(root.classList.contains("noema-columns-valign-center")).toBe(true);
    expect(root.classList.contains("noema-columns-rule-on")).toBe(true);
    expect(root.dataset.cols).toBe("2");
    expect(root.style.getPropertyValue("--noema-columns-tracks")).toBe("minmax(0, 60fr) minmax(0, 40fr)");

    const panes = root.querySelectorAll<HTMLElement>(".noema-column-pane");
    expect(panes).toHaveLength(2);
    expect(panes[0]!.querySelector("h3")?.textContent).toBe("Overview");
    expect(panes[0]!.querySelectorAll("li")).toHaveLength(2);
    expect(panes[1]!.classList.contains("noema-columns-align-center")).toBe(true);
    expect(panes[1]!.querySelector("img")?.getAttribute("src")).toBe("/resolved/assets/plot.png");
    expect(panes[1]!.querySelector("table")).toBeTruthy();
  });

  test("CM6 preview resolves relative assets via window.NoemaResolveAssetUrl", () => {
    const prevResolver = window.NoemaResolveAssetUrl;
    window.NoemaResolveAssetUrl = (src) => `/api/asset?path=${src}`;
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: multiBlockSource });
    editor.setMarkdownSelection(multiBlockSource.length);
    try {
      const img = host.querySelector<HTMLImageElement>(".cm-columns-widget img");
      expect(img?.getAttribute("src")).toBe("/api/asset?path=assets/plot.png");
    } finally {
      window.NoemaResolveAssetUrl = prevResolver;
      editor.destroy();
      host.remove();
    }
  });

  test("whole-column reorder swaps entire multi-block panes and custom widths in one undo step", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: multiBlockSource });
    editor.setMarkdownSelection(multiBlockSource.length);
    try {
      const grips = host.querySelectorAll<HTMLButtonElement>(".cm-column-pane-grip");
      expect(grips).toHaveLength(2);
      grips[0]!.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, altKey: true, key: "ArrowRight" }));
      const next = editor.getMarkdown();
      expect(next).toContain("{data-note=keep widths=40-60 valign=center}");
      expect(next.indexOf("![Plot](assets/plot.png)")).toBeLessThan(next.indexOf("### Overview"));
      editor.undo();
      expect(editor.getMarkdown()).toBe(multiBlockSource);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("divider keyboard resize writes clean integer widths summing to 100 and double-click resets equal", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: multiBlockSource });
    editor.setMarkdownSelection(multiBlockSource.length);
    try {
      const divider = host.querySelector<HTMLButtonElement>(".cm-columns-divider")!;
      expect(divider).toBeTruthy();
      divider.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" }));
      expect(editor.getMarkdown()).toContain("widths=62-38");
      const updatedDivider = host.querySelector<HTMLButtonElement>(".cm-columns-divider")!;
      updatedDivider.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
      expect(editor.getMarkdown()).not.toContain("widths=");
      expect(editor.getMarkdown()).toContain("valign=center");
      editor.undo();
      expect(editor.getMarkdown()).toContain("widths=62-38");
      editor.undo();
      expect(editor.getMarkdown()).toBe(multiBlockSource);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("adding and removing columns works cleanly without losing non-empty content", () => {
    const simple = "#+begin columns\nLeft body.\n\n#+col\n\nRight body.\n#+end columns\n\nTail";
    const bodyOf = (md: string) => md.slice(md.indexOf("\n") + 1, md.indexOf("\n#+end columns"));
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: simple });
    editor.setMarkdownSelection(simple.length);
    try {
      host.querySelector<HTMLButtonElement>('button[aria-label="Add column"]')!.click();
      expect(splitColumnPanes(bodyOf(editor.getMarkdown()))).toHaveLength(3);
      expect(host.querySelectorAll(".cm-column-pane")).toHaveLength(3);
      host.querySelector<HTMLButtonElement>('button[aria-label="Remove last column"]')!.click();
      expect(splitColumnPanes(bodyOf(editor.getMarkdown()))).toHaveLength(2);
      expect(host.querySelectorAll(".cm-column-pane")).toHaveLength(2);
      // Removing a non-empty column merges its content into the previous column (lossless).
      host.querySelector<HTMLButtonElement>('button[aria-label="Remove last column"]')!.click();
      const merged = editor.getMarkdown();
      expect(merged).toContain("Left body.");
      expect(merged).toContain("Right body.");
      expect(merged).toContain("\n#+end columns");
      expect(merged).not.toContain("#+col");
      editor.undo();
      expect(editor.getMarkdown()).toContain("#+col");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("clicking a pane enters side-by-side WYSIWYG editing without showing raw directives, and clicking sibling switches panes in-place", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: multiBlockSource });
    editor.setMarkdownSelection(multiBlockSource.length);
    try {
      const panes = host.querySelectorAll<HTMLElement>(".cm-column-pane");
      expect(panes).toHaveLength(2);
      expect(Number(panes[1]!.dataset.cmSourceAnchor)).toBe(multiBlockSource.indexOf("![Plot]"));

      // Click Column 2 -> stays side-by-side in WYSIWYG mode!
      panes[1]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      expect(editor.getMarkdownSelection().from).toBe(multiBlockSource.indexOf("![Plot]"));
      expect(host.querySelector(".cm-columns-widget")).toBeNull();
      expect(host.querySelector(".cm-columns-open-banner")).toBeNull();
      expect(host.querySelector(".cm-columns-col-banner")).toBeNull();
      expect(host.querySelector(".cm-columns-close-banner")).toBeNull();

      // Active stage renders Column 1 as live sibling pane beside Column 2's native CM6 lines.
      const topStage = host.querySelector<HTMLElement>(".cm-columns-active-top")!;
      expect(topStage).toBeTruthy();
      expect(topStage.dataset.activeCol).toBe("1");
      expect(host.querySelector(".cm-columns-active-bottom")).toBeTruthy();
      expect(host.querySelectorAll(".cm-columns-active-line").length).toBeGreaterThanOrEqual(1);
      const siblingPanes = host.querySelectorAll<HTMLElement>(".cm-columns-sibling-pane");
      expect(siblingPanes).toHaveLength(1);
      expect(siblingPanes[0]!.dataset.colIndex).toBe("0");
      expect(siblingPanes[0]!.textContent).toContain("Overview");
      expect(host.querySelector('.cm-org-env-rail[data-org-env-kind="columns"]')).toBeNull();

      // Clicking Column 1 (sibling pane) switches active editing directly to Column 1 in-place!
      siblingPanes[0]!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 }));
      expect(editor.getMarkdownSelection().from).toBe(multiBlockSource.indexOf("### Overview"));
      expect(host.querySelector<HTMLElement>(".cm-columns-active-top")?.dataset.activeCol).toBe("0");
      const nextSiblings = host.querySelectorAll<HTMLElement>(".cm-columns-sibling-pane");
      expect(nextSiblings).toHaveLength(1);
      expect(nextSiblings[0]!.dataset.colIndex).toBe("1");
      expect(nextSiblings[0]!.querySelector("table")).toBeTruthy();

      // Typing directly inside Column 1 works natively and live toolbar still works after edits!
      const view = editor.view as unknown as EditorView;
      runEditorTextInput(view, "Intro ");
      expect(editor.getMarkdown()).toContain("Intro ### Overview");
      expect(host.querySelector<HTMLElement>(".cm-columns-active-top")?.dataset.activeCol).toBe("0");
      host.querySelector<HTMLButtonElement>('button[aria-label="Align center"]')!.click();
      expect(editor.getMarkdown()).toContain("align=center");
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("WYSIWYG keyboard navigation crosses columns seamlessly and protects directive boundaries", () => {
    const simple = "Before\n\n#+begin columns\nLeft\n\n#+col\n\nRight\n#+end columns\n\nAfter";
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: simple });
    const view = editor.view as unknown as EditorView;
    try {
      // Place caret at start of Column 1 ("Left").
      const leftStart = simple.indexOf("Left");
      const leftEnd = leftStart + "Left".length;
      const rightStart = simple.indexOf("Right");
      const rightEnd = rightStart + "Right".length;
      editor.setMarkdownSelection(leftStart);
      expect(host.querySelector<HTMLElement>(".cm-columns-active-top")?.dataset.activeCol).toBe("0");

      // Backspace at start of Column 1 must NOT delete `#+begin columns`.
      runEditorDelete(view, "backward");
      expect(editor.getMarkdown()).toBe(simple);

      // Delete at end of Column 1 must NOT delete `#+col`.
      editor.setMarkdownSelection(leftEnd);
      runEditorDelete(view, "forward");
      expect(editor.getMarkdown()).toBe(simple);

      // ArrowRight at end of Column 1 jumps straight to start of Column 2 (stays WYSIWYG).
      runEditorMovement(view, "ArrowRight");
      expect(editor.getMarkdownSelection().from).toBe(rightStart);
      expect(host.querySelector<HTMLElement>(".cm-columns-active-top")?.dataset.activeCol).toBe("1");

      // Backspace at start of Column 2 must NOT delete `#+col`.
      runEditorDelete(view, "backward");
      expect(editor.getMarkdown()).toBe(simple);

      // ArrowLeft at start of Column 2 jumps straight back to end of Column 1.
      runEditorMovement(view, "ArrowLeft");
      expect(editor.getMarkdownSelection().from).toBe(leftEnd);
      expect(host.querySelector<HTMLElement>(".cm-columns-active-top")?.dataset.activeCol).toBe("0");

      // Delete at end of Column 2 must NOT delete `#+end columns`.
      editor.setMarkdownSelection(rightEnd);
      runEditorDelete(view, "forward");
      expect(editor.getMarkdown()).toBe(simple);

      // ArrowDown from bottom of Column 2 exits cleanly below the block back to preview.
      runEditorMovement(view, "ArrowDown");
      expect(editor.getMarkdownSelection().from).toBeGreaterThan(simple.indexOf("#+end columns"));
      expect(host.querySelector(".cm-columns-widget")).toBeTruthy();
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("Source button manually expands raw syntax banners, and Visual / Done return cleanly", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: multiBlockSource });
    editor.setMarkdownSelection(multiBlockSource.length);
    try {
      // Click Source from preview -> expands raw banners.
      host.querySelector<HTMLButtonElement>('button[aria-label="Edit columns source"]')!.click();
      expect(host.querySelector(".cm-columns-widget")).toBeNull();
      expect(host.querySelector(".cm-columns-active-top")).toBeNull();
      expect(host.querySelector(".cm-columns-open-banner")?.textContent).toContain("COLUMNS SOURCE");
      expect(host.querySelector(".cm-columns-open-banner")?.textContent).toContain("60% / 40%");
      expect(host.querySelector(".cm-columns-col-banner")?.textContent).toContain("Column 2 · 40% · center");
      expect(host.querySelector(".cm-columns-close-banner")?.textContent).toContain("End Columns");

      // Click Visual -> switches directly back into side-by-side WYSIWYG editing.
      host.querySelector<HTMLButtonElement>('button[aria-label="Return to side-by-side editing"]')!.click();
      expect(host.querySelector(".cm-columns-open-banner")).toBeNull();
      expect(host.querySelector(".cm-columns-active-top")).toBeTruthy();

      // Click Source from WYSIWYG toolbar -> re-expands raw banners, then Done exits to preview.
      host.querySelector<HTMLButtonElement>('button[aria-label="Edit columns source"]')!.click();
      expect(host.querySelector(".cm-columns-open-banner")).toBeTruthy();
      host.querySelector<HTMLButtonElement>('button[aria-label="Finish editing columns"]')!.click();
      expect(host.querySelector(".cm-columns-widget")).toBeTruthy();
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("mode switch preserves content and Noema block identity", () => {
    const id = "0198fbac-0780-7c99-85e6-333333333333";
    const withId = `#+begin columns {widths=60-40 data-note=keep} {#${id}}\nLeft prose.\n\n#+col\n\nRight prose.\n#+end columns\n\nEnd`;
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditor(host, { kernel: "cm6", initialContent: withId });
    editor.setMarkdownSelection(withId.length);
    try {
      host.querySelector<HTMLButtonElement>('button[aria-label="Switch to flowing text columns"]')!.click();
      const flowMd = editor.getMarkdown();
      expect(flowMd).toContain(`#+begin columns {data-note=keep mode=flow cols=2} {#${id}}`);
      expect(flowMd).not.toContain("#+col");
      expect(flowMd).toContain("Left prose.");
      expect(flowMd).toContain("Right prose.");
      // Switch back to explicit columns splits the two paragraphs across #+col.
      host.querySelector<HTMLButtonElement>('button[aria-label="Switch to explicit multi-block columns"]')!.click();
      const backMd = editor.getMarkdown();
      expect(backMd).toContain(`#+begin columns {data-note=keep} {#${id}}`);
      expect(backMd).toContain("#+col");
      editor.undo();
      editor.undo();
      expect(editor.getMarkdown()).toBe(withId);
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("LaTeX export emits minipage for explicit columns, multicols for flow, and loads multicol package", () => {
    const explicit = preprocessNoemaForPandoc(multiBlockSource);
    expect(explicit.markdown).toContain("\\noindent\\begin{minipage}[c]{0.582\\textwidth}");
    expect(explicit.markdown).toContain("\\end{minipage}%\n\\hfill\\begin{minipage}[c]{0.388\\textwidth}\n\\centering");
    expect(explicit.markdown).toContain("\\end{minipage}");
    expect(explicit.markdown).not.toContain("\\begin{columns}");

    const flow = preprocessNoemaForPandoc("#+begin columns {mode=flow cols=3}\nAlpha.\n\nBeta.\n#+end columns");
    expect(flow.markdown).toContain("\\begin{multicols}{3}");
    expect(flow.markdown).toContain("\\end{multicols}");

    const pkgWithout = latexMacrosPackage({}, { usesMulticol: false });
    const pkgWith = latexMacrosPackage({}, { usesMulticol: true });
    expect(pkgWithout).not.toContain("\\RequirePackage{multicol}");
    expect(pkgWith).toContain("\\RequirePackage{multicol}");
  });

  test("CSS reader grid/border rules never match .cm-columns-active-top (prevents active stage shifting into grid track 2)", () => {
    const css = readFileSync(join(process.cwd(), "src/styles/widgets.css"), "utf8");
    // Every reader-only `.noema-columns...:not(.cm-columns-widget)` selector must also exclude `.cm-columns-active-top`.
    const readerSelectors = css.match(/\.noema-columns[^\n{]*:not\(\.cm-columns-widget\)[^\n{]*/g) ?? [];
    expect(readerSelectors.length).toBeGreaterThanOrEqual(4);
    for (const sel of readerSelectors) {
      expect(sel, `reader selector must exclude .cm-columns-active-top: ${sel}`).toContain(":not(.cm-columns-active-top)");
    }
  });
});
