/**
 * Inline `@@comment [text]` (C79): a comment standing on its own, drawn as a
 * small mark whose card pops up above the text.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { showTooltip } from "@codemirror/view";
import { createEditor } from "../src/editor-api.ts";
import { commentAt, commentCard } from "../src/cm6/extensions/visual/widgets/comment-popover.ts";

function mountCM6(initialContent = "") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("inline @@comment (C79)", () => {
  test("C79 a comment is a small mark; the source is hidden", () => {
    const md = "Public text @@comment [private note] {id: ab12cd}\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const widget = document.querySelector<HTMLElement>(".inline-comment-widget.inline-comment-mark");
      expect(widget).toBeTruthy();
      expect(widget!.getAttribute("aria-label")).toBe("Comment: private note");
      expect(widget!.querySelector(".inline-comment-icon")).toBeTruthy();
      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent).not.toContain("@@comment");
    } finally { cleanup(); }
  });

  test("C79 a done comment is ticked", () => {
    const md = "x @@comment(done) [finished] {id: ab12cd}\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const widget = document.querySelector<HTMLElement>(".inline-comment-mark")!;
      expect(widget.classList.contains("inline-comment-done")).toBe(true);
      expect(widget.querySelector(".inline-comment-icon")?.textContent).toBe("✓");
    } finally { cleanup(); }
  });

  test("C79 with the caret on the comment its source opens and its card pops up above", () => {
    const md = "Public text @@comment [check **this**] {id: ab12cd}\nplain";
    const { editor, cleanup } = mountCM6(md);
    const cards = () => (editor.view as any).state.facet(showTooltip).filter(Boolean)
      .map((tooltip: any) => ({ above: tooltip.above, pos: tooltip.pos, dom: tooltip.create(editor.view).dom as HTMLElement }));
    try {
      editor.setMarkdownSelection(md.indexOf("@@comment") + 4);
      expect(document.querySelector(".inline-comment-mark")).toBeNull();
      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent).toContain("@@comment [check");
      const [card] = cards();
      expect(card).toMatchObject({ above: true, pos: md.indexOf("@@comment") });
      expect(card.dom.querySelector(".noema-comment-card-body strong")?.textContent).toBe("this");
      expect(card.dom.querySelector("small")?.textContent).toBe("ab12cd");
      // Leaving the comment closes the card.
      editor.setMarkdownSelection(md.length);
      expect(cards()).toEqual([]);
    } finally { cleanup(); }
  });

  test("C79 the card renders math and says when the task is done", () => {
    const md = String.raw`a @@comment(done) [check \(\alpha\)] {id: ab12cd} b`;
    const { editor, cleanup } = mountCM6(md);
    try {
      const comment = commentAt(editor.view.state as any, md.indexOf("check"))!;
      expect(comment).toMatchObject({ id: "ab12cd", done: true, from: 2 });
      const card = commentCard(comment);
      expect(card.classList.contains("noema-comment-card-done")).toBe(true);
      expect(card.querySelector(".katex")).toBeTruthy();
      expect(commentAt(editor.view.state as any, 0)).toBeNull();
    } finally { cleanup(); }
  });

  test("C79 @@comment(true) still shows its body after COMMENT:", () => {
    const md = "@@comment(true) [check **this**]\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const display = document.querySelector<HTMLElement>(".inline-comment-display")!;
      expect(display.dataset.commentOpen).toBe("true");
      expect(display.querySelector(".inline-comment-display-label")?.textContent).toBe("COMMENT:");
      expect(display.querySelector(".inline-comment-display-content strong")?.textContent).toBe("this");
    } finally { cleanup(); }
  });

  test("C79 several comments on a line are separate marks", () => {
    const { cleanup } = mountCM6("a @@comment [one] b @@comment [two]\nplain");
    try {
      expect(document.querySelectorAll(".inline-comment-mark").length).toBe(2);
    } finally { cleanup(); }
  });
});
