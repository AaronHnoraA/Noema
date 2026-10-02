// Real WebKit DOM/lifecycle checks. Repeated text edits must not reload a
// picture or reset an interactive HTML attachment's input state.
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
  await page.route("**/image-audit", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}aaronnote/style.css"></head><body style="margin:0"><div id="host" class="aaronnote-focused-editor" style="height:800px;width:1000px;--aaronnote-visual-zoom:1"></div></body></html>`,
  }));
  let imageRequests = 0, frameRequests = 0;
  await page.route("**/plot.svg", (route) => {
    imageRequests++;
    return route.fulfill({ contentType: "image/svg+xml", body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100"><rect width="320" height="100" fill="#e6efff"/></svg>' });
  });
  await page.route("**/plot.html", (route) => {
    frameRequests++;
    return route.fulfill({ contentType: "text/html", body: '<!doctype html><input aria-label="Attachment state" value="initial">' });
  });
  await page.goto(new URL("image-audit", server.resolvedUrls.local[0]).href);
  await page.evaluate(async (root) => {
    const { createEditor } = await import(root + "src/editor-api.ts");
    window.editor = createEditor(document.querySelector("#host"), {
      initialContent: "before\n\n![](plot.svg)\n\n![](plot.html)\n\nafter",
    });
  }, root);
  const attachment = page.frameLocator(".cm-visual-embed-html").getByRole("textbox");
  await attachment.fill("unsaved interactive state");
  await page.waitForFunction(() => document.querySelector(".cm-image-render").naturalWidth > 0);
  await page.evaluate(() => { window.originalMedia = [...document.querySelectorAll(".cm-image-render")]; });
  const before = { imageRequests, frameRequests };
  for (let i = 0; i < 5; i++) {
    await page.evaluate(() => editor.view.dispatch({ changes: { from: 0, insert: "x" }, userEvent: "input.type" }));
    // Exercise both the mapping phase and the settled decoration rebuild.
    await page.waitForTimeout(180);
  }
  assert.equal(await attachment.inputValue(), "unsaved interactive state");
  assert.equal(await page.evaluate(() => originalMedia.every((node, i) => node === document.querySelectorAll(".cm-image-render")[i])), true);
  assert.deepEqual({ imageRequests, frameRequests }, before);
  // A control activated before the 120 ms settle uses the new source range.
  await page.evaluate(() => {
    editor.view.dispatch({ changes: { from: 0, insert: "new " }, userEvent: "input.type" });
    document.querySelector('button[title="Align right"]').click();
  });
  assert.equal(await page.evaluate(() => editor.getMarkdown()), "new xxxxxbefore\n\n![](plot.svg){align=right}\n\n![](plot.html)\n\nafter");
  assert.equal(await attachment.inputValue(), "unsaved interactive state");
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ checks: "media identity, iframe state, coalesced layout action", initialRequests: before, finalRequests: { imageRequests, frameRequests } }));
} finally {
  await browser.close();
  await server.close();
}
