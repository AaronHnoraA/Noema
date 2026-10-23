/**
 * Outside insert mode a key that comes from an input method is neither a
 * Vim command nor text.  With Pinyin on, pressing "j" reaches the page as a
 * keydown the input method has already taken; acting on it moved the cursor
 * while the input method also began composing "j".
 */

import { describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { inputMethodKey } from "../pages/vim-lite.ts";
import { handleXwidgetVimBeforeInput, handleXwidgetVimKeydown } from "../pages/xwidget-key-guard.ts";

async function setup(initial = "alpha\nbeta\ngamma") {
  const { createEditorCM6 } = await import("../src/cm6/editor-cm6.ts");
  const { createVimLite } = await import("../pages/vim-lite.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: initial });
  const reported: string[] = [];
  const vim = createVimLite(editor, host, { onUnhandledKey: (sequence) => reported.push(sequence) });
  vim.setMode("normal");
  const keydown = (init: KeyboardEventInit & { keyCode?: number }): { handled: boolean; prevented: boolean } => {
    const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    if (init.keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: init.keyCode });
    Object.defineProperty(event, "target", { value: editor.view.contentDOM });
    return { handled: vim.handleKeyDown(event), prevented: event.defaultPrevented };
  };
  const head = (): number => editor.view.state.selection.main.head;
  const dispose = (): void => { vim.destroy(); editor.destroy(); host.remove(); };
  return { editor, vim, reported, keydown, head, dispose };
}

describe("input method keys", () => {
  it("are recognised by composition, key code 229 or a character outside ASCII", () => {
    expect(inputMethodKey({ key: "j" })).toBe(false);
    expect(inputMethodKey({ key: "Escape" })).toBe(false);
    expect(inputMethodKey({ key: "ArrowDown" })).toBe(false);
    expect(inputMethodKey({ key: "j", keyCode: 229 })).toBe(true);
    expect(inputMethodKey({ key: "Process" })).toBe(true);
    expect(inputMethodKey({ key: "j", isComposing: true })).toBe(true);
    expect(inputMethodKey({ key: "，" })).toBe(true);
    expect(inputMethodKey({ key: "ｊ" })).toBe(true);
    expect(inputMethodKey({ key: "中" })).toBe(true);
    // A chord is a command whatever the layout produced for it.
    expect(inputMethodKey({ key: "∆", altKey: true })).toBe(false);
    expect(inputMethodKey({ key: "é", metaKey: true })).toBe(false);
  });

  it("do nothing in normal and visual mode, and are not reported as unknown commands", async () => {
    const ui = await setup();
    try {
      const start = ui.head();
      for (const init of [{ key: "j", keyCode: 229 }, { key: "Process" }, { key: "，" }, { key: "d", isComposing: true }]) {
        expect(ui.keydown(init)).toEqual({ handled: true, prevented: true });
      }
      expect(ui.head()).toBe(start);
      expect(ui.editor.getMarkdown()).toBe("alpha\nbeta\ngamma");
      expect(ui.reported).toEqual([]);

      // The same physical key with a Latin layout is the command it always was.
      expect(ui.keydown({ key: "j" }).handled).toBe(true);
      expect(ui.head()).not.toBe(start);

      ui.vim.setMode("visual");
      const selected = ui.editor.view.state.selection.main;
      expect(ui.keydown({ key: "l", keyCode: 229 })).toEqual({ handled: true, prevented: true });
      expect(ui.editor.view.state.selection.main.eq(selected)).toBe(true);
    } finally {
      ui.dispose();
    }
  });

  it("are left to the editor in insert mode, and Escape always works", async () => {
    const ui = await setup();
    try {
      ui.vim.setMode("insert");
      expect(ui.keydown({ key: "j", keyCode: 229 })).toEqual({ handled: false, prevented: false });
      expect(ui.keydown({ key: "中", isComposing: true }).handled).toBe(false);
      expect(ui.vim.mode()).toBe("insert");
      expect(ui.keydown({ key: "Escape" }).handled).toBe(true);
      expect(ui.vim.mode()).toBe("normal");
    } finally {
      ui.dispose();
    }
  });

  // The Emacs host routes keys through the xwidget guard, which runs before
  // `handleKeyDown` and used to execute the key the input method had taken.
  it("are swallowed on the xwidget path too, with the text the input method then writes", async () => {
    const ui = await setup();
    try {
      const context = { editor: ui.editor, editorHost: ui.editor.view.dom.parentElement!, vim: ui.vim };
      const start = ui.head();
      const down = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
      Object.defineProperty(down, "keyCode", { value: 229 });
      Object.defineProperty(down, "target", { value: ui.editor.view.contentDOM });
      expect(handleXwidgetVimKeydown(down, context)).toBe(true);
      expect(down.defaultPrevented).toBe(true);
      expect(ui.head()).toBe(start);

      // The letter it passes through right after is not read back as `j`.
      const letter = new InputEvent("beforeinput", { inputType: "insertText", data: "j", bubbles: true, cancelable: true });
      Object.defineProperty(letter, "target", { value: ui.editor.view.contentDOM });
      expect(handleXwidgetVimBeforeInput(letter, context)).toBe(true);
      expect(ui.head()).toBe(start);

      // Full-width punctuation is dropped without being reported as a key.
      const comma = new InputEvent("beforeinput", { inputType: "insertText", data: "，", bubbles: true, cancelable: true });
      Object.defineProperty(comma, "target", { value: ui.editor.view.contentDOM });
      expect(handleXwidgetVimBeforeInput(comma, context)).toBe(true);
      expect(ui.reported).toEqual([]);
      expect(ui.editor.getMarkdown()).toBe("alpha\nbeta\ngamma");
    } finally {
      ui.dispose();
    }
  });

  it("composition text never reaches the note outside insert mode", async () => {
    const ui = await setup();
    try {
      const view = ui.editor.view;
      view.dispatch({ changes: { from: 0, insert: "你" }, userEvent: "input.type.compose" });
      expect(ui.editor.getMarkdown()).toBe("alpha\nbeta\ngamma");
      ui.vim.setMode("insert");
      view.dispatch({ changes: { from: 0, insert: "你" }, userEvent: "input.type.compose" });
      expect(ui.editor.getMarkdown()).toBe("你alpha\nbeta\ngamma");
    } finally {
      ui.dispose();
    }
  });
});
