import type { Text } from "@codemirror/state";
import { indexMarkdownDefinitionLines, type DefinitionSourceLine } from "../../../render-html.ts";

const sourceDefinitions = new WeakMap<Text, ReadonlyMap<number, DefinitionSourceLine> | null>();

export function definitionLinesFromText(doc: Text): ReadonlyMap<number, DefinitionSourceLine> | null {
  const cached = sourceDefinitions.get(doc);
  if (cached !== undefined) return cached;
  const indexed = indexMarkdownDefinitionLines(doc.toString());
  sourceDefinitions.set(doc, indexed);
  return indexed;
}
