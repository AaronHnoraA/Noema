import { parseAttrArgs } from "./attrs-syntax.ts";

export type LayoutGroup = {
  columns: 1 | 2 | 3 | 4;
  mode: "grid" | "flow";
  align: "inherit" | "left" | "center" | "right" | "justify";
  widths: readonly number[];
};

/** `#+begin layout {cols=3 mode=grid}` uses the existing Org environment and
 * attribute parsers; its body is untouched Markdown. */
export function layoutGroupFromTitle(title: string): LayoutGroup {
  const attrs = parseAttrArgs(title.match(/\{[^{}]*\}\s*$/)?.[0] ?? "");
  const requested = Number(attrs.cols ?? attrs.columns ?? 2);
  const columns = requested === 1 || requested === 3 || requested === 4 ? requested : 2;
  const requestedAlign = String(attrs.align ?? "").toLowerCase();
  const align = (["left", "center", "right", "justify"] as const).find((value) => value === requestedAlign) ?? "inherit";
  const parts = String(attrs.widths ?? "").split("-");
  const parsed = parts.map(Number);
  const widths = parts.length === columns && parsed.every((value) => Number.isFinite(value) && value >= 10 && value <= 90)
    ? parsed : Array(columns).fill(100 / columns);
  return { columns, mode: attrs.mode === "flow" ? "flow" : "grid", align, widths };
}

export function layoutGroupTracks(group: LayoutGroup): string {
  return group.widths.map((width) => `${Math.round(width * 1000) / 1000}fr`).join(" ");
}

/** The reader and the CM6 widget must use the same layout contract. */
export function layoutGroupClasses(group: LayoutGroup): string {
  return `noema-layout-group noema-layout-${group.mode}`
    + (group.align === "inherit" ? "" : ` noema-layout-align-${group.align}`);
}

export function layoutGroupStyle(group: LayoutGroup): string {
  return `--noema-layout-cols:${group.columns};--noema-layout-tracks:${layoutGroupTracks(group)}`;
}
