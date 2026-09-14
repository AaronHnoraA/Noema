export type AttrMap = Record<string, string>;

export type TrailingAttrs = {
  raw: string;
  attrs: AttrMap;
  from: number;
  to: number;
};

export type TrailingAttrsOptions = {
  allowWhitespace?: boolean;
  knownKeys?: readonly string[];
};

export type LayoutAlign = "left" | "center" | "right";

export type LayoutAttrs = {
  align: LayoutAlign;
  wrap: boolean;
  width: string;
  height: string;
};

export const LAYOUT_ATTR_KEYS: readonly string[];

export function parseAttrArgs(raw?: string): AttrMap;
export function findSingleLineClose(text: string, open: number, closeChar: "]" | "}"): number;
export function readTrailingAttrs(text: string, from: number, options?: TrailingAttrsOptions): TrailingAttrs | null;
export function readLayoutTrailingAttrs(text: string, from: number): TrailingAttrs | null;
export function readLayoutAttrsLine(text: string): TrailingAttrs | null;
export function layoutFromAttrs(attrs: AttrMap): LayoutAttrs;
export function layoutClasses(kind: string, layout: LayoutAttrs): string;
export function layoutStyle(kind: string, layout: LayoutAttrs): string;
export function layoutIsDefault(layout: LayoutAttrs): boolean;
export function layoutLatexLength(value: string, relativeTo?: string): string;
export function layoutLatexEnvironment(
  layout: LayoutAttrs,
  lines: string[] | string,
): { lines: string[]; packages: string[] };
export function layoutLatexFigure(
  layout: LayoutAttrs,
  lines: string[] | string,
): { lines: string[]; packages: string[] };
