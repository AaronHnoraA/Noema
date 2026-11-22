import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorView } from "@codemirror/view";
import { ensureSyntaxTree } from "@codemirror/language";
import { createEditor, type Editor } from "../src/editor-api.ts";

const opened: Array<{ editor: Editor; host: HTMLElement }> = [];
afterEach(() => { for (const { editor, host } of opened.splice(0)) { editor.destroy(); host.remove(); } });

/** Type one character at the caret the way the browser's input reaches CM6. */
function type(editor: Editor, text: string): void {
  const view = editor.view;
  const { from, to } = view.state.selection.main;
  const handled = view.state.facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })));
  if (!handled) view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.type" });
}

function open(text: string, at = text.length): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: text });
  opened.push({ editor, host });
  ensureSyntaxTree(editor.view.state, editor.view.state.doc.length, 1000);
  editor.view.dispatch({ selection: { anchor: at } });
  return editor;
}

describe("a space after full-width punctuation", () => {
  test("is swallowed in prose after each kind of full-width mark", () => {
    for (const mark of ["，", "。", "！", "？", "；", "：", "、", "）", "」"]) {
      const editor = open(`量子${mark}`);
      type(editor, " ");
      type(editor, "比");
      expect(editor.getMarkdown()).toBe(`量子${mark}比`);
    }
  });

  test("is kept after ASCII punctuation and in code", () => {
    const ascii = open("Hello,");
    type(ascii, " ");
    expect(ascii.getMarkdown()).toBe("Hello, ");
    const code = open("`量子，`", "`量子，".length);
    type(code, " ");
    expect(code.getMarkdown()).toBe("`量子， `");
  });
});
