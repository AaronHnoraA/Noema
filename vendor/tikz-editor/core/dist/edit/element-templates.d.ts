import type { WorldPoint } from "../coords/points.js";
import type { Span } from "../ast/types.js";
export type AnchorReference = {
    nodeName: string;
    nodeSourceId?: string;
    anchor: string;
};
export type ElementTemplate = {
    kind: "node";
    name?: string;
    text?: string;
    shape?: string;
    minimumWidthPt?: number;
    minimumHeightPt?: number;
    strokeColor?: string;
    fillColor?: string;
} | {
    kind: "matrix";
    rows?: number;
    columns?: number;
    matrixKind?: "plain" | "nodes" | "math-nodes";
    cells?: string[][];
} | {
    kind: "line";
    hasArrow?: boolean;
    to?: WorldPoint;
    fromAnchor?: AnchorReference;
    toAnchor?: AnchorReference;
    strokeColor?: string;
} | {
    kind: "bezier";
    to?: WorldPoint;
    control1?: WorldPoint;
    control2?: WorldPoint;
    strokeColor?: string;
} | {
    kind: "grid";
    corner?: WorldPoint;
    strokeColor?: string;
} | {
    kind: "rectangle";
    corner?: WorldPoint;
    strokeColor?: string;
    fillColor?: string;
} | {
    kind: "ellipse";
    corner?: WorldPoint;
    strokeColor?: string;
    fillColor?: string;
} | {
    kind: "circle";
    edge?: WorldPoint;
    strokeColor?: string;
    fillColor?: string;
} | {
    kind: "filledCircle";
    edge?: WorldPoint;
};
export type ComplexPathSegment = {
    kind: "line";
    to: WorldPoint;
    toAnchor?: AnchorReference;
} | {
    kind: "bezier";
    to: WorldPoint;
    control1: WorldPoint;
    control2: WorldPoint;
    toAnchor?: AnchorReference;
};
export declare function generateElementSource(template: ElementTemplate, at: WorldPoint): string;
export declare function insertElementIntoSource(source: string, snippet: string, figureSpan?: Span): string;
export declare function generateComplexPathSource(start: WorldPoint, segments: readonly ComplexPathSegment[], options?: {
    closed?: boolean;
    startAnchor?: AnchorReference;
    strokeColor?: string;
}): string | null;
/**
 * Generate just the segment operators (e.g. `-- (x,y) .. controls ... .. (x2,y2)`)
 * without the `\draw`, start coordinate, or `;`.
 */
export declare function generateComplexPathSegmentSource(segments: readonly ComplexPathSegment[]): string | null;
/**
 * Reverse an array of path segments so they traverse the path in the opposite direction.
 * `fromWorld` is the start point of the original (unreversed) segment sequence.
 */
export declare function reverseComplexPathSegments(fromWorld: WorldPoint, segments: readonly ComplexPathSegment[], fromAnchor?: AnchorReference): {
    startWorld: WorldPoint;
    startAnchor?: AnchorReference;
    segments: ComplexPathSegment[];
};
/**
 * Generate source for prepending to an existing path's start.
 * Returns `(newStart) -- (p1) -- ... --` — ending with an operator (no final coordinate),
 * so the existing path's first coordinate naturally follows.
 *
 * `startWorld` is the new far start point; `segments` should be reversed so the last
 * segment's target is the existing path's old start (which will be omitted).
 */
export declare function generateComplexPathPrependSource(startWorld: WorldPoint, segments: readonly ComplexPathSegment[], startAnchor?: AnchorReference): string | null;
export declare function buildDrawOptions(strokeColor: string | undefined, fillColor: string | undefined, hasArrow: boolean): string;
