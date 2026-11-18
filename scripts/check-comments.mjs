// Comments in the real editor under WebKit (C80): there is no rail; the caret
// in a highlight, or the pointer on it, pops its card up above the text; a
// highlight holding math stays a highlight; commenting on a selection drafts
// above it and wraps the text.  The host is faked; no user note is opened or
// saved.
//
//   NOEMA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-comments.mjs [shot.png]
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const playwright = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const webkit = playwright.webkit ?? playwright.default.webkit;
const root = fileURLToPath(new URL("../", import.meta.url));
const shot = process.argv[2];
const server = await createServer({
  configFile: `${root}/vite.pages.config.ts`, logLevel: "error",
  server: { host: "127.0.0.1", port: 0, hmr: false },
});
await server.listen();
const browser = await webkit.launch({ headless: true, ...(process.env.NOEMA_WEBKIT_EXECUTABLE ? { executablePath: process.env.NOEMA_WEBKIT_EXECUTABLE } : {}) });
const threads = [{
  id: "c-20261117000000-aaaaaa", note: "check.md", quote: "fixed field", status: "open",
  createdAt: new Date(Date.now() - 3 * 60_000).toISOString(), author: { name: "You", kind: "person" },
  assignee: { name: "claude·SAI" },
  messages: [
    { mid: "m0", author: { name: "You", kind: "person" }, text: "Why is the field fixed here?", at: new Date(Date.now() - 3 * 60_000).toISOString() },
    { mid: "m-1", author: { name: "claude·SAI", kind: "agent" }, text: "Because every subspace is over the same F; Section 2 needs it for the rank argument.", at: new Date(Date.now() - 60_000).toISOString() },
  ],
}];
const calls = [];
try {
  const page = await browser.newPage({ viewport: { width: 1400, height: 820 } });
  page.on("pageerror", (error) => { throw error; });
  await page.route("**/api", async (route) => {
    const { channel, args } = JSON.parse(route.request().postData() || "{}");
    calls.push([channel, args?.[0]]);
    if (channel === "noema:api:comments:list") return route.fulfill({ json: { ok: true, threads } });
    if (channel === "noema:api:emacs:agent") return route.fulfill({ json: { ok: true, sessions: [
      { buffer: "*Agent · claude·SAI*", nativeSessionId: "n1", name: "claude·SAI", agent: "claude", busy: true },
      { buffer: "*Agent · codex·SAI*", nativeSessionId: "n2", name: "codex·SAI", agent: "codex", attention: "permission" },
    ] } });
    if (channel === "noema:api:comments:create") {
      const body = args[0];
      threads.push({ id: body.id, note: "check.md", quote: body.quote, status: "open", createdAt: new Date().toISOString(),
        author: { name: "You", kind: "person" }, assignee: null,
        messages: [{ mid: "m0", author: { name: "You", kind: "person" }, text: body.text, at: new Date().toISOString() }] });
      return route.fulfill({ json: { ok: true } });
    }
    return route.fulfill({ json: { ok: true } });
  });
  await page.addInitScript(() => {
    window.noemaApi = {
      copilot: { request: async () => ({ ok: true }) },
      notes: { bootstrap: () => new Promise(() => {}), save: async () => ({ ok: true }) },
      config: { katexMacros: async () => ({ macros: {} }) },
    };
  });
  await page.route("**/main.ts", async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.commentProbe = {
      async setup(text) {
        paused = false; host.hidden = false;
        currentFile = '/tmp/noema-comments-check/check.md'; currentReadOnly = false;
        editor.setMarkdown(text, { history: 'reset' });
        await comments.refresh();
      },
      select(from, to) { editor.focus(); editor.view.dispatch({ selection: { anchor: from, head: to } }); comments.selectionChanged(); },
      start() { comments.startComment(); },
      text() { return editor.getMarkdown(); },
    };` });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Boolean(window.commentProbe));
  const text = "# Notation\n\n" + "Some opening words.\n\n".repeat(8) + "The {==fixed field==}{>>#c-20261117000000-aaaaaa<<} is \\(\\mathbb F\\), and [s] is a set.\n\nArrows {==labelled \\(\\widehat A\\) show maps==}{>>#c-20261117000000-bbbbbb<<} of members.\n\nA subspace is identified with the column space of its basis matrix.\n";
  threads.push({ ...threads[0], id: "c-20261117000000-bbbbbb", quote: "labelled", assignee: null,
    messages: [{ mid: "m0", author: { name: "You", kind: "person" }, text: "Is \\widehat A defined yet?", at: new Date().toISOString() }] });
  await page.evaluate((value) => window.commentProbe.setup(value), text);
  await page.waitForSelector(".noema-comment-anchor");
  assert.equal(await page.locator(".noema-comment-rail").count(), 0, "no rail");
  // A highlight holding math is a highlight, its math rendered.
  assert.equal(await page.locator('.noema-comment-anchor[data-comment-id="c-20261117000000-bbbbbb"]').count() > 0, true);
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-overview.png") });
  // The caret in the highlight: the card above the text.
  const at = text.indexOf("fixed field") + 3;
  await page.evaluate(([a]) => window.commentProbe.select(a, a), [at]);
  await page.waitForSelector(".noema-comment-pop:not([hidden])");
  const anchorBox = await page.locator(".noema-comment-anchor").first().boundingBox();
  const popBox = await page.locator(".noema-comment-pop").boundingBox();
  // Above the text, or below it when there is no room; never over it.
  assert.ok(popBox.y + popBox.height <= anchorBox.y + 2 || popBox.y >= anchorBox.y + anchorBox.height - 2,
    `card ${popBox.y}..${popBox.y + popBox.height} covers the text at ${anchorBox.y}`);
  assert.equal(await page.locator(".noema-comment-pop .noema-comment-state").textContent(), "→ claude·SAI");
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-caret.png") });
  // The caret leaves: the card closes; the pointer on the other highlight opens it.
  await page.evaluate(([a]) => window.commentProbe.select(a, a), [text.length - 2]);
  await page.waitForSelector(".noema-comment-pop[hidden]", { state: "attached" });
  await page.locator('.noema-comment-anchor[data-comment-id="c-20261117000000-bbbbbb"]').first().hover();
  await page.waitForSelector(".noema-comment-pop:not([hidden])");
  assert.match(await page.locator(".noema-comment-pop .noema-comment-body").first().textContent(), /widehat/);
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-hover.png") });
  await page.mouse.move(5, 790);
  await page.waitForSelector(".noema-comment-pop[hidden]", { state: "attached" });
  // A new comment on a selection: a draft above it.
  const from = text.indexOf("column space");
  await page.evaluate(([a, b]) => window.commentProbe.select(a, b), [from, from + "column space".length]);
  await page.evaluate(() => window.commentProbe.start());
  await page.locator(".noema-comment-pop textarea").fill("Column space of which matrix?");
  await page.locator(".noema-comment-pop .noema-comment-primary").click();
  await page.waitForFunction(() => window.commentProbe.text().includes("{==column space==}{>>#c-"));
  const created = calls.find(([channel]) => channel === "noema:api:comments:create");
  assert.equal(created[1].quote, "column space");
  assert.equal(created[1].text, "Column space of which matrix?");
  if (shot) await page.screenshot({ path: shot });
  console.log("PASS comments: no rail, card above on caret and hover, math in a highlight, a draft wraps the selection");
} finally {
  await browser.close();
  await server.close();
}
