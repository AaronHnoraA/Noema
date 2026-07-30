import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";

function mountCM6(initialContent = "") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("inline @@scomment widget", () => {
  test("renders an always-visible side card without leaking command syntax", () => {
    const md = "Claim @@scomment [Check the hypothesis.] after";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const widget = document.querySelector<HTMLElement>(".inline-side-comment-widget");
      expect(widget).toBeTruthy();
      expect(widget?.getAttribute("role")).toBe("note");
      expect(widget?.querySelector(".inline-side-comment-card")?.textContent)
        .toBe("Check the hypothesis.");
      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
        .not.toContain("@@scomment");
    } finally {
      cleanup();
    }
  });

  test("shows raw source while the selection intersects the command", () => {
    const md = "Claim @@scomment [editable note] after";
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.indexOf("editable"));
      expect(document.querySelector(".inline-side-comment-widget")).toBeNull();
      expect((editor.view as unknown as { contentDOM: HTMLElement }).contentDOM.textContent)
        .toContain("@@scomment [editable note]");
    } finally {
      cleanup();
    }
  });

  test("renders inline markdown and math inside the card", () => {
    const md = String.raw`Claim @@scomment [Use **care** with \(u,v,w\).] after`;
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      const card = document.querySelector<HTMLElement>(".inline-side-comment-card")!;
      expect(card.querySelector("strong")?.textContent).toBe("care");
      expect(card.querySelector(".katex")).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("does not render inside inline math or fenced code", () => {
    const md = [
      String.raw`Math \(@@scomment [hidden]\)`,
      "",
      "```",
      "@@scomment [also hidden]",
      "```",
    ].join("\n");
    const { editor, cleanup } = mountCM6(md);
    try {
      editor.setMarkdownSelection(md.length);
      expect(document.querySelector(".inline-side-comment-widget")).toBeNull();
    } finally {
      cleanup();
    }
  });
});
