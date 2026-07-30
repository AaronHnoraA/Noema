import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../../src/editor-api.ts";
import { toggleAaronnoteMarkdownSource } from "../../src/cm6/editor-cm6.ts";

function mount(initialContent: string) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent });
  return {
    editor,
    cleanup() {
      editor.destroy();
      host.remove();
    },
  };
}

function blankLines(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(".cm-line.cm-prose-blank-line"));
}

describe("Visual typography kernel", () => {
  test("is installed as a Visual-only core extension", () => {
    const { editor, cleanup } = mount("Alpha\n\nBeta");
    expect(editor.view.dom.classList.contains("aaronnote-visual-typography")).toBe(true);
    expect(editor.view.dom.getAttribute("style")).toContain("--content-width: 100%");

    expect(toggleAaronnoteMarkdownSource(editor.view)).toBe(true);
    expect(editor.view.dom.classList.contains("aaronnote-visual-typography")).toBe(false);
    expect(blankLines()).toHaveLength(0);
    cleanup();
  });

  test("does not read layout width for ordinary document transactions", () => {
    const { editor, cleanup } = mount("Alpha");
    let reads = 0;
    Object.defineProperty(editor.view.contentDOM, "offsetWidth", {
      configurable: true,
      get() {
        reads += 1;
        return 960;
      },
    });

    editor.view.dispatch({ changes: { from: 5, insert: "!" } });
    expect(reads).toBe(0);
    cleanup();
  });

  test("keeps every authored blank line as compact visual rhythm", () => {
    const { cleanup } = mount("Alpha\n\n\nBeta");
    const lines = blankLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.classList.contains("cm-prose-paragraph-gap")).toBe(true);
    expect(lines[1]!.classList.contains("cm-prose-paragraph-gap")).toBe(true);
    expect(lines.some((line) => line.classList.contains("cm-prose-blank-collapsed"))).toBe(false);
    cleanup();
  });

  test("lets semantic blocks own their adjacent vertical spacing", () => {
    const { cleanup } = mount("Alpha\n\n\n# Heading");
    const lines = blankLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.classList.contains("cm-prose-blank-absorbed")).toBe(true);
    expect(lines[1]!.classList.contains("cm-prose-paragraph-gap")).toBe(true);
    cleanup();
  });

  test("expands only the blank line containing the caret", () => {
    const { editor, cleanup } = mount("Alpha\n\n\nBeta");
    editor.setMarkdownSelection(6);
    const lines = blankLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]!.classList.contains("cm-prose-blank-active")).toBe(true);
    expect(lines[1]!.classList.contains("cm-prose-paragraph-gap")).toBe(true);

    editor.setMarkdownSelection(0);
    expect(blankLines()[0]!.classList.contains("cm-prose-paragraph-gap")).toBe(true);
    expect(blankLines()[1]!.classList.contains("cm-prose-paragraph-gap")).toBe(true);
    cleanup();
  });
});
