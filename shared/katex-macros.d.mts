export type KatexMacroFile = { name: string; text: string };

export type KatexMacroParseResult = {
  macros: Record<string, string>;
  errors: { file: string; message: string }[];
};

export function parseLatexMacros(files: KatexMacroFile[]): KatexMacroParseResult;
