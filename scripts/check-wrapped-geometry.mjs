// Real layout regression: Happy DOM cannot detect float/height-map drift.
// Requires Playwright with Chromium and WebKit installed. An external install
// may be selected with NOEMA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs.
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createServer } from "vite";
const { chromium, webkit } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = "/@fs" + repo;
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
  root: repo + "website",
  logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const url = server.resolvedUrls.local[0];
try {
  for (const [name, engine] of Object.entries({ chromium, webkit })) {
    const browser = await engine.launch({ headless: true });
    try {
      const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
      const errors = [];
      page.on("pageerror", (e) => {
        errors.push(e.message);
      });
      // This isolated fixture needs CSS injection, but no development HMR
      // connection (its document is supplied by Playwright).
      await page.route("**/@vite/client", (r) =>
        r.fulfill({
          contentType: "application/javascript",
          body: `export function createHotContext(){return {accept(){},prune(){},dispose(){},on(){},invalidate(){}}} export function updateStyle(id,css){let s=document.createElement('style');s.textContent=css;document.head.append(s)} export function removeStyle(){} export function injectQuery(u){return u}`,
        }),
      );
      await page.route("**/geometry", (r) =>
        r.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}aaronnote/style.css"></head><body><div id="host" class="aaronnote-focused-editor" style="height:900px;width:1300px;--aaronnote-visual-zoom:1"></div></body></html>`,
        }),
      );
      await page.route("**/fixture.svg", (r) =>
        r.fulfill({
          contentType: "image/svg+xml",
          body: '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="300"><rect width="400" height="300" fill="lightblue"/></svg>',
        }),
      );
      await page.goto(new URL("geometry", url).href);
      for (const kind of ["tikz", "table", "image"])
        for (const side of ["left", "right"]) {
          const prose =
            "The diagram leaves space for editable text beside its bounds. Every sentence should accept a click at its visible position, and moving down should reach the next visual row. ".repeat(
              3,
            );
          const figureSource =
            kind === "tikz"
              ? `#+begin tikz geometry-${side} {wrap=${side}}\n\\begin{tikzpicture}\n\\draw (0,0) rectangle (8,5);\n\\node at (4,2.5) {Diagram};\n\\end{tikzpicture}\n#+end tikz`
              : kind === "table"
                ? `| A | B |\n| --- | --- |\n${Array.from({ length: 6 }, (_, i) => `| Row ${i} | Value |`).join("\n")}\n{align:${side}; wrap:on}`
                : `![Diagram](/fixture.svg){align:${side}; wrap:on; width:400px}`;
          const selector =
            kind === "tikz"
              ? ".cm-tikz-env-widget"
              : kind === "table"
                ? ".cm-table-block"
                : ".cm-image-widget";
          const note = [
            "# Geometry regression",
            ...Array.from({ length: 8 }, (_, i) => `Before ${i}. ${prose}`),
            figureSource,
            ...Array.from({ length: 12 }, (_, i) => `After ${i}. ${prose}`),
          ].join("\n\n");
          await page.evaluate(
            async ({ root, note }) => {
              window.editor?.destroy();
              const { createEditor } = await import(root + "src/editor-api.ts");
              window.editor = createEditor(document.querySelector("#host"), {
                initialContent: note,
              });
              editor.setMarkdownSelection(note.indexOf("After 0.") + 25);
            },
            { root, note },
          );
          try {
            await page.waitForSelector(kind === "tikz" ? ".cm-tikz-env-image svg" : selector);
          } catch (error) {
            console.error(name, kind, side, await page.locator(selector).textContent(), errors);
            throw error;
          }
          await page.evaluate((selector) => {
            const h = document.querySelector("#host");
            h.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
            h.scrollTop += document.querySelector(selector).getBoundingClientRect().top - 150;
          }, selector);
          await page.waitForTimeout(700);
          const collectPoints = () => {
            const v = editor.view,
              points = [];
            const start = v.state.doc.toString().indexOf("After 0.");
            for (const line of v.contentDOM.querySelectorAll(".cm-line")) {
              const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
              let n;
              while ((n = walker.nextNode())) {
                if (n.textContent.length < 15 || n.parentElement.closest("[contenteditable=false]"))
                  continue;
                for (let offset = 5; offset < n.length - 5; offset += 30) {
                  const pos = v.posAtDOM(n, offset);
                  if (pos < start) continue;
                  const r = document.createRange();
                  r.setStart(n, offset);
                  r.setEnd(n, offset + 1);
                  const c = r.getBoundingClientRect();
                  if (c.top < 80 || c.bottom > 850 || c.width === 0) continue;
                  const x = c.left + 1,
                    y = (c.top + c.bottom) / 2;
                  const mapped = v.posAtCoords({ x, y });
                  points.push({ pos, mapped, x, y });
                }
              }
            }
            return points;
          };
          const points = await page.evaluate(collectPoints);
          assert.ok(points.length > 20);
          const bad = points.filter((p) => Math.abs(p.pos - p.mapped) > 1);
          console.log(name, kind, side, "points", points.length, "bad", bad.slice(0, 4));
          assert.equal(bad.length, 0);
          const targets = [points[0], points[Math.floor(points.length / 2)], points.at(-1)];
          for (const p of targets) {
            await page.mouse.click(p.x, p.y);
            await page.waitForTimeout(60);
            const head = await page.evaluate(() => editor.view.state.selection.main.head);
            assert.ok(Math.abs(head - p.pos) <= 1, `click ${p.pos} -> ${head}`);
          }
          await page.mouse.click(points[0].x, points[0].y);
          await page.waitForTimeout(180);
          for (let i = 0; i < 8; i++) {
            const before = await page.evaluate(() => {
              const v = editor.view,
                c = v.coordsAtPos(v.state.selection.main.head);
              return { head: v.state.selection.main.head, top: c.top, left: c.left };
            });
            await page.keyboard.press("ArrowDown");
            await page.waitForTimeout(50);
            const after = await page.evaluate(() => {
              const v = editor.view,
                c = v.coordsAtPos(v.state.selection.main.head);
              return { head: v.state.selection.main.head, top: c.top, left: c.left };
            });
            assert.ok(
              after.head > before.head && after.top > before.top && after.top - before.top < 70,
              JSON.stringify({ before, after }),
            );
          }
          for (let i = 0; i < 8; i++) {
            const before = await page.evaluate(
              () => editor.view.coordsAtPos(editor.view.state.selection.main.head).top,
            );
            await page.keyboard.press("ArrowUp");
            await page.waitForTimeout(40);
            const after = await page.evaluate(
              () => editor.view.coordsAtPos(editor.view.state.selection.main.head).top,
            );
            assert.ok(after < before && before - after < 70, `ArrowUp ${before} -> ${after}`);
          }
          await page.mouse.click(points[0].x, points[0].y);
          await page.waitForTimeout(700);
          await page.evaluate(() => {
            const h = document.querySelector("#host"),
              v = editor.view;
            window.samples = [];
            window.tracking = true;
            window.widgetChanges = 0;
            window.scrollWrites = [];
            for (const key of ["scrollTop", "scrollLeft"]) {
              let proto = h,
                descriptor;
              while (proto && !descriptor) {
                descriptor = Object.getOwnPropertyDescriptor(proto, key);
                proto = Object.getPrototypeOf(proto);
              }
              Object.defineProperty(h, key, {
                configurable: true,
                get() {
                  return descriptor.get.call(this);
                },
                set(value) {
                  scrollWrites.push({ key, old: descriptor.get.call(this), value });
                  descriptor.set.call(this, value);
                },
              });
            }
            const observer = new MutationObserver((rs) => {
              for (const r of rs)
                for (const n of [...r.addedNodes, ...r.removedNodes])
                  if (
                    n instanceof Element &&
                    (n.matches(".cm-image-widget, .cm-table-block, .cm-float-anchor") ||
                      n.querySelector(".cm-image-widget, .cm-table-block"))
                  )
                    window.widgetChanges++;
            });
            observer.observe(v.contentDOM, { childList: true, subtree: true });
            window.probeObserver = observer;
            const sample = () => {
              if (!window.tracking) return;
              samples.push({ top: h.scrollTop, height: h.scrollHeight, content: v.contentHeight });
              requestAnimationFrame(sample);
            };
            sample();
          });
          await page.keyboard.type("abcdefghij", { delay: 100 });
          await page.waitForTimeout(600);
          const perf = await page.evaluate(() => {
            window.tracking = false;
            probeObserver.disconnect();
            delete document.querySelector("#host").scrollTop;
            delete document.querySelector("#host").scrollLeft;
            return { samples, widgetChanges, scrollWrites };
          });
          const tops = perf.samples.map((s) => s.top),
            heights = perf.samples.map((s) => s.height);
          const stats = {
            frames: tops.length,
            scrollDelta: Math.max(...tops) - Math.min(...tops),
            heightDelta: Math.max(...heights) - Math.min(...heights),
            widgetChanges: perf.widgetChanges,
            scrollWrites: perf.scrollWrites.length,
            heightTransitions: heights.filter((h, i) => i && h !== heights[i - 1]).length,
          };
          console.log(name, kind, side, "typing", stats);
          assert.equal(stats.scrollDelta, 0);
          assert.equal(stats.widgetChanges, 0);
          assert.ok(stats.heightTransitions <= 1, JSON.stringify(stats));
          assert.equal(stats.scrollWrites, 0);
          for (const [width, zoom] of [
            [900, 1],
            [1100, 1.25],
          ]) {
            await page.evaluate(
              ({ width, zoom }) => {
                const h = document.querySelector("#host");
                h.style.width = width + "px";
                h.style.setProperty("--aaronnote-visual-zoom", String(zoom));
              },
              { width, zoom },
            );
            await page.waitForTimeout(400);
            const resized = await page.evaluate(collectPoints);
            const bad = resized.filter((p) => Math.abs(p.pos - p.mapped) > 1);
            console.log(
              name,
              kind,
              side,
              "resize",
              width,
              zoom,
              "points",
              resized.length,
              "bad",
              bad.slice(0, 2),
            );
            assert.ok(resized.length > 10);
            assert.equal(bad.length, 0);
          }
          await page.evaluate(() => {
            const h = document.querySelector("#host");
            h.style.width = "1300px";
            h.style.setProperty("--aaronnote-visual-zoom", "1");
          });
        }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  }
} finally {
  await server.close();
}
