import type { KatexMacroParseResult } from "./katex-macros.mjs";

export const NOTE_MACROS_FROM_KEY: string;
export const NOTE_MACRO_SOURCE_EXTENSIONS: RegExp;
export const NOTE_MACROS_FROM_LIMIT: number;

export type NoteMacroSpec = {
  metaFrom: number;
  metaTo: number;
  metaCloseFrom: number;
  from: string[];
  fromLine: { from: number; to: number } | null;
  block: { from: number; to: number; bodyFrom: number; bodyTo: number } | null;
  text: string;
};

export function noteMacroSpec(markdown: string): NoteMacroSpec | null;
export function parseNoteLocalMacros(markdown: string): KatexMacroParseResult;
export function filterClassMacros(macros: Record<string, string>): Record<string, string>;
export function macroArity(body: string): number;
export function validMacroName(name: string): boolean;
export function balancedMacroBody(body: string): boolean;
export function serializeMacroDefinition(name: string, body: string): string;
export function serializeMacroDefinitions(macros: Record<string, string>): string;
export function noteMacroBlockEdit(
  markdown: string,
  macros: Record<string, string>,
): { from: number; to: number; insert: string } | null;
