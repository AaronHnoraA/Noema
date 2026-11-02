// A proposal arriving under the caret stays a card in the real editor under
// WebKit, as Pi C25 requires.  No user note is opened or saved.
//
//   NOEMA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-ediff-arrival.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { webkit } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
const server = await createServer({
  configFile: `${root}/vite.pages.config.ts`, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
await server.listen();
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (error) => { throw error; });
  await page.addInitScript(() => {
    window.noemaApi = {
      copilot: { request: async () => ({ ok: true }) },
      notes: { bootstrap: () => new Promise(() => {}), save: async () => ({ ok: true }) },
      config: { katexMacros: async () => ({ macros: {} }) },
    };
  });
  await page.route('**/main.ts', async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.ediffProbe = {
      setup(text, caret) {
        paused = false; host.hidden = false;
        currentFile = '/tmp/noema-ediff-check.md'; currentReadOnly = false;
        editor.setMarkdown(text, { history: 'reset' });
        editor.focus();
        editor.setMarkdownSelection(caret);
      },
      arrive(text) { editor.setMarkdown(text, { history: 'reset', preserveView: true }); },
      caret() { return editor.view.state.selection.main.head; },
    };` });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Boolean(window.ediffProbe));
  const plain = '# t\n\none\ntwo\nthree\n';
  const proposed = '# t\n\none\n#+begin ediff Change two\n-two\n+2\n#+end ediff\nthree\n';
  for (const caret of [plain.indexOf('two'), plain.indexOf('two') + 2, 0]) {
    await page.evaluate(([text, at]) => window.ediffProbe.setup(text, at), [plain, caret]);
    await page.evaluate((text) => window.ediffProbe.arrive(text), proposed);
    await page.waitForSelector('.noema-ediff', { timeout: 3000 });
    const source = await page.locator('.cm-line', { hasText: '#+begin ediff' }).count();
    assert.equal(source, 0, `caret ${caret}: the proposal opened as source`);
  }
  console.log('PASS a proposal arriving under the caret stays a card');
} finally {
  await browser.close();
  await server.close();
}
