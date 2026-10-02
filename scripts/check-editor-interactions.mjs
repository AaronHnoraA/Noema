// WebKit checks for editor interactions a DOM emulator cannot judge: the
// empty-line hint must not move the caret or change line height, a real
// mouse drag must select a table rectangle, and emoji/media must render.
// NOEMA_PLAYWRIGHT_MODULE may point to an external Playwright installation.
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
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/@vite/client", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `export function createHotContext(){return {accept(){},prune(){},dispose(){},on(){},invalidate(){}}} export function updateStyle(id,css){let s=document.createElement('style');s.textContent=css;document.head.append(s)} export function removeStyle(){} export function injectQuery(u){return u}`,
  }));
  await page.route("**/interaction-audit", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}aaronnote/style.css"></head><body style="margin:0"><div id="host" class="aaronnote-focused-editor" style="height:780px;width:960px;--aaronnote-visual-zoom:1"></div></body></html>`,
  }));
  const markdown = [
    "Intro line :tada:",
    "",
    "",
    "| A | B | C |",
    "|-|:-:|-|",
    "| 1 | 2 | 3 |",
    "| 4 | 5 | 6 |",
    "",
    "![Clip](clip.mp4)",
    "",
    "Tail",
  ].join("\n");
  await page.goto(new URL("interaction-audit", server.resolvedUrls.local[0]).href);
  await page.evaluate(async ({ root, markdown }) => {
    const { createEditor } = await import(root + "src/editor-api.ts");
    window.editor = createEditor(document.querySelector("#host"), { initialContent: markdown });
  }, { root, markdown });
  await page.waitForSelector(".cm-markdown-table-preview");
  await page.evaluate(() => document.fonts.ready);

  // Emoji and media render as in export.
  assert.equal(await page.locator(".cm-emoji").first().textContent(), "🎉");
  assert.equal(await page.locator("video.cm-media-player").count(), 1, "mp4 is a video player");

  // The empty-line hint changes neither the line box nor the caret.
  const blankFrom = "Intro line :tada:\n".length;
  const measure = () => page.evaluate((at) => {
    const line = editor.view.domAtPos(at).node.closest?.(".cm-line") ?? editor.view.domAtPos(at).node.parentElement.closest(".cm-line");
    const rect = line.getBoundingClientRect();
    const caret = editor.view.coordsAtPos(at);
    return { height: rect.height, top: rect.top, caretLeft: caret.left, caretTop: caret.top, hinted: line.classList.contains("cm-empty-line-hint") };
  }, blankFrom);
  await page.evaluate((at) => { editor.view.focus(); editor.setMarkdownSelection(at); }, blankFrom);
  await page.waitForTimeout(100);
  const withHint = await measure();
  await page.evaluate(() => editor.view.contentDOM.blur());
  await page.waitForTimeout(100);
  const withoutHint = await measure();
  assert.equal(withHint.hinted, true, "focused empty line carries the hint");
  assert.equal(withoutHint.hinted, false, "blurred editor drops the hint");
  for (const key of ["height", "top", "caretLeft", "caretTop"]) {
    assert.ok(Math.abs(withHint[key] - withoutHint[key]) < 0.5, `hint moved ${key}: ${withHint[key]} vs ${withoutHint[key]}`);
  }

  // A real drag from cell (1,0) to (2,1) selects the 2x2 rectangle; Delete empties it.
  const cell = (row, col) => page.locator(".cm-markdown-table-preview").locator("tr").nth(row).locator("td, th").nth(col);
  const from = await cell(1, 0).boundingBox();
  const to = await cell(2, 1).boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width + 8, from.y + from.height / 2, { steps: 4 });
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 6 });
  await page.mouse.up();
  const selected = await page.locator(".cm-table-cell-selected").evaluateAll((cells) => cells.map((c) => `${c.dataset.row},${c.dataset.col}`).sort());
  assert.deepEqual(selected, ["1,0", "1,1", "2,0", "2,1"], "drag selects the rectangle");
  assert.equal(await page.locator(".cm-table-cell-input").count(), 0, "drag leaves no cell editor open");
  await page.keyboard.press("Delete");
  await page.waitForTimeout(50);
  const source = await page.evaluate(() => editor.getMarkdown());
  assert.ok(source.includes("|  |  | 3 |\n|  |  | 6 |"), `Delete empties the rectangle:\n${source}`);

  assert.deepEqual(errors, [], "page errors");
  console.log(JSON.stringify({ checks: "emoji, media, empty-line hint geometry, table drag selection", hint: withHint, selected }));
} finally {
  await browser.close();
  await server.close();
}
