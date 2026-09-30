import type { Span } from "../ast/types.js";
import type { OptionListAst } from "../options/types.js";
import type { ForeachExpansionDiagnostic, ForeachIterationBinding } from "./types.js";
type EvaluateRule = {
    variable: string;
    target: string;
    expression: string;
    span: Span;
};
type RememberRule = {
    variable: string;
    target: string;
    initial: string;
    span: Span;
};
type CountRule = {
    target: string;
    current: number;
    span: Span;
};
export type ForeachOptionsConfig = {
    variablesFromOptions: string[];
    evaluateRules: EvaluateRule[];
    rememberRules: RememberRule[];
    countRules: CountRule[];
    parseExpressions: boolean;
    expandList: boolean;
    diagnostics: ForeachExpansionDiagnostic[];
};
export type ForeachIteration = {
    index: number;
    bindings: ForeachIterationBinding;
};
export declare function parseForeachOptions(options: OptionListAst | undefined): ForeachOptionsConfig;
export declare function resolveForeachVariables(raw: string, config: ForeachOptionsConfig): string[];
export declare function buildForeachIterations(params: {
    variablesRaw: string;
    listRaw: string;
    options: OptionListAst | undefined;
    baseBindings: ForeachIterationBinding;
    loopSpan: Span;
}): {
    iterations: ForeachIteration[];
    diagnostics: ForeachExpansionDiagnostic[];
};
export {};
