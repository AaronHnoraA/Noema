// WebKit layout regression: a DOM emulator cannot reproduce virtualized
// heading metrics, native wheel chaining, or loading-widget height changes.
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
  const page = await browser.newPage({ viewport: { width: 1100, height: 820 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/@vite/client", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `export function createHotContext(){return {accept(){},prune(){},dispose(){},on(){},invalidate(){}}} export function updateStyle(id,css){let s=document.createElement('style');s.textContent=css;document.head.append(s)} export function removeStyle(){} export function injectQuery(u){return u}`,
  }));
  await page.route("**/scroll-audit", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}aaronnote/style.css"></head><body style="margin:0"><div id="host" class="aaronnote-focused-editor" style="height:800px;width:1000px;--aaronnote-visual-zoom:1"></div></body></html>`,
  }));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="220"><rect width="640" height="220" fill="#e6efff"/></svg>';
  const img = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
  const markdown = Array.from({ length: 100 }, (_, i) => [
    `## Section ${i + 1}`,
    `A stable reading line ${i}. This paragraph describes the relationship between measurement and rendered geometry. The reader should be able to follow a line without sudden movement.`,
    `\\[\n\\begin{aligned} f_${i}(x)&=\\sum_{k=1}^{n}\\frac{x^k}{k!}\\\\ g(x)&=\\int_0^x \\frac{1}{1+t^2}\\,dt\\\\ h(x)&=\\sqrt{1+x^2}\\end{aligned}\n\\]`,
    `![Plot ${i}](${img})`,
    ...(i % 3 === 0 ? ["```mermaid\ngraph LR\nA[Observe]-->B[Measure]\nB-->C[Update]\n```"] : []),
    `Readout ${i}: formulas and pictures have stable positions while the document scrolls.`,
  ].join("\n\n")).join("\n\n");
  await page.goto(new URL("scroll-audit", server.resolvedUrls.local[0]).href);
  await page.evaluate(async ({ root, markdown }) => {
    const { createEditor } = await import(root + "src/editor-api.ts");
    window.editor = createEditor(document.querySelector("#host"), { initialContent: markdown });
    editor.setMarkdownSelection(0);
  }, { root, markdown });
  await page.waitForSelector(".cm-mermaid-widget svg");
  await page.evaluate(() => document.fonts.ready);

  // Wheel chaining must work with the pointer over a rendered diagram.
  const diagram = page.locator(".cm-diagram-interactive").first();
  await diagram.hover();
  const before = await page.evaluate(() => document.querySelector("#host").scrollTop);
  await page.mouse.wheel(0, 70);
  await page.waitForTimeout(100);
  assert.ok(await page.evaluate(() => document.querySelector("#host").scrollTop) > before, "diagram swallowed ordinary wheel");

  for (const mode of ["preview", "preview-back", "source"]) {
    await page.evaluate((mode) => { if (editor.isSourceMode() !== (mode === "source")) editor.toggleSource(); }, mode);
    await page.waitForTimeout(1150); // Finish the explicit mode-change scroll lease.
    await page.evaluate((mode) => { document.querySelector("#host").scrollTop = mode === "preview-back" ? 4400 : 0; }, mode);
    await page.waitForTimeout(200);
    await page.evaluate(() => {
      window.scrollSamples = [];
      window.recordScroll = true;
      const host = document.querySelector("#host");
      let previous = new Map(), last = performance.now();
      const sample = () => {
        if (!window.recordScroll) return;
        const now = performance.now(), current = new Map();
        let shift = 0;
        for (const line of editor.view.contentDOM.querySelectorAll(".cm-line")) {
          const rect = line.getBoundingClientRect();
          if (rect.bottom < 0 || rect.top > 800) continue;
          const y = rect.top + host.scrollTop;
          current.set(line, y);
          if (previous.has(line)) shift = Math.max(shift, Math.abs(y - previous.get(line)));
        }
        const blank = [...document.querySelectorAll(".cm-math-scroll-deferred")].some((el) => {
          const rect = el.getBoundingClientRect(); return rect.top < 800 && rect.bottom > 0;
        });
        scrollSamples.push({ dt: now - last, shift, blank, lineHeight: editor.view.defaultLineHeight });
        previous = current; last = now;
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.mouse.move(20, 550);
    for (let i = 0; i < 65; i++) {
      await page.mouse.wheel(0, mode === "preview-back" ? -70 : 70);
      await page.waitForTimeout(20);
    }
    await page.waitForTimeout(400);
    const samples = await page.evaluate(() => { window.recordScroll = false; return scrollSamples; });
    const times = samples.map((s) => s.dt).sort((a, b) => a - b);
    const maxShift = Math.max(...samples.map((s) => s.shift));
    const lineHeights = [...new Set(samples.map((s) => s.lineHeight))];
    console.log(mode, JSON.stringify({ frames: samples.length, maxShift, lineHeights,
      blankFrames: samples.filter((s) => s.blank).length, p95ms: times[Math.floor(times.length * .95)], maxFrameMs: times.at(-1) }));
    // Timings remain observations: they depend on the runner and WebKit's
    // headless wheel delivery. Geometry and unchanged source are hard gates.
    assert.ok(maxShift <= 1, `${mode}: visible lines changed document coordinates by ${maxShift}px`);
    assert.equal(lineHeights.length, 1, `${mode}: styled lines changed default prose metrics`);
    assert.equal(await page.evaluate(() => editor.getMarkdown()), markdown);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
