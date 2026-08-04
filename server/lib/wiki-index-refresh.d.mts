export const DEFAULT_WIKI_FULL_REFRESH_PROBABILITY: number;
export function wikiFullRefreshProbability(value?: unknown): number;
export function wikiMutationFiles(
  result?: Record<string, any> | null,
  fallbackFiles?: readonly string[],
): string[];
export function coalesceWikiRefreshMode(
  current?: "auto" | "incremental" | "full",
  requested?: "auto" | "incremental" | "full",
): "auto" | "incremental" | "full";
export function wikiSyncIndexRefreshPlan(
  result?: Record<string, any> | null,
  options?: { fullProbability?: number; random?: () => number },
): {
  mode: "incremental" | "full";
  changedFiles: string[];
  fullProbability: number;
} | null;
