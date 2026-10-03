import { afterEach, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { EditorView, type DecorationSet, type WidgetType } from "@codemirror/view";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { figureLayoutTarget } from "../../src/cm6/figure-layout-menu.ts";
import { measuredHeightCache } from "../../src/cm6/extensions/visual/widgets/measured-observer.ts";

vi.mock("../../src/diagram-render.ts", async (original) => {
  const actual = await original<typeof import("../../src/diagram-render.ts")>();
  return {
    ...actual,
    renderMermaidLazy: (_source: string, element: HTMLElement, _fail: unknown, options: { onRender: () => void }) => {
      element.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>Diagram</text></svg>';
      actual.presentDiagramFigure(element);
      options.onRender();
    },
  };
});

const editors: Editor[] = [];
const diagram = "```mermaid\ngraph LR\nA-->B\n```";
async function open(markdown = `before\n\n${diagram}\n\nafter`) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: markdown });
  editors.push(editor);
  await vi.waitFor(() => expect(host.querySelector(".cm-diagram-expand")).toBeTruthy());
  return { host, editor };
}
function widgets(view: EditorView): WidgetType[] {
  const found: WidgetType[] = [];
  for (const entry of view.state.facet(EditorView.decorations)) {
    const decorations: DecorationSet = typeof entry === "function" ? entry(view) : entry;
    decorations.between(0, view.state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget?.constructor.name.startsWith("Mermaid")) found.push(decoration.spec.widget);
    });
  }
  return found;
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
  document.body.classList.remove("has-diagram-fullscreen");
  measuredHeightCache.clear();
});

test("typing before a diagram keeps its layout menu and source anchor current", async () => {
  const { host, editor } = await open();
  editor.view.dispatch({ changes: { from: 0, insert: "new " }, userEvent: "input.type" });
  const figure = host.querySelector<HTMLElement>(".cm-mermaid-widget")!;
  expect(figureLayoutTarget(editor.view, figure)?.from).toBe(12);
  expect(Number(figure.dataset.cmSourceAnchor)).toBe(editor.getMarkdown().indexOf("graph"));
});

test("inserting a paragraph before a diagram preserves its SVG", async () => {
  const { host, editor } = await open();
  const svg = host.querySelector<SVGSVGElement>(".cm-mermaid-widget svg")!;
  editor.view.dispatch({ changes: { from: 0, insert: "new paragraph\n\n" }, userEvent: "input" });
  await new Promise(requestAnimationFrame);
  expect(host.querySelector(".cm-mermaid-widget svg")).toBe(svg);
  // A figure carries no view state to lose, which is why the edit above used to
  // reset a zoom that lived on the element itself.
  expect(svg.style.transform).toBe("");
});

test("a wrapped diagram always estimates zero block height, even after the same diagram was measured", async () => {
  const { host, editor } = await open(`before\n\n${diagram}\n\n${diagram}\n{wrap=left width=180px}\n\nafter`);
  const block = host.querySelector<HTMLElement>(".cm-mermaid-widget")!;
  measuredHeightCache.set(block.dataset.cmMeasureKey!, 420);
  expect(widgets(editor.view).map((widget) => widget.estimatedHeight)).toEqual([420, 0]);
});

test("the same diagram at two sizes keeps separate measured heights", async () => {
  const { host, editor } = await open(`before\n\n${diagram}\n{width=180px}\n\n${diagram}\n{width=600px}\n\nafter`);
  const figures = [...host.querySelectorAll<HTMLElement>(".cm-mermaid-widget")];
  [150, 430].forEach((height, index) => measuredHeightCache.set(figures[index]!.dataset.cmMeasureKey!, height));
  expect(widgets(editor.view).map((widget) => widget.estimatedHeight)).toEqual([150, 430]);
});

test.each(["delete", "destroy"])("%s closes a diagram viewer owned by the editor", async (action) => {
  const { host, editor } = await open();
  host.querySelector<HTMLButtonElement>(".cm-diagram-expand")!.click();
  expect(document.querySelector(".cm-diagram-lightbox")).toBeTruthy();
  if (action === "delete") editor.setMarkdown("Only text remains");
  else { editor.destroy(); editors.splice(editors.indexOf(editor), 1); }
  expect(document.querySelector(".cm-diagram-lightbox")).toBeNull();
  expect(document.body.classList.contains("has-diagram-fullscreen")).toBe(false);
});

test("disposing an open diagram viewer leaves another input's focus alone", async () => {
  const { host, editor } = await open();
  host.querySelector<HTMLButtonElement>(".cm-diagram-expand")!.click();
  const input = document.createElement("input");
  document.body.append(input);
  input.focus();
  editor.destroy();
  editors.splice(editors.indexOf(editor), 1);
  expect(document.activeElement).toBe(input);
  expect(document.querySelector(".cm-diagram-lightbox")).toBeNull();
});
