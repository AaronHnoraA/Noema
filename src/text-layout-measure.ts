import type { PreparedText, PreparedTextWithSegments } from "@chenglou/pretext";

/** Shared, bounded paragraph measurements for layout decisions. It never
 * replaces the editor's line breaking or measures rich DOM widgets. */
const CACHE_LIMIT = 64;
const MAX_TEXT_LENGTH = 16_384;
const cache = new Map<string, PreparedText>();
const flowCache = new Map<string, PreparedTextWithSegments>();
let engine: Promise<typeof import("@chenglou/pretext")> | null = null;

export async function measureTextBlock(text: string, font: string, width: number, lineHeight: number): Promise<{ height: number; lineCount: number } | null> {
  if (!text || text.length > MAX_TEXT_LENGTH || !font || !Number.isFinite(width) || width <= 0 ||
      !Number.isFinite(lineHeight) || lineHeight <= 0) return null;
  const { layout, prepare } = await (engine ??= import("@chenglou/pretext"));
  const key = `${font}\0${text}`;
  let prepared = cache.get(key);
  if (prepared) {
    cache.delete(key);
    cache.set(key, prepared);
  } else {
    prepared = prepare(text, font);
    cache.set(key, prepared);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  }
  return layout(prepared, width, lineHeight);
}

/** Suggest a grid width only on an explicit layout action. The browser still
 * owns the final layout, and each column remains ordinary Markdown content. */
export async function suggestTextColumns(text: string, font: string, width: number, lineHeight: number): Promise<2 | 3 | 4> {
  if (!Number.isFinite(width) || width < 560) return 2;
  let best: 2 | 3 | 4 = 2;
  let bestScore = Infinity;
  for (const columns of [2, 3, 4] as const) {
    const columnWidth = (width - 16 * (columns - 1)) / columns;
    if (columnWidth < 220) continue;
    const result = await measureTextBlock(text, font, columnWidth, lineHeight);
    if (!result) return 2;
    // Prefer readable column widths; avoid a very tall, narrow flow.
    const score = result.height / columns + Math.max(0, 300 - columnWidth) * 0.75;
    if (score < bestScore) { best = columns; bestScore = score; }
  }
  return best;
}

/** Estimate unequal text-column tracks without repeatedly mounting DOM or
 * reading layout. The result is advisory; CSS renders and measures the final
 * mixed Markdown blocks. */
export async function balanceTextColumns(
  texts: readonly string[], font: string, totalWidth: number, lineHeight: number, gap = 16,
): Promise<readonly number[] | null> {
  if (texts.length < 2 || texts.length > 4 || !Number.isFinite(totalWidth) || totalWidth <= 0) return null;
  const available = totalWidth - gap * (texts.length - 1);
  if (available < texts.length * 160) return null;
  const measureWidth = available / texts.length;
  const heights = await Promise.all(texts.map((text) => measureTextBlock(text, font, measureWidth, lineHeight)));
  if (heights.some((value) => !value)) return null;
  const weights = heights.map((value) => Math.sqrt(Math.max(1, value!.height)));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const floor = 100 / texts.length * 0.6;
  const flex = 100 - floor * texts.length;
  return weights.map((weight) => floor + flex * weight / total);
}

/** Variable-width text estimate for future and current media wrap decisions.
 * No DOM reads or CM6 line breaks occur inside this service. */
export async function measureVariableWidthText(
  text: string, font: string, lineHeight: number, widthForLine: (line: number) => number,
): Promise<{ height: number; lineCount: number } | null> {
  if (!text || text.length > MAX_TEXT_LENGTH || !font || !Number.isFinite(lineHeight) || lineHeight <= 0) return null;
  const { prepareWithSegments, layoutNextLineRange } = await (engine ??= import("@chenglou/pretext"));
  const key = `${font}\0${text}`;
  let prepared = flowCache.get(key);
  if (prepared) {
    flowCache.delete(key);
    flowCache.set(key, prepared);
  } else {
    prepared = prepareWithSegments(text, font);
    flowCache.set(key, prepared);
    if (flowCache.size > CACHE_LIMIT) flowCache.delete(flowCache.keys().next().value!);
  }
  let cursor = { segmentIndex: 0, graphemeIndex: 0 };
  let lineCount = 0;
  while (lineCount < 4_096) {
    const width = widthForLine(lineCount);
    if (!Number.isFinite(width) || width <= 0) return null;
    const range = layoutNextLineRange(prepared, cursor, width);
    if (!range) return { lineCount, height: lineCount * lineHeight };
    if (range.end.segmentIndex === cursor.segmentIndex && range.end.graphemeIndex === cursor.graphemeIndex) return null;
    cursor = range.end;
    lineCount++;
  }
  return null;
}
