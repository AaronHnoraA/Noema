import type { MacroBinding, MacroOriginFrame } from "./types.js";
export declare const DEFAULT_MACRO_EXPANSION_MAX_DEPTH = 100;
export type MacroExpansionTraceEvent = {
    macroName: string;
    provenance: MacroOriginFrame[];
};
export type MacroExpansionOptions = {
    maxDepth?: number;
    trace?: MacroExpansionTraceEvent[];
};
export declare function expandMacroBindings(input: string, bindings: ReadonlyMap<string, MacroBinding>, opts?: MacroExpansionOptions): string;
export declare function isControlSequenceToken(raw: string): boolean;
