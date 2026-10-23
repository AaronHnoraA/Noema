// Record what Neovim does for a table of Normal/Visual commands, as the
// expectations of tests/vim-native-parity.test.ts.
//
//   node scripts/record-vim-parity.mjs            # needs `nvim` on PATH
//   NOEMA_PARITY_RECORD=1 npx vp test --run tests/vim-native-parity.test.ts
//
// The first step writes Neovim's result for every case; the second marks the
// cases Noema reproduces.  The test then holds Noema to exactly those, so a
// case can only leave the set on purpose.  What stays outside is deliberate
// (Markdown indentation on `o`/`cc`, the Visual `w` convention of ../../docs/noema/guide/vim.md,
// Evil's Visual `I`) or Neovim-specific (bracket objects searching forward).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE = fileURLToPath(new URL('../tests/fixtures/vim-native-parity.json', import.meta.url));

// One text with indentation, an empty line, brackets and a one-character last
// line; a few carets on each line.  The audit that produced the fixes ran the
// same commands at every caret of four texts.
const TEXT = 'foo bar baz\n  indented line here\n\nlast (paren text) end\nx';
const CARETS = [[1, 1], [1, 5], [1, 9], [1, 11], [2, 1], [2, 3], [2, 12], [2, 20], [3, 1], [4, 1], [4, 6], [4, 11], [4, 21], [5, 1]];

