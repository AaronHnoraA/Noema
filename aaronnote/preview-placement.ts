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
