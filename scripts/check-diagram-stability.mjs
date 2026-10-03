// Real WebKit diagram lifecycle, interaction state and float geometry checks.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const { webkit } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = "/@fs" + repo;
const server = await createServer({
  configFile: repo + "vite.aaronnote.config.ts", root: repo + "aaronnote",
  logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/@vite/client", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `export function createHotContext(){return {accept(){},prune(){},dispose(){},on(){},invalidate(){}}} export function updateStyle(id,css){let s=document.createElement('style');s.textContent=css;document.head.append(s)} export function removeStyle(){} export function injectQuery(u){return u}`,
  }));
  await page.route("**/diagram-audit", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}aaronnote/style.css"></head><body style="margin:0"><div id="host" class="aaronnote-focused-editor" style="height:800px;width:1000px;--aaronnote-visual-zoom:1"></div></body></html>`,
  }));
  const diagram = "```mermaid\ngraph LR\nA[Observe]-->B[Measure]\n```";
  await page.goto(new URL("diagram-audit", server.resolvedUrls.local[0]).href);
  await page.evaluate(async ({ root, diagram }) => {
    const { createEditor } = await import(root + "src/editor-api.ts");
    window.editor = createEditor(document.querySelector("#host"), {
      initialContent: `before\n\n${diagram}\n\n${diagram}\n{wrap=left width=180px}\n\nText wraps beside this diagram.\n\nend`,
    });
  }, { root, diagram });
  await page.waitForFunction(() => document.querySelectorAll(".cm-mermaid-widget svg").length === 2);
  await page.evaluate(() => document.fonts.ready);
  // The figure in the document carries no transform: it is a picture, and a
  // click on it belongs to CodeMirror.
  const figureState = await page.evaluate(() => {
    window.originalSvg = document.querySelector(".cm-mermaid-widget svg");
    const figure = originalSvg.closest(".cm-diagram-figure");
    return {
      transform: originalSvg.style.transform,
      interactive: Boolean(document.querySelector(".cm-mermaid-widget .cm-diagram-interactive")),
      toolbar: Boolean(document.querySelector(".cm-mermaid-widget .cm-diagram-toolbar")),
      expand: Boolean(figure?.querySelector(".cm-diagram-expand")),
      height: Math.round(figure.getBoundingClientRect().height),
    };
  });
  assert.equal(figureState.transform, "", "an inline diagram must not be transformed");
  assert.equal(figureState.interactive, false, "an inline diagram must not bind the pan/zoom controller");
  assert.equal(figureState.toolbar, false, "an inline diagram must not carry the viewer toolbar");
  assert.equal(figureState.expand, true, "an inline diagram needs its viewer affordance");
  // The old fixed 380-620px mind-map window is gone: a two-node graph is short.
  assert.ok(figureState.height > 0 && figureState.height < 320, `figure height ${figureState.height}px is not content-sized`);
  await page.evaluate(() => editor.view.dispatch({ changes: { from: 0, insert: "new paragraph\n\n" }, userEvent: "input" }));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => originalSvg === document.querySelector(".cm-mermaid-widget svg")), true);
  assert.equal(await page.evaluate(() => originalSvg.style.transform), "");
  await page.evaluate(async (root) => {
    const { figureLayoutTarget } = await import(root + "src/cm6/figure-layout-menu.ts");
    editor.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" });
    const figure = document.querySelector(".cm-mermaid-widget");
    const target = figureLayoutTarget(editor.view, figure);
    if (target?.from !== editor.getMarkdown().indexOf("```")) throw new Error("stale diagram source range");
  }, root);
  const float = await page.evaluate(() => {
    const estimates = [];
    for (const entry of editor.view.state.facet(editor.view.constructor.decorations)) {
      const decorations = typeof entry === "function" ? entry(editor.view) : entry;
      decorations.between(0, editor.view.state.doc.length, (_from, _to, deco) => {
        if (deco.spec.widget?.constructor.name === "MermaidWidget") estimates.push(deco.spec.widget.estimatedHeight);
      });
    }
    const figure = document.querySelector(".cm-mermaid-widget.aaronnote-diagram-wrap");
    return { height: figure.getBoundingClientRect().height, estimates };
  });
  assert.equal(float.height, 0);
  assert.equal(float.estimates[1], 0);
  // The viewer: opened on demand, owns a clone, and pans/zooms there only.
  await page.locator(".cm-diagram-expand").first().click();
  await page.waitForSelector(".cm-diagram-lightbox .cm-diagram-stage");
  await page.locator(".cm-diagram-control-zoom-in").first().click();
  await page.keyboard.press("ArrowRight");
  const viewer = await page.evaluate(() => ({
    transform: document.querySelector(".cm-diagram-lightbox svg").style.transform,
    figureTransform: originalSvg.style.transform,
    clone: document.querySelector(".cm-diagram-lightbox svg") !== originalSvg,
  }));
  assert.ok(viewer.transform.includes("scale(1.18)") && !viewer.transform.includes("translate(0px, 0px)"), viewer.transform);
  assert.equal(viewer.clone, true, "the viewer must not move the figure out of the document");
  assert.equal(viewer.figureTransform, "", "the viewer must not transform the figure");
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".cm-diagram-lightbox").count(), 0, "Escape did not close the viewer");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("cm-diagram-expand")), true, "Escape lost keyboard focus");
  await page.locator(".cm-diagram-expand").first().click();
  await page.waitForSelector(".cm-diagram-lightbox");
  await page.evaluate(() => editor.setMarkdown("The diagram was deleted."));
  assert.equal(await page.locator(".cm-diagram-lightbox").count(), 0);
  assert.equal(await page.evaluate(() => document.body.classList.contains("has-diagram-fullscreen")), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: "static figure, SVG identity, mapped source, float estimate, viewer clone + zoom, Escape focus, viewer disposal", figureState, viewer, float }));
} finally {
  await browser.close();
  await server.close();
}
