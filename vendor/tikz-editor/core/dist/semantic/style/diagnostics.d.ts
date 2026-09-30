import type { Span } from "../../ast/types.js";
export type StyleDiagnostic = {
    code: string;
    span?: Span;
};
export type StyleDiagnosticInput = string | StyleDiagnostic;
export declare function styleDiagnosticCode(diagnostic: StyleDiagnosticInput): string;
export declare function normalizeStyleDiagnostic(diagnostic: StyleDiagnosticInput, fallbackSpan?: Span): StyleDiagnostic;
export declare function styleDiagnosticSpan(diagnostic: StyleDiagnostic, fallbackSpan: Span): Span;
