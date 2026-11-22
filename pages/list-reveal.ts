/**
 * Bring ROW into view inside its scrolling LIST, moving only that list.
 *
 * `row.scrollIntoView()` scrolls every scrollable ancestor until the row is
 * visible: a popup's list near a screen edge also scrolled the editor or the
 * page under it, so each arrow key in a completion, reference or tag list made
 * the whole page jump. Lists use this instead
 * (tests/architecture-list-reveal.test.ts).
 */
export function revealInList(boundary: HTMLElement, row: HTMLElement | null | undefined): void {
  if (!row) return;
  // The element that scrolls: the nearest scrollable ancestor of ROW, never
  // anything outside BOUNDARY.
  let list: HTMLElement = boundary;
  for (let node = row.parentElement; node; node = node.parentElement) {
    if (node.scrollHeight > node.clientHeight && /auto|scroll/.test(getComputedStyle(node).overflowY)) {
      list = node;
      break;
    }
    if (node === boundary) break;
  }
  if (list.clientHeight <= 0) return;
  const listRect = list.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const top = rowRect.top - listRect.top + list.scrollTop;
  const bottom = top + rowRect.height;
  if (top < list.scrollTop) list.scrollTop = top;
  else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
}
