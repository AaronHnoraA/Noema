import type { ForeachIterationBinding } from "./types.js";
export declare function substituteForeachBindings(input: string, bindings: Partial<ForeachIterationBinding>): string;
export type ForeachSubstitutionResult = {
    output: string;
    mapSpan: (span: {
        from: number;
        to: number;
    }) => {
        from: number;
        to: number;
    } | null;
};
export declare function substituteForeachBindingsWithMap(input: string, bindings: Partial<ForeachIterationBinding>): ForeachSubstitutionResult;
