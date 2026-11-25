export type ColumnLength = { value: number; unit: "ch" | "px" | "em" | "rem" | "lh" };
export type ColumnTrack = { value: number; unit: "fr" | "ch" | "%" };
export type AdaptiveColumns = {
  tracks: ColumnTrack[] | null;
  maxColumns: number;
  minimum: ColumnLength;
  gap: ColumnLength;
  padding: ColumnLength;
  justify: "start" | "center" | "end" | "space-between" | "space-around";
  align: "top" | "center" | "bottom" | "stretch" | null;
  wrap: boolean;
};
export type ColumnMetrics = { width: number; ch: number; em: number; rem: number; lh: number };
export type AdaptiveColumnLayout = { rows: number[][]; gap: number; padding: number };

export function parseAdaptiveColumns(attrs: Record<string, string>): AdaptiveColumns | null;
export function columnPaneGrow(value: string | undefined): number;
export function layoutAdaptiveColumns(spec: AdaptiveColumns, growth: readonly number[], metrics: ColumnMetrics): AdaptiveColumnLayout;
