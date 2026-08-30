/**
 * A Visual selection with an endpoint on a formula used to freeze the page.
 *
 * `onSelectionChange` fires whenever a transaction carries a selection —
 * CodeMirror's `selectionSet` does not compare it with the previous one. The
 * app adopts that selection into vim-lite in a microtask; vim-lite snaps the
 * endpoint to the whole formula and republishes it, which renders the formula's
 * end, which reads back as the formula's start, which is "wrong" again. The
 * cycle never reaches a fixed point and never leaves the microtask checkpoint,
 * so the WebKit/xwidget renderer spins at 100% CPU with no way back to the
 * event loop.
 *
 * The guard belongs in vim-lite: publishing a selection that is already live is
 * a no-op, scroll included.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";

// "Thus \(A_e\) is alternating." — the formula occupies [5, 12).
const TEXT = "Thus \\(A_e\\) is alternating. Equivalently, it corresponds.\n";
const LIMIT = 30;

/**
 * Drive the app's reconcile loop with its historical shape: the re-entrancy
 * flag is cleared before the sync, so vim-lite's own dispatch is free to queue
 * another pass. That is exactly what made the loop unbounded.
 */
async function adoptSelection(anchor: number, head: number): Promise<number> {
  const host = document.createElement("div");
  document.body.append(host);
  let reconcile: () => void = () => {};
  const editor = createEditor(host, {
    initialContent: TEXT,
    onSelectionChange: () => reconcile(),
  });
  const vim = createVimLite(editor, host, {});
  let pending = false;
  let passes = 0;
  reconcile = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (vim.mode() === "insert") return;
      if (vim.mode() === "visual-line" && !editor.view.state.selection.main.empty) return;
      if (++passes > LIMIT) return;
      vim.syncSelectionFromEditor();
    });
  };
  vim.setMode("visual");
  editor.setSelection(anchor, head);
  for (let i = 0; i < LIMIT * 8; i++) await Promise.resolve();
  vim.destroy();
  editor.destroy();
  host.remove();
  return passes;
}

describe("adopting a Visual selection that touches a formula", () => {
  test("a forward drag ending inside the formula settles", async () => {
    expect(await adoptSelection(0, 9)).toBeLessThan(LIMIT);
  });

  test("a forward drag ending at the formula's end settles", async () => {
    expect(await adoptSelection(0, 12)).toBeLessThan(LIMIT);
  });

  test("a backward drag anchored after the formula settles", async () => {
    expect(await adoptSelection(12, 3)).toBeLessThan(LIMIT);
  });

  test("a drag that never touches the formula still settles", async () => {
    expect(await adoptSelection(30, 5)).toBeLessThan(LIMIT);
  });
});

/**
 * The same hazard exists for every endpoint that vim-lite normalises, not just
 * the two hand-picked ones above, so sweep a document that carries each kind of
 * static object: inline math, display math, code, a table, a task and CJK.
 */
const RICH = [
  "# Def",
  "",
  "Throughout, we assume \\(H\\) has no isolated vertices, and \\(V = [n]\\).",
  "",
  "$$",
  "A_e(x_1, x_r) := \\det(u(x))",
  "$$",
  "",
  "- [ ] task with `code` and a [link](note.md)",
  "- 中文段落，包含 \\(r\\)-uniform 与标点。",
  "",
  "| a | b |",
  "| - | - |",
  "",
].join("\n");

async function adoptIn(text: string, mode: "visual" | "normal", anchor: number, head: number): Promise<number> {
  const host = document.createElement("div");
  document.body.append(host);
  let reconcile: () => void = () => {};
  const editor = createEditor(host, {
    initialContent: text,
    onSelectionChange: () => reconcile(),
  });
  const vim = createVimLite(editor, host, {});
  let pending = false;
  let passes = 0;
  reconcile = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      if (vim.mode() === "insert") return;
      if (vim.mode() === "visual-line" && !editor.view.state.selection.main.empty) return;
      if (++passes > LIMIT) return;
      vim.syncSelectionFromEditor();
    });
  };
  vim.setMode(mode);
  editor.setSelection(anchor, head);
  for (let i = 0; i < LIMIT * 8; i++) await Promise.resolve();
  vim.destroy();
  editor.destroy();
  host.remove();
  return passes;
}

describe("adopting selections across a document of static objects", () => {
  test("every endpoint settles", async () => {
    const stuck: string[] = [];
    for (let head = 0; head <= RICH.length; head += 3) {
      for (const [mode, anchor] of [
        ["visual", 0],
        ["visual", Math.min(RICH.length, head + 7)],
        ["normal", head],
      ] as const) {
        if (await adoptIn(RICH, mode, anchor, head) > LIMIT) stuck.push(`${mode} ${anchor}->${head}`);
      }
    }
    expect(stuck).toEqual([]);
  });
});
