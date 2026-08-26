import { describe, expect, test } from "@voidzero-dev/vite-plus-test";

import {
  applyPortableAttributeViewFitWidths,
  estimateAttributeViewTextWidth,
  getAttributeViewColumnFitWidth,
  getAttributeViewColumnResizeWidth,
  getAttributeViewDistributedColumnWidth,
  getPortableAttributeViewFitWidths,
} from "../src/attribute-view-column-width.ts";

const measureText = (value: string) => value.length * 10;

describe("SiYuan-derived attribute-view column fitting", () => {
  test("calculates compact widths from measured content", () => {
    expect(getAttributeViewColumnFitWidth("优先级", "select", ["P1", "P2", "P3"], measureText))
      .toBe("72px");
    expect(getAttributeViewColumnFitWidth(
      "URL",
      "url",
      ["https://github.com/siyuan-note/siyuan/issues/10767"],
      measureText,
    )).toBe("480px");
    expect(getAttributeViewColumnFitWidth("日期", "date", ["2026-07-30"], measureText))
      .toBe("120px");
    expect(getAttributeViewColumnFitWidth(
      "标题",
      "text",
      ["A very long title that should not make the field excessively wide"],
      measureText,
    )).toBe("480px");
  });

  test("uses deterministic CJK, whitespace, and wide-ASCII fallback metrics", () => {
    expect(estimateAttributeViewTextWidth("中 A m")).toBe(14 + 4 + 9 + 4 + 7);
    expect(estimateAttributeViewTextWidth("a\nb")).toBe(7 + 4 + 7);
  });

  test("maps portable row cells by stable key rather than physical order", () => {
    const widths = getPortableAttributeViewFitWidths([
      { key: "title", label: "Title", type: "text" },
      { key: "priority", label: "P", type: "mSelect" },
    ], [{ cells: [
      { key: "priority", value: "Long" },
      { key: "title", value: "Content" },
    ] }], measureText);
    expect(widths).toEqual({ title: "92px", priority: "72px" });
  });

  test("snaps manual widths and computes even distribution", () => {
    expect(getAttributeViewColumnResizeWidth(195, 200)).toEqual({ width: 195, snapped: false });
    expect(getAttributeViewColumnResizeWidth(196, 200)).toEqual({ width: 200, snapped: true });
    expect(getAttributeViewColumnResizeWidth(204, 200)).toEqual({ width: 200, snapped: true });
    expect(getAttributeViewColumnResizeWidth(10)).toEqual({ width: 25, snapped: false });
    expect(getAttributeViewDistributedColumnWidth([120, 240, 360])).toBe(240);
    expect(getAttributeViewDistributedColumnWidth([])).toBe(25);
  });

  test("applies keyed fit widths to a production-shaped colgroup", () => {
    const table = document.createElement("table");
    table.innerHTML = `
      <colgroup><col data-column="title"><col data-column="priority"></colgroup>
      <tbody><tr><td class="cm-attribute-view-cell">Content</td><td>Long</td></tr></tbody>
    `;
    const widths = applyPortableAttributeViewFitWidths(table, [
      { key: "title", label: "Title", type: "text" },
      { key: "priority", label: "P", type: "mSelect" },
    ], [{ cells: [
      { key: "priority", value: "Long" },
      { key: "title", value: "Content" },
    ] }]);
    expect(widths.title).toMatch(/^\d+px$/);
    expect(table.querySelector<HTMLElement>('col[data-column="title"]')?.style.width)
      .toBe(widths.title);
    expect(table.querySelector<HTMLElement>('col[data-column="priority"]')?.style.width)
      .toBe(widths.priority);
  });
});
