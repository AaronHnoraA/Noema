/**
 * Inline `@@comment [text]` — private annotation chip mirroring the org-env
 * block comment's dimmed collapsible UI, as a non-block inline widget.
 */

import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";

function mountCM6(initialContent = "") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("inline @@comment widget", () => {
  test("renders a collapsed chip with the source hidden", () => {
    const md = "Public text @@comment [private note]\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);

      const widget = document.querySelector<HTMLElement>(".inline-comment-widget");
      expect(widget).toBeTruthy();
      expect(widget!.dataset.commentOpen).toBe("false");

      const label = widget!.querySelector<HTMLElement>(".org-env-comment-label");
      expect(label?.textContent).toBe("comment");

      const content = widget!.querySelector<HTMLElement>(".org-env-content");
      expect(content?.hidden).toBe(true);
      expect(content?.textContent).toBe("private note");

      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
        .not.toContain("@@comment");
    } finally {
      cleanup();
    }
  });

  test("keeps false collapsed but renders true as a prominent visible comment", () => {
    const md = "@@comment(false) [private]\n@@comment(true) [check **this**]\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const widgets = Array.from(document.querySelectorAll<HTMLElement>(".inline-comment-widget"));
      const collapsed = widgets.find((widget) => !widget.classList.contains("inline-comment-display"))!;
      const display = widgets.find((widget) => widget.classList.contains("inline-comment-display"))!;

      expect(collapsed.dataset.commentOpen).toBe("false");
      expect(collapsed.querySelector<HTMLElement>(".org-env-content")?.hidden).toBe(true);
      expect(display.dataset.commentOpen).toBe("true");
      expect(display.getAttribute("role")).toBe("note");
      expect(display.querySelector(".inline-comment-display-label")?.textContent).toBe("COMMENT:");
      expect(display.querySelector(".inline-comment-display-content strong")?.textContent).toBe("this");
      expect(display.querySelector(".org-env-comment-button")).toBeNull();
    } finally {
      cleanup();
    }
  });

  test("shows raw source when the cursor is inside the command", () => {
    const md = "Public text @@comment [private note]\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.indexOf("@@comment") + 2);
      expect(document.querySelector(".inline-comment-widget")).toBeNull();
      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
        .toContain("@@comment [private note]");
    } finally {
      cleanup();
    }
  });

  test("clicking the button toggles the content open and updates state text", () => {
    const md = "Public text @@comment [private note]\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const widget = document.querySelector<HTMLElement>(".inline-comment-widget")!;
      const button = widget.querySelector<HTMLButtonElement>(".org-env-comment-button")!;
      const state = widget.querySelector<HTMLElement>(".org-env-comment-state")!;
      const content = widget.querySelector<HTMLElement>(".org-env-content")!;

      expect(state.textContent).toBe("show");
      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(content.hidden).toBe(false);
      expect(widget.dataset.commentOpen).toBe("true");
      expect(state.textContent).toBe("hide");

      button.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(content.hidden).toBe(true);
      expect(widget.dataset.commentOpen).toBe("false");
      expect(state.textContent).toBe("show");
    } finally {
      cleanup();
    }
  });

  test("renders inline math inside the revealed content", () => {
    const md = String.raw`Public @@comment [check \(\alpha\)]` + "\nplain";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const widget = document.querySelector<HTMLElement>(".inline-comment-widget")!;
      const content = widget.querySelector<HTMLElement>(".org-env-content")!;
      expect(content.querySelector(".katex")).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("multiple inline comments do not interfere with each other", () => {
    const { cleanup } = mountCM6("a @@comment [one] b @@comment [two]\nplain");
    try {
      const widgets = Array.from(document.querySelectorAll<HTMLElement>(".inline-comment-widget"));
      expect(widgets.length).toBe(2);
      expect(widgets.map((w) => w.querySelector(".org-env-content")?.textContent)).toEqual(["one", "two"]);
    } finally {
      cleanup();
    }
  });
});
