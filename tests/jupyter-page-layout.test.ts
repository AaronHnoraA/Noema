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

  test("isolates page, board, panel, and long-output scrolling", () => {
    expect(css).toMatch(/html, body[\s\S]*overflow: hidden/);
    expect(css).toMatch(/body \{ position: fixed; inset: 0; \}/);
    expect(css).toMatch(/\.noema-jupyter-workspace[\s\S]*overscroll-behavior: contain/);
    expect(css).toMatch(/\.noema-jupyter-output\.is-auto-collapsed[^}]*overflow: auto/);
    expect(css).toContain('grid-template-columns: 0 minmax(0, 1fr) 0');
  });
});
