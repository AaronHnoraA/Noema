// Vim rows, the painted selection, search and undo in the real editor under
// WebKit, where hidden Markdown syntax has the layout that broke them.  No
// user note is opened or saved.  Playwright is an optional local dependency.
//
//   NOEMA_PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/check-vim-rows.mjs
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { webkit } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
// Headings and quotes hide their markers; the blank lines are rows too.
const LINES = [
  '# 严重bug', '',
  '## 笔记', '', '> 这里记录核心编辑器 在使用中的各种问题', '',
  '## 同步', '', '> 这里记录git工具链的问题', '',
  '# 非严重bug', '', 'tail paragraph',
];
const DOC = LINES.join('\n');
const lineStart = (index) => LINES.slice(0, index).join('\n').length + (index > 0 ? 1 : 0);

const server = await createServer({
  configFile: `${root}/vite.aaronnote.config.ts`,
  logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
await server.listen();
const browser = await webkit.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  page.on('pageerror', (error) => { throw error; });
  await page.addInitScript(() => {
    window.aaronnoteApi = {
      copilot: { request: async () => ({ ok: true }) },
      notes: { bootstrap: () => new Promise(() => {}), save: async () => ({ ok: true }) },
      config: { katexMacros: async () => ({ macros: {} }) },
    };
  });
  await page.route('**/main.ts', async (route) => {
    const response = await route.fetch();
    const body = `${await response.text()}\nwindow.vimProbe = {
      setup(text) {
        paused = false; host.hidden = false;
        currentFile = '/tmp/noema-vim-rows-check.md'; currentReadOnly = false;
        editor.setMarkdown(text, { history: 'reset' });
        vim.setMode('normal'); editor.focus();
      },
      goto(pos) { editor.setMarkdownSelection(pos); vim.syncSelectionFromEditor(); },
      state() {
        const main = editor.view.state.selection.main;
        const line = editor.view.contentDOM.querySelector('.cm-line');
        const box = (element) => { const r = element.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.right)]; };
        return {
          mode: vim.mode(), from: main.from, to: main.to, head: main.head,
          text: editor.getMarkdown(),
          nativeHighlight: getComputedStyle(line, '::selection').backgroundColor,
          column: box(line),
          layer: box(editor.view.dom.querySelector('.cm-selectionLayer')),
          findOpen: !findPanel.hidden,
        };
      },
    };`;
    await route.fulfill({ response, body });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Boolean(window.vimProbe));
  await page.evaluate((text) => window.vimProbe.setup(text), DOC);
  await page.waitForTimeout(400);
  const state = async () => { await page.waitForTimeout(120); return page.evaluate(() => window.vimProbe.state()); };
  const goto = (pos) => page.evaluate((at) => window.vimProbe.goto(at), pos);

  // V then j takes exactly one line each time: a hidden `>` is not a row.
  await goto(lineStart(2) + 3);
  await page.keyboard.press('Shift+V');
  let current = await state();
  assert.equal(current.mode, 'visual-line');
  assert.deepEqual([current.from, current.to], [lineStart(2), lineStart(3)], 'V selects the whole heading line');
  for (let line = 3; line <= 10; line++) {
    await page.keyboard.press('j');
    current = await state();
    assert.deepEqual([current.from, current.to], [lineStart(2), lineStart(line + 1)], `j reaches line ${line + 1}`);
  }

  // One painter, kept inside the text column.
  assert.match(current.nativeHighlight, /rgba\(0, 0, 0, 0\)|transparent/, 'the browser highlight stays hidden');
  assert.ok(Math.abs(current.layer[0] - current.column[0]) <= 1 && Math.abs(current.layer[1] - current.column[1]) <= 1,
    `the selection layer ${current.layer} is clipped to the text column ${current.column}`);
  await page.keyboard.press('Escape');

  // Extending upward onto a heading takes its hidden marker as well.
  await goto(lineStart(4) + 3);
  await page.keyboard.press('Shift+V');
  await page.keyboard.press('k');
  await page.keyboard.press('k');
  current = await state();
  assert.deepEqual([current.from, current.to], [lineStart(2), lineStart(5)], 'k onto a heading selects it from its marker');
  await page.keyboard.press('Escape');

  // `/` is Vim's search: Enter accepts, n and N continue, Escape goes back.
  await goto(0);
  await page.keyboard.press('/');
  assert.equal((await state()).findOpen, true);
  await page.keyboard.type('记录');
  await page.keyboard.press('Enter');
  current = await state();
  assert.deepEqual([current.findOpen, current.mode, current.head], [false, 'normal', DOC.indexOf('记录')]);
  await page.keyboard.press('n');
  const second = DOC.indexOf('记录', DOC.indexOf('记录') + 1);
  assert.equal((await state()).head, second);
  await page.keyboard.press('Shift+N');
  assert.equal((await state()).head, DOC.indexOf('记录'));
  await page.keyboard.press('/');
  await page.keyboard.type('tail');
  await page.keyboard.press('Escape');
  current = await state();
  assert.deepEqual([current.findOpen, current.mode, current.head], [false, 'normal', DOC.indexOf('记录')]);

  // One u for an opened line and what was typed on it.
  await goto(DOC.length - 3);
  await page.keyboard.press('o');
  await page.keyboard.type('a b c');
  await page.keyboard.press('Escape');
  assert.equal((await state()).text, `${DOC}\na b c`);
  await page.keyboard.press('u');
  assert.equal((await state()).text, DOC);
  console.log('Noema Vim: rows over hidden syntax, one clipped selection, search and undo passed');
} finally {
  await browser.close();
  await server.close();
}
