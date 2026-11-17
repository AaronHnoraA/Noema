export interface ResolvedEdit { from: number; to: number; oldText: string; newText: string }
export const LARGE_CHANGE: { lines: number; fraction: number; minLines: number };
export function resolveEdits(source: string, edits: unknown[], position: (source: string, value: unknown) => number): ResolvedEdit[];
export function largeChange(before: string, after: string, changedLines: number): boolean;
