import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Noema Jupyter workspace layout", () => {
  const main = readFileSync(join(process.cwd(), "aaronnote/jupyter-main.ts"), "utf8");
  const css = readFileSync(join(process.cwd(), "aaronnote/jupyter-page.css"), "utf8");

  test("keeps cell selection local until an explicit Emacs open command", () => {
    expect(main).not.toContain("notifyEmacsCellSelection");
    expect(main).not.toContain("noemaJupyterSelectCell");
    expect(main).not.toContain('fetch("/emacs/event"');
    expect(main).not.toContain("if (detail.cellId) tab.activeCellId");
    expect(main).toContain("loadTab(tab, false), 90");
  });

  test("uses one workspace toolbar and a contextual cell menu", () => {
    expect(main).toContain('data-action="run-current"');
    expect(main).toContain('data-pane="manager"');
    expect(main).toContain('data-pane="inspector"');
    expect(main).toContain('button("•••", "Cell actions"');
    expect(main).toContain('menuItem("Pop Out Output"');
  });

  test("keeps live OutputAreas stable across execution events", () => {
    const start = main.indexOf('window.addEventListener("aaronnote:jupyter-cell"');
    const end = main.indexOf('window.addEventListener("aaronnote:jupyter-session"', start);
    const handler = main.slice(start, end);
    expect(handler).toContain("ensureCellOutputView(tab, cell)?.setOutput");
    expect(handler).toContain("if (!isWidgetOutput(patch.output))");
    expect(handler).toContain("updateCellChrome(cell)");
    expect(handler).not.toContain("renderWorkspace()");
  });

  test("isolates page, board, panel, and long-output scrolling", () => {
    expect(css).toMatch(/html, body[\s\S]*overflow: hidden/);
    expect(css).toMatch(/body \{ position: fixed; inset: 0; \}/);
    expect(css).toMatch(/\.noema-jupyter-page[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.noema-jupyter-shell[\s\S]*width: 100%; height: 100%/);
    expect(css).toContain(".noema-jupyter-workspace { grid-column: 2; }");
    expect(css).toMatch(/\.noema-jupyter-cell[\s\S]*width: 100%; min-width: 0; max-width: 100%/);
    expect(css).toMatch(/\.noema-jupyter-workspace[\s\S]*overscroll-behavior: contain/);
    expect(css).toMatch(/\.noema-jupyter-output\.is-auto-collapsed[^}]*overflow: auto/);
    expect(css).toContain('grid-template-columns: 0 minmax(0, 1fr) 0');
  });

  test("applies the dark JupyterLab token surface to widgets and KaTeX", () => {
    expect(css).toContain("--jp-ui-font-color1: #e4e9f2");
    expect(css).toContain("--jp-widgets-label-color: #e4e9f2");
    expect(css).toContain("--jp-widgets-input-background-color: #171f2f");
    expect(css).toMatch(/\.cm-ceil-output-latex, \.katex\)[\s\S]*--jp-content-font-color1/);
  });
});
