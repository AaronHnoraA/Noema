export type RectLike = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

export const BLANK_SELECTION_PROBE_LIMIT = 4096;

/** Inside rendered output WebKit owns the selection. For a range across DOM
 * nodes, position the toolbar at the moving end without laying out every box. */
export function nativeSelectionRect(range: Range, focusAtStart: boolean): DOMRect | null {
  const shortText = range.startContainer === range.endContainer
    && range.startContainer.nodeType === Node.TEXT_NODE
    && range.endOffset - range.startOffset <= BLANK_SELECTION_PROBE_LIMIT;
  if (shortText && !range.toString().trim()) return null;
  const anchor = shortText ? range : range.cloneRange();
  if (!shortText) anchor.collapse(focusAtStart);
  const rect = anchor.getBoundingClientRect();
  return rect.width || rect.height ? rect : null;
}

/**
 * The smallest box containing every non-empty rect, or null when there is none.
 *
 * The floating selection toolbar anchors to this. It exists because the editor
 * runs CodeMirror's `drawSelection`, which hides the browser's own selection and
 * paints its own boxes — so the selection's screen position has to be read off
 * what CodeMirror painted (or off `coordsAtPos`), never off a DOM Range.
 */
export function unionSelectionRect(boxes: Iterable<RectLike>): DOMRect | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const box of boxes) {
    if (!box) continue;
    // A zero-size rect is a collapsed cursor or an unrendered line, not part of
    // the selection's extent.
    if (box.right - box.left <= 0 && box.bottom - box.top <= 0) continue;
    left = Math.min(left, box.left);
    top = Math.min(top, box.top);
    right = Math.max(right, box.right);
    bottom = Math.max(bottom, box.bottom);
  }
  if (left === Infinity) return null;
  return new DOMRect(left, top, Math.max(0, right - left), Math.max(0, bottom - top));
}
