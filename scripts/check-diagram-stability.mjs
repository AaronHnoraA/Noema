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
  await page.locator(".cm-diagram-control-zoom-in").first().click();
  await page.evaluate(() => document.querySelector(".cm-diagram-interactive").focus({ preventScroll: true }));
  await page.keyboard.press("ArrowRight");
  const transform = await page.evaluate(() => {
    window.originalSvg = document.querySelector(".cm-mermaid-widget svg");
    return originalSvg.style.transform;
  });
  assert.ok(transform.includes("scale(1.18)") && !transform.includes("translate(0px, 0px)"));
  await page.evaluate(() => editor.view.dispatch({ changes: { from: 0, insert: "new paragraph\n\n" }, userEvent: "input" }));
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => originalSvg === document.querySelector(".cm-mermaid-widget svg")), true);
  assert.equal(await page.evaluate(() => originalSvg.style.transform), transform);
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
  await page.locator(".cm-diagram-control-fullscreen").first().click();
  await page.keyboard.press("Escape");
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("cm-diagram-interactive")), true, "Escape lost keyboard focus");
  await page.locator(".cm-diagram-control-fullscreen").first().click();
  await page.evaluate(() => editor.setMarkdown("The diagram was deleted."));
  assert.equal(await page.locator(".cm-diagram-fullscreen-portal").count(), 0);
  assert.equal(await page.evaluate(() => document.body.classList.contains("has-diagram-fullscreen")), false);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: "SVG identity, zoom/pan, mapped source, float estimate, Escape focus, fullscreen disposal", transform, float }));
} finally {
  await browser.close();
  await server.close();
}
