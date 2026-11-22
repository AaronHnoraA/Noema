export type FloatingBox = { left: number; top: number; width: number; height: number };

function overlaps(a: FloatingBox, b: FloatingBox): boolean {
  return a.left < b.left + b.width && a.left + a.width > b.left
    && a.top < b.top + b.height && a.top + a.height > b.top;
}

/** Keep the preview still unless completion actually covers it. */
export function previewPlacement(
  preferred: FloatingBox,
  completion: FloatingBox | null,
  viewport: { width: number; height: number },
  sourceBand: { top: number; bottom: number },
): { left: number; top: number } | null {
  if (!completion || !overlaps(preferred, completion)) {
    return { left: preferred.left, top: preferred.top };
  }
  const margin = 8;
  const maxLeft = viewport.width - preferred.width - margin;
  const maxTop = viewport.height - preferred.height - margin;
  if (maxLeft < margin || maxTop < margin) return null;
  const clampX = (x: number) => Math.max(margin, Math.min(maxLeft, x));
  const clampY = (y: number) => Math.max(margin, Math.min(maxTop, y));
  const xs = [preferred.left, completion.left - preferred.width - margin,
    completion.left + completion.width + margin, margin, maxLeft].map(clampX);
  const ys = [preferred.top, completion.top - preferred.height - margin,
    completion.top + completion.height + margin, sourceBand.top - preferred.height - margin,
    sourceBand.bottom + margin, margin, maxTop].map(clampY);
  const source = { left: 0, top: sourceBand.top, width: viewport.width,
    height: Math.max(0, sourceBand.bottom - sourceBand.top) };
  let best: { left: number; top: number } | null = null;
  let distance = Infinity;
  for (const left of xs) for (const top of ys) {
    const candidate = { ...preferred, left, top };
    if (overlaps(candidate, completion) || overlaps(candidate, source)) continue;
    const nextDistance = (left - preferred.left) ** 2 + (top - preferred.top) ** 2;
    if (nextDistance < distance) { best = { left, top }; distance = nextDistance; }
  }
  // Only a viewport with no free space suppresses the preview. Its session
  // stays alive, so closing/moving completion can reveal the same formula.
  return best;
}

export type CompletionSide = "below" | "above";

/**
 * Place the completion list beside the caret line.
 *
 * The side is chosen from the list's maximum height, not its current one, and
 * a side already in use is kept while it still fits: a list that shrinks or
 * grows as the user types never hops across the caret. Above the caret the
 * list's bottom edge stays on the line, so only its top moves.
 */
export function completionPlacement(
  caret: { left: number; top: number; bottom: number },
  size: { width: number; height: number; maxHeight: number },
  viewport: { width: number; height: number },
  previous: CompletionSide | null = null,
): { left: number; top: number; width: number; side: CompletionSide } {
  const margin = 8;
  const gap = 8;
  const width = Math.min(size.width, Math.max(220, viewport.width - margin * 2));
  const left = Math.min(Math.max(margin, caret.left), Math.max(margin, viewport.width - width - margin));
  const reserve = Math.max(size.height, size.maxHeight);
  const roomBelow = viewport.height - margin - (caret.bottom + gap);
  const roomAbove = caret.top - gap - margin;
  const fitsBelow = (need: number) => roomBelow >= need;
  const fitsAbove = (need: number) => roomAbove >= need;
  let side: CompletionSide;
  if (previous === "below" && fitsBelow(size.height)) side = "below";
  else if (previous === "above" && fitsAbove(size.height)) side = "above";
  else if (fitsBelow(reserve)) side = "below";
  else if (fitsAbove(reserve)) side = "above";
  else side = roomBelow >= roomAbove ? "below" : "above";
  let top = side === "below" ? caret.bottom + gap : caret.top - gap - size.height;
  top = Math.max(margin, Math.min(top, viewport.height - margin - size.height));
  return { left, top, width, side };
}
