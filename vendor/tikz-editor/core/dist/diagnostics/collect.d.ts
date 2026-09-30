import type { SyntaxNode } from "@lezer/common";
import type { Diagnostic } from "./types.js";
export declare function collectParseErrorDiagnostics(node: SyntaxNode, source: string, diagnostics: Diagnostic[]): void;
export declare function collectStructuralDiagnostics(envNode: SyntaxNode, source: string, diagnostics: Diagnostic[]): void;
