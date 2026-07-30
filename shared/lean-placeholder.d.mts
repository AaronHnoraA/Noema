export const DEFAULT_LEAN_SELECTOR: "";

export type ParsedLeanPlaceholderLine = {
  commandFrom: number;
  commandTo: number;
  selector: string;
  tag: string;
  bracketed: boolean;
  bareTag: boolean;
};

export type MarkdownLeanPlaceholder = {
  tag: string;
  selector: string;
  rawSelector: string;
  from: number;
  to: number;
  lineFrom: number;
  lineTo: number;
  lineNo: number;
};

export function parseLeanPlaceholderLine(line: string): ParsedLeanPlaceholderLine | null;

export function formatLeanPlaceholder(selector: string, tag: string, leading?: string): string;

export function normalizeLeanPlaceholderLine(line: string): string | null;

export function normalizeLeanSelector(value: string): string;

export function isLeanNewfileSelector(selector: string): boolean;

export function leanNewfileId(selector: string): number | null;

export function canonicalLeanSelector(selector: string): string;

export function scanMarkdownLeanPlaceholders(markdown: string): MarkdownLeanPlaceholder[];
