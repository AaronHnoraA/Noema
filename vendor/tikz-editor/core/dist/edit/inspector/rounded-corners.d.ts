import type { ScenePathCommand } from "../../semantic/types.js";
export declare function computePathRoundedCornersMax(commands: ScenePathCommand[]): number | null;
export declare function pathHasRoundableCorner(commands: ScenePathCommand[]): boolean;
export declare function computeLineBasedPathRoundedCornersMax(commands: ScenePathCommand[]): number | null;
export declare function computeGenericPathRoundedCornersMax(commands: ScenePathCommand[]): number | null;
export declare function estimateSegmentStartRoundedOffset(previous: ScenePathCommand | undefined, start: {
    x: number;
    y: number;
}, end: {
    x: number;
    y: number;
}): number;
export declare function estimateSegmentEndRoundedOffset(next: ScenePathCommand | undefined, start: {
    x: number;
    y: number;
}, end: {
    x: number;
    y: number;
}): number;
export declare function estimateClosingCornerStartOffset(commands: readonly ScenePathCommand[], closingIndex: number, start: {
    x: number;
    y: number;
}, end: {
    x: number;
    y: number;
}): number;
export declare function estimateRoundedOffsetAlongDirection(vector: {
    x: number;
    y: number;
}, direction: {
    x: number;
    y: number;
}): number;
export declare function normalizeVector(vector: {
    x: number;
    y: number;
}): {
    x: number;
    y: number;
} | null;
export declare function maxRoundedCornersForSubpath(lengths: readonly number[], closed: boolean): number | null;
export declare function pointDistance(a: {
    x: number;
    y: number;
}, b: {
    x: number;
    y: number;
}): number;
export declare function normalizeRoundedCornersMax(value: number | null): number;
export declare function clampRoundedCornersRadius(value: number, max: number): number;
