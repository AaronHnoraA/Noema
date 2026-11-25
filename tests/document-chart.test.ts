import { expect, test } from "@voidzero-dev/vite-plus-test";
import { createEditor } from "../src/editor-api.ts";
import { renderMarkdownHTML } from "../src/render-html.ts";

const chart = (type: string, table: string): string =>
  `#+begin chart 解析 {type=${type}} {#demo-chart}\n${table}\n#+end chart`;

function render(markdown: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = renderMarkdownHTML(markdown);
  return root;
}

const signedTable = "| 阶段 | 时间偏差 (ms) |\n| --- | ---: |\n| **解析** | -4 |\n| 布局 | 0 |\n| 绘制 | 8 |";

test("signed bars have a common zero, with exact source values and authored units", () => {
  const root = render(chart("bar", signedTable));
  expect(root.querySelector("org-env-block")?.getAttribute("data-title")).toBe("解析");
  expect(root.querySelector("org-env-block")?.getAttribute("data-block-id")).toBe("demo-chart");
  expect(root.querySelector(".noema-chart-bar")).not.toBeNull();
  expect(root.querySelector(".noema-chart-bar strong")?.textContent).toBe("解析");
  expect(root.querySelector(".noema-chart-bar")?.textContent).toContain("时间偏差 (ms)");
  const marks = Array.from(root.querySelectorAll<HTMLElement>(".noema-chart-bar-mark"));
  expect(marks.map((mark) => Number.parseFloat(mark.style.inlineSize))).toEqual([33.33, 0, 66.67]);
  expect(marks.map((mark) => Number.parseFloat(mark.style.insetInlineStart))).toEqual([0, 33.33, 33.33]);
  expect([...root.querySelectorAll(".noema-chart-value")].map((node) => node.textContent)).toEqual(["-4", "0", "8"]);
});

test("stacked segments keep proportions, zero items, and total", () => {
  const root = render(chart("stacked", "| 组件 | 项数 |\n| --- | ---: |\n| A | 3 |\n| B | 1 |\n| C | 0 |"));
  expect(root.querySelector(".noema-chart-total")?.textContent).toContain("4");
  const segments = Array.from(root.querySelectorAll<HTMLElement>(".noema-chart-segment"));
  expect(segments.map((segment) => segment.style.inlineSize)).toEqual(["75%", "25%"]);
  expect([...root.querySelectorAll(".noema-chart-value")].map((node) => node.textContent)).toEqual(["3", "1", "0"]);
  expect(root.querySelector(".noema-chart-legend")?.textContent).toContain("0%");
  const large = render(chart("stacked", "| Label | Count |\n| --- | --- |\n| A | 999999999999999 |\n| B | 2 |"));
  expect(large.querySelector(".noema-chart-total")?.textContent).toContain("1000000000000001");
});

test("heatmap preserves row and column headers and separates zero from missing values", () => {
  const root = render(chart("heatmap", "| 周 | Mon | Tue |\n| --- | ---: | ---: |\n| Week 1 | -4 | 1 |\n| Week 2 | 0 | |"));
  expect([...root.querySelectorAll(".noema-chart-heatmap th[scope=row]")].map((node) => node.textContent)).toEqual(["Week 1", "Week 2"]);
  expect([...root.querySelectorAll(".noema-chart-heatmap th[scope=col]")].map((node) => node.textContent)).toEqual(["周", "Mon", "Tue"]);
  const cells = [...root.querySelectorAll(".noema-chart-heatmap td")];
  expect(cells.map((node) => node.textContent)).toEqual(["-4", "1", "0", "—"]);
  expect(cells.map((node) => node.getAttribute("data-sign"))).toEqual(["negative", "positive", "zero", "missing"]);
  expect(cells[3]?.querySelector("[aria-label=Missing]")).not.toBeNull();
});

test("line points are in source order and a missing value breaks the line", () => {
  const root = render(chart("line", "| Month | Items |\n| --- | ---: |\n| Jan | 0 |\n| Feb | 4 |\n| Mar | |\n| Apr | 1 |\n| May | 2 |"));
  expect(root.querySelectorAll(".noema-chart-line polyline")).toHaveLength(2);
  expect(root.querySelectorAll(".noema-chart-line circle")).toHaveLength(4);
  expect(root.querySelector(".noema-chart-line svg")?.getAttribute("aria-hidden")).toBe("true");
  expect([...root.querySelectorAll(".noema-chart-line td")].map((node) => node.textContent)).toEqual(["0", "4", "—", "1", "2"]);
});

test("malformed table rows remain legible in the visual fallback", () => {
  const root = render(chart("heatmap", "| Phase | Items |\n| --- | ---: |\n| A | 1 | 10 |\nTrailing note."));
  expect(root.querySelector(".noema-chart")).toBeNull();
  expect(root.textContent).toContain("| A | 1 | 10 |");
  expect(root.textContent).toContain("Trailing note.");
});

test("invalid inputs keep Markdown and the chart uses normal environment editing", () => {
  for (const type of ["stacked", "invalid"]) {
    const root = render(chart(type, signedTable));
    expect(root.querySelector(".noema-chart")).toBeNull();
    expect(root.querySelector("table")?.textContent).toContain("-4");
  }
  const source = `${chart("bar", signedTable)}\n\nAfter.`;
  const host = document.createElement("div");
  document.body.append(host);
  const editor = createEditor(host, { kernel: "cm6", initialContent: source });
  try {
    editor.setMarkdownSelection(source.length);
    expect(host.querySelector(".noema-chart-bar")).not.toBeNull();
    const heading = host.querySelector(".cm-org-env-heading-widget[data-org-env-kind=chart]");
    expect(heading?.textContent).toContain("解析");
    expect(heading?.textContent).not.toContain("type=bar");
    expect(host.querySelector(".cm-table-editable-block")).toBeNull();
    editor.setMarkdownSelection(source.indexOf("-4"));
    expect(host.querySelector(".noema-chart")).toBeNull();
    expect(editor.getMarkdown()).toBe(source);
  } finally {
    editor.destroy();
    host.remove();
  }
});
