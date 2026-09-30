import type { WorldBounds } from "../../coords/points.js";
import type { Axis, AxisMinOffset, AxisSnapBuckets, Gap, GapSnapCandidate, SnapBounds, SnapLine } from "./types.js";
export declare function buildVisibleGaps(referenceBounds: readonly SnapBounds[], maxPairsPerAxis: number): {
    horizontal: Gap[];
    vertical: Gap[];
};
export declare function collectGapSnaps({ selectionBounds, visibleGaps, minOffset, nearest, enabledAxis }: {
    selectionBounds: WorldBounds;
    visibleGaps: {
        horizontal: Gap[];
        vertical: Gap[];
    };
    minOffset: AxisMinOffset;
    nearest: AxisSnapBuckets;
    enabledAxis?: Axis | null;
}): void;
export declare function createGapSnapLines(selectionBounds: WorldBounds, candidates: readonly GapSnapCandidate[]): SnapLine[];
