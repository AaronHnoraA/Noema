import { KnuthPlassVisitor } from './KnuthPlassVisitor.js';
import type { ParagraphLayoutReport } from './paragraph/report.js';
import type { ParagraphAlignment } from './alignment.js';
import { clearKnuthPlassCaretMappingCache, getKnuthPlassCaretFromPoint, getKnuthPlassLineRangeFromPoint, getKnuthPlassPointFromOffset, getKnuthPlassSelectionRects, type CaretFromPointParams, type CaretHitResult, type LineRangeFromPointResult, type CaretPointResult, type PointFromOffsetParams, type SelectionRectsParams, type SelectionRectsResult } from './editor/hitmap.js';
export type OutputJaxName = 'svg' | 'chtml';
export type KnuthPlassLayoutMode = 'wrap' | 'fixed-lines' | 'wrapped-explicit';
export interface WrappedTextGap {
    sourceStart: number;
    widthEm: number;
    stretchEm?: number;
    shrinkEm?: number;
    spaceFactor?: number;
}
export interface KnuthPlassConfig {
    alignment?: ParagraphAlignment;
    layoutMode?: KnuthPlassLayoutMode;
    wrappedTextGaps?: WrappedTextGap[];
    pretolerance?: number;
    tolerance?: number;
    linepenalty?: number;
    hyphenpenalty?: number;
    exhyphenpenalty?: number;
    adjdemerits?: number;
    doublehyphendemerits?: number;
    finalhyphendemerits?: number;
    lefthyphenmin?: number;
    righthyphenmin?: number;
}
export interface MathJaxOutputConfig {
    linebreaks?: {
        LinebreakVisitor?: typeof KnuthPlassVisitor;
        [key: string]: unknown;
    };
    [key: string]: unknown;
}
export interface MathJaxConfigLike {
    svg?: MathJaxOutputConfig;
    chtml?: MathJaxOutputConfig;
    [key: string]: unknown;
}
export declare function installKnuthPlassVisitor(config: MathJaxConfigLike, outputs?: OutputJaxName[]): MathJaxConfigLike;
export declare function setKnuthPlassOptionsOnOutputJax(outputJax: unknown, options: KnuthPlassConfig | null | undefined): void;
export declare function getKnuthPlassReportsFromOutputJax(outputJax: unknown): ParagraphLayoutReport[];
export { getKnuthPlassCaretFromPoint, getKnuthPlassLineRangeFromPoint, getKnuthPlassPointFromOffset, getKnuthPlassSelectionRects, clearKnuthPlassCaretMappingCache, type CaretFromPointParams, type PointFromOffsetParams, type SelectionRectsParams, type CaretHitResult, type LineRangeFromPointResult, type CaretPointResult, type SelectionRectsResult, };
