export type WikiLinkMatch = {
  from: number;
  to: number;
  target: string;
  label: string;
  href: string;
  targetFrom: number;
  targetTo: number;
  labelFrom: number;
  labelTo: number;
  pipe: number;
  explicitLabel: boolean;
};

export function wikiHrefForTarget(value: unknown): string;
export function scanWikiLinks(value: unknown, offset?: number): WikiLinkMatch[];
export function wikiLinkAt(value: unknown, position: number, offset?: number): WikiLinkMatch | null;
export function stableWikiTarget(pageId: unknown): string;
export function formatStableWikiLink(pageId: unknown, label: unknown): string;
export function normalizeWikiNamespace(value: unknown): string;
export function qualifiedWikiTitle(namespace: unknown, title: unknown): string;
export function splitQualifiedWikiTarget(value: unknown, knownNamespaces?: unknown[]): {
  target: string;
  namespace: string;
  title: string;
  qualified: boolean;
};
