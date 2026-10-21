// Exercise the real editor and popup event pipeline in WebKit without opening
// or saving a user's note. Playwright is an optional local test dependency.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const { webkit } = await import(process.env.NOEMA_PLAYWRIGHT_MODULE || 'playwright');
const root = fileURLToPath(new URL('../', import.meta.url));
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
      notes: {
        bootstrap: () => new Promise(() => {}),
        pathSuggestions: async (_file, prefix) => {
          await new Promise((resolve) => setTimeout(resolve, 240));
          return { ok: true, paths: ['../AI/', '../Bio/', '../CS/', '../Math/', '../Philosophy/', '../QC/', '../README/']
            .filter((path) => path.toLowerCase().startsWith(prefix.toLowerCase())) };
        },
        save: async () => ({ ok: true }),
      },
      config: { katexMacros: async () => ({ macros: {} }) },
    };
  });
  await page.route('**/main.ts', async (route) => {
    const response = await route.fetch();
    const body = `${await response.text()}\nwindow.snippetProbe = {
      setup() {
        paused = false;
        host.hidden = false;
        currentFile = '/tmp/noema-snippet-check.md';
        currentReadOnly = false;
        editor.setMarkdown('');
        vim.setMode('insert');
        editor.focus();
      },
      setText(text) {
        editor.setMarkdown(text);
        editor.setMarkdownSelection(text.length);
        editor.focus();
      },
      setCursor(position) {
        editor.setMarkdownSelection(position);
        editor.focus();
      },
      state() {
        return {
          text: editor.getMarkdown(),
          visible: !snippetPopup.hidden,
          composing: editor.view.compositionStarted,
          armed: snippetCompletionArmed,
          tableRows: [...editor.view.dom.querySelectorAll('.cm-table-source-row')].map((row) => ({
            cells: row.querySelectorAll('.cm-table-source-cell').length,
            height: row.getBoundingClientRect().height,
          })),
          pending: completionRequestPending,
          index: snippetPopupIndex,
          busy: snippetPopup.getAttribute('aria-busy'),
          items: snippetPopupItems.map((item) => item.key),
          focused: editorOwnsActiveSurface(),
        };
      },
      firstOption: () => snippetPopup.querySelector('.aaronnote-snippet-option'),
      geometry() {
        const position = editor.view.state.selection.main.head;
        const activeCell = editor.view.dom.querySelector('.cm-table-source-active-cell');
        const nativeSelection = window.getSelection();
        return {
          cm: editor.view.coordsAtPos(position),
          context: editor.cursorContext().rect,
          native: nativeSelection?.rangeCount ? nativeSelection.getRangeAt(0).getBoundingClientRect().toJSON() : null,
          activeCell: activeCell?.getBoundingClientRect().toJSON(),
          popup: snippetPopup.getBoundingClientRect().toJSON(),
          pipeInsideActive: Boolean(activeCell?.querySelector('.cm-table-source-pipe')),
          rowHeight: activeCell?.closest('.cm-table-source-row')?.getBoundingClientRect().height,
        };
      },
      programmaticScroll() {
        editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
      },
      userScroll() {
        editor.view.scrollDOM.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
        editor.view.scrollDOM.dispatchEvent(new Event('scroll'));
      },
    };`;
    await route.fulfill({ response, body });
  });
  await page.goto(server.resolvedUrls.local[0]);
  await page.waitForFunction(() => Boolean(window.snippetProbe));
  await page.evaluate(() => window.snippetProbe.setup());

  // Typing opens the path menu and keeps it mounted during caret reveal.
  await page.keyboard.type('../');
  await page.waitForFunction(() => window.snippetProbe.state().visible);
  let state = await page.evaluate(() => window.snippetProbe.state());
  assert.equal(state.items.length, 7);
  assert.equal(state.focused, true);
  await page.waitForTimeout(400);
  assert.equal((await page.evaluate(() => window.snippetProbe.state())).visible, true);
  await page.evaluate(() => window.snippetProbe.programmaticScroll());
  await page.waitForTimeout(100);
  assert.equal((await page.evaluate(() => window.snippetProbe.state())).visible, true,
    'caret reveal must not dismiss completion');

  await page.evaluate(() => { window.snippetProbe.originalFirstOption = window.snippetProbe.firstOption(); });
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  state = await page.evaluate(() => window.snippetProbe.state());
  assert.equal(state.visible, true);
  assert.equal(state.index, 2);
  assert.equal(await page.evaluate(() => window.snippetProbe.firstOption() === window.snippetProbe.originalFirstOption), true,
    'arrow selection must retain the popup rows');

  await page.keyboard.press('Tab');
  state = await page.evaluate(() => window.snippetProbe.state());
  assert.equal(state.visible, false);
  assert.ok(state.text.includes('CS/'), `Tab did not accept the selected candidate: ${state.text}`);

  // While a new path request is pending, Tab applies the fresh result.
  await page.evaluate(() => window.snippetProbe.setText(''));
  await page.keyboard.type('../');
  await page.waitForFunction(() => window.snippetProbe.state().visible);
  await page.keyboard.type('A');
  await page.waitForFunction(() => window.snippetProbe.state().busy === 'true');
  assert.equal((await page.evaluate(() => window.snippetProbe.state())).visible, true);
  await page.keyboard.press('Tab');
  await page.waitForFunction(() => !window.snippetProbe.state().visible);
  state = await page.evaluate(() => window.snippetProbe.state());
  assert.ok(state.text.includes('AI/'), `Tab did not wait for the current path: ${state.text}`);

  // A caret reveal during the first async request must not cancel that request.
  await page.evaluate(() => window.snippetProbe.setText(''));
  await page.keyboard.type('../');
  await page.waitForFunction(() => window.snippetProbe.state().pending);
  await page.evaluate(() => window.snippetProbe.programmaticScroll());
  await page.waitForFunction(() => window.snippetProbe.state().visible);

  // A click on an existing prefix has no automatic completion session.
  await page.evaluate(() => window.snippetProbe.setText('../'));
  await page.locator('.cm-content').click();
  await page.waitForTimeout(400);
  assert.equal((await page.evaluate(() => window.snippetProbe.state())).visible, false,
    'moving the cursor with the mouse must not open completion');

  await page.evaluate(() => window.snippetProbe.setText(''));
  await page.keyboard.type('../');
  await page.waitForFunction(() => window.snippetProbe.state().visible);
  await page.evaluate(() => window.snippetProbe.userScroll());
  assert.equal((await page.evaluate(() => window.snippetProbe.state())).visible, false,
    'a real user scroll should dismiss completion');

  // The same CM6 input and completion path edits table cells. An IME session
  // closes an existing menu and cannot reopen it while candidates are active.
  const table = '|  | Value |\n| --- | --- |\n| item | value |';
  await page.evaluate((text) => {
    window.snippetProbe.setText(text);
    window.snippetProbe.setCursor(2);
  }, table);
  await page.keyboard.type(';');
  await page.waitForFunction(() => window.snippetProbe.state().visible);
  await page.locator('.cm-content').dispatchEvent('compositionstart', { data: '' });
  state = await page.evaluate(() => window.snippetProbe.state());
  assert.equal(state.visible, false, 'IME start must close the table completion menu');
  assert.equal(state.armed, false);
  await page.keyboard.insertText('中文');
  await page.waitForTimeout(50);
  state = await page.evaluate(() => window.snippetProbe.state());
  assert.equal(state.visible, false, 'composition text must not open completion');
  assert.equal(state.text.split('\n').length, 3, 'table typing must stay on its row');
  assert.match(state.text, /^\| ;中文 \| Value \|/, 'composition must stay inside the active cell');
  assert.equal(state.tableRows[0]?.cells, 2, 'composition must retain both table columns');
  assert.ok(state.tableRows[0]?.height < 90, 'composition must not expand the header row');
  await page.locator('.cm-content').dispatchEvent('compositionend', { data: '中文' });
  await page.waitForTimeout(120);
  state = await page.evaluate(() => window.snippetProbe.state());
  assert.equal(state.visible, false, 'candidate confirmation must not reopen completion');
  const bodyTable = '| Header | Value |\n| --- | --- |\n| item| value |';
  await page.evaluate((tableText) => {
    window.snippetProbe.setText(tableText);
    window.snippetProbe.setCursor(tableText.indexOf('| value |', 20));
  }, bodyTable);
  let geometry = await page.evaluate(() => window.snippetProbe.geometry());
  assert.equal(geometry.pipeInsideActive, true, 'the closing pipe belongs to the active cell DOM');
  assert.ok(geometry.cm.bottom - geometry.cm.top > 20 && geometry.native.height > 20,
    'the boundary caret needs a normal line box');
  assert.ok(Math.abs(geometry.context.left - geometry.native.left) < 12,
    'CM6 completion geometry must match the native caret at a cell boundary');
  await page.keyboard.type(';');
  await page.locator('.cm-content').dispatchEvent('compositionstart', { data: '' });
  await page.keyboard.insertText('中文');
  geometry = await page.evaluate(() => window.snippetProbe.geometry());
  state = await page.evaluate(() => window.snippetProbe.state());
  assert.match(state.text, /\| item;中文\| value \|/, 'composition must stay in the cell before its delimiter');
  assert.equal(geometry.pipeInsideActive, true);
  assert.ok(geometry.rowHeight < 90, 'composition at the cell boundary must not expand its row');
  assert.ok(Math.abs(geometry.context.left - geometry.native.left) < 12,
    'completion geometry must follow the composed caret');
  await page.locator('.cm-content').dispatchEvent('compositionend', { data: '中文' });
  await page.waitForTimeout(120);
  const completionTable = '| Header | Value |\n| --- | --- |\n| item | value |';
  await page.evaluate((tableText) => {
    window.snippetProbe.setText(tableText);
    window.snippetProbe.setCursor(tableText.lastIndexOf('| value |'));
  }, completionTable);
  await page.keyboard.type(';');
  await page.waitForFunction(() => window.snippetProbe.state().visible);
  geometry = await page.evaluate(() => window.snippetProbe.geometry());
  assert.ok(Math.abs(geometry.popup.left - geometry.native.left) < 12,
    'table completion must open at the cell caret, not the column boundary');
  console.log('Noema snippet popup: typing, stable arrows, Tab, pointer gating and table IME passed');
} finally {
  await browser.close();
  await server.close();
}
