export type SimilarityNote = {
  title?: string;
  aliases?: string[];
  kind?: string;
  file?: string;
};

export const SIMILAR_TITLE_THRESHOLD: number;
export const SIMILAR_PAGE_THRESHOLD: number;

export function tokenize(value: unknown): Set<string>;
export function rareTokenWeight(population: number, documentFrequency: number): number;
export function titleSimilarity(left: unknown, right: unknown): number;
export function similarTitles<T extends SimilarityNote>(
  title: unknown,
  notes: readonly T[] | null | undefined,
  options?: { threshold?: number; limit?: number },
): Array<{ note: T; score: number; name: string }>;
export function similarTitlePairs<T extends SimilarityNote>(
  notes: readonly T[] | null | undefined,
  options?: { threshold?: number; limit?: number },
): Array<{ left: T; right: T; score: number }>;
