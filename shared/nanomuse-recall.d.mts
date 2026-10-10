export const RRF_K: number;
export function tokenize(text: unknown): Set<string>;
export function similarity(a: unknown, b: unknown): number;
export function sameStem(word: string, allowed: Iterable<string>): boolean;
export function search<T extends { id: string; content: string; createdAt?: string }>(items: T[], query: string, limit?: number): T[];
export function fuse<T extends { id: string }>(rankings: T[][], limit: number): T[];
export function standouts<T extends { score: number }>(scored: T[], limit: number): T[];
