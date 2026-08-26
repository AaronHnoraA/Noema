/**
 * Linewise `p`/`P`, and the `s`/`S` character jump that replaces Vim's
 * substitute in this editor.
 *
 * Paste is asynchronous — the register is mirrored to the system clipboard and
 * read back — so every case here has to settle before asserting.
 *
 * The bug these pin: appending a linewise register past the last line kept the
 * register's own trailing newline *and* added a leading separator, so `yy p` on
 * the final line of a file left a stray blank line at the end. In a git-backed
 * vault that gets saved and shows up in the diff.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));

async function press(text: string, at: number, keys: string[], jumpTimeoutMs = 20) {
  delete (window as unknown as Record<string, unknown>).__aaronoteVimRegister;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const vim = createVimLite(editor, host, { jumpTimeoutMs });
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  for (const key of keys) {
    vim.handleKey({ key });
    await settle();
  }
  await settle(jumpTimeoutMs + 60);
  const result = {
    markdown: editor.getMarkdown(),
    head: editor.getMarkdownSelectionRange().head,
    mode: vim.mode(),
  };
  vim.destroy();
  editor.destroy();
  host.remove();
  return result;
}

describe("linewise paste does not grow a trailing blank line", () => {
  test("yy then p on the last line", { timeout: 20_000 }, async () => {
    const r = await press("aaa\nbbb", 4, ["y", "y", "p"]);
    expect(r.markdown).toBe("aaa\nbbb\nbbb");
  });

  test("yy then p in a one-line document", { timeout: 20_000 }, async () => {
    const r = await press("aaa", 0, ["y", "y", "p"]);
    expect(r.markdown).toBe("aaa\naaa");
  });

  test("dd then p restores the line without adding one", { timeout: 20_000 }, async () => {
    const r = await press("aaa\nbbb", 0, ["d", "d", "p"]);
    expect(r.markdown).toBe("bbb\naaa");
  });

  test("a document that already ends in a newline keeps exactly that", { timeout: 20_000 }, async () => {
    const r = await press("aaa\nbbb\n", 0, ["y", "y", "p"]);
    expect(r.markdown).toBe("aaa\naaa\nbbb\n");
  });
});

describe("linewise paste puts the lines where Vim does", () => {
  test("p inserts below the current line", { timeout: 20_000 }, async () => {
    const r = await press("aaa\nbbb\nccc", 0, ["y", "y", "j", "p"]);
    expect(r.markdown).toBe("aaa\nbbb\naaa\nccc");
  });

  test("P inserts above it", { timeout: 20_000 }, async () => {
    const r = await press("aaa\nbbb", 0, ["y", "y", "P"]);
    expect(r.markdown).toBe("aaa\naaa\nbbb");
  });

  test("a counted yank pastes every line it took", { timeout: 20_000 }, async () => {
    const r = await press("a\nb\nc", 0, ["2", "y", "y", "p"]);
    expect(r.markdown).toBe("a\na\nb\nb\nc");
  });

  test("the caret lands on the first pasted line", { timeout: 20_000 }, async () => {
    const r = await press("aaa\nbbb", 0, ["y", "y", "p"]);
    expect(r.head).toBe(4);
  });
});

describe("charwise paste stays on the line", () => {
  test("yw then p inserts after the caret's character", { timeout: 20_000 }, async () => {
    const r = await press("one two", 0, ["y", "w", "p"]);
    expect(r.markdown).toBe("oone ne two");
  });

  test("a Visual yank pastes back charwise", { timeout: 20_000 }, async () => {
    const r = await press("abcdef", 0, ["v", "l", "y", "p"]);
    expect(r.markdown).toBe("aabbcdef");
  });
});

describe("s and S jump to a character", () => {
  test("a single match is taken immediately", { timeout: 20_000 }, async () => {
    const r = await press("alpha beta gamma", 0, ["s", "g"]);
    expect(r.head).toBe(11);
    expect(r.markdown).toBe("alpha beta gamma");
  });

  test("S searches backwards", { timeout: 20_000 }, async () => {
    const r = await press("gamma alpha beta", 14, ["S", "g"]);
    expect(r.head).toBe(0);
  });

  test("no match leaves the caret alone", { timeout: 20_000 }, async () => {
    const r = await press("alpha beta", 0, ["s", "z"]);
    expect(r.head).toBe(0);
  });

  test("Escape abandons the jump", { timeout: 20_000 }, async () => {
    const r = await press("alpha beta", 0, ["s", "Escape"]);
    expect(r.head).toBe(0);
    expect(r.mode).toBe("normal");
  });

  test("several matches wait for a label instead of guessing", { timeout: 20_000 }, async () => {
    const r = await press("aa bb aa", 0, ["s", "a"]);
    expect(r.head).toBe(0);
    expect(r.mode).toBe("normal");
  });
});
