export const AARONNOTE_ACCEPTED_WORDS: string[];

export function maskAaronnoteProse(text: string): string;

export function lineStartOffsets(text: string): number[];

export function offsetFromLineColumn(text: string, line: number, column: number): number;

export function rangeHasCheckedText(masked: string, from: number, to: number): boolean;

export function collectBrowserSpellWords(
  masked: string,
  limit?: number,
): Array<{ word: string; ranges: Array<{ from: number; to: number }> }>;
