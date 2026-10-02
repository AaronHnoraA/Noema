// Long-session memory in a real engine: one editor switches between 40 notes
// with typing and source toggles, then editors are created and destroyed
// repeatedly. The JS heap after a forced GC must level off. Chromium is used
// because its DevTools protocol can force GC and read the heap.
// NOEMA_PLAYWRIGHT_MODULE may point to an external Playwright installation.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
const { chromium } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const repo = fileURLToPath(new URL("../", import.meta.url));
const root = "/@fs" + repo;
const switches = Number(process.env.NOEMA_SOAK_SWITCHES || 600);
const server = await createServer({
  configFile: repo + "vite.aaronnote.config.ts", root: repo + "aaronnote",
  logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/@vite/client", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `export function createHotContext(){return {accept(){},prune(){},dispose(){},on(){},invalidate(){}}} export function updateStyle(id,css){let s=document.createElement('style');s.textContent=css;document.head.append(s)} export function removeStyle(){} export function injectQuery(u){return u}`,
  }));
  await page.route("**/memory-soak", (route) => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><link rel="stylesheet" href="${root}src/styles/widgets.css"><link rel="stylesheet" href="${root}aaronnote/style.css"></head><body style="margin:0"><div id="host" class="aaronnote-focused-editor" style="height:780px;width:960px"></div></body></html>`,
  }));
  const big = readFileSync(repo + "tests/synthetic_qc_note_5mb.md", "utf8");
  const notes = Array.from({ length: 40 }, (_, i) => big.slice(i * 60_000, i * 60_000 + 60_000)
    + `\n\n| a | b |\n|-|-|\n| ${i} | :tada: |\n\n\`\`\`js\nconst x${i} = ${i};\n\`\`\`\n\nNote[^${i}].\n\n[^${i}]: foot ${i}\n`);
  await page.goto(new URL("memory-soak", server.resolvedUrls.local[0]).href);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  const heap = async () => {
    for (let i = 0; i < 3; i++) await cdp.send("HeapProfiler.collectGarbage");
    const { usedSize } = await cdp.send("Runtime.getHeapUsage");
    return Math.round(usedSize / 1048576 * 10) / 10;
  };
  await page.evaluate(async ({ root, notes }) => {
    const { createEditor } = await import(root + "src/editor-api.ts");
    window.notes = notes;
    window.makeEditor = () => createEditor(document.querySelector("#host"), { initialContent: notes[0] });
    window.editor = makeEditor();
  }, { root, notes });
  await page.waitForTimeout(500);
  const samples = [{ phase: "start", heap: await heap() }];
  for (let done = 0; done < switches;) {
    const batch = Math.min(50, switches - done);
    await page.evaluate(async ({ from, batch }) => {
      for (let n = from; n < from + batch; n++) {
        editor.setMarkdown(notes[n % notes.length], { history: "reset" });
        editor.setMarkdownSelection(Math.min(2000, editor.getMarkdown().length));
        for (let k = 0; k < 10; k++) editor.view.dispatch(editor.view.state.replaceSelection("y"));
        if (n % 7 === 0) editor.toggleSource();
        document.querySelector("#host").scrollTop = (n % 5) * 900;
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
    }, { from: done + 1, batch });
    done += batch;
    if (done % 100 === 0) samples.push({ phase: `switch ${done}`, heap: await heap() });
  }
  for (let cycle = 1; cycle <= 20; cycle++) {
    await page.evaluate(async () => {
      editor.destroy();
      window.editor = makeEditor();
      await new Promise((resolve) => requestAnimationFrame(resolve));
    });
    if (cycle % 10 === 0) samples.push({ phase: `recreate ${cycle}`, heap: await heap() });
  }
  console.log(JSON.stringify(samples));
  const steady = samples.filter((sample) => sample.phase.startsWith("switch"));
  const firstHalf = steady.slice(0, Math.ceil(steady.length / 2)).map((sample) => sample.heap);
  const secondHalf = steady.slice(Math.ceil(steady.length / 2)).map((sample) => sample.heap);
  const growth = Math.max(...secondHalf) - Math.max(...firstHalf);
  assert.ok(growth < 8, `heap keeps growing across note switches: +${growth} MB`);
  const recreated = samples.filter((sample) => sample.phase.startsWith("recreate")).map((sample) => sample.heap);
  assert.ok(recreated[1] - recreated[0] < 5, `editor re-creation leaks: ${recreated.join(" -> ")} MB`);
  assert.deepEqual(errors, [], "page errors");
} finally {
  await browser.close();
  await server.close();
}
