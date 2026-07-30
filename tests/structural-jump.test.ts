import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import { createEditor } from "../src/lib.ts";
import { jumpStructuralDelimiter, structuralJumpTarget, structuralPairs } from "../src/cm6/structural-jump.ts";

describe("region-bounded structural jumps", () => {
  test("moves within the innermost math pair", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "\\(\\frac{a}{(b+c)}\\)" });
    try {
      const cursor = editor.getMarkdown().indexOf("b");
      editor.setSelection(cursor);
      const close = editor.getMarkdown().indexOf(")}") + 1;
      expect(structuralJumpTarget(editor.view, 1)).toBe(close);
      expect(jumpStructuralDelimiter(editor.view, 1)).toBe(true);
      expect(editor.getSelection().from).toBe(close);
      expect(structuralJumpTarget(editor.view, -1)).toBe(editor.getMarkdown().indexOf("(b") + 1);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("does not cross the current Markdown block", () => {
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    const editor = createEditor(mount, { initialContent: "plain paragraph\n\nnext (target)" });
    try {
      editor.setSelection(3);
      expect(structuralJumpTarget(editor.view, 1)).toBeNull();
      expect(jumpStructuralDelimiter(editor.view, 1)).toBe(false);
    } finally {
      editor.destroy();
      mount.remove();
    }
  });

  test("ignores escaped brackets and inline-code pairs", () => {
    expect(structuralPairs("\\(escaped\\) `code(x)` [real]")).toEqual([{ open: 22, close: 27 }]);
  });
});
