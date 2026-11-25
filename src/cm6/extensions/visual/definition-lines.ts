import { StateField, type EditorState, type Text } from "@codemirror/state";
import { indexMarkdownDefinitionLines, type DefinitionSourceLine } from "../../../render-html.ts";
import { isIsolatedProseEdit } from "./isolated-prose-edit.ts";

const sourceDefinitions = new WeakMap<Text, ReadonlyMap<number, DefinitionSourceLine> | null>();

function definitionLinesFromText(doc: Text): ReadonlyMap<number, DefinitionSourceLine> | null {
  const cached = sourceDefinitions.get(doc);
  if (cached !== undefined) return cached;
  const indexed = indexMarkdownDefinitionLines(doc.toString());
  sourceDefinitions.set(doc, indexed);
  return indexed;
}

export const renderedDefinitionLines = StateField.define<ReadonlyMap<number, DefinitionSourceLine> | null>({
  create: (state) => definitionLinesFromText(state.doc),
  update(previous, transaction) {
    if (!transaction.docChanged || isIsolatedProseEdit(transaction)) return previous;
    return definitionLinesFromText(transaction.newDoc);
  },
});

export function definitionLinesFromState(state: EditorState): ReadonlyMap<number, DefinitionSourceLine> | null {
  const indexed = state.field(renderedDefinitionLines, false);
  return indexed === undefined ? definitionLinesFromText(state.doc) : indexed;
}
