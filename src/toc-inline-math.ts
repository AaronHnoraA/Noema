import { scanInlineMathRanges } from "./inline-math.ts";
import { renderMathHTML } from "./math-render.ts";

/** Render canonical Noema inline math (`\(...\)`) inside a TOC label.
 *
 * Text is always appended through text nodes. The only HTML insertion is the
 * trusted KaTeX output produced by the same renderer used by the editor.
 */
export function renderTocInlineMath(target: HTMLElement, source: string, fallback = ""): void {
  const text = source || fallback;
  const ranges = scanInlineMathRanges(text);
  if (ranges.length === 0) {
    target.textContent = text;
    return;
  }

  const fragment = document.createDocumentFragment();
  let cursor = 0;
  for (const range of ranges) {
    if (range.from > cursor) fragment.append(document.createTextNode(text.slice(cursor, range.from)));

    const math = document.createElement("span");
    math.className = "aaronnote-toc-math";
    const rendered = renderMathHTML(range.tex, { displayMode: false });
    if (rendered.error) {
      math.classList.add("is-error");
      math.textContent = text.slice(range.from, range.to);
      math.title = rendered.error;
    } else {
      math.innerHTML = rendered.html;
    }
    fragment.append(math);
    cursor = range.to;
  }
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  target.replaceChildren(fragment);
}
