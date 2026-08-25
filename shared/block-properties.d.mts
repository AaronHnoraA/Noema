export type PortableBlockPropertyDefinition = {
  canonicalId: string;
  line: number;
  index: number;
  kind: string;
  orgEnv: boolean;
  text: string;
  properties: Record<string, string>;
};

export function scanBlockPropertyDefinitions(source?: string): {
  definitions: PortableBlockPropertyDefinition[];
  duplicateDefinitionIds: string[];
};

export function blockPropertyItemsForDocument(source: string, context?: {
  file?: string;
  noteTitle?: string;
}): Array<Record<string, unknown>>;

export function patchBlockPropertySource(source: string, patch: {
  id: string;
  key: string;
  value?: string | null;
}): {
  from: number;
  to: number;
  source: string;
  nextSource: string;
  markdown: string;
  definition: PortableBlockPropertyDefinition;
};
