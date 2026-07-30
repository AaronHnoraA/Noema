export type LatexMarkSpec = {
  placement: "between" | "prefix" | "block" | "block-once";
  latex: string;
  symbol: string;
  label: string;
};
export const LATEX_MARKS: Readonly<Record<string, LatexMarkSpec>>;
export function latexMark(name: unknown): LatexMarkSpec | null;
export function latexMarkNames(): string[];
export function latexMarkSnippetDefinitions(): Array<{ key: string; name: string; body: string }>;
