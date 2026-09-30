export type MathDelimiterKind = 'dollar' | 'paren';
export interface TextSourceSpan {
    kind: 'text';
    rawStart: number;
    rawEnd: number;
    text: string;
}
export interface MathSourceSpan {
    kind: 'math';
    rawStart: number;
    rawEnd: number;
    delimiter: MathDelimiterKind;
    contentStart: number;
    contentEnd: number;
    source: string;
    content: string;
}
export type SourceSpan = TextSourceSpan | MathSourceSpan;
export interface SourceParseError {
    code: 'unclosed-math' | 'unexpected-close-delimiter';
    message: string;
    index: number;
}
export interface SourceParseResult {
    spans: SourceSpan[];
    error: SourceParseError | null;
}
export declare function parseSourceSpans(sourceText: string): SourceParseResult;
