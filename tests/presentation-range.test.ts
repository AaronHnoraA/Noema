import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/lib.ts";

describe("Reveal marker preview", () => {
  test("keeps the Reveal slide marker in source but hides it in editable preview", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "# Native\n@@slides(reveal) []\n<div class=\"fragment\">Hi</div>" });
    try {
      editor.setMarkdownSelection(0);
      expect(editor.getMarkdown()).toContain("@@slides(reveal) []");
      expect(editor.view.contentDOM.textContent).not.toContain("@@slides(reveal) []");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("hides the vertical stack marker in editable preview", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "# Below\n@@slides(vertical) []\nContent" });
    try {
      editor.setMarkdownSelection(0);
      expect(editor.getMarkdown()).toContain("@@slides(vertical) []");
      expect(editor.view.contentDOM.textContent).not.toContain("@@slides(vertical) []");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });
});
