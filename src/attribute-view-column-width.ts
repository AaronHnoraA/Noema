/**
 * Portable attribute-view column sizing adapted from SiYuan's
 * app/src/protyle/render/av/columnWidth.ts (AGPL-3.0).
 *
 * The original implementation is independent of protyle. Noema keeps the
 * measurement and clamping semantics here so CM6 and future table surfaces can
 * share them without importing an editor adapter.
 */

export type AttributeViewColumnType = string;
export type AttributeViewTextMeasurer = (value: string) => number;

export type PortableAttributeViewColumn = {
  key: string;
  label: string;
  type?: AttributeViewColumnType;
};

export type PortableAttributeViewRow = {
  cells?: Array<{ key: string; value: string }>;
};

export function estimateAttributeViewTextWidth(value: string): number {
  return Array.from(value.trim().replace(/[\r\n]+/g, " ")).reduce((width, character) => {
    if (/[\u2E80-\u9FFF\uAC00-\uD7AF]/u.test(character)) return width + 14;
    if (/\s/u.test(character)) return width + 4;
    if (/[A-ZMW@#%&]/u.test(character)) return width + 9;
    return width + 7;
  }, 0);
}

export function getAttributeViewTextMeasurer(blockElement: HTMLElement): AttributeViewTextMeasurer {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const cellElement = blockElement.querySelector<HTMLElement>(
    ".cm-attribute-view-cell, .av__cell",
  );
  if (!context || !cellElement) return estimateAttributeViewTextWidth;
  const style = getComputedStyle(cellElement);
  context.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  return (value: string) => context.measureText(value.trim().replace(/[\r\n]+/g, " ")).width;
}

export function getAttributeViewColumnFitWidth(
  name: string,
  type: AttributeViewColumnType,
  values: string[],
  measureText: AttributeViewTextMeasurer = estimateAttributeViewTextWidth,
): string {
  const headerWidth = measureText(name) + 42;
  const contentPadding = type === "select" || type === "mSelect" ? 32 : 20;
  const contentWidth = values.reduce(
    (width, value) => Math.max(width, measureText(value) + contentPadding),
    0,
  );
  return `${Math.ceil(Math.min(480, Math.max(64, headerWidth, contentWidth)))}px`;
}

export function getAttributeViewColumnResizeWidth(
  width: number,
  previousWidth?: number,
  snapThreshold = 4,
): { width: number; snapped: boolean } {
  const limitedWidth = Math.max(Math.round(width), 25);
  const normalizedPreviousWidth = typeof previousWidth === "number"
    ? Math.round(previousWidth)
    : undefined;
  const snapped = typeof normalizedPreviousWidth === "number"
    && Math.abs(limitedWidth - normalizedPreviousWidth) <= snapThreshold;
  return { width: snapped ? normalizedPreviousWidth : limitedWidth, snapped };
}

export function getAttributeViewDistributedColumnWidth(widths: number[]): number {
  if (widths.length === 0) return 25;
  return Math.max(25, Math.round(widths.reduce((total, width) => total + width, 0) / widths.length));
}

export function getPortableAttributeViewFitWidths(
  columns: readonly PortableAttributeViewColumn[],
  rows: readonly PortableAttributeViewRow[],
  measureText: AttributeViewTextMeasurer = estimateAttributeViewTextWidth,
): Record<string, string> {
  return Object.fromEntries(columns.map((column) => {
    const values = rows.map((row) => String(
      row.cells?.find((cell) => cell.key === column.key)?.value ?? "",
    ));
    return [
      column.key,
      getAttributeViewColumnFitWidth(column.label || column.key, column.type || "text", values, measureText),
    ];
  }));
}

export function applyPortableAttributeViewFitWidths(
  table: HTMLTableElement,
  columns: readonly PortableAttributeViewColumn[],
  rows: readonly PortableAttributeViewRow[],
): Record<string, string> {
  const widths = getPortableAttributeViewFitWidths(columns, rows, getAttributeViewTextMeasurer(table));
  const colgroup = table.querySelector<HTMLTableColElement>("colgroup");
  if (!colgroup) return widths;
  for (const column of columns) {
    const col = Array.from(colgroup.children)
      .find((candidate) => (candidate as HTMLElement).dataset.column === column.key) as HTMLTableColElement | undefined;
    if (col) col.style.width = widths[column.key] || "64px";
  }
  return widths;
}