const K = (s) => [...s];
const E = 'Escape';
// A string is typed key by key; an array names keys such as Escape.
const COMMANDS = [
  // motions
  'h', 'l', 'j', 'k', 'w', 'b', 'e', 'W', 'B', 'E', 'ge', 'gE', '0', '^', '$', 'gg', 'G', '3G', '2gg',
  '2j', '2k', '3l', '3h', '2w', '3b', '2e', '2W', '2B', '2E', '{', '}', '2}', '%', '_', '+', '-', '2+', '2-',
  'fa', 'Fa', 'ta', 'Ta', 'fe', 'te', '2fe', 'fe;', 'fe,', 'te;', 'Te;', 'fo;;', 'Fe,', '$j', '$jj', '$k',
  'jj', 'kk', 'jk', 'lj', 'lljj', '*', '#', '**', '*n', '*N', 'g_',
  // deletes
  'x', 'X', '3x', '2X', 'D', '2D', 'dd', '2dd', 'd2d', '3dd', 'dw', 'd2w', '2dw', 'de', 'db', 'dW', 'dE', 'dB', 'dge',
  'd$', 'd0', 'd^', 'dj', 'dk', 'd2j', 'dG', 'dgg', 'd}', 'd{', 'dh', 'dl', 'd3l', 'd%', 'dfe', 'dte', 'dFe', 'dTe',
  'dfe;', 'dfe.', 'diw', 'daw', 'diW', 'daW', 'd2iw', 'd2aw', 'di(', 'da(', 'dib', 'di[', 'da[', 'di{', 'da{', 'di"', 'da"',
  'dip', 'dap', 'd_', 'd+', 'd-', 'dw.', 'dw..', 'x.', 'x..', 'dd.', 'dj.', 'd*',
  // misc edits
  'J', '3J', 'gJ', 'JJ', '~', '3~', 'rZ', '3rZ', 'g~w', 'guw', 'gUw', 'g~~', 'guu', 'gUU', 'gUiw', 'g~$', 'gUe', 'gUj',
  // yank (cursor only)
  'yy', 'yw', 'y$', 'yiw', 'yj', 'yk', 'yb', 'y0', 'yap', 'Y',
  // undo
];
const S = (...segments) => ({ segs: segments.map((seg) => (typeof seg === 'string' ? K(seg) : seg)) });
const UNDO = [
  S('x', 'u'), S('dd', 'u'), S('dw', 'u'), S('x', 'x', 'u', 'u'), S('x', 'x', 'u'), S('x', 'u', ['C-r']), S('dd', 'u', ['C-r']),
  S('x', 'x', 'u', 'u', ['C-r']), S('x', '3x', 'u'), S('J', 'u'), S('x', 'x', 'x', '2u'), S('x', 'x', 'u', 'u', ['C-r'], ['C-r']),
  S(['c', 'w', ...K('XY'), E], 'u'), S(['i', ...K('XY Z'), E], 'u'), S(['o', ...K('XY'), E], 'u'), S(['c', 'c', ...K('X Y'), E], 'u'),
  S(['c', 'w', ...K('XY'), E], 'u', ['C-r']), S(['A', ...K('XY'), E], 'u'), S('x', ['i', 'Q', E], 'u'), S('x', ['i', 'Q', E], 'u', 'u'),
  S(['v', 'e', 'c', ...K('XY'), E], 'u'), S('vld', 'u'), S(['3', 'i', 'X', E], 'u'), S(['o', ...K('a b c'), E], 'u', ['C-r']),
  S('dd', 'dd', 'u'), S('guu', 'u'), S('~', 'u'), S('rZ', 'u'), S('D', 'u'), S(['c', 'w', ...K('XY'), E], 'w', '.', 'u'), S('x', '.', '.', 'u', 'u'),
  S(['V', 'c', ...K('XY'), E], 'u'), S(['v', 'j', 'd'], 'u'), S(['V', 'j', 'd'], 'u', ['C-r']), S(['d', 'i', 'w'], 'u'), S('dj', 'u'), S(['I', 'Q', E], 'u'),
];
const INSERTS = [
  ['i', ...K('XY'), E], ['a', ...K('XY'), E], ['I', ...K('XY'), E], ['A', ...K('XY'), E],
  ['o', ...K('XY'), E], ['O', ...K('XY'), E], ['3', 'i', 'X', E], ['2', 'a', ...K('ab'), E], ['i', E], ['a', E], ['A', E], ['I', E],
  ['c', 'w', ...K('XY'), E], ['c', 'e', ...K('XY'), E], ['c', 'c', ...K('XY'), E], ['C', ...K('XY'), E], ['c', '$', ...K('XY'), E],
  ['c', 'i', 'w', ...K('XY'), E], ['c', 'a', 'w', ...K('XY'), E], ['c', 'b', ...K('XY'), E], ['c', 'W', ...K('XY'), E],
  ['c', '2', 'w', ...K('XY'), E], ['c', 'i', '(', ...K('XY'), E], ['c', 'j', ...K('XY'), E], ['c', 'f', 'e', ...K('XY'), E],
  ['c', 'w', ...K('XY'), E, 'w', '.'], ['i', ...K('XY'), E, 'j', '.'], ['A', '!', E, 'j', '.'], ['o', 'X', E, '.'],

  ['i', 'X', 'Backspace', E], ['a', ...K('X\nY'.replace('\n', '')), E], ['c', 'w', E], ['c', 'c', E], ['i', ...K('XY'), E, '.'],
  ['3', 'x', 'j', '.'], ['d', '2', 'w', 'j', '.'], ['d', 'w', '2', '.'],
];
const VISUAL = [
  'vd', 'vld', 'vlld', 'vhd', 'vjd', 'vkd', 'vwd', 'ved', 'vbd', 'v$d', 'v0d', 'v^d', 'viwd', 'vawd', 'vi(d', 'va(d', 'vipd', 'vapd',
  'vjjd', 'vGd', 'vggd', 'v}d', 'vfed', 'vted', 'v%d', 'vlod', 'vlohd', 'vx', 'vly', 'vey', 'vjy', 'vby', 'v~', 'vl~', 'veU', 'veu', 'vjJ', 'vrZ', 'verZ',
  'Vd', 'Vjd', 'Vkd', 'V2jd', 'VGd', 'Vggd', 'Vy', 'Vjy', 'Vky', 'V~', 'VU', 'Vu', 'VJ', 'VjJ', 'VrZ', 'Vx', 'vVd', 'Vvd', 'vjVd', 'vlD', 'vlX', 'vjD',
  ['v', E], ['v', 'l', E], ['v', 'j', E], ['v', 'h', E], ['V', E], ['V', 'j', E], ['V', 'k', E], ['v', 'e', E], ['v', 'b', E], ['v', '$', E], ['v', 'i', 'w', E],
  ['v', 'e', 'c', ...K('XY'), E], ['V', 'c', ...K('XY'), E], ['v', 'j', 'c', ...K('XY'), E],
  ['v', 'e', E, 'g', 'v', 'd'], ['V', 'j', E, 'g', 'v', 'd'], ['v', 'l', 'I', 'X', E], ['v', 'l', 'A', 'X', E], ['v', 'i', 'w', 'i', 'w', 'd'], ['v', 'a', 'w', 'a', 'w', 'd'],
  ['v', '$', 'j', 'd'], ['v', 'w', E], ['v', 'w', 'w', E], ['v', 'e', 'e', 'd'], ['v', 'l', 'o', E], ['v', 'j', 'o', 'k', 'd'],
];

