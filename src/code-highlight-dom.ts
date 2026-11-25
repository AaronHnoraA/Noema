import { highlightCodeForEditor } from "./code-highlight-async.ts";

export function renderHighlightedCode(element: HTMLElement, source: string, language: string): void {
  const doc = element.ownerDocument;
  const fragment = doc.createDocumentFragment();
  let position = 0;
  for (const range of highlightCodeForEditor(language, source)) {
    if (range.from > position) fragment.append(doc.createTextNode(source.slice(position, range.from)));
    const span = doc.createElement("span");
    span.className = range.className;
    span.textContent = source.slice(range.from, range.to);
    fragment.append(span);
    position = range.to;
  }
  if (position < source.length) fragment.append(doc.createTextNode(source.slice(position)));
  element.replaceChildren(fragment);
}
