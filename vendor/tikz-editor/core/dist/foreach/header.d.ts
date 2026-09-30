import type { Span } from "../ast/types.js";
export type ParsedForeachHeaderRaw = {
    headerRaw: string;
    variablesRaw: string;
    listRaw: string;
    optionsRaw?: string;
    optionsSpan?: Span;
    isValid: boolean;
};
export declare function stripForeachCommandPrefix(raw: string): string;
export declare function parseForeachHeaderRaw(raw: string): ParsedForeachHeaderRaw;
