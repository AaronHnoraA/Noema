/**
 * One "word", one "line".
 *
 * Word: Vim's `w`/`b`, `Mod-d`'s occurrence selection and CodeMirror's own
 * double-click each used to carry their own character class, so `foo-bar`
 * selected differently depending on how you asked. They now share
 * `isWordChar` in src/cm6/text-boundaries.ts.
 *
 * Line: `j`/`k` move by wrapped row and Insert-mode Home/End use CodeMirror's
 * visual line boundaries, but `0`/`$` resolved against the source line — so in
 * a wrapped paragraph `$` jumped to the end of the whole paragraph while `j`
 * stepped one row. `0`/`$` now use the visual row too.
 */

import { EditorSelection } from "@codemirror/state";
import { describe, expect, it } from "@voidzero-dev/vite-plus-test";

import { isWordChar } from "../../src/cm6/text-boundaries.ts";

describe("isWordChar is the single word definition", () => {
  it("treats a hyphen as a separator, like Vim and CodeMirror's categorizer", () => {
    expect(isWordChar("-")).toBe(false);
    expect(isWordChar("_")).toBe(true);
    expect(isWordChar("a")).toBe(true);
    expect(isWordChar("7")).toBe(true);
    expect(isWordChar("中")).toBe(true);
    expect(isWordChar(" ")).toBe(false);
    expect(isWordChar(".")).toBe(false);
  });
});

describe("Mod-d occurrence selection agrees with Vim's w/b", () => {
  async function selectOccurrence(text: string, at: number): Promise<string> {
    const { createEditorCM6, selectNextMarkdownOccurrence } =
      await import("../../src/cm6/editor-cm6.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditorCM6(host, { initialContent: text });
    editor.setSelection(at, at);
    selectNextMarkdownOccurrence(editor.view);
    const { from, to } = editor.getMarkdownSelection();
    const selected = editor.getMarkdown().slice(from, to);
    editor.destroy();
    host.remove();
    return selected;
  }

  it("selects only the sub-word before a hyphen", async () => {
    expect(await selectOccurrence("foo-bar foo-bar", 1)).toBe("foo");
  });

  it("still selects a whole underscore identifier", async () => {
    // A second occurrence is required: the command selects the word at the
    // caret only as a side effect of having somewhere else to jump to.
    expect(await selectOccurrence("foo_bar foo_bar", 1)).toBe("foo_bar");
  });

  it("matches what Vim's w motion treats as one word", async () => {
    const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
    const { createVimLite } = await import("../../aaronnote/vim-lite.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditorCM6(host, { initialContent: "foo-bar baz" });
    const vim = createVimLite(editor, host);
    vim.setMode("normal");
    editor.setSelection(0, 0);
    vim.handleKey({ key: "w" });
    // `w` stops at the hyphen, so the occurrence selection must stop there too.
    expect(editor.getMarkdownSelection().from).toBe(3);
    vim.destroy();
    editor.destroy();
    host.remove();
  });
});

describe("Mod-d selects the word under the caret before hunting for matches", () => {
  async function mount(text: string, at: number) {
    const { createEditorCM6, selectNextMarkdownOccurrence } =
      await import("../../src/cm6/editor-cm6.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditorCM6(host, { initialContent: text });
    editor.setSelection(at, at);
    const press = (): boolean => selectNextMarkdownOccurrence(editor.view);
    const selected = (): string[] => editor.view.state.selection.ranges.map((range) => (
      editor.view.state.doc.sliceString(range.from, range.to)
    ));
    return { editor, press, selected, cleanup: () => { editor.destroy(); host.remove(); } };
  }

  it("selects a word that occurs only once", async () => {
    // The whole point of F8: this used to select nothing at all, because the
    // command only ever selected the caret's word as a side effect of finding
    // a second match.
    const { press, selected, cleanup } = await mount("solitary word here", 3);
    expect(press()).toBe(true);
    expect(selected()).toEqual(["solitary"]);
    cleanup();
  });

  it("adds the next occurrence on the second press, not the first", async () => {
    const { press, selected, cleanup } = await mount("alpha beta alpha", 2);
    expect(press()).toBe(true);
    expect(selected()).toEqual(["alpha"]);
    expect(press()).toBe(true);
    expect(selected()).toEqual(["alpha", "alpha"]);
    cleanup();
  });

  it("reports no-op once every occurrence is already selected", async () => {
    const { press, selected, cleanup } = await mount("solitary word here", 3);
    expect(press()).toBe(true);
    expect(press()).toBe(false);
    expect(selected()).toEqual(["solitary"]);
    cleanup();
  });

  it("wraps around to an earlier occurrence", async () => {
    const { press, selected, cleanup } = await mount("alpha beta alpha", 12);
    expect(press()).toBe(true);
    expect(selected()).toEqual(["alpha"]);
    expect(press()).toBe(true);
    expect(selected()).toEqual(["alpha", "alpha"]);
    cleanup();
  });

  it("does nothing when the caret is not in a word", async () => {
    const { press, cleanup } = await mount("alpha   beta", 6);
    expect(press()).toBe(false);
    cleanup();
  });
});

describe("Vim 0/$ resolve against the visual row", () => {
  async function setup(text: string) {
    const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
    const { createVimLite } = await import("../../aaronnote/vim-lite.ts");
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditorCM6(host, { initialContent: text });
    const vim = createVimLite(editor, host);
    vim.setMode("normal");
    return { editor, vim, host };
  }

  it("asks CodeMirror for the wrapped-row boundary when layout is available", async () => {
    const { editor, vim, host } = await setup("aaaa bbbb cccc dddd");
    // happy-dom reports a zero-size box, so stand in for a laid-out editor and
    // pretend the row wraps after "aaaa bbbb".
    Object.defineProperty(editor.view.contentDOM, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ width: 400, height: 200, left: 0, top: 0, right: 400, bottom: 200 }),
    });
    const asked: Array<{ pos: number; forward: boolean }> = [];
    Object.defineProperty(editor.view, "moveToLineBoundary", {
      configurable: true,
      value: (range: { head: number }, forward: boolean) => {
        asked.push({ pos: range.head, forward });
        return EditorSelection.cursor(forward ? 9 : 0);
      },
    });

    editor.setSelection(6, 6);
    vim.handleKey({ key: "$" });
    expect(asked).toEqual([{ pos: 6, forward: true }]);
    expect(editor.getMarkdownSelection().from).toBe(9);

    asked.length = 0;
    vim.handleKey({ key: "0" });
    expect(asked).toEqual([{ pos: 9, forward: false }]);
    expect(editor.getMarkdownSelection().from).toBe(0);

    vim.destroy();
    editor.destroy();
    host.remove();
  });

  it("falls back to the source line when the editor has no layout", async () => {
    const { editor, vim, host } = await setup("alpha beta\ngamma");
    // No stub: happy-dom has no layout engine, which is the fallback path.
    editor.setSelection(3, 3);
    vim.handleKey({ key: "$" });
    expect(editor.getMarkdownSelection().from).toBe(9);
    vim.handleKey({ key: "0" });
    expect(editor.getMarkdownSelection().from).toBe(0);
    vim.destroy();
    editor.destroy();
    host.remove();
  });
});
