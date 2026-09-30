import type { Span } from "../ast/types.js";
export declare function replaceSpan(source: string, span: Span, replacement: string): {
    source: string;
    changedSpan: Span;
};
