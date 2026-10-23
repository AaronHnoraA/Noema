/**
 * Noema's Vim layer against Neovim itself.
 *
 * `scripts/record-vim-parity.mjs` ran a table of Normal, Visual, Insert and
 * undo commands through Neovim from a set of carets and recorded the text and
 * caret each one left.  Every case marked as reproduced must stay reproduced:
 * this is what "behaves like Vim" means here, checked rather than recalled.
 *
 * Without layout a screen row is a source line, so the rows of this test are
 * Vim's lines.  The cases left unmarked are the deliberate differences listed
 * in that script.
 */

import { expect, it } from "@voidzero-dev/vite-plus-test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

type ParityCase = [caret: number, commands: string[][], text: number, line: number, column: number, reproduced: 0 | 1];
type Fixture = { nvim: string; columns: string[]; texts: string[]; cases: ParityCase[] };

const FIXTURE = join(process.cwd(), "tests", "fixtures", "vim-native-parity.json");
const RECORD = process.env.NOEMA_PARITY_RECORD === "1";

it("reproduces Neovim for every recorded command", async () => {
  const { createEditorCM6 } = await import("../src/cm6/editor-cm6.ts");
  const { createVimLite } = await import("../pages/vim-lite.ts");
  const fixture = JSON.parse(readFileSync(FIXTURE, "utf8")) as Fixture;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: "" });
  const view = editor.view;

  const run = (item: ParityCase): { text: string; line: number; column: number } => {
    editor.setMarkdown(fixture.texts[0]!, { history: "reset" });
    const vim = createVimLite(editor, host, { onUndo: () => editor.undo(), onRedo: () => editor.redo() });
    try {
      editor.setMarkdownSelection(item[0]);
      vim.setMode("normal");
      for (const key of item[1].flat()) {
        if (vim.handleKey(key === "C-r" ? { key: "r", ctrlKey: true } : { key })) continue;
        // Insert mode leaves typing to the editor.
        if (vim.mode() !== "insert") continue;
        const head = view.state.selection.main.head;
        if (key === "Backspace") {
          if (head > 0) view.dispatch({ changes: { from: head - 1, to: head }, userEvent: "delete.backward" });
        } else {
          view.dispatch({ ...view.state.replaceSelection(key === "Enter" ? "\n" : key), userEvent: "input.type" });
        }
      }
      // A command line that ends in Visual mode ends it, as `:normal` does.
      if (vim.mode() !== "normal") vim.handleKey({ key: "Escape" });
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      return { text: editor.getMarkdown(), line: line.number, column: [...line.text.slice(0, head - line.from)].length + 1 };
    } finally {
      vim.destroy();
    }
  };

  const failures: string[] = [];
  let reproduced = 0;
  for (const item of fixture.cases) {
    const got = run(item);
    const same = got.text === fixture.texts[item[2]] && got.line === item[3] && got.column === item[4];
    if (RECORD) {
      item[5] = same ? 1 : 0;
    } else if (item[5] === 1 && !same) {
      failures.push(`${item[1].map((segment) => segment.join("")).join(" ")} from offset ${item[0]}: `
        + `Vim ${item[3]}:${item[4]} ${JSON.stringify(fixture.texts[item[2]])}, `
        + `Noema ${got.line}:${got.column} ${JSON.stringify(got.text)}`);
    }
    if (same) reproduced++;
  }
  editor.destroy();
  host.remove();
  if (RECORD) {
    writeFileSync(FIXTURE, `${JSON.stringify(fixture)}\n`);
    console.log(`marked ${reproduced} of ${fixture.cases.length} cases as reproduced`);
  }
  expect(failures.slice(0, 20)).toEqual([]);
  // The set may grow; it must not quietly shrink to nothing.
  expect(reproduced / fixture.cases.length).toBeGreaterThan(0.9);
}, 120_000);
