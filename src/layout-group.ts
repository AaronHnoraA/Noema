import { parseAttrArgs } from "./attrs-syntax.ts";

export type LayoutGroup = { columns: 2 | 3 | 4; mode: "grid" | "flow"; widths: readonly number[] };

/** `#+begin layout {cols=3 mode=grid}` uses the existing Org environment and
 * attribute parsers; its body is untouched Markdown. */
export function layoutGroupFromTitle(title: string): LayoutGroup {
  const attrs = parseAttrArgs(title.match(/\{[^{}]*\}\s*$/)?.[0] ?? "");
  const requested = Number(attrs.cols ?? attrs.columns ?? 2);
  const columns = requested === 3 || requested === 4 ? requested : 2;
  const parts = String(attrs.widths ?? "").split("-");
  const parsed = parts.map(Number);
  const widths = parts.length === columns && parsed.every((value) => Number.isFinite(value) && value >= 10 && value <= 90)
    ? parsed : Array(columns).fill(100 / columns);
  return { columns, mode: attrs.mode === "flow" ? "flow" : "grid", widths };
}

export function layoutGroupTracks(group: LayoutGroup): string {
  return group.widths.map((width) => `${Math.round(width * 1000) / 1000}fr`).join(" ");
}
