import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

async function mount(text: string) {
  const { createEditorCM6 } = await import("../../src/cm6/editor-cm6.ts");
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditorCM6(host, { initialContent: text });
  return { editor, cleanup: () => { editor.destroy(); host.remove(); } };
}

describe("portable embed-query widget", () => {
  const source = [
    "Before", "",
    "#+begin embed Recent claims",
    "sql: SELECT * FROM blocks WHERE type = 'p' LIMIT 5",
    "#+end embed",
    "", "After",
  ].join("\n");

  test("renders safe Markdown results and emits an open request", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    let request: any = null;
    editor.view.dom.addEventListener("aaronnote:embed-query-request", (event) => {
      event.preventDefault();
      request = (event as CustomEvent).detail;
      request.respond({
        type: "embed-query", title: "Recent claims", evaluationSource: "kernel-search-embed", total: 1,
        diagnostics: [],
        items: [{
          id: "0198fc34-7b32-7a11-8cb4-6c40e3b33d72", projectionId: "projection-a", rootId: "root-a",
          file: "/target.md", path: "/target.md", hPath: "Noema/target", markdown: "Portable **result** <script>bad()</script>",
          kind: "NodeParagraph", subType: "",
        }],
      });
    });
    editor.view.dom.querySelector<HTMLButtonElement>(".cm-embed-query-action")?.click();
    await Promise.resolve();
    expect(request).toMatchObject({ title: "Recent claims", source: expect.stringContaining("SELECT * FROM blocks") });
    expect(editor.view.dom.querySelector<HTMLElement>(".cm-embed-query")?.dataset.evaluationSource).toBe("kernel-search-embed");
    expect(editor.view.dom.querySelector(".cm-embed-query-result-markdown strong")?.textContent).toBe("result");
    expect(editor.view.dom.querySelector(".cm-embed-query-result script")).toBeNull();
    let opened: any = null;
    editor.view.dom.addEventListener("aaronnote:embed-query-open", (event) => {
      event.preventDefault();
      opened = (event as CustomEvent).detail;
    });
    editor.view.dom.querySelector<HTMLButtonElement>(".cm-embed-query-result-path")?.click();
    expect(opened).toMatchObject({ item: { id: "0198fc34-7b32-7a11-8cb4-6c40e3b33d72", file: "/target.md" } });
    expect(editor.getMarkdown()).toBe(source);
    cleanup();
  });

  test("reveals its portable source at the cursor and ignores fenced-code lookalikes", async () => {
    const { editor, cleanup } = await mount(source);
    editor.setSelection(source.length, source.length);
    expect(editor.view.dom.querySelector(".cm-embed-query")).toBeTruthy();
    const inside = source.indexOf("SELECT") + 2;
    editor.setSelection(inside, inside);
    expect(editor.view.dom.querySelector(".cm-embed-query")).toBeNull();
    cleanup();

    const fenced = await mount("```\n#+begin embed Nope\nSELECT 1\n#+end embed\n```");
    expect(fenced.editor.view.dom.querySelector(".cm-embed-query")).toBeNull();
    fenced.cleanup();
  });
});
