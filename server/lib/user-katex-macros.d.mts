type MacroMap = Record<string, string>;
type MacroError = { file: string; message: string };
type ConfigOptions = { configDir?: string; env?: Record<string, string | undefined> };

export const USER_KATEX_MACROS_FILE_NAME: string;
export const USER_KATEX_MACROS_LIMIT: number;
export const USER_KATEX_MACRO_BODY_LIMIT: number;
export const MACRO_SOURCE_BYTES_LIMIT: number;

export function userKatexMacrosFile(options?: ConfigOptions): string;
export function loadUserKatexMacros(options?: ConfigOptions): Promise<{ file: string; macros: MacroMap; errors: MacroError[] }>;
export function normalizeUserKatexMacros(input: unknown): MacroMap;
export function saveUserKatexMacros(input: unknown, options?: ConfigOptions): Promise<{ file: string; macros: MacroMap; errors: MacroError[] }>;
export function readLocalMacroSource(path: string): Promise<string>;
export function loadMacroSourceFiles(
  names: string[],
  read: (name: string) => Promise<string>,
): Promise<{ macros: MacroMap; errors: MacroError[]; files: string[] }>;
