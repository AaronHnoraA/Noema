/**
 * org-env / comment widget titles render inline KaTeX (`#+begin theorem \(x^2\)`).
 * Title rendering reuses the same shared `renderMarkdownInlineHTML` helper the
 * fold-summary title and todo bodies already use for math.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";

function mountCM6(initialContent = "") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("org-env title math", () => {
  test("theorem block title renders inline KaTeX in the editor widget", () => {
    const md = "#+begin theorem Spectral \\(x^2\\)\nBody.\n#+end theorem";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const title = document.querySelector<HTMLElement>(".org-env-heading-title");
      expect(title).toBeTruthy();
      expect(title!.querySelector(".katex")).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("comment widget label renders inline KaTeX", () => {
    // A trailing paragraph after the block ensures the cursor sits strictly
    // outside `[block.from, block.to]` — `selectionTouchesRange` treats a
    // cursor exactly at the block's closing boundary as still "touching" it.
    const md = "#+begin comment Note \\(\\alpha\\)\nHidden.\n#+end comment\n\nAfter.";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const label = document.querySelector<HTMLElement>(".org-env-comment-label");
      expect(label).toBeTruthy();
      expect(label!.querySelector(".katex")).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("empty comment title still falls back to the word 'comment'", () => {
    const md = "#+begin comment\nHidden.\n#+end comment\n\nAfter.";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const label = document.querySelector<HTMLElement>(".org-env-comment-label");
      expect(label).toBeTruthy();
      expect(label!.textContent).toBe("comment");
    } finally {
      cleanup();
    }
  });
});
