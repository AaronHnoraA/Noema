export type KnowledgeQueryClause = {
  raw: string;
  negative: boolean;
  field: "" | "title" | "tag" | "repo" | "namespace" | "path" | "kind" | "is" | "linksto";
  value: string;
};

export type ParsedKnowledgeQuery = { source: string; clauses: KnowledgeQueryClause[] };

export function parseKnowledgeQuery(value: unknown): ParsedKnowledgeQuery;
export function knowledgeEntityMatches(
  entity: Record<string, unknown>,
  query: string | ParsedKnowledgeQuery,
  options?: { degree?: number },
): boolean;
export function knowledgeQueryTextTerms(query: string | ParsedKnowledgeQuery): string[];
