import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const timeline = [
  "#+begin timeline 交付 {orientation=horizontal card=true} {#release-timeline}",
  "- [success] **11 月 20 日** · 解析",
  "",
  "  保留链接 [详细说明](https://example.com)。",
  "- [warning] **11 月 23 日** · 排版",
  "- **11 月 25 日** · 交付",
  "#+end timeline",
].join("\n");

const steps = [
  "#+begin steps 复核",
  "3. [x] 锁定范围",
  "",
  "   保存原始稿。",
  "4. [ ] 对照内容",
  "5. [ ] 提交",
  "#+end steps",
].join("\n");

function render(source: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(source);
  return root;
}

test("timeline uses ordinary Markdown list contents and source order", () => {
  const root = render(timeline);
  const block = root.querySelector("org-env-block");
  expect(block?.getAttribute("data-title")).toBe("交付");
  expect(block?.getAttribute("data-block-id")).toBe("release-timeline");
  const list = root.querySelector("ul.noema-timeline-list");
  expect(list?.getAttribute("data-orientation")).toBe("horizontal");
  expect(list?.getAttribute("data-card")).toBe("true");
  expect([...list!.querySelectorAll(".noema-timeline-date strong")].map((node) => node.textContent))
    .toEqual(["11 月 20 日", "11 月 23 日", "11 月 25 日"]);
  expect([...list!.querySelectorAll(".noema-timeline-title")].map((node) => node.textContent))
    .toEqual(["解析", "排版", "交付"]);
  expect(list?.querySelector("[data-event-status=success]")?.textContent).toContain("success");
  expect(list?.querySelector("[data-event-status=warning]")?.textContent).toContain("warning");
  expect(list?.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
});

test("steps retain authored numbering, distinguish completion, and keep explanatory paragraphs", () => {
  const list = render(steps).querySelector("ol.noema-steps-list");
  expect(list?.getAttribute("start")).toBe("3");
  expect([...list!.querySelectorAll(":scope > li")].map((node) => node.getAttribute("data-step-state")))
    .toEqual(["done", "current", "pending"]);
  expect(list?.querySelector("[aria-current=step]")?.textContent).toContain("对照内容");
  expect(list?.querySelector("li p:nth-of-type(2)")?.textContent).toBe("保存原始稿。");
});

test("unrecognized sequence contents render in their ordinary Markdown form", () => {
  const root = render("#+begin timeline\nA paragraph.\n\n> A quotation.\n#+end timeline");
  expect(root.querySelector(".noema-timeline-list")).toBeNull();
  expect(root.querySelector("blockquote")?.textContent).toContain("A quotation.");
});

test("escaped or encoded status markers remain literal Markdown text", () => {
  const root = render("#+begin steps\n1. \\[ ] Literal\n2. [ ] Actual\n#+end steps\n\n"
    + "#+begin timeline\n- \\[success] Literal\n- &#91;warning] Encoded\n#+end timeline");
  expect(root.querySelector(".noema-steps-list li:first-child")?.textContent).toContain("[ ] Literal");
  expect(root.querySelector("[aria-current=step]")?.textContent).toContain("Actual");
  expect(root.querySelector(".noema-timeline-status")).toBeNull();
  expect(root.querySelector(".noema-timeline-list")?.textContent).toContain("[warning] Encoded");
});

test("sequence widgets use the original environment boundaries and reveal source", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `${timeline}\n\n${steps}\n\nAfter.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    expect(host.querySelector(".noema-timeline-list")).not.toBeNull();
    expect(host.querySelector(".noema-steps-list")).not.toBeNull();
    const title = host.querySelector(".cm-org-env-heading-widget[data-org-env-kind=timeline]");
    expect(title?.textContent).toContain("交付");
    expect(title?.textContent).not.toContain("orientation=");
    editor.setMarkdownSelection(source.indexOf("success"));
    expect(host.querySelector(".noema-timeline-list")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
    editor.setMarkdownSelection(source.indexOf("对照内容"));
    expect(host.querySelector(".noema-steps-list")).toBeNull();
    expect(host.querySelector(".noema-timeline-list")).not.toBeNull();
  } finally {
    editor.destroy();
    host.remove();
  }
});
