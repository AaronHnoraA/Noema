import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";

function mount(initialContent: string) {
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("native @@revision workflow", () => {
  test("accepts and undoes an unresolved suggestion as one edit", () => {
    const source = '@@revision(red) [old claim] {advice: "new claim"; reason: "clearer"}\nTail';
    const { editor, cleanup } = mount(source);
    try {
      editor.setMarkdownSelection(source.length);
      const widget = document.querySelector<HTMLElement>(".aaronnote-revision")!;
      expect(widget.dataset.revisionStyle).toBe("red");
      expect(widget.querySelector(".aaronnote-revision-advice")?.textContent).toBe("new claim");
      const accept = Array.from(widget.querySelectorAll("button")).find((button) => button.textContent === "Accept")!;
      accept.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(editor.getMarkdown()).toBe("new claim\nTail");
      expect(editor.undo()).toBe(true);
      expect(editor.getMarkdown()).toBe(source);
    } finally { cleanup(); }
  });

  test("keeps the original and does not decorate revision syntax in math", () => {
    const command = '@@revision(indigo) [old] {advice: "new"}';
    const source = `${command}\n\\(${command}\\)`;
    const { editor, cleanup } = mount(source);
    try {
      editor.setMarkdownSelection(source.length);
      expect(document.querySelectorAll(".aaronnote-revision")).toHaveLength(1);
      const keep = Array.from(document.querySelectorAll<HTMLButtonElement>(".aaronnote-revision button"))
        .find((button) => button.textContent === "Keep")!;
      keep.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(editor.getMarkdown()).toContain(`old\n\\(${command}\\)`);
    } finally { cleanup(); }
  });
});
