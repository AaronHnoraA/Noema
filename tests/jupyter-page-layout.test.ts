import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Noema Jupyter Emacs-owned output surface", () => {
  const main = readFileSync(join(process.cwd(), "aaronnote/jupyter-main.ts"), "utf8");
  const css = readFileSync(join(process.cwd(), "aaronnote/jupyter-page.css"), "utf8");

  test("keeps cell selection local until an explicit Emacs open command", () => {
    expect(main).not.toContain("notifyEmacsCellSelection");
    expect(main).not.toContain("noemaJupyterSelectCell");
    expect(main).not.toContain('fetch("/emacs/event"');
    expect(main).not.toContain("if (detail.cellId) tab.activeCellId");
    expect(main).toContain("loadTab(tab, false), 90");
  });

  test("retains rich-output actions without becoming a document/control UI", () => {
    const template = main.slice(main.indexOf("app.innerHTML"), main.indexOf("document.body.append(app)"));
    expect(template).toContain("Jupyter Output");
    expect(template).not.toContain('data-action="run-current"');
    expect(template).not.toContain('data-pane="manager"');
    expect(template).not.toContain('data-pane="inspector"');
    expect(template).not.toContain("data-kernel-select");
    expect(template).not.toContain("data-manager");
    expect(template).not.toContain("data-inspector");
    expect(main).not.toContain("managerSnapshot");
    expect(main).not.toContain("sessionSelect");
    expect(main).not.toContain("renderJupyterVariablesTable");
    expect(main).toContain('button("•••", "Cell actions"');
    expect(main).toContain('menuItem("Pop Out Output"');
    const menu = main.slice(main.indexOf("function openCellMenu"), main.indexOf("function appendStdinForm"));
    expect(menu).not.toContain("Insert Cell");
    expect(menu).not.toContain("Delete Cell");
    expect(menu).not.toContain('execute("current")');
    expect(menu).not.toContain('mutate("');
    const keys = main.slice(main.indexOf('window.addEventListener("keydown"'), main.indexOf('window.addEventListener("aaronnote:jupyter-cell"'));
    expect(keys).not.toContain("execute(");
    expect(keys).not.toContain("mutate(");
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

  test("keeps the Emacs-validated Noema project root on every document refresh", () => {
    expect(main).toContain("projectRoot?: string");
    expect(main).toContain('projectRoot: query.get("projectRoot") || ""');
    expect(main).toContain("projectRoot: text(payload.projectRoot)");
    expect(main).toContain("scriptSnapshot(documentParams(tab))");
  });

  test("renders .noema as kernel-free streamed Work Output", () => {
    expect(main).toContain('surfaceTitleEl.textContent = research ? "Work Output" : "Jupyter Output"');
    expect(main).toContain("kernelStatusEl.hidden = research");
    expect(main).toContain('new EventSource(`/api/noema/research/run/stream?${params}`)');
    expect(main).toContain('eventType(item) === "run.content.segment"');
    expect(main).toContain('eventType(item).includes("permission")');
    expect(main).toContain('"text/markdown": content');
    expect(main).toContain("after: String(tab.runSeq || 0)");
  });

  test("isolates page, board, panel, and long-output scrolling", () => {
    expect(css).toMatch(/html, body[\s\S]*overflow: hidden/);
    expect(css).toMatch(/body \{ position: fixed; inset: 0; \}/);
    expect(css).toMatch(/\.noema-jupyter-page[\s\S]*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.noema-jupyter-output-surface[\s\S]*grid-template-rows: 38px minmax\(0, 1fr\)/);
    expect(css).toMatch(/\.noema-jupyter-shell[\s\S]*width: 100%; height: 100%/);
    expect(css).not.toContain("data-manager-open");
    expect(css).not.toContain("data-inspector-open");
    expect(css).toMatch(/\.noema-jupyter-cell[\s\S]*width: 100%; min-width: 0; max-width: 100%/);
    expect(css).toMatch(/\.noema-jupyter-workspace[\s\S]*overscroll-behavior: contain/);
    expect(css).toMatch(/\.noema-jupyter-output\.is-auto-collapsed[^}]*overflow: auto/);
    expect(css).toContain('grid-template-columns: minmax(0, 1fr)');
  });

  test("applies the dark JupyterLab token surface to widgets and KaTeX", () => {
    expect(css).toContain("--jp-ui-font-color1: #e4e9f2");
    expect(css).toContain("--jp-widgets-label-color: #e4e9f2");
    expect(css).toContain("--jp-widgets-input-background-color: #171f2f");
    expect(css).toMatch(/\.cm-ceil-output-latex, \.katex\)[\s\S]*--jp-content-font-color1/);
  });
});
