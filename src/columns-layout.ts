import {
  COLUMNS_ENV_KIND,
  COLUMNS_MAX_COUNT,
  COLUMNS_MIN_WIDTH_PCT,
  areEqualColumnWidths,
  columnDividerLeftCss,
  columnLeftCss,
  columnRightCss,
  columnWidthCss,
  columnsClasses,
  columnsGridTracks,
  columnsLatexBlocks,
  columnsStyle,
  normalizeColumnWidths,
  parseColumnsHeader,
  resolvedColumnWidths,
  serializeColumnsAttrs,
  splitColumnPanes,
} from "../shared/columns-layout.mjs";

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

export {
  COLUMNS_ENV_KIND,
  COLUMNS_MAX_COUNT,
  COLUMNS_MIN_WIDTH_PCT,
  areEqualColumnWidths,
  columnDividerLeftCss,
  columnLeftCss,
  columnRightCss,
  columnWidthCss,
  columnsClasses,
  columnsGridTracks,
  columnsLatexBlocks,
  columnsStyle,
  normalizeColumnWidths,
  parseColumnsHeader,
  resolvedColumnWidths,
  serializeColumnsAttrs,
  splitColumnPanes,
};
