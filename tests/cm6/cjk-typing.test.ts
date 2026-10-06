import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { runEditorTextInput } from "../../src/cm6/input-commands.ts";

function opened(source: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  return { editor, close: () => { editor.destroy(); host.remove(); } };
}

describe("CJK typing at source boundaries", () => {
  test("spaces Chinese and Latin or digits only at the typed boundary", () => {
    const { editor, close } = opened("中文");
    try {
      editor.setMarkdownSelection(2);
      runEditorTextInput(editor.view, "A");
      expect(editor.getMarkdown()).toBe("中文 A");
      runEditorTextInput(editor.view, "I");
      expect(editor.getMarkdown()).toBe("中文 AI");
      runEditorTextInput(editor.view, "2");
      expect(editor.getMarkdown()).toBe("中文 AI2");
    } finally { close(); }
  });

  test("converts punctuation after Chinese but leaves inline code source alone", () => {
    const { editor, close } = opened("中文\n\n`中文`");
    try {
      editor.setMarkdownSelection(2);
      runEditorTextInput(editor.view, ",");
      expect(editor.getMarkdown()).toBe("中文，\n\n`中文`");
      editor.setMarkdownSelection(editor.getMarkdown().indexOf("`中文") + 3);
      runEditorTextInput(editor.view, ",");
      expect(editor.getMarkdown()).toBe("中文，\n\n`中文,`");
    } finally { close(); }
  });

  test("converts full-width punctuation after Latin without touching line breaks", () => {
    const { editor, close } = opened("AI\n\n中文");
    try {
      editor.setMarkdownSelection(2);
      runEditorTextInput(editor.view, "，");
      expect(editor.getMarkdown()).toBe("AI,\n\n中文");
      editor.setMarkdownSelection(editor.getMarkdown().length);
      runEditorTextInput(editor.view, "3");
      expect(editor.getMarkdown()).toBe("AI,\n\n中文 3");
    } finally { close(); }
  });

  test("does not rewrite table and math source", () => {
    const source = "| 名称 | 值 |\n| --- | --- |\n| 中文 | 1 |\n\n\\(中文\\)";
    const { editor, close } = opened(source);
    try {
      editor.toggleSource();
      editor.setMarkdownSelection(source.indexOf("中文"));
      runEditorTextInput(editor.view, "A");
      expect(editor.getMarkdown()).toContain("| A中文 | 1 |");
      editor.setMarkdownSelection(editor.getMarkdown().lastIndexOf("中文") + 2);
      runEditorTextInput(editor.view, ",");
      expect(editor.getMarkdown()).toContain("\\(中文,\\)");
    } finally { close(); }
  });
});
