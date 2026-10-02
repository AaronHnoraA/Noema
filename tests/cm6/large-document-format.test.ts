import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { createEditorCM6 } from "../../src/cm6/editor-cm6.ts";
import { activeInlineFormats, inlineFormatsAvailable } from "../../src/cm6/inline-format.ts";

describe("inline commands beyond the syntax parser's initial viewport", () => {
  it("recognizes a code block and a formatted link near the end of a 5 MB note", () => {
    const fixture = readFileSync(join(process.cwd(), "tests/synthetic_qc_note_5mb.md"), "utf8");
    const tail = "\n```js\n**literal**\n```\n\n**tail** and see [docs](old)"
      + "\n\n**first\nsecond**\n\nuse `first\nsecond` now\n\nsee [first\nsecond](url)"
      + "\n\n| a | b |\n| --- | --- |\n| cell one | x |\n| cell two | y |";
    const doc = fixture + tail;
    const host = document.createElement("div");
    document.body.append(host);
    const editor = createEditorCM6(host, { initialContent: doc });
    try {
      const codeAt = doc.indexOf("literal", fixture.length) + 2;
      editor.setSelection(codeAt, codeAt);
      expect(inlineFormatsAvailable(editor.view.state)).toBe(false);
      expect(activeInlineFormats(editor.view.state).size).toBe(0);
      expect(editor.runCommand("bold")).toBe(false);
      expect(editor.runCommand("link")).toBe(false);

      const boldAt = doc.indexOf("tail", fixture.length) + 2;
      editor.setSelection(boldAt, boldAt);
      expect(activeInlineFormats(editor.view.state).has("bold")).toBe(true);
      expect(editor.runCommand("bold")).toBe(true);
      expect(editor.getMarkdown()).toContain("\n```js\n**literal**\n```\n\ntail and see [docs](old)");

      const linkStart = editor.getMarkdown().lastIndexOf("see [docs]");
      editor.setSelection(linkStart, linkStart + 7);
      expect(editor.runCommand("link")).toBe(true);
      expect(editor.getMarkdown()).toContain("tail and [see docs](https://)");

      let current = editor.getMarkdown();
      editor.setSelection(current.lastIndexOf("second**") + 2);
      expect(editor.runCommand("bold")).toBe(true);
      expect(editor.getMarkdown()).toContain("\n\nfirst\nsecond\n\n");

      current = editor.getMarkdown();
      editor.setSelection(current.lastIndexOf("`first\nsecond`") + 9);
      expect(editor.runCommand("bold")).toBe(false);
      expect(editor.runCommand("link")).toBe(false);

      current = editor.getMarkdown();
      editor.setSelection(current.lastIndexOf("[first\nsecond](url)") + 9);
      expect(editor.runCommand("link")).toBe(true);
      expect(editor.getMarkdown()).toContain("see first\nsecond\n\n");

      current = editor.getMarkdown();
      editor.setSelection(current.lastIndexOf("cell one"), current.lastIndexOf("cell two") + 8);
      expect(editor.runCommand("bold")).toBe(true);
      expect(editor.getMarkdown().endsWith("| **cell one** | **x** |\n| **cell two** | y |")).toBe(true);
      expect(editor.runCommand("bold")).toBe(true);
      expect(editor.getMarkdown()).toBe(current);

      const cell = current.lastIndexOf("cell two");
      editor.setSelection(cell, cell + 8);
      expect(editor.runCommand("bold")).toBe(true);
      expect(editor.getMarkdown().endsWith("| **cell two** | y |")).toBe(true);

      editor.setSelection(codeAt, editor.getMarkdown().length);
      expect(editor.runCommand("clear-format")).toBe(true);
      expect(editor.getMarkdown()).toContain("\n```js\n**literal**\n```\n");
      expect(editor.getMarkdown().endsWith("| cell two | y |")).toBe(true);
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