const lineStarts = [];
TEXT.split('\n').reduce((offset, line) => { lineStarts.push(offset); return offset + line.length + 1; }, 0);
const cases = [];
for (const [line, col] of CARETS) {
  for (const command of [...COMMANDS, ...INSERTS, ...VISUAL, ...UNDO]) {
    const segs = command.segs ?? [typeof command === 'string' ? K(command) : command];
    cases.push({ pos: lineStarts[line - 1] + col - 1, line, col, segs });
  }
}

// Each segment is one typed command and so one undo block; `normal!` keeps
// user mappings out, and the caret is set together with its wanted column.
const DRIVER = String.raw`
set nocompatible nojoinspaces selection=inclusive startofline whichwrap= noautoindent nosmartindent nrformats= encoding=utf-8 nomore shortmess+=IatT report=9999 belloff=all
let s:input = json_decode(join(readfile('cases.json'), "\n"))
let s:special = {'Escape': "\<Esc>", 'Enter': "\<CR>", 'C-r': "\<C-r>", 'Backspace': "\<BS>"}
let s:out = []
for s:c in s:input.cases
  silent! enew!
  setlocal noswapfile undolevels=1000
  let s:ul = &l:undolevels | setlocal undolevels=-1
  call setline(1, split(s:input.text, "\n", 1))
  let &l:undolevels = s:ul
  call setcharpos('.', [0, s:c.line, s:c.col, 0, s:c.col])
  for s:seg in s:c.segs
    let s:keys = join(map(copy(s:seg), {_, k -> get(s:special, k, k)}), '')
    silent! execute "normal! " . s:keys
    let &l:undolevels = &l:undolevels
  endfor
  call add(s:out, [join(getline(1, '$'), "\n"), line('.'), charcol('.')])
endfor
call writefile([json_encode(s:out)], 'expected.json')
qa!
`;

const work = mkdtempSync(join(tmpdir(), 'noema-vim-parity-'));
try {
  writeFileSync(join(work, 'cases.json'), JSON.stringify({ text: TEXT, cases }));
  writeFileSync(join(work, 'driver.vim'), DRIVER);
  execFileSync('nvim', ['--headless', '-u', 'NONE', '-i', 'NONE', '-n', '-S', 'driver.vim'], { cwd: work, stdio: 'ignore' });
  const expected = JSON.parse(readFileSync(join(work, 'expected.json'), 'utf8'));
  // Resulting texts repeat heavily; store each once.
  const texts = [TEXT];
  const index = new Map([[TEXT, 0]]);
  const rows = cases.map((item, at) => {
    const [text, line, col] = expected[at];
    if (!index.has(text)) { index.set(text, texts.length); texts.push(text); }
    return [item.pos, item.segs, index.get(text), line, col, 0];
  });
  writeFileSync(FIXTURE, `${JSON.stringify({
    nvim: execFileSync('nvim', ['--version'], { encoding: 'utf8' }).split('\n')[0],
    columns: ['caret', 'commands', 'text', 'line', 'column', 'reproduced'],
    texts,
    cases: rows,
  })}\n`);
  console.log(`recorded ${rows.length} cases; now run the test with NOEMA_PARITY_RECORD=1`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
