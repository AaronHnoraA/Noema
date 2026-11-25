import type { AttrMap } from "./layout-attrs.mjs";

export type DocumentComponentDefinition = { role: "definition"; name: string; kind: string; defaults: AttrMap };
export type DocumentComponentInstance = { role: "instance"; name: string; title: string; properties: AttrMap };
export type DocumentComponentDefinitions = ReadonlyMap<string, DocumentComponentDefinition>;

export function parseDocumentComponentHeader(source: string): DocumentComponentDefinition | DocumentComponentInstance | null;
export function collectDocumentComponents(source: string): DocumentComponentDefinitions;
export function resolveDocumentComponent(source: string, definitions?: DocumentComponentDefinitions): {
  kind: string;
  title: string;
  attrs: AttrMap;
} | null;
