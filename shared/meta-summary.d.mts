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

export interface MetaSummaryOptions { isExcluded?: (offset: number) => boolean; }

export function orgMetaSummaryRangeFromLines(doc: LineDocument, options?: MetaSummaryOptions): MetaSummarySourceRange | null;
export function orgMetaSummaryRange(markdown: string, options?: MetaSummaryOptions): MetaSummarySourceRange | null;
export function maskMetaSummaryContent(markdown: string): string;
