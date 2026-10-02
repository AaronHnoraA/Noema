import { afterEach, expect, test, vi } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { measuredHeightCache, shortHash } from "../../src/cm6/extensions/visual/widgets/measured-observer.ts";
import { refreshViewportDecorations } from "../../src/cm6/viewport-refresh.ts";

const renders = vi.hoisted(() => [] as Array<{ finish: () => void; element: HTMLElement; fail: (error: string) => void }>);
vi.mock("../../src/diagram-render.ts", () => ({
  renderMermaidLazy: (_source: string, element: HTMLElement, fail: (error: string) => void, options: { onRender: () => void }) => {
    renders.push({ element, fail, finish: options.onRender });
  },
  disposeDiagramRuntime: () => {},
  disposeDiagramInteraction: () => {},
}));

const editors: Editor[] = [];
function open(markdown: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: markdown });
  editors.push(editor);
  return { host, editor };
}
afterEach(() => {
  editors.splice(0).forEach((editor) => editor.destroy());
  document.body.replaceChildren();
  measuredHeightCache.clear();
  renders.length = 0;
});

test("headings and code keep structural marks when the viewport moves away", () => {
  const { host, editor } = open("## Title\n\n```text\nplain code\n```\n\nend");
  const end = editor.view.state.doc.length;
  editor.view.dispatch({ effects: refreshViewportDecorations.of([{ from: end - 3, to: end }]) });
  expect(host.querySelector(".cm-md-h2 > .cm-heading-text")?.textContent).toBe("## Title");
  expect([...host.querySelectorAll(".cm-md-code-block .cm-block-text")].map((el) => el.textContent))
    .toContain("plain code");
});

test.each([false, true])("a remounted diagram reserves its last height until rendering finishes (error: %s)", async (error) => {
  const source = "graph LR\nA-->B";
  measuredHeightCache.set("mermaid:" + shortHash("mermaid\n" + source), 240);
  const { host } = open("before\n\n```mermaid\n" + source + "\n```\n\nafter");
  await vi.waitFor(() => expect(renders.length).toBeGreaterThan(0));
  const { element, finish, fail } = renders[0]!;
  const figure = element.parentElement!;
  expect(figure.style.minHeight).toBe("240px");
  expect(figure.getAttribute("aria-busy")).toBe("true");
  if (error) fail("Invalid diagram");
  else element.innerHTML = '<svg viewBox="0 0 100 50"></svg>';
  finish();
  expect(figure.style.minHeight).toBe("");
  expect(figure.hasAttribute("aria-busy")).toBe(false);
  expect(host.contains(figure)).toBe(true);
});

test("a wrapped diagram keeps its zero-height anchor while loading", async () => {
  const source = "graph LR\nA-->B";
  measuredHeightCache.set("mermaid:" + shortHash("mermaid\n" + source), 240);
  open("before\n\n```mermaid\n" + source + "\n```\n{align:left; wrap:on}\n\nafter");
  await vi.waitFor(() => expect(renders.length).toBeGreaterThan(0));
  const figure = renders[0]!.element.parentElement!;
  expect(figure.classList.contains("aaronnote-diagram-wrap")).toBe(true);
  expect(figure.style.minHeight).toBe("");
});
