import { StateField, type EditorState, type Text } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";
import { markdownLinkDestination } from "../../../markdown-link.ts";
import { indexMarkdownDocumentReferences, type MarkdownDocumentReferences } from "../../../render-html.ts";

const referenceIndexes = new WeakMap<Text, MarkdownDocumentReferences | null>();

export function documentReferencesForText(doc: Text): MarkdownDocumentReferences | null {
  const cached = referenceIndexes.get(doc);
  if (cached !== undefined) return cached;
  const indexed = indexMarkdownDocumentReferences(doc.toString());
  referenceIndexes.set(doc, indexed);
  return indexed;
}

/** Only the effective labels and link targets invalidate rendered fragments. */
export const renderedDocumentReferences = StateField.define<MarkdownDocumentReferences | null>({
  create: (state) => documentReferencesForText(state.doc),
  update(previous, transaction) {
    if (!transaction.docChanged) return previous;
    const next = documentReferencesForText(transaction.newDoc);
    return next?.signature === previous?.signature ? previous : next;
  },
});

/** Resolve a full, collapsed or shortcut reference using Markdown's document scope. */
export function markdownLinkNodeDestination(state: EditorState, node: SyntaxNode): string {
  const url = node.getChild("URL");
  if (url) return markdownLinkDestination(state.doc.sliceString(url.from, url.to), { stripTitle: false });
  const explicit = node.getChild("LinkLabel");
  const marks = node.getChildren("LinkMark");
  const opening = marks[0];
  const closing = marks[1];
  if (!opening || !closing || (!explicit && (marks.length !== 2 || closing.to !== node.to))) return "";
  const raw = explicit ? state.doc.sliceString(explicit.from + 1, explicit.to - 1) : "";
  const label = (raw || state.doc.sliceString(opening.to, closing.from)).trim().replace(/\s+/g, " ")
    .toLowerCase().toUpperCase();
  const definitions = state.field(renderedDocumentReferences, false);
  const references = definitions === undefined ? documentReferencesForText(state.doc) : definitions;
  return references?.links[label]?.href ?? "";
}
