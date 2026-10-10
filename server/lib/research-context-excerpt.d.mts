export function excerptRanges(
  bytes: Buffer,
  payloadBytes: number,
  terms: string[],
  gapBytes: number,
): Array<[number, number]> | null;
