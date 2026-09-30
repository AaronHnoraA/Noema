import type { ClientBounds, ClientPoint } from '../../../coords/points.js';
type ClientRectLike = {
    left: number;
    right: number;
    top: number;
    bottom: number;
    width: number;
    height: number;
};
type ScreenMatrixLike = {
    a: number;
    b: number;
    c: number;
    d: number;
    e: number;
    f: number;
};
type SvgOwnerLike = {
    viewBox?: {
        baseVal?: {
            width?: number;
        };
    };
};
type Element = {
    getBoundingClientRect?(): ClientRectLike;
    getScreenCTM?(): ScreenMatrixLike | null;
    ownerSVGElement?: SvgOwnerLike | null;
    querySelector?(selector: string): Element | null;
    querySelectorAll?(selector: string): ArrayLike<Element>;
};
export interface CaretBaseParams {
    paragraphId: string;
    sourceText: string;
    containerElement: Element;
}
export interface CaretFromPointParams extends CaretBaseParams {
    clientPoint: ClientPoint;
}
export interface PointFromOffsetParams extends CaretBaseParams {
    offset: number;
}
export interface SelectionRectsParams extends CaretBaseParams {
    startOffset: number;
    endOffset: number;
}
export type CaretMappingErrorCode = 'invalid-params' | 'paragraph-not-found' | 'source-parse-error' | 'alignment-error' | 'math-measurement-error' | 'geometry-error';
export interface CaretMappingError {
    code: CaretMappingErrorCode;
    paragraphId: string;
    message: string;
}
interface ResultBase {
    ok: boolean;
    paragraphId: string;
    error: CaretMappingError | null;
}
export interface CaretHitResult extends ResultBase {
    offset: number | null;
    lineIndex: number | null;
    kind: 'text' | 'space' | 'math' | null;
    snappedToMathPrefix: boolean;
}
export interface CaretPointResult extends ResultBase {
    offset: number | null;
    lineIndex: number | null;
    lineLocalX: number | null;
    clientPoint: ClientPoint | null;
    rotationDeg: number | null;
    kind: 'text' | 'space' | 'math' | null;
    snappedToMathPrefix: boolean;
}
export interface LineRangeFromPointResult extends ResultBase {
    lineIndex: number | null;
    lineStartOffset: number | null;
    lineEndOffset: number | null;
}
export interface SelectionRect {
    lineIndex: number;
    startOffset: number;
    endOffset: number;
    bounds: ClientBounds;
    center: ClientPoint;
    rotationDeg: number;
}
export interface SelectionRectsResult extends ResultBase {
    startOffset: number;
    endOffset: number;
    rects: SelectionRect[];
}
export declare function getKnuthPlassCaretFromPoint(outputJax: unknown, params: Partial<CaretFromPointParams> | null | undefined): Promise<CaretHitResult>;
export declare function getKnuthPlassPointFromOffset(outputJax: unknown, params: Partial<PointFromOffsetParams> | null | undefined): Promise<CaretPointResult>;
export declare function getKnuthPlassSelectionRects(outputJax: unknown, params: Partial<SelectionRectsParams> | null | undefined): Promise<SelectionRectsResult>;
export declare function getKnuthPlassLineRangeFromPoint(outputJax: unknown, params: Partial<CaretFromPointParams> | null | undefined): Promise<LineRangeFromPointResult>;
export declare function clearKnuthPlassCaretMappingCache(outputJax?: unknown): void;
export declare function __getKnuthPlassCaretMappingCacheSize(outputJax: unknown): number;
export {};
