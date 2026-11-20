// Exercise the real Task Manager with changing host snapshots in WebKit.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const { webkit } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || "playwright");
const server = await createServer({
  configFile: fileURLToPath(new URL("../vite.pages.config.ts", import.meta.url)),
  logLevel: "error", server: { host: "127.0.0.1", port: 0, hmr: false },
});
let browser;
try {
  await server.listen();
  browser = await webkit.launch({ headless: true, executablePath: process.env.NOEMA_WEBKIT_EXECUTABLE });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const task = { id: "export", kind: "latex-export", status: "running", title: "Sample",
      result: { agent: { summary: "Review", decisions: [] } } };
    let reads = 0;
    window.noemaApi = {
      notes: { bootstrap: () => new Promise(() => {}) },
      config: { katexMacros: async () => ({ macros: {} }) },
      tasks: { list: async () => ({ ok: true, tasks: [
        ...(reads ? [{ id: "other", kind: "demo", title: "Other", status: "running", progress: [{ text: "Busy" }] }] : []),
        { ...task, progress: [{ text: "Pass " + (++reads) }] },
      ] }) },
    };
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => typeof window.noemaOpenTaskManager === "function");
  await page.evaluate(() => window.noemaOpenTaskManager());
  const card = page.locator(".noema-task-card").filter({ hasText: "Sample" });
  const progress = card.locator("details").filter({ has: page.locator("ol") });
  const audit = card.locator(".noema-task-agent-audit");
  await progress.locator("summary").click();
  await progress.locator("summary").focus();
  await page.waitForFunction(() => [...document.querySelectorAll(".noema-task-card li")].some(li => /^Pass (?!1$)\d+$/.test(li.textContent)));
  assert.equal(await progress.evaluate(el => el.open), true, "poll collapsed progress");
  assert.equal(await progress.locator("summary").evaluate(el => el === document.activeElement), true, "poll lost keyboard focus");
  assert.equal(await page.locator(".noema-task-card").filter({ hasText: "Other" }).locator("details:visible").evaluate(el => el.open), false);
  await audit.locator("summary").click();
  await progress.locator("summary").click();
  const lastEntry = await progress.locator("li").textContent();
  await page.locator("[data-task-manager-refresh]").click();
  await page.waitForFunction(last => {
    const log = [...document.querySelectorAll(".noema-task-card li")].find(li => li.textContent.startsWith("Pass "));
    return log && log.textContent !== last;
  }, lastEntry);
  assert.equal(await progress.evaluate(el => el.open), false);
  assert.equal(await audit.evaluate(el => el.open), true, "manual refresh collapsed the audit");
  console.log("Task Manager kept independent disclosure states and focus while updating progress.");
} finally {
  await browser?.close();
  await server.close();
}
