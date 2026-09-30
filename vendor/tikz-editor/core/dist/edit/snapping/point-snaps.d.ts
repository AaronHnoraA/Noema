import type { WorldPoint } from "../../coords/points.js";
import type { Axis, AxisMinOffset, AxisSnapBuckets, SelectionSnapPoint, SnapLine, SnapPoint } from "./types.js";
/**
 * When several references fall within the snap threshold, prefer the visually
 * nearest cluster of references over a distant element that wins on raw offset
 * by a hair. Candidates whose distance jumps by more than this (screen px,
 * converted to world by the caller) past the previous one are discarded.
 */
export declare const SNAP_CLUSTER_BREAK_PX = 200;
export declare function collectPointSnaps({ selectionPoints, referencePoints, minOffset, nearest, kind, enabledAxis, clusterBreakWorld }: {
    selectionPoints: readonly SelectionSnapPoint[];
    referencePoints: readonly (SnapPoint | WorldPoint)[];
    minOffset: AxisMinOffset;
    nearest: AxisSnapBuckets;
    kind: "point" | "grid";
    enabledAxis?: Axis | null;
    clusterBreakWorld?: number;
}): void;
export declare function collectGuideSnaps({ selectionPoints, guides, minOffset, nearest, enabledAxis }: {
    selectionPoints: readonly WorldPoint[];
    guides: {
        x: readonly number[];
        y: readonly number[];
    };
    minOffset: AxisMinOffset;
    nearest: AxisSnapBuckets;
    enabledAxis?: Axis | null;
}): void;
export declare function pointSnapOffset(nearest: AxisSnapBuckets): WorldPoint;
export declare function createPointSnapLines(nearest: AxisSnapBuckets): SnapLine[];
export declare function createPointerLinesForPointSnap(nearest: AxisSnapBuckets, snappedPoint: WorldPoint): SnapLine[];
export declare function createEmptySnapBuckets(): AxisSnapBuckets;
export declare function createMinOffset(threshold: number, enabledAxis?: Axis | null): AxisMinOffset;
export declare function roundSnapValue(value: number): number;
