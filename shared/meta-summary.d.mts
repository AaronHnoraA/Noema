export const ORG_META_PREAMBLE_LINE_LIMIT: number;

export interface LineDocument {
  lines: number;
  line(number: number): { from: number; to: number; text: string };
}

export interface MetaSummarySourceRange {
  from: number;
  to: number;
  bodyFrom: number;
  bodyTo: number;
}

export function orgMetaSummaryRangeFromLines(doc: LineDocument): MetaSummarySourceRange | null;
export function orgMetaSummaryRange(markdown: string): MetaSummarySourceRange | null;
export function maskMetaSummaryContent(markdown: string): string;
