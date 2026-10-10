import { knowledgeQueryTextTerms } from "../shared/knowledge-query.mjs";

/**
 * Show a search excerpt with the query's free-text terms marked.
 *
 * The index brackets its hit with `[[`…`]]`, but a note body uses the same
 * brackets for Wiki links, so the brackets cannot say which words matched.
 * They are dropped and the terms are found again in the visible text.  The
 * excerpt is built from text nodes; nothing in it is parsed as markup.
 */
export function renderSearchExcerpt(host: HTMLElement, excerpt: string, query: string): void {
  const text = String(excerpt || "").replaceAll("[[", "").replaceAll("]]", "");
  const terms = [...new Set(knowledgeQueryTextTerms(String(query || "")))]
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);
  host.replaceChildren();
  if (!terms.length) {
    host.textContent = text;
    return;
  }
  const folded = text.toLocaleLowerCase();
  // Case folding can change a string's length (İ → i̇); offsets would then
  // point at the wrong characters, so such an excerpt is shown unmarked.
  if (folded.length !== text.length) {
    host.textContent = text;
    return;
  }
  let position = 0;
  while (position < text.length) {
    let hit = -1;
    let length = 0;
    for (const term of terms) {
      const at = folded.indexOf(term, position);
      if (at >= 0 && (hit < 0 || at < hit)) { hit = at; length = term.length; }
    }
    if (hit < 0) break;
    if (hit > position) host.append(text.slice(position, hit));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(hit, hit + length);
    host.append(mark);
    position = hit + length;
  }
  if (position < text.length) host.append(text.slice(position));
}
