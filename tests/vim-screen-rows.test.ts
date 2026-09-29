/** Screen-row behavior with deterministic soft wrapping (the test DOM has no layout). */
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/editor-api.ts";
import { createVimLite } from "../aaronnote/vim-lite.ts";
import { fixedWidthRowLayout, setVimRowLayoutForTesting } from "../aaronnote/vim-rows.ts";

function mount(text: string, at: number, width = 4) {
  const restore = setVimRowLayoutForTesting(fixedWidthRowLayout(width));
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: text });
  const unhandled: string[] = [];
  const vim = createVimLite(editor, host, { onUnhandledKey: (key) => unhandled.push(key) });
  vim.setMode("normal");
  editor.setSelection(at, at);
  vim.syncSelectionFromEditor();
  return {
    vim,
    unhandled,
    keys: (...keys: string[]) => { for (const key of keys) vim.handleKey({ key }); },
    head: () => editor.getMarkdownSelectionRange().head,
    picked: () => {
      const { from, to } = editor.getMarkdownSelection();
      return editor.getMarkdown().slice(from, to);
    },
    markdown: () => editor.getMarkdown(),
    register: () => (window as unknown as { __aaronoteVimRegister?: { text: string; kind: string } })
      .__aaronoteVimRegister,
    done: () => { vim.destroy(); editor.destroy(); host.remove(); restore(); },
  };
}

describe("Evil visual-line-mode row mappings", () => {
  test("j and k use wrapped rows and keep the screen column", () => {
    const s = mount("abcdefghij\nxyz", 1);
    s.keys("j");
    expect(s.head()).toBe(5);
    s.keys("j");
    expect(s.head()).toBe(9);
    s.keys("j");
    expect(s.head()).toBe(12);
    s.keys("k", "k");
    expect(s.head()).toBe(5);
    s.done();
  });

  test("gj and gk use source lines", () => {
    const s = mount("abcdefghij\nxyz", 1);
    s.keys("g", "j");
    expect(s.head()).toBe(12);
    s.keys("g", "k");
    expect(s.head()).toBe(1);
    s.done();
  });

  test("0 and $ use the screen row; g0 and g$ use the source line", () => {
    const s = mount("abcdefghij\nxyz", 5);
    s.keys("0");
    expect(s.head()).toBe(4);
    s.keys("$");
    expect(s.head()).toBe(7);
    s.keys("g", "0");
    expect(s.head()).toBe(0);
    s.keys("g", "$");
    expect(s.head()).toBe(9);
    s.done();
  });

  test("^ uses the source line while g^ uses the wrapped screen row", () => {
    const s = mount("  abcdefghij", 7, 5);
    s.keys("^");
    expect(s.head()).toBe(2);
    s.keys("l", "l", "l", "l", "l");
    expect(s.head()).toBe(7);
    s.keys("g", "^");
    expect(s.head()).toBe(5);
    s.done();
  });

  test("dd removes only the current wrapped row", () => {
    const s = mount("abcdefghij\nxyz", 5);
    s.keys("d", "d");
    expect(s.markdown()).toBe("abcdij\nxyz");
    expect(s.register()).toEqual(expect.objectContaining({ text: "efgh\n", kind: "linewise" }));
    s.done();
  });

  test("Y yanks the whole wrapped row and keeps the caret", () => {
    const s = mount("abcdefghij\nxyz", 5);
    s.keys("Y");
    expect(s.markdown()).toBe("abcdefghij\nxyz");
    expect(s.head()).toBe(5);
    expect(s.register()).toEqual(expect.objectContaining({ text: "efgh\n", kind: "linewise" }));
    s.done();
  });

  test("dj spans two wrapped rows", () => {
    const s = mount("abcdefghij\nxyz", 1);
    s.keys("d", "j");
    expect(s.markdown()).toBe("ij\nxyz");
    s.done();
  });

  test("V selects wrapped rows, including the newline on the final row", () => {
    const s = mount("abcdefghij\nxyz", 5);
    s.keys("V");
    expect(s.picked()).toBe("efgh");
    s.keys("j");
    expect(s.picked()).toBe("efghij\n");
    s.done();
  });

  test("f cannot search beyond the current wrapped row", () => {
    const s = mount("abcdefghij", 1);
    s.keys("f", "e");
    expect(s.head()).toBe(1);
    expect(s.unhandled).toContain("fe");
    s.keys("j", "f", "g");
    expect(s.head()).toBe(6);
    s.done();
  });
});
