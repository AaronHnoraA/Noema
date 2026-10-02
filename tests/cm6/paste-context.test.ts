/**
 * Paste adapts to its destination (MarkText `clipboard/paste.ts` rules) and
 * pasted HTML tables always become GFM tables (MarkText
 * `utils/paste.ts#normalizePastedHTML`).
 */

import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { EditorSelection } from "@codemirror/state";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { htmlToMarkdown } from "../../src/paste-html.ts";
import type { Editor } from "../../src/editor-api.ts";

const editors: Editor[] = [];

function open(doc: string, from = 0, to = from): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: doc });
  editor.setSelection(from, to);
  editors.push(editor);
  return editor;
}

function clipboard(parts: { plain?: string; html?: string }): DataTransfer {
  return {
    files: [] as unknown as FileList,
    items: [] as unknown as DataTransferItemList,
    getData: (type: string) => type === "text/plain" ? parts.plain ?? "" : type === "text/html" ? parts.html ?? "" : "",
  } as unknown as DataTransfer;
}

afterEach(() => {
  while (editors.length) editors.pop()!.destroy();
});

describe("paste destination rules", () => {
  it("pastes the plain text, not converted HTML, inside a fenced code block", async () => {
    const ed = open("```js\n\n```", 6);
    await ed.pasteFromDataTransfer(clipboard({
      plain: "const a = b * c;",
      html: "<pre><span>const</span> a = b <em>*</em> c;</pre>",
    }));
    expect(ed.getMarkdown()).toBe("```js\nconst a = b * c;\n```");
  });

  it("keeps a table row on one line", () => {
    const ed = open("| a | b |\n| - | - |\n| 1 |  |", 26);
    ed.pastePlainText("first\nsecond | third");
    expect(ed.getMarkdown()).toBe("| a | b |\n| - | - |\n| 1 | first<br>second \\| third |");
  });

  it("inserts only the URL of a pasted link inside a link destination", () => {
    const ed = open("[docs]()", 7);
    ed.pastePlainText("[Example](https://example.com)");
    expect(ed.getMarkdown()).toBe("[docs](https://example.com)");
  });

  it("turns selected text into a link when a URL is pasted over it", () => {
    const ed = open("see the docs here", 8, 12);
    ed.pastePlainText("https://example.com/a");
    expect(ed.getMarkdown()).toBe("see the [docs](https://example.com/a) here");
  });

  it("does not link a selection that is itself a URL", () => {
    const ed = open("https://old.example", 0, 19);
    ed.pastePlainText("https://new.example");
    expect(ed.getMarkdown()).toBe("https://new.example");
  });

  it("native paste reaches every caret and distributes one line per caret", async () => {
    const ed = open("a\nb", 0);
    ed.view.dispatch({ selection: EditorSelection.create([EditorSelection.cursor(1), EditorSelection.cursor(3)]) });
    const data = clipboard({ plain: "1\n2" });
    const event = new Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
    Object.defineProperty(event, "clipboardData", { value: data });
    ed.view.contentDOM.dispatchEvent(event);
    await Promise.resolve();
    expect(ed.getMarkdown()).toBe("a1\nb2");
  });

  it("plain text outside special contexts is unchanged", () => {
    const ed = open("x", 1);
    ed.pastePlainText(" **y**");
    expect(ed.getMarkdown()).toBe("x **y**");
  });
});

describe("pasted HTML tables", () => {
  it("promotes the first row of a header-less table", () => {
    expect(htmlToMarkdown("<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>"))
      .toBe("| a | b |\n| --- | --- |\n| 1 | 2 |");
  });

  it("folds cell paragraphs and breaks into <br> and escapes pipes", () => {
    expect(htmlToMarkdown("<table><thead><tr><th>h</th><th>k</th></tr></thead><tbody><tr><td><p>x</p><p>y</p></td><td>a|b</td></tr></tbody></table>"))
      .toBe("| h | k |\n| --- | --- |\n| x<br>y | a\\|b |");
    expect(htmlToMarkdown("<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>x<br>y</td></tr></tbody></table>"))
      .toBe("| h |\n| --- |\n| x<br>y |");
  });

  it("expands colspan so every row has the header's width", () => {
    expect(htmlToMarkdown("<table><thead><tr><th colspan=2>h</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>"))
      .toBe("| h |  |\n| --- | --- |\n| 1 | 2 |");
  });

  it("pads short rows", () => {
    expect(htmlToMarkdown("<table><tr><th>a</th><th>b</th></tr><tr><td>1</td></tr></table>"))
      .toBe("| a | b |\n| --- | --- |\n| 1 |  |");
  });
});

describe("file drop", () => {
  it("uploads dropped images and links them at the drop point", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const uploads: string[] = [];
    const editor = createEditorCM6(host, {
      initialContent: "ab",
      pasteAssets: {
        async uploadBlobAsset(_blob, meta) {
          uploads.push(meta.name ?? "");
          return { ok: true, isImage: true, name: "cat", markdownPath: "assets/cat.png" };
        },
      },
    });
    editors.push(editor);
    editor.view.posAtCoords = () => 1;
    const file = new File(["png"], "cat.png", { type: "image/png" });
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [file], items: [], getData: () => "" },
    });
    editor.view.contentDOM.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(uploads).toEqual(["cat.png"]);
    expect(editor.getMarkdown()).toBe("a![cat](assets/cat.png)b");
  });

  it("leaves a drop of text files to CodeMirror", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditorCM6(host, {
      initialContent: "ab",
      pasteAssets: { async uploadBlobAsset() { return {}; } },
    });
    editors.push(editor);
    editor.view.posAtCoords = () => 1;
    const event = new Event("drop", { bubbles: true, cancelable: true }) as DragEvent;
    Object.defineProperty(event, "dataTransfer", {
      value: { files: [new File(["x"], "note.md", { type: "text/markdown" })], items: [], getData: () => "" },
    });
    editor.view.contentDOM.dispatchEvent(event);
    expect(editor.getMarkdown()).toBe("ab");
  });
});
