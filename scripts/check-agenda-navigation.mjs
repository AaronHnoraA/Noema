// Real Markdown editor + host command path in WebKit, with a read-only fake
// host. No user note, save or Emacs session is involved. See check-comments.mjs
// for the shared optional Playwright module / WebKit executable environment.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const playwright = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const root = fileURLToPath(new URL("../", import.meta.url));
const server = await createServer({ configFile: `${root}/vite.pages.config.ts`, logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false } });
let browser;
try {
  await server.listen();
  browser = await (playwright.webkit ?? playwright.default.webkit).launch({ headless: true,
    ...(process.env.NOEMA_WEBKIT_EXECUTABLE ? { executablePath: process.env.NOEMA_WEBKIT_EXECUTABLE } : {}) });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error));
  await page.route("**/api", (route) => route.fulfill({ json: { ok: true, threads: [] } }));
  await page.addInitScript(() => {
    window.agendaInspections = [];
    window.agendaCompletions = [];
    window.agendaSaves = 0;
    window.noemaApi = {
      copilot: { request: async () => ({ ok: true }) },
      notes: { bootstrap: () => new Promise(() => {}),
        save: async () => { window.agendaSaves++; return { ok: true }; },
        agendaDocument: (body) => {
          window.agendaInspections.push(body);
          return new Promise((resolve) => window.agendaCompletions.push(resolve));
        } },
      config: { katexMacros: async () => ({ macros: {} }) },
    };
  });
  await page.route("**/main.ts", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.agendaProbe = {
      setup(text) {
        applyPaused(false); host.hidden = false; currentReadOnly = false;
        currentFile = '/tmp/agenda-navigation.md';
        editor.setMarkdown(text, { history: 'reset' });
        editor.setMarkdownSelection(0, 0);
      },
      result() {
        const s = editor.view.state.selection.main;
        return { from: s.from, to: s.to, text: editor.getMarkdown() };
      },
      pause(next) { applyPaused(next); },
    };` });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Boolean(window.agendaProbe));
  const text = "😀\n\nAn unsaved introduction.\n\n@@todo [Updated]{id: task}\n";
  const from = text.indexOf("@@todo"), source = text.slice(from).trimEnd();
  await page.evaluate((value) => window.agendaProbe.setup(value), text);
  const visit = () => page.evaluate(() => window.dispatchEvent(new CustomEvent("noema:command", {
    detail: { command: "agenda-visit", file: "/tmp/agenda-navigation.md", id: "#task", index: 999, source: "old" },
  })));
  const complete = () => page.evaluate((task) => window.agendaCompletions.shift()({ todos: [task] }), { id: "#task", index: from, source });
  await visit();
  await page.waitForFunction(() => window.agendaCompletions.length === 1);
  assert.deepEqual(await page.evaluate(() => window.agendaInspections[0]), { file: "/tmp/agenda-navigation.md", content: text });
  await complete();
  await page.waitForFunction((position) => window.agendaProbe.result().from === position, from);
  assert.deepEqual(await page.evaluate(() => window.agendaProbe.result()), { from, to: from + source.length, text });

  await page.evaluate((value) => window.agendaProbe.setup(value), text);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("noema:command", { detail: {
    command: "agenda-visit", file: "/tmp/agenda-navigation.md", id: "#c-7777",
    sourceKind: "comment-reference", quote: "An unsaved introduction.",
  } })));
  const quoteFrom = text.indexOf("An unsaved introduction.");
  await page.waitForFunction((position) => window.agendaProbe.result().from === position, quoteFrom);
  assert.deepEqual(await page.evaluate(() => window.agendaProbe.result()),
    { from: quoteFrom, to: quoteFrom + "An unsaved introduction.".length, text });
  assert.equal(await page.evaluate(() => window.agendaInspections.length), 1);

  await page.evaluate((value) => window.agendaProbe.setup(value), text);
  await visit();
  await page.waitForFunction(() => window.agendaCompletions.length === 1);
  await page.evaluate(() => { window.agendaProbe.pause(true); window.agendaProbe.pause(false); });
  await complete();
  // A later event-loop turn observes the settled navigation promise.
  await page.evaluate(() => new Promise(requestAnimationFrame));
  assert.equal((await page.evaluate(() => window.agendaProbe.result())).from, 0);
  assert.equal(await page.evaluate(() => window.agendaSaves), 0);
  assert.deepEqual(errors, []);
  console.log("PASS Agenda WebKit: host commands select live unsaved tasks and journal quotes, preserve text, cancel on pause/resume, never save");
} finally {
  await browser?.close();
  await server.close();
}
