import { EditorState } from "@codemirror/state";
import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import type { Editor } from "../src/editor-api.ts";
import { tocIndexExtension } from "../src/cm6/toc-index.ts";
import { createWritingStatsController } from "../aaronnote/features/writing-stats/controller.ts";

describe("writing stats feature controller", () => {
  test("keeps full-document and heading-subtree output behavior", () => {
    const holder = {
      state: EditorState.create({
        doc: "# One\n你好 world\n## Child\nmore words\n# Two\nend",
        extensions: [tocIndexExtension],
      }),
    };
    holder.state = holder.state.update({ selection: { anchor: 30 } }).state;
    const editor = {
      view: holder,
      getMarkdownLength: () => holder.state.doc.length,
    } as unknown as Editor;
    const label = document.createElement("span");
    const controller = createWritingStatsController(editor, label);

    expect(controller.isDocumentChanged()).toBe(true);
    controller.updateNow();
    expect(controller.isDocumentChanged()).toBe(false);
    expect(label.textContent).toMatch(/^全文 \d+ 字 · 本节 \d+ 字$/);
    expect(label.title).toContain("中日韩");
    controller.destroy();
  });
});
