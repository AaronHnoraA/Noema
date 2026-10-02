import { afterEach, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../../src/editor-api.ts";
import { refreshViewportDecorations } from "../../src/cm6/viewport-refresh.ts";
import { figureLayoutTarget } from "../../src/cm6/figure-layout-menu.ts";
import { imageExtension } from "../../src/cm6/extensions/visual/widgets/image.ts";
import { measuredHeightCache } from "../../src/cm6/extensions/visual/widgets/measured-observer.ts";

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
  delete window.AaronnoteResolveAssetUrl;
});

test.each(["![](plot.png)", "![](plot.html)"])("editing before %s preserves the media DOM after decorations settle", (source) => {
  const { host, editor } = open(`before\n\n${source}\n\nafter`);
  const media = host.querySelector(".cm-image-render")!;
  editor.view.dispatch({ changes: { from: 0, insert: "new " }, userEvent: "input.type" });
  editor.view.dispatch({ effects: refreshViewportDecorations.of(editor.view.visibleRanges) });
  expect(host.querySelector(".cm-image-render")).toBe(media);
  expect(figureLayoutTarget(editor.view, media)?.from).toBe(12);
});

test("layout controls follow an image while typing is coalesced", () => {
  const source = "before\n\n![plot](plot.png)\n\nafter";
  const { host, editor } = open(source);
  editor.view.dispatch({ changes: { from: 0, insert: "new " }, userEvent: "input.type" });
  const button = host.querySelector<HTMLButtonElement>('button[title="Align right"]')!;
  expect(figureLayoutTarget(editor.view, button)?.from).toBe(12);
  button.click();
  expect(editor.getMarkdown()).toBe("new before\n\n![plot](plot.png){align=right}\n\nafter");
});

test("same image at different sizes or with a different caption has a separate measured height", () => {
  const { host, editor } = open("before\n\n![](plot.png){width=100px}\n\n![](plot.png){width=600px}\n\n![Caption](plot.png){width=100px}");
  const keys = [...host.querySelectorAll<HTMLElement>(".cm-image-widget")].map((el) => el.dataset.cmMeasureKey);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(3);
  const heights = [80, 420, 120];
  keys.forEach((key, index) => measuredHeightCache.set(key!, heights[index]!));
  const estimates: number[] = [];
  editor.view.plugin(imageExtension)!.decorations.between(0, editor.view.state.doc.length, (_from, _to, deco) => {
    estimates.push(deco.spec.widget.estimatedHeight);
  });
  expect(estimates).toEqual(heights);
});

test("editing the image source refreshes its content during a typing burst", () => {
  const { host, editor } = open("before\n\n![plot](plot.png)\n\nafter");
  const at = editor.getMarkdown().indexOf("plot.png");
  editor.view.dispatch({ changes: { from: at, to: at + 4, insert: "other" }, userEvent: "input.type" });
  expect(host.querySelector("img.cm-image-render")?.getAttribute("src")).toBe("other.png");
});

test("changing the note base resolves the same relative image again", () => {
  window.AaronnoteResolveAssetUrl = (src) => "/note-one/" + src;
  const { host, editor } = open("before\n\n![](plot.png)");
  const old = host.querySelector("img.cm-image-render")!;
  const key = old.parentElement!.dataset.cmMeasureKey;
  window.AaronnoteResolveAssetUrl = (src) => "/note-two/" + src;
  editor.view.dispatch({ effects: refreshViewportDecorations.of(editor.view.visibleRanges) });
  const next = host.querySelector("img.cm-image-render")!;
  expect(next.getAttribute("src")).toBe("/note-two/plot.png");
  expect(next).not.toBe(old);
  expect(next.parentElement!.dataset.cmMeasureKey).not.toBe(key);
});

test("canceling an image resize restores automatic width constraints", async () => {
  const { host, editor } = open("before\n\n![](plot.png)");
  const figure = host.querySelector<HTMLElement>(".cm-image-widget")!;
  const before = figure.style.cssText;
  const handle = figure.querySelector<HTMLButtonElement>(".cm-image-resize-handle")!;
  const pointer = (type: string, clientX: number) => handle.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX }));
  pointer("pointerdown", 10);
  pointer("pointermove", 90);
  await new Promise(requestAnimationFrame);
  pointer("pointercancel", 90);
  expect(figure.style.cssText).toBe(before);
  expect(editor.getMarkdown()).toBe("before\n\n![](plot.png)");
});
