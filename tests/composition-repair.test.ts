import { afterEach, describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor, type Editor } from "../src/editor-api.ts";
import { mismatchedDrawnLines, repairDrawnText } from "../src/cm6/composition-repair.ts";

const opened: Array<{ editor: Editor; host: HTMLElement }> = [];
afterEach(() => { for (const { editor, host } of opened.splice(0)) { editor.destroy(); host.remove(); } });

function open(text: string): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { initialContent: text });
  opened.push({ editor, host });
  editor.toggleSource();
  return editor;
}

/** Write the DOM the way a browser input method does, unseen by CodeMirror. */
function behindCodeMirror(editor: Editor, write: () => void): void {
  (editor.view as unknown as { observer: { ignore(f: () => void): void } }).observer.ignore(write);
}

function firstTextNode(editor: Editor, containing: string): Text {
  const walker = document.createTreeWalker(editor.view.contentDOM, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.nodeValue?.includes(containing)) return node as Text;
  }
  throw new Error(`no text node with ${containing}`);
}

describe("the drawn text always matches the document", () => {
  const source = "量子纠错协议\n\nSteane code protects one qubit.\n";

  test("an untouched page has no mismatched line", () => {
    const editor = open(source);
    expect(mismatchedDrawnLines(editor.view)).toEqual([]);
    expect(repairDrawnText(editor.view)).toBe(0);
  });

  test("a character an input method doubled behind CodeMirror's back is redrawn from the document", () => {
    const editor = open(source);
    const view = editor.view;
    view.dispatch({ selection: { anchor: 3 } });
    const node = firstTextNode(editor, "Steane");
    behindCodeMirror(editor, () => { node.nodeValue = `S${node.nodeValue}`; });
    expect(mismatchedDrawnLines(view)).toHaveLength(1);

    expect(repairDrawnText(view)).toBe(1);
    expect(mismatchedDrawnLines(view)).toEqual([]);
    expect(view.contentDOM.textContent).toContain("Steane code");
    expect(view.contentDOM.textContent).not.toContain("SSteane");
    expect(editor.getMarkdown()).toBe(source);
    expect(view.state.selection.main.head).toBe(3);
  });

  test("a line that still differs after one repair is left alone, never repaired in a loop", () => {
    const editor = open(source);
    const view = editor.view;
    const node = firstTextNode(editor, "量子");
    behindCodeMirror(editor, () => { node.nodeValue = `量${node.nodeValue}`; });
    expect(repairDrawnText(view)).toBe(1);
    const again = firstTextNode(editor, "量子");
    behindCodeMirror(editor, () => { again.nodeValue = `量${again.nodeValue}`; });
    expect(repairDrawnText(view)).toBe(0);
  });
});
