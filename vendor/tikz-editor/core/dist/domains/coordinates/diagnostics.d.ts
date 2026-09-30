import type { SyntaxNode } from "@lezer/common";
import type { Diagnostic } from "../../diagnostics/types.js";
export declare function collectCoordinateDiagnostics(root: SyntaxNode, source: string, diagnostics: Diagnostic[]): void;
