import type { FrameLocalPoint, FrameLocalVector, SourceCmPoint, WorldPoint, WorldVector } from "../coords/points.js";
import type { FrameTransform } from "../coords/transforms.js";
/**
 * Convert a world-space position to local (pre-transform) coordinates.
 * Returns null if the transform is not invertible.
 */
export declare function worldToFrameLocalPoint(world: WorldPoint, transform: FrameTransform): FrameLocalPoint | null;
/**
 * Convert a world-space delta to a local-space delta (excludes translation).
 * Returns null if the transform is not invertible.
 */
export declare function worldVectorToFrameLocalPoint(delta: WorldVector, transform: FrameTransform): FrameLocalVector | null;
/**
 * Convert local coordinates (TeX points) to source units (cm).
 */
export declare function frameLocalPtToSourceCmPoint(local: Pick<FrameLocalPoint, "x" | "y"> | Pick<FrameLocalVector, "x" | "y">): SourceCmPoint;
export declare const worldToLocal: typeof worldToFrameLocalPoint;
export declare const worldDeltaToLocalDelta: typeof worldVectorToFrameLocalPoint;
export declare const localToSourceUnits: typeof frameLocalPtToSourceCmPoint;
