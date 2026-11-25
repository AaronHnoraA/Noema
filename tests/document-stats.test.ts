import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const stats = [
  "#+begin stats 交付",
  "| 指标 | 数值 | 变化 | 说明 | 走势 | 强调 |",
  "| --- | ---: | --- | --- | --- | --- |",
  "| **通过** | 403 项 | +18% | 完整验收 | 4,6,5,8 | success |",
  "| 解析 \\| 布局 | 14 ms | -24% | 冷启动 | 8,5,4 | info |",
  "| 遗留问题 | 0 | | | | |",
  "#+end stats",
].join("\n");

test("stats uses GFM cells and retains values, comments, and ordered trend data", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(stats);
  const cards = [...root.querySelectorAll(".noema-stat-card")];
  expect(cards.map((card) => card.querySelector(".noema-stat-value")?.textContent)).toEqual(["403 项", "14 ms", "0"]);
  expect(cards[0]?.querySelector("strong")?.textContent).toBe("通过");
  expect(cards[0]?.getAttribute("data-accent")).toBe("success");
  expect(cards[0]?.querySelector(".noema-stat-spark")?.getAttribute("title")).toBe("4,6,5,8");
  expect(cards[0]?.querySelectorAll(".noema-stat-spark-bar")).toHaveLength(4);
  expect(cards[1]?.querySelector(".noema-stat-name")?.textContent).toBe("解析 | 布局");
});

test("stats with a wrong table shape or trailing prose retains its Markdown", () => {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(stats.replace("#+end stats", "\nPreserve this line.\n#+end stats"));
  expect(root.querySelector(".noema-stat-card")).toBeNull();
  expect(root.querySelector("table tbody")?.textContent).toContain("403 项");
  expect(root.textContent).toContain("Preserve this line.");
});

test("stats cards use the normal environment heading and reveal their GFM source", () => {
  const host = document.createElement("div");
  document.body.append(host);
  const source = `${stats}\n\nAfter.`;
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    expect(host.querySelectorAll(".noema-stat-card")).toHaveLength(3);
    expect(host.querySelector(".cm-table-editable-block")).toBeNull();
    expect(host.querySelector(".cm-org-env-heading-widget[data-org-env-kind=stats]")?.textContent).toContain("交付");
    expect(editor.getMarkdown()).toBe(source);
    editor.setMarkdownSelection(source.indexOf("403"));
    expect(host.querySelector(".noema-stat-card")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
