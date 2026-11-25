import { describe, expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const progressBlock = [
  "#+begin progress Delivery",
  "- 解析：75%",
  "- **复核**: 4/8",
  "- 测试: 12/10",
  "#+end progress",
].join("\n");

function render(markdown: string): HTMLElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdownHTML(markdown);
  return host;
}

describe("document progress blocks", () => {
  test("renders both forms with readable values and a bounded bar", () => {
    const host = render(progressBlock);
    const bars = Array.from(host.querySelectorAll<HTMLProgressElement>("progress"));
    expect(bars.map((bar) => [bar.getAttribute("value"), bar.getAttribute("max")])).toEqual([
      ["75", "100"], ["4", "8"], ["10", "10"],
    ]);
    expect(bars[0]?.getAttribute("aria-label")).toBe("解析");
    expect(host.querySelector("strong")?.textContent).toBe("复核");
    expect(host.querySelector("[data-kind=progress]")?.textContent).toContain("12/10");
  });

  test("leaves malformed or literal data readable", () => {
    const invalid = "#+begin progress\n- Done: 1/0\n- Keep this note\n#+end progress";
    const fallback = render(invalid);
    expect(fallback.querySelector("progress")).toBeNull();
    expect(fallback.querySelectorAll("li")).toHaveLength(2);
    const nested = render("#+begin progress\n- Parent: 75%\n  - Child: 5/8\n#+end progress");
    expect(nested.querySelector("progress")).toBeNull();
    expect(nested.querySelector("li ul li")?.textContent).toContain("Child: 5/8");
    expect(render("```text\n" + progressBlock + "\n```").querySelector("progress")).toBeNull();
  });

  test("renders in the live editor, reveals the same source, and updates after editing", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const source = "Before.\n\n" + progressBlock + "\n\nAfter.";
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    try {
      editor.setMarkdownSelection(source.length);
      expect(host.querySelector("progress")?.getAttribute("value")).toBe("75");
      expect(editor.getMarkdown()).toBe(source);

      const at = source.indexOf("75%");
      editor.setMarkdownSelection(at);
      expect(host.querySelector("progress")).toBeNull();
      const heading = ".cm-org-env-heading-widget[data-org-env-kind=progress]";
      const footer = ".cm-org-env-end-widget[data-org-env-kind=progress]";
      expect(host.querySelector(heading)).not.toBeNull();
      editor.setMarkdownSelection(source.indexOf("Delivery") + 1);
      expect(host.querySelector(heading)).toBeNull();
      editor.setMarkdownSelection(at);
      expect(host.querySelector(heading)).not.toBeNull();
      expect(host.querySelector(footer)).not.toBeNull();
      editor.setMarkdownSelection(source.indexOf("#+end progress") + 3);
      expect(host.querySelector(footer)).toBeNull();
      editor.setMarkdownSelection(at);
      editor.replaceMarkdownRange(at, at + 3, "80%");
      editor.setMarkdownSelection(source.length);
      expect(host.querySelector("progress")?.getAttribute("value")).toBe("80");
      expect(editor.getMarkdown()).toBe(source.replace("75%", "80%"));
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("clicking a retained progress block opens its mapped source range", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const source = "Before.\n\n" + progressBlock + "\n\nAfter.";
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    try {
      editor.setMarkdownSelection(source.length);
      const label = host.querySelector(".noema-progress-label")!;
      const heading = host.querySelector(".cm-org-env-heading-widget[data-org-env-kind=progress]")!;
      const prefix = "A longer introduction before the block. ".repeat(3);
      editor.replaceMarkdownRange(0, 0, prefix);
      expect(host.querySelector(".noema-progress-label")).toBe(label);
      expect(host.querySelector(".cm-org-env-heading-widget[data-org-env-kind=progress]")).toBe(heading);

      const start = editor.getMarkdown().indexOf("#+begin progress");
      heading.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(editor.getMarkdownSelection().from).toBe(start + "#+begin progress ".length);
      expect(host.querySelector("progress")).toBeNull();

      editor.setMarkdownSelection(editor.getMarkdown().length);
      host.querySelector(".noema-progress-label")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      expect(editor.getMarkdownSelection().from).toBeGreaterThanOrEqual(start);
      expect(editor.getMarkdownSelection().from).toBeLessThan(start + progressBlock.length);
      expect(host.querySelector("progress")).toBeNull();
    } finally {
      editor.destroy();
      host.remove();
    }
  });

  test("revealed nested progress rows stay inside their own environment rail", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const source = "#+begin note Outer\n" + progressBlock + "\n#+end note\n\nAfter.";
    const editor = createEditor(host, { kernel: "cm6", initialContent: source });
    try {
      editor.setMarkdownSelection(source.length);
      editor.setMarkdownSelection(source.indexOf("75%"));
      expect(host.querySelectorAll('.cm-line[data-org-env-kind="progress"][data-org-env-depth="1"]')).toHaveLength(3);
    } finally {
      editor.destroy();
      host.remove();
    }
  });
});
