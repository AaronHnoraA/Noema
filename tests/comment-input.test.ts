import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { EditorView } from "@codemirror/view";
import { createEditor } from "../src/editor-api.ts";
import { commentInsertion, installComments } from "../pages/comments.ts";

function mount(content: string, readOnly = false) {
  const scroller = document.createElement("div");
  document.body.append(scroller);
  const editor = createEditor(scroller, { kernel: "cm6", initialContent: content });
  const view = editor.view as unknown as EditorView;
  const statuses: string[] = [];
  const comments = installComments({ view, readOnly: () => readOnly, setStatus: (m) => statuses.push(m) });
  return { view, comments, statuses, done: () => { comments.destroy(); editor.destroy?.(); scroller.remove(); } };
}

const enter = (input: HTMLTextAreaElement, text: string) => {
  input.value = text;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
};

describe("C79 the page adds side comments", () => {
  test("C79 Cmd-Option-M writes @@comment after the selected passage, one edit", () => {
    const content = "The fixed field here.\n";
    const { view, done } = mount(content);
    try {
      const from = content.indexOf("fixed");
      view.dispatch({ selection: { anchor: from, head: from + "fixed field".length } });
      view.dom.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyM", key: "µ", metaKey: true, altKey: true, bubbles: true }));
      const input = document.querySelector<HTMLTextAreaElement>(".noema-comment-input textarea")!;
      expect(input).toBeTruthy();
      enter(input, "Why ] fixed?");
      expect(view.state.doc.toString()).toMatch(/^The fixed field @@comment \[Why \\\] fixed\?\] \{id: [a-z0-9]{6}\} here\.\n$/);
      expect(document.querySelector(".noema-comment-input")).toBeNull();
    } finally { done(); }
  });

  test("C79 Escape or empty text adds nothing; a read-only pane says so", () => {
    const { view, comments, done } = mount("abc\n");
    try {
      comments.startComment();
      const input = document.querySelector<HTMLTextAreaElement>(".noema-comment-input textarea")!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(view.state.doc.toString()).toBe("abc\n");
    } finally { done(); }
    const ro = mount("abc\n", true);
    try {
      ro.comments.startComment();
      expect(document.querySelector(".noema-comment-input")).toBeNull();
      expect(ro.statuses).toEqual(["Read-only pane"]);
    } finally { ro.done(); }
    expect(commentInsertion("x", "ab12cd", " ")).toBe("@@comment [x] {id: ab12cd}");
  });
});
