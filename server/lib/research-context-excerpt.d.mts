export function excerptRanges(
  bytes: Buffer,
  payloadBytes: number,
  terms: string[],
  gapBytes: number,
): Array<[number, number]> | null;
export function cutToBudget(
  bytes: Buffer,
  maxBytes: number,
  options: { note: string; terms?: string[]; fullText?: string; keepEnd?: boolean },
): { bytes: Buffer; reason: string };
