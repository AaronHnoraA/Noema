/**
 * Source-owned format painter model.
 *
 * SiYuan's useful core is the intersection rule: copying a mixed selection
 * keeps only marks shared by every text segment. Noema stores Markdown, so
 * this adapter applies the rule to source delimiters instead of DOM spans.
 */

export type FormatPainterMode = "once" | "continuous";

export type FormatPainterType =
  | "strong"
  | "em"
  | "s"
  | "mark"
  | "sup"
  | "sub"
  | "code";

export interface FormatPainterStyle {
  backgroundColor?: string;
  color?: string;
  fontSize?: string;
  shadow?: boolean;
  hollow?: boolean;
}

export interface FormatPainterSegment {
  styles: FormatPainterStyle;
  types: string[];
}

export interface FormatPainterSnapshot {
  styles: FormatPainterStyle;
  types: FormatPainterType[];
}

export interface MarkdownFormatSelection {
  outerFrom: number;
  outerTo: number;
  contentFrom: number;
  contentTo: number;
  types: FormatPainterType[];
}

export interface MarkdownFormatChange {
  from: number;
  to: number;
  insert: string;
  selectionFrom: number;
  selectionTo: number;
}

export const FORMAT_PAINTER_TYPES: readonly FormatPainterType[] = [
  "strong", "em", "s", "mark", "sup", "sub", "code",
];

const MARKERS: ReadonlyArray<{
  type: FormatPainterType;
  open: string;
  close: string;
}> = [
  { type: "strong", open: "**", close: "**" },
  { type: "s", open: "~~", close: "~~" },
  { type: "mark", open: "==", close: "==" },
  { type: "code", open: "`", close: "`" },
  { type: "sup", open: "^", close: "^" },
  { type: "sub", open: "~", close: "~" },
  { type: "em", open: "*", close: "*" },
];

const markerFor = (type: FormatPainterType) => MARKERS.find((item) => item.type === type)!;

export const shouldKeepFormatPainterActive = (mode: FormatPainterMode): boolean => mode === "continuous";

export const shouldShowFormatPainterMessage = (enabled?: boolean): boolean => enabled !== false;

function commonStyles(segments: FormatPainterSegment[]): FormatPainterStyle {
  const styles: FormatPainterStyle = {};
  const keys: Array<keyof FormatPainterStyle> = [
    "backgroundColor", "color", "fontSize", "shadow", "hollow",
  ];
  for (const key of keys) {
    const value = segments[0]!.styles[key];
    if (value && segments.every((segment) => segment.styles[key] === value)) {
      (styles as Record<keyof FormatPainterStyle, string | boolean>)[key] = value;
    }
  }
  return styles;
}

export function getCommonFormatPainterSnapshot(
  segments: FormatPainterSegment[],
): FormatPainterSnapshot | undefined {
  if (segments.length === 0) return undefined;
  return {
    styles: commonStyles(segments),
    types: FORMAT_PAINTER_TYPES.filter((type) => (
      segments.every((segment) => segment.types.includes(type))
    )),
  };
}

function clampedRange(source: string, from: number, to: number): { from: number; to: number } {
  const start = Math.max(0, Math.min(source.length, Math.min(from, to)));
  const end = Math.max(start, Math.min(source.length, Math.max(from, to)));
  return { from: start, to: end };
}

function escapedAt(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index -= 1) slashes += 1;
  return slashes % 2 === 1;
}

function canPeel(
  source: string,
  contentFrom: number,
  contentTo: number,
  outerFrom: number,
  outerTo: number,
  marker: { open: string; close: string },
  included: boolean,
): boolean {
  const openAt = included ? contentFrom : outerFrom - marker.open.length;
  const closeAt = included ? contentTo - marker.close.length : outerTo;
  if (openAt < 0 || closeAt < openAt + marker.open.length) return false;
  if (source.slice(openAt, openAt + marker.open.length) !== marker.open) return false;
  if (source.slice(closeAt, closeAt + marker.close.length) !== marker.close) return false;
  if (escapedAt(source, openAt) || escapedAt(source, closeAt)) return false;
  if ((marker.open === "*" || marker.open === "~")
      && (source[openAt - 1] === marker.open || source[closeAt + marker.close.length] === marker.close)) {
    return false;
  }
  const innerFrom = openAt + marker.open.length;
  const innerTo = closeAt;
  return innerFrom < innerTo && !/^\s|\s$/u.test(source.slice(innerFrom, innerTo));
}

/**
 * Resolve delimiters around a visual selection or included in a Source-mode
 * selection. Only the Markdown marks Noema can round-trip are recognized.
 */
export function resolveMarkdownFormatSelection(
  source: string,
  from: number,
  to: number,
): MarkdownFormatSelection {
  const range = clampedRange(source, from, to);
  let outerFrom = range.from;
  let outerTo = range.to;
  let contentFrom = range.from;
  let contentTo = range.to;
  const types: FormatPainterType[] = [];

  let changed = true;
  while (changed && contentFrom < contentTo) {
    changed = false;
    for (const marker of MARKERS) {
      if (types.includes(marker.type)) continue;
      if (canPeel(source, contentFrom, contentTo, outerFrom, outerTo, marker, true)) {
        contentFrom += marker.open.length;
        contentTo -= marker.close.length;
        types.push(marker.type);
        changed = true;
        break;
      }
      if (canPeel(source, contentFrom, contentTo, outerFrom, outerTo, marker, false)) {
        outerFrom -= marker.open.length;
        outerTo += marker.close.length;
        types.push(marker.type);
        changed = true;
        break;
      }
    }
  }

  return { outerFrom, outerTo, contentFrom, contentTo, types };
}

export function captureMarkdownFormat(
  source: string,
  from: number,
  to: number,
): FormatPainterSnapshot | undefined {
  const selection = resolveMarkdownFormatSelection(source, from, to);
  if (selection.contentFrom === selection.contentTo) return undefined;
  return getCommonFormatPainterSnapshot([{ styles: {}, types: selection.types }]);
}

/** Build one transaction that clears the target marks and paints the copy. */
export function applyMarkdownFormat(
  source: string,
  from: number,
  to: number,
  snapshot: FormatPainterSnapshot,
): MarkdownFormatChange | undefined {
  const selection = resolveMarkdownFormatSelection(source, from, to);
  if (selection.contentFrom === selection.contentTo) return undefined;
  const content = source.slice(selection.contentFrom, selection.contentTo);
  const requested = FORMAT_PAINTER_TYPES.filter((type) => snapshot.types.includes(type));
  // Code spans are literal; combining them with presentation marks would show
  // the other delimiters rather than applying them.
  const types = requested.includes("code") ? ["code" as const] : requested;
  let prefix = "";
  let suffix = "";
  for (const type of types) {
    const marker = markerFor(type);
    prefix += marker.open;
    suffix = marker.close + suffix;
  }
  return {
    from: selection.outerFrom,
    to: selection.outerTo,
    insert: `${prefix}${content}${suffix}`,
    selectionFrom: selection.outerFrom + prefix.length,
    selectionTo: selection.outerFrom + prefix.length + content.length,
  };
}
