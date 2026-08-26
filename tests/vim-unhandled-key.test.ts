/**
 * Normal/Visual mode must never swallow a key without a trace.
 *
 * `normalCommand`/`visualCommand`/`visualLineCommand` consume every printable
 * key so it cannot leak into the document or browser chrome. That is correct,
 * but it is otherwise indistinguishable from a dropped keystroke: an operator
 * aimed at a motion Vim-lite does not implement would move nothing and say
 * nothing. These tests pin the feedback channel that makes that visible.
 */

import { describe, expect, it } from "@voidzero-dev/vite-plus-test";

async function setup(initial = "alpha beta\ngamma") {
  const { createEditorCM6 } = await import("../src/cm6/editor-cm6.ts");
  const { createVimLite } = await import("../aaronnote/vim-lite.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: initial });
  const reported: string[] = [];
  const vim = createVimLite(editor, host, {
    onUnhandledKey: (sequence) => reported.push(sequence),
  });
  vim.setMode("normal");
  const press = (key: string): boolean => vim.handleKey({ key });
  const dispose = (): void => { vim.destroy(); editor.destroy(); host.remove(); };
  return { editor, vim, reported, press, dispose };
}

describe("a selection built outside Vim is adopted, not ignored", () => {
  it("enters Visual mode for a select-all made by CodeMirror", async () => {
    const { editor, vim, dispose } = await setup();
    // What Cmd-A leaves behind: Vim never saw the chord, so its modal state is
    // still a collapsed Normal-mode cursor until the selection is adopted.
    editor.setSelection(0, editor.getMarkdown().length);
    expect(vim.mode()).toBe("normal");
    vim.syncSelectionFromEditor();
    expect(vim.mode()).toBe("visual");
    dispose();
  });

  it("returns to Normal mode when the selection collapses again", async () => {
    const { editor, vim, dispose } = await setup();
    editor.setSelection(0, 5);
    vim.syncSelectionFromEditor();
    expect(vim.mode()).toBe("visual");
    editor.setSelection(3, 3);
    vim.syncSelectionFromEditor();
    expect(vim.mode()).toBe("normal");
    dispose();
  });
});

describe("unbound Normal-mode chords are reported", () => {
  it("drives a motion with a count prefix instead of reporting it", async () => {
    const { press, reported, editor, dispose } = await setup("a\nb\nc\nd\ne");
    editor.setSelection(0, 0);
    press("3");
    press("j");
    expect(reported).toEqual([]);
    expect(editor.getMarkdownSelectionRange().head).toBe(6);
    dispose();
  });

  it("still reports the unbound key a count was aimed at", async () => {
    const { press, reported, dispose } = await setup();
    press("3");
    press("q");
    expect(reported).toEqual(["q"]);
    dispose();
  });

  it("reports an operator abandoned by a motion it does not support", async () => {
    const { press, reported, editor, dispose } = await setup();
    const before = editor.getMarkdown();
    expect(press("d")).toBe(true);
    expect(press("q")).toBe(true);
    expect(reported).toEqual(["dq"]);
    expect(editor.getMarkdown()).toBe(before);
    dispose();
  });

  it("stays silent for an operator with a motion it does support", async () => {
    const { press, reported, editor, dispose } = await setup();
    press("d");
    press("w");
    expect(reported).toEqual([]);
    expect(editor.getMarkdown()).toBe("beta\ngamma");
    dispose();
  });

  it("reports unbound single keys such as q and m", async () => {
    const { press, reported, dispose } = await setup();
    press("q");
    press("m");
    expect(reported).toEqual(["q", "m"]);
    dispose();
  });

  it("stays silent for chords that are bound", async () => {
    const { press, reported, dispose } = await setup();
    press("j");
    press("k");
    press("w");
    press("b");
    press("0");
    press("$");
    press("g");
    press("g");
    press(">");
    press(">");
    press("e");
    press("^");
    press("}");
    press("{");
    expect(reported).toEqual([]);
    dispose();
  });

  it("stays silent when dd actually deletes a line", async () => {
    const { press, reported, editor, dispose } = await setup();
    press("d");
    press("d");
    expect(reported).toEqual([]);
    expect(editor.getMarkdown()).toBe("gamma");
    dispose();
  });

  it("does not consume non-printable keys it has no binding for", async () => {
    const { vim, reported, dispose } = await setup();
    expect(vim.handleKey({ key: "F5" })).toBe(false);
    expect(reported).toEqual([]);
    dispose();
  });
});
