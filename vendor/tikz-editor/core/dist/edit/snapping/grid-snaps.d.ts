import type { WorldPoint } from "../../coords/points.js";
import type { Axis, AxisMinOffset, AxisSnapBuckets } from "./types.js";
export declare function pickGridStepPt(scale: number, targetPixels: number): number;
export declare function snapToNextMultiple(value: number, step: number, direction: -1 | 1): number;
export declare function collectGridSnaps({ selectionPoints, minOffset, nearest, gridStep, enabledAxis }: {
    selectionPoints: readonly WorldPoint[];
    minOffset: AxisMinOffset;
    nearest: AxisSnapBuckets;
    gridStep: number;
    enabledAxis?: Axis | null;
}): void;
