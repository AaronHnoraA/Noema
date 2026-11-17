// Google Docs-style comments in the real editor under WebKit (C70): an open
// thread is a card level with its text, clicking the text activates the card,
// and commenting on a selection creates the thread and wraps the text.  The
// host is faked; no user note is opened or saved.
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
      text() { return editor.getMarkdown(); },
    };` });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Boolean(window.commentProbe));
  const text = "# Notation\n\nThe {==fixed field==}{>>#c-20261117000000-aaaaaa<<} is \\(\\mathbb F\\), and [s] is a set.\n\nA subspace is identified with the column space of its basis matrix.\n\n\n\n\n\n\n\n\n\n#+begin ediff Clarify the oracle\n@@ediff-author {\"name\":\"codex·SAI\"}\n-The decision oracle answers this question.\n+The decision oracle answers exactly this yes/no question.\n#+end ediff\n";
  await page.evaluate((value) => window.commentProbe.setup(value), text);
  await page.waitForSelector('.noema-comment-card[data-comment-id="c-20261117000000-aaaaaa"]');
  // Collaborators at the top, with their state (C71).
  await page.waitForSelector(".noema-collab-chip");
  assert.deepEqual(await page.locator(".noema-collab-chip").evaluateAll((chips) => chips.map((chip) => chip.dataset.state)),
    ["working", "needs you"]);
  // A proposal reads in place and has its card on the rail (C72).
  await page.waitForSelector(".noema-suggestion-card");
  assert.equal(await page.locator(".noema-ediff-inline ins").first().textContent(), "exactly ");
  assert.equal(await page.locator(".noema-ediff-actions").first().isVisible(), false);
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-overview.png") });
  // Level with its text.
  const anchorBox = await page.locator(".noema-comment-anchor").boundingBox();
  const cardBox = await page.locator(".noema-comment-card").first().boundingBox();
  assert.ok(Math.abs(anchorBox.y - cardBox.y) < 40, `card at ${cardBox.y}, text at ${anchorBox.y}`);
  assert.ok(cardBox.x > anchorBox.x + anchorBox.width, "the card sits right of the text");
  // Markers hidden.
  const markerWidths = await page.locator(".syntax-hidden").evaluateAll((nodes) => nodes
    .filter((node) => /\{==|==\}/.test(node.textContent || "")).map((node) => node.getBoundingClientRect().width));
  assert.ok(markerWidths.length === 2 && markerWidths.every((width) => width < 1), `markers drawn: ${markerWidths}`);
  // Clicking the text activates the card.
  await page.locator(".noema-comment-anchor").click();
  await page.waitForSelector(".noema-comment-card.noema-comment-active textarea");
  if (shot) await page.screenshot({ path: shot.replace(/\.png$/, "-active.png") });
  // A new comment on a selection.
  const from = text.indexOf("column space");
  await page.evaluate(([a, b]) => window.commentProbe.select(a, b), [from, from + "column space".length]);
  await page.waitForSelector(".noema-comment-add:not([hidden])");
  await page.locator(".noema-comment-add").click();
  await page.locator(".noema-comment-draft textarea").fill("Column space of which matrix?");
  await page.locator(".noema-comment-draft .noema-comment-primary").click();
  await page.waitForFunction(() => window.commentProbe.text().includes("{==column space==}{>>#c-"));
  const created = calls.find(([channel]) => channel === "noema:api:comments:create");
  assert.equal(created[1].quote, "column space");
  assert.equal(created[1].text, "Column space of which matrix?");
  await page.waitForFunction(() => document.querySelectorAll(".noema-comment-card:not(.noema-suggestion-card)").length === 2);
  // The new anchor is drawn like the first, and the text keeps clear of the rail.
  await page.waitForFunction(() => document.querySelectorAll(".noema-comment-anchor").length === 2, null, { timeout: 3000 });
  await page.waitForTimeout(400);
  const railLeft = (await page.locator(".noema-comment-rail").boundingBox()).x;
  const textRight = await page.locator(".cm-line").evaluateAll((lines) => Math.max(...lines.map((line) => {
    const range = document.createRange(); range.selectNodeContents(line);
    return Math.max(0, ...[...range.getClientRects()].map((rect) => rect.right));
  })));
  assert.ok(textRight <= railLeft, `text reaches ${textRight}, rail starts at ${railLeft}`);
  if (shot) await page.screenshot({ path: shot });
  console.log("PASS comments: card level with text, active on click, new comment wraps the selection");
} finally {
  await browser.close();
  await server.close();
}
