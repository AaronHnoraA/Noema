import { describe, test, expect } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";

/**
 * getMarkdown() memoizes by CM6 `Text` identity. These guard the one real risk of
 * that optimization: returning stale content after an edit invalidates the doc.
 */
describe("getMarkdown memoization", () => {
  test("stays consistent and never returns stale content after edits", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "hello" });
    try {
      expect(editor.getMarkdown()).toBe("hello");
      // Repeated reads of an unchanged doc agree (and hit the cache).
      expect(editor.getMarkdown()).toBe(editor.getMarkdown());

      editor.setMarkdown("world", { history: "reset" });
      expect(editor.getMarkdown()).toBe("world");

      editor.replaceMarkdownRange(0, 0, "pre-", "start");
      expect(editor.getMarkdown()).toBe("pre-world");
      expect(editor.getMarkdownLength()).toBe("pre-world".length);

      editor.replaceMarkdownRange(0, "pre-".length, "", "start");
      expect(editor.getMarkdown()).toBe("world");
    } finally {
      editor.destroy();
      mount.remove();
    }
  });
});
