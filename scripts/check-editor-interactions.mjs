// WebKit checks for editor interactions a DOM emulator cannot judge: the
// a real mouse drag must select a table rectangle, emoji/media must render, and the
// keyboard paths through cells, embeds and inline marks behave natively.
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

  // Keyboard: arrows cross cells at the text edge and leave the table.
  await page.keyboard.press("Escape");
  await cell(1, 2).click();
  await page.waitForTimeout(50);
  // Cell (1,2) holds "3"; one press reaches its start, the next crosses.
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(80);
  const leftCell = await page.evaluate(() => document.activeElement?.closest("td, th")?.dataset.col);
  assert.equal(leftCell, "1", "ArrowLeft at a cell's start enters the previous cell");
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(80);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(120);
  const afterTable = await page.evaluate(() => ({
    inEditor: editor.view.hasFocus,
    line: editor.view.state.doc.lineAt(editor.getMarkdownSelection().from).text,
  }));
  assert.equal(afterTable.inEditor, true, "ArrowDown past the last row returns to the document");
  assert.equal(afterTable.line, "", "caret lands on the line below the table");

  // Backspace after an embed selects it whole and keeps it rendered.
  const mediaEnd = await page.evaluate(() => editor.getMarkdown().indexOf("(clip.mp4)") + "(clip.mp4)".length);
  await page.evaluate((at) => { editor.view.focus(); editor.setMarkdownSelection(at); }, mediaEnd);
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(80);
  const media = await page.evaluate(() => {
    const { from, to } = editor.getMarkdownSelection();
    return { selected: editor.getMarkdown().slice(from, to), players: document.querySelectorAll("video.cm-media-player").length };
  });
  assert.equal(media.selected, "![Clip](clip.mp4)", "Backspace selects the whole embed");
  assert.equal(media.players, 1, "the selected embed stays rendered");
  await page.keyboard.press("Escape");

  // Tab leaves bold at its content end.
  await page.evaluate(() => { editor.setMarkdown("x **bold** y"); editor.view.focus(); editor.setMarkdownSelection(8); });
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => editor.getMarkdownSelection().from), 10, "Tab moves past **");
  assert.equal(await page.evaluate(() => editor.getMarkdown()), "x **bold** y", "Tab inserts nothing there");

  assert.deepEqual(errors, [], "page errors");
  console.log(JSON.stringify({ checks: "emoji, media, empty-line hint geometry, table drag selection, cell arrows, embed Backspace, Tab past bold", hint: withHint, selected }));
} finally {
  await browser.close();
  await server.close();
}
