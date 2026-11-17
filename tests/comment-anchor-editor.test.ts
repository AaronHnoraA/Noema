import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

function mount(content: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: content });
  return { host, view: editor.view as unknown as EditorView, done: () => { editor.destroy(); host.remove(); } };
}

describe("C70 comment anchors in the editor", () => {
  const content = "Intro line.\n\nThe {==fixed field==}{>>#c-20261117-abc123<<} and ==bright== words.\n";

  test("C70 the commented text carries its thread id and the markers stay hidden", () => {
    const { host, view, done } = mount(content);
    try {
      view.dispatch({ selection: { anchor: 0 } });
      const mark = host.querySelector<HTMLElement>(".noema-comment-anchor");
      expect(mark?.dataset.commentId).toBe("c-20261117-abc123");
      expect(mark?.textContent).toBe("fixed field");
      const hidden = [...host.querySelectorAll(".syntax-hidden")].map((node) => node.textContent);
      expect(hidden).toContain("{==");
      expect(hidden).toContain("==}{>>#c-20261117-abc123<<}");
      // The anchor's markers are not taken for a highlight; ==bright== still is.
      expect([...host.querySelectorAll(".cm-highlight")].map((node) => node.textContent)).toEqual(["==bright=="]);
    } finally { done(); }
  });

  test("C70 editing the commented text does not reveal the markers", () => {
    const { host, view, done } = mount(content);
    try {
      const inside = content.indexOf("fixed") + 2;
      view.dispatch({ selection: { anchor: inside } });
      const hidden = [...host.querySelectorAll(".syntax-hidden")].map((node) => node.textContent);
      expect(hidden).toContain("{==");
      // Only a caret inside a marker shows it.
      view.dispatch({ selection: { anchor: content.indexOf("{==") + 1 } });
      expect([...host.querySelectorAll(".syntax-hint")].map((node) => node.textContent)).toContain("{==");
    } finally { done(); }
  });

  test("C70 previews show only the commented text", () => {
    const html = renderMarkdownHTML(content);
    expect(html).toContain("fixed field");
    expect(html).not.toContain("c-20261117-abc123");
    expect(html).not.toContain("{==");
  });
});
