import type { ResolvedPattern, ResolvedStyle } from "../types.js";
type ParsedPatternValue = {
    pattern: ResolvedPattern | null;
    recognized: boolean;
    disabled: boolean;
    diagnostics: string[];
};
export declare const DEFAULT_PATTERN: ResolvedPattern;
export declare function parsePatternValue(valueRaw: string, style: ResolvedStyle): ParsedPatternValue;
export declare function isInherentlyColoredPattern(pattern: ResolvedPattern | null): boolean;
export {};
