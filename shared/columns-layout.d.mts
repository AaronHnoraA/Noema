export const COLUMNS_ENV_KIND: "columns";
export const COLUMNS_MIN_WIDTH_PCT: number;
export const COLUMNS_MAX_COUNT: number;

export type ColumnsMode = "columns" | "flow";
export type ColumnsAlign = "inherit" | "left" | "center" | "right" | "justify";
export type ColumnsValign = "top" | "center" | "bottom" | "stretch";
export type ColumnsGap = "sm" | "md" | "lg";
export type ColumnsRule = "on" | "off";

export type ColumnsSpec = {
  mode: ColumnsMode;
  cols: number;
  widths: number[] | null;
  align: ColumnsAlign;
  valign: ColumnsValign;
  gap: ColumnsGap;
  rule: ColumnsRule;
  extraAttrs: Record<string, string>;
};

export type ColumnPane = {
  body: string;
  from: number;
  to: number;
  markerFrom: number;
  markerTo: number;
  align: ColumnsAlign;
};

export function normalizeColumnWidths(rawWidths: readonly number[] | null | undefined, count: number): number[];
export function areEqualColumnWidths(widths: readonly number[] | null | undefined, count: number): boolean;
export function parseColumnsHeader(title?: string): ColumnsSpec;
export function serializeColumnsAttrs(spec: ColumnsSpec, paneCount?: number): string;
export function splitColumnPanes(body?: string): ColumnPane[];
export function resolvedColumnWidths(spec: ColumnsSpec, paneCount: number): number[];
export function columnsGridTracks(widths: readonly number[]): string;
export function columnDividerLeftCss(widths: readonly number[], index: number): string;
export function columnLeftCss(widths: readonly number[], index: number): string;
export function columnWidthCss(widths: readonly number[], index: number): string;
export function columnRightCss(widths: readonly number[], index: number): string;
export function columnsClasses(spec: ColumnsSpec, paneCount?: number): string;
export function columnsStyle(spec: ColumnsSpec, paneCount?: number): string;
export function columnsLatexBlocks(
  spec: ColumnsSpec,
  transformedPanes: readonly (string | { body: string; align?: ColumnsAlign })[],
): string[];
