import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { EditorView } from "@codemirror/view";
import { createEditor, type Editor } from "../src/editor-api.ts";

const opened: Array<{ editor: Editor; host: HTMLElement }> = [];
afterEach(() => { for (const { editor, host } of opened.splice(0)) { editor.destroy(); host.remove(); } });

function open(text: string, at: number): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: text });
  opened.push({ editor, host });
  editor.view.dispatch({ selection: { anchor: at } });
  return editor;
}

/** A change read from the DOM, as CodeMirror hands it to input handlers. */
function domInput(editor: Editor, from: number, to: number, text: string): void {
  const view = editor.view;
  const handled = view.state.facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, () => view.state.update({ changes: { from, to, insert: text } })));
  if (!handled) view.dispatch({ changes: { from, to, insert: text }, userEvent: "input.type" });
}

describe("typed text never joins two lines", () => {
  const source = "#+begin proof\nasd\n#+end proof\n";
  const header = "#+begin proof".length;

  test("text the browser put over the header's line break goes to the caret", () => {
    const end = source.indexOf("asd") + 3;
    const editor = open(source, end);
    domInput(editor, header, header + 1, "s");
    expect(editor.getMarkdown()).toBe("#+begin proof\nasds\n#+end proof\n");
    expect(editor.view.state.selection.main.head).toBe(end + 1);
  });

  test("with the caret in the replaced range the break is kept and the text follows it", () => {
    const editor = open(source, header + 1);
    domInput(editor, header, header + 1, "是");
    expect(editor.getMarkdown()).toBe("#+begin proof\n是asd\n#+end proof\n");
  });

  test("a deletion (Backspace at a line start) and a typed newline are left alone", () => {
    const editor = open(source, header + 1);
    domInput(editor, header, header + 1, "");
    expect(editor.getMarkdown()).toBe("#+begin proofasd\n#+end proof\n");
  });

  test("replacing a selection that spans lines still replaces it", () => {
    const editor = open(source, 0);
    editor.view.dispatch({ selection: { anchor: header - 5, head: header + 2 } });
    domInput(editor, header - 5, header + 2, "x");
    expect(editor.getMarkdown()).toBe("#+begin xsd\n#+end proof\n");
  });
});
