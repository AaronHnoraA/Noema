import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { AARONNOTE_AUTHORING_SNIPPETS } from "../src/authoring-syntax.ts";

function mount(initialContent = "") {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("Noema authoring commands and snippets", () => {
  test("ships metadata, review, script and footnote snippets", () => {
    expect(AARONNOTE_AUTHORING_SNIPPETS.map((snippet) => snippet.key)).toEqual([
      "meta", "metafield", "summary", "rev", "sup", "sub", "fnref", "fndef",
    ]);
    expect(AARONNOTE_AUTHORING_SNIPPETS.find((snippet) => snippet.key === "rev")?.body)
      .toContain("@@revision");
  });

  test("wraps superscript/subscript and inserts a footnote in one history event", () => {
    const { editor, cleanup } = mount("x plus y");
    try {
      editor.setMarkdownSelection(0, 1);
      expect(editor.runCommand("superscript")).toBe(true);
      expect(editor.getMarkdown()).toBe("^x^ plus y");
      editor.setMarkdownSelection(9, 10);
      expect(editor.runCommand("subscript")).toBe(true);
      expect(editor.getMarkdown()).toBe("^x^ plus ~y~");
      editor.setMarkdownSelection(editor.getMarkdownLength());
      expect(editor.runCommand("insert-footnote")).toBe(true);
      expect(editor.getMarkdown()).toBe("^x^ plus ~y~[^1]\n\n[^1]: ");
      expect(editor.undo()).toBe(true);
      expect(editor.getMarkdown()).toBe("^x^ plus ~y~");
    } finally { cleanup(); }
  });

  test("moves a heading with its whole section in one undoable transaction", () => {
    const source = "# Alpha\nA body\n\n# Beta\nB body\n";
    const { editor, cleanup } = mount(source);
    try {
      editor.setMarkdownSelection(source.indexOf("# Beta"));
      expect(editor.runCommand("move-block-up")).toBe(true);
      expect(editor.getMarkdown()).toBe("# Beta\nB body\n# Alpha\nA body\n\n");
      expect(editor.undo()).toBe(true);
      expect(editor.getMarkdown()).toBe(source);
    } finally { cleanup(); }
  });

  test("does not mutate block source until a gutter drag is dropped", () => {
    const source = "# Alpha\nA body\n\n# Beta\nB body\n";
    const { editor, cleanup } = mount(source);
    try {
      const handles = document.querySelectorAll<HTMLElement>(".cm-block-drag-handle");
      expect(handles.length).toBeGreaterThanOrEqual(2);
      handles[0]!.dispatchEvent(new Event("dragstart", { bubbles: true, cancelable: true }));
      expect(editor.getMarkdown()).toBe(source);
      handles[1]!.dispatchEvent(new MouseEvent("drop", { bubbles: true, cancelable: true, clientY: 10_000 }));
      expect(editor.getMarkdown().startsWith("# Beta\nB body\n")).toBe(true);
    } finally { cleanup(); }
  });
});
