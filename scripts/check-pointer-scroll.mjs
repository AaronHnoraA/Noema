// Native focus/selection scrolling needs a real browser, especially WebKit.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const { chromium, webkit } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = "/@fs" + repo;
const server = await createServer({
  configFile: repo + "vite.aaronnote.config.ts", root: repo + "aaronnote",
  logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
try {
  for (const [name, engine] of Object.entries({ webkit, chromium })) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/@vite/client", (route) => route.fulfill({
        contentType: "application/javascript",
        body: `export function createHotContext(){return {accept(){},prune(){},dispose(){},on(){},invalidate(){}}} export function updateStyle(id,css){let s=document.createElement('style');s.textContent=css;document.head.append(s)} export function removeStyle(){} export function injectQuery(u){return u}`,
      }));
      await page.route("**/pointer-scroll", (route) => route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}aaronnote/style.css"></head><body style="margin:0"><div id="host" class="aaronnote-focused-editor" style="height:800px;width:1000px;overflow:auto;--aaronnote-visual-zoom:1"></div></body></html>`,
      }));
      await page.goto(new URL("pointer-scroll", server.resolvedUrls.local[0]).href);
      await page.evaluate(async (root) => {
        const { createEditor } = await import(root + "src/editor-api.ts");
        const { createFocusQuiescenceController } = await import(root + "src/cm6/focus-quiescence.ts");
        window.host = document.querySelector("#host");
        window.editor = createEditor(host, { initialContent: "" });
        window.quiescence = createFocusQuiescenceController({
          enabled: true, view: editor.view, editorSurface: host, isSurfaceVisible: () => true,
        });
        await document.fonts.ready;
      }, root);
      const prose = Array.from({ length: 180 }, (_, i) =>
        `Paragraph ${i}. A long document must retain the clicked text position after scrolling. ` +
        "The old cursor is outside the viewport. ".repeat(5));
      const image = "data:image/svg+xml;base64," + Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="100"><rect width="180" height="100" fill="lightblue"/></svg>',
      ).toString("base64");
      const fixtures = {
        plain: prose.join("\n\n"),
        rich: prose.map((text, i) => [
          `## Section ${i}`, text + " **bold** and \\(x^2+y^2\\).",
          ...(i % 5 === 0 ? [`![Plot](${image}){align:left; wrap:on; width:180px}`, text] : []),
        ].join("\n\n")).join("\n\n"),
      };
      for (const [fixture, markdown] of Object.entries(fixtures)) {
        await page.evaluate((markdown) => editor.setMarkdown(markdown), markdown);
        for (const source of [false, true]) {
          await page.evaluate((source) => { if (editor.isSourceMode() !== source) editor.toggleSource(); }, source);
          await page.waitForTimeout(1150); // Let the explicit mode-change viewport lease finish.
          for (const focus of ["focused", "parked", "resumed"]) {
            for (const [scrollTop, oldEnd] of [[2200, false], [7000, true]]) {
              await page.evaluate(({ focus, oldEnd }) => {
                editor.setMarkdownSelection(oldEnd ? editor.view.state.doc.length : 0);
                editor.view.focus();
                if (focus === "parked") quiescence.park();
                if (focus === "resumed") { quiescence.setPaused(true); quiescence.setPaused(false); }
              }, { focus, oldEnd });
              await page.waitForTimeout(150);
              await page.evaluate((scrollTop) => {
                host.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
                host.scrollTop = scrollTop;
              }, scrollTop);
              await page.waitForTimeout(350);
              const point = await page.evaluate(() => {
                for (const line of editor.view.contentDOM.querySelectorAll(".cm-line")) {
                  const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
                  let node;
                  while ((node = walker.nextNode())) {
                    if (node.length < 20 || node.parentElement.closest("[contenteditable=false]")) continue;
                    const range = document.createRange();
                    range.setStart(node, 10); range.setEnd(node, 11);
                    const rect = range.getBoundingClientRect();
                    if (rect.top < 180 || rect.bottom > 650 || !rect.width) continue;
                    return { x: rect.left + .2, y: (rect.top + rect.bottom) / 2,
                      pos: editor.view.posAtDOM(node, 10), top: host.scrollTop };
                  }
                }
              });
              assert.ok(point, `${name}: visible click point`);
              assert.ok(point.top > 1000, `${name}: fixture really scrolled`);
              await page.mouse.click(point.x, point.y);
              await page.waitForTimeout(180);
              const after = await page.evaluate(() => ({
                top: host.scrollTop, pos: editor.view.state.selection.main.head, focused: editor.view.hasFocus,
              }));
              console.log(name, JSON.stringify({ fixture, source, focus, oldEnd, point, after }));
              assert.ok(Math.abs(after.top - point.top) <= 1, `${name}: click after scroll moved viewport`);
              assert.ok(Math.abs(after.pos - point.pos) <= 1, `${name}: click returned to old cursor`);
              assert.equal(after.focused, true);
              // The acquired focus must also preserve a subsequent native drag.
              await page.mouse.move(point.x, point.y);
              await page.mouse.down();
              await page.mouse.move(point.x + 55, point.y, { steps: 5 });
              await page.mouse.up();
              await page.waitForTimeout(50);
              assert.equal(await page.evaluate(() => editor.view.state.selection.main.empty), false,
                `${name}: pointer focus broke drag selection`);
              assert.ok(Math.abs(await page.evaluate(() => host.scrollTop) - point.top) <= 1,
                `${name}: in-viewport drag moved viewport`);
            }
          }
        }
      }
      assert.deepEqual(errors, [], `${name}: page errors`);
    } finally { await browser.close(); }
  }
} finally { await server.close(); }
