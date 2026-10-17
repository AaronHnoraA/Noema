/**
 * Edits made from a construct's own controls (a checkbox, a code-language
 * field, an AI suggestion's Accept) are one undo step each, labelled as
 * construct edits, never merged with typing or with each other.
 */
import { afterEach, describe, expect, it } from "@voidzero-dev/vite-plus-test";
import { undo, undoDepth } from "@codemirror/commands";
import { createEditor, type Editor } from "../src/editor-api.ts";

const editors: Editor[] = [];
afterEach(() => { for (const editor of editors.splice(0)) editor.destroy(); document.body.replaceChildren(); });

function mount(doc: string): Editor {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: doc });
  editors.push(editor);
  editor.setMarkdownSelection(doc.length);
  return editor;
}

const clickCheckbox = (editor: Editor) => {
  const box = editor.view.dom.querySelector<HTMLElement>(".cm-task-checkbox")!;
  box.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
};

describe("edits from a construct's controls", () => {
  it("two quick checkbox toggles are two undo steps", () => {
    const editor = mount("- [ ] a task\n\nend");
    clickCheckbox(editor);
    expect(editor.getMarkdown()).toContain("- [x] a task");
    clickCheckbox(editor);
    expect(editor.getMarkdown()).toContain("- [ ] a task");
    expect(undoDepth(editor.view.state)).toBe(2);
    undo(editor.view);
    expect(editor.getMarkdown()).toContain("- [x] a task");
  });

  it("a checkbox toggle right after typing is its own undo step", () => {
    const editor = mount("- [ ] a task\n\nend");
    const at = editor.getMarkdown().indexOf("]") + 1;
    editor.view.dispatch({ changes: { from: at, insert: "!" }, userEvent: "input.type" });
    clickCheckbox(editor);
    undo(editor.view);
    expect(editor.getMarkdown()).toContain("- [ ]! a task");
  });

  it("is labelled a construct edit, not typing", () => {
    const editor = mount("- [ ] a task\n\nend");
    const events: boolean[] = [];
    const off = editor.view.dom.ownerDocument; void off;
    const original = editor.view.dispatch.bind(editor.view);
    (editor.view as { dispatch: typeof original }).dispatch = ((...args: Parameters<typeof original>) => {
      const spec = args[0] as { userEvent?: string };
      events.push(spec?.userEvent === "construct");
      return original(...args);
    }) as typeof original;
    clickCheckbox(editor);
    expect(events).toEqual([true]);
  });
});
